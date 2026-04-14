'use strict';

const RuleRequestPipeline = require('../../../src/servicenow/integration/RuleRequestPipeline');

describe('RuleRequestPipeline', () => {
  let pipeline;
  let deps;

  beforeEach(() => {
    deps = {
      restClient: {
        post: jest.fn().mockResolvedValue({ status: 200 }),
        get: jest.fn().mockResolvedValue({ result: [] })
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      }
    };

    pipeline = new RuleRequestPipeline(deps);
  });

  const buildCatalogRequest = (overrides = {}) => ({
    ritmNumber: 'RITM0010001',
    requestedBy: 'user-sys-id-001',
    sourceGroup: 'SG-Web-Production',
    destinationGroup: 'SG-App-Production',
    action: 'allow',
    protocol: 'TCP',
    port: '443',
    justification: 'Web tier needs HTTPS access to application tier',
    ...overrides
  });

  const buildRuleDefinition = (overrides = {}) => ({
    sourceGroup: 'SG-App-Production',
    destinationGroup: 'SG-DB-Production',
    action: 'allow',
    protocol: 'TCP',
    port: '5432',
    ...overrides
  });

  // -------------------------------------------------------------------------
  // Constructor tests
  // -------------------------------------------------------------------------

  test('throws DFW-9100 when dependencies is null', () => {
    expect(() => new RuleRequestPipeline(null)).toThrow(/DFW-9100/);
  });

  test('throws DFW-9101 when restClient is missing', () => {
    expect(() => new RuleRequestPipeline({ logger: deps.logger })).toThrow(/DFW-9101/);
  });

  test('throws DFW-9102 when logger is missing', () => {
    expect(() => new RuleRequestPipeline({ restClient: deps.restClient })).toThrow(/DFW-9102/);
  });

  // -------------------------------------------------------------------------
  // submitFromCatalog tests
  // -------------------------------------------------------------------------

  test('submits a valid catalog request and returns pipeline status', async () => {
    const result = await pipeline.submitFromCatalog(buildCatalogRequest());

    expect(result.source).toBe('catalog');
    expect(result.status).toBe('submitted');
    expect(result.ritmNumber).toBe('RITM0010001');
    expect(result.requestId).toMatch(/^DFW-CAT-/);
    expect(result.submittedAt).toBeDefined();
  });

  test('persists catalog request to ServiceNow via restClient', async () => {
    await pipeline.submitFromCatalog(buildCatalogRequest());

    expect(deps.restClient.post).toHaveBeenCalledWith(
      '/api/now/table/u_dfw_rule_request',
      expect.objectContaining({
        u_source: 'catalog',
        u_status: 'submitted',
        u_ritm_number: 'RITM0010001',
        u_action: 'allow',
        u_protocol: 'TCP'
      })
    );
  });

  test('throws DFW-9110 when catalog request has missing required fields', async () => {
    await expect(
      pipeline.submitFromCatalog(buildCatalogRequest({ ritmNumber: '' }))
    ).rejects.toThrow(/DFW-9110/);
  });

  test('throws DFW-9110 when catalog request has invalid action', async () => {
    await expect(
      pipeline.submitFromCatalog(buildCatalogRequest({ action: 'block' }))
    ).rejects.toThrow(/DFW-9110/);
  });

  test('throws DFW-9110 when catalog request has invalid protocol', async () => {
    await expect(
      pipeline.submitFromCatalog(buildCatalogRequest({ protocol: 'HTTP' }))
    ).rejects.toThrow(/DFW-9110/);
  });

  test('continues when ServiceNow persistence fails for catalog request', async () => {
    deps.restClient.post.mockRejectedValue(new Error('ServiceNow unreachable'));

    const result = await pipeline.submitFromCatalog(buildCatalogRequest());

    expect(result.status).toBe('submitted');
    expect(result.requestId).toMatch(/^DFW-CAT-/);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Failed to persist tracking record to ServiceNow',
      expect.objectContaining({ component: 'RuleRequestPipeline' })
    );
  });

  // -------------------------------------------------------------------------
  // submitFromOnboarding tests
  // -------------------------------------------------------------------------

  test('submits a batch of onboarding rules and returns batch result', async () => {
    const rules = [
      buildRuleDefinition(),
      buildRuleDefinition({ port: '8080' })
    ];

    const result = await pipeline.submitFromOnboarding('APP-001', rules);

    expect(result.source).toBe('onboarding');
    expect(result.appId).toBe('APP-001');
    expect(result.totalRules).toBe(2);
    expect(result.submittedCount).toBe(2);
    expect(result.rejectedCount).toBe(0);
    expect(result.batchId).toMatch(/^DFW-ONB-/);
  });

  test('rejects individual invalid rules without failing the batch', async () => {
    const rules = [
      buildRuleDefinition(),
      buildRuleDefinition({ action: 'invalid_action' }),
      buildRuleDefinition({ port: '8443' })
    ];

    const result = await pipeline.submitFromOnboarding('APP-002', rules);

    expect(result.submittedCount).toBe(2);
    expect(result.rejectedCount).toBe(1);
    expect(result.results[1].status).toBe('rejected');
    expect(result.results[1].errors.length).toBeGreaterThan(0);
  });

  test('throws DFW-9120 when appId is missing', async () => {
    await expect(
      pipeline.submitFromOnboarding('', [buildRuleDefinition()])
    ).rejects.toThrow(/DFW-9120/);
  });

  test('throws DFW-9121 when ruleDefinitions is empty', async () => {
    await expect(
      pipeline.submitFromOnboarding('APP-001', [])
    ).rejects.toThrow(/DFW-9121/);
  });

  test('throws DFW-9122 when rule count exceeds maximum', async () => {
    const rules = Array.from({ length: 201 }, () => buildRuleDefinition());

    await expect(
      pipeline.submitFromOnboarding('APP-001', rules)
    ).rejects.toThrow(/DFW-9122/);
  });

  // -------------------------------------------------------------------------
  // submitEmergency tests
  // -------------------------------------------------------------------------

  test('submits emergency rule with auto-approved status', async () => {
    const ruleReq = buildRuleDefinition({
      justification: 'Critical security incident requires immediate block',
      requestedBy: 'sec-ops-user'
    });

    const result = await pipeline.submitEmergency('INC0054321', ruleReq);

    expect(result.source).toBe('emergency');
    expect(result.status).toBe('approved');
    expect(result.emergency).toBe(true);
    expect(result.incidentId).toBe('INC0054321');
    expect(result.requestId).toMatch(/^DFW-EMR-/);
  });

  test('throws DFW-9130 when incidentId is missing', async () => {
    await expect(
      pipeline.submitEmergency('', buildRuleDefinition({ justification: 'reason' }))
    ).rejects.toThrow(/DFW-9130/);
  });

  test('throws DFW-9132 when emergency justification is empty', async () => {
    await expect(
      pipeline.submitEmergency('INC0054321', buildRuleDefinition({ justification: '' }))
    ).rejects.toThrow(/DFW-9132/);
  });

  // -------------------------------------------------------------------------
  // submitFromAudit tests
  // -------------------------------------------------------------------------

  test('submits audit-driven rule request with compliance metadata', async () => {
    const ruleReq = buildRuleDefinition({
      complianceFramework: 'PCI',
      remediationDeadline: '2026-06-01'
    });

    const result = await pipeline.submitFromAudit('AUD-2026-0042', ruleReq);

    expect(result.source).toBe('audit');
    expect(result.status).toBe('submitted');
    expect(result.auditFindingId).toBe('AUD-2026-0042');
    expect(result.complianceFramework).toBe('PCI');
    expect(result.requestId).toMatch(/^DFW-AUD-/);
  });

  test('throws DFW-9140 when auditFindingId is missing', async () => {
    await expect(
      pipeline.submitFromAudit('', buildRuleDefinition())
    ).rejects.toThrow(/DFW-9140/);
  });

  test('throws DFW-9142 when audit rule has invalid fields', async () => {
    await expect(
      pipeline.submitFromAudit('AUD-001', { action: 'nope', protocol: 'X' })
    ).rejects.toThrow(/DFW-9142/);
  });

  // -------------------------------------------------------------------------
  // getStatus tests
  // -------------------------------------------------------------------------

  test('retrieves status from in-memory tracking store', async () => {
    const submitResult = await pipeline.submitFromCatalog(buildCatalogRequest());
    const status = await pipeline.getStatus(submitResult.requestId);

    expect(status.requestId).toBe(submitResult.requestId);
    expect(status.source).toBe('catalog');
    expect(status.status).toBe('submitted');
    expect(status.history).toBeDefined();
    expect(status.history.length).toBeGreaterThan(0);
  });

  test('falls back to ServiceNow REST lookup when not in memory', async () => {
    deps.restClient.get.mockResolvedValue({
      result: [{
        u_request_id: 'DFW-CAT-ext-0001',
        u_source: 'catalog',
        u_status: 'processing',
        sys_created_on: '2026-04-14 10:00:00',
        sys_updated_on: '2026-04-14 10:05:00'
      }]
    });

    const status = await pipeline.getStatus('DFW-CAT-ext-0001');

    expect(status.requestId).toBe('DFW-CAT-ext-0001');
    expect(status.status).toBe('processing');
  });

  test('throws DFW-9150 when requestId is empty', async () => {
    await expect(pipeline.getStatus('')).rejects.toThrow(/DFW-9150/);
  });

  test('throws DFW-9151 when request is not found', async () => {
    deps.restClient.get.mockResolvedValue({ result: [] });

    await expect(
      pipeline.getStatus('DFW-CAT-nonexistent-0001')
    ).rejects.toThrow(/DFW-9151/);
  });

  // -------------------------------------------------------------------------
  // Port validation edge case
  // -------------------------------------------------------------------------

  test('accepts port range format in rule definition', async () => {
    const result = await pipeline.submitFromCatalog(
      buildCatalogRequest({ port: '8080-8090' })
    );

    expect(result.status).toBe('submitted');
  });

  test('rejects malformed port value', async () => {
    await expect(
      pipeline.submitFromCatalog(buildCatalogRequest({ port: 'abc' }))
    ).rejects.toThrow(/DFW-9110/);
  });

  // -------------------------------------------------------------------------
  // Static constants
  // -------------------------------------------------------------------------

  test('exports valid sources constant', () => {
    expect(RuleRequestPipeline.VALID_SOURCES).toContain('catalog');
    expect(RuleRequestPipeline.VALID_SOURCES).toContain('onboarding');
    expect(RuleRequestPipeline.VALID_SOURCES).toContain('emergency');
    expect(RuleRequestPipeline.VALID_SOURCES).toContain('audit');
  });

  test('exports valid rule actions constant', () => {
    expect(RuleRequestPipeline.VALID_RULE_ACTIONS).toContain('allow');
    expect(RuleRequestPipeline.VALID_RULE_ACTIONS).toContain('deny');
    expect(RuleRequestPipeline.VALID_RULE_ACTIONS).toContain('drop');
    expect(RuleRequestPipeline.VALID_RULE_ACTIONS).toContain('reject');
  });
});
