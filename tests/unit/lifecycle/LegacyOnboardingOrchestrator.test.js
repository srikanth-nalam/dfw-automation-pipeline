'use strict';

const LegacyOnboardingOrchestrator = require('../../../src/vro/actions/lifecycle/LegacyOnboardingOrchestrator');

describe('LegacyOnboardingOrchestrator', () => {
  let orchestrator;
  let deps;

  beforeEach(() => {
    deps = {
      tagOperations: {
        getTags: jest.fn().mockResolvedValue({}),
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        removeTags: jest.fn().mockResolvedValue({ removed: true }),
        verifyPropagation: jest.fn().mockResolvedValue({ propagated: true })
      },
      groupVerifier: {
        predictGroupChanges: jest.fn().mockReturnValue({
          vmId: 'vm-1', groupsToJoin: [], groupsToLeave: [], unchangedGroups: []
        })
      },
      dfwValidator: {
        validatePolicies: jest.fn().mockResolvedValue({ compliant: true, policies: [] })
      },
      sagaCoordinator: { begin: jest.fn(), recordStep: jest.fn() },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      },
      restClient: {
        post: jest.fn().mockResolvedValue({ status: 200 })
      },
      configLoader: {
        getEndpointsForSite: jest.fn().mockReturnValue({
          vcenterUrl: 'https://vcenter-ndcng.test'
        })
      },
      snowAdapter: {
        toCallbackPayload: jest.fn().mockImplementation(r => r)
      },
      payloadValidator: {
        validate: jest.fn().mockReturnValue({ valid: true, errors: [] })
      }
    };

    orchestrator = new LegacyOnboardingOrchestrator(deps);
  });

  const buildPayload = (overrides = {}) => ({
    correlationId: 'LEGACY-001',
    requestType: 'legacy_onboard',
    site: 'NDCNG',
    batchSize: 10,
    dryRun: false,
    vmEntries: [
      {
        vmName: 'LEGACY-VM-001',
        tags: {
          Application: 'APP001',
          Tier: 'Web',
          Environment: 'Production',
          Compliance: ['PCI'],
          DataClassification: 'Confidential'
        }
      },
      {
        vmName: 'LEGACY-VM-002',
        tags: {
          Application: 'APP002',
          Tier: 'DB',
          Environment: 'Development',
          Compliance: ['None'],
          DataClassification: 'Internal'
        }
      }
    ],
    ...overrides
  });

  // Constructor
  test('throws when dependencies is null', () => {
    expect(() => new LegacyOnboardingOrchestrator(null)).toThrow(/DFW-8400/);
  });

  // Happy path
  test('processes valid entries through bulk orchestrator', async () => {
    const report = await orchestrator.onboardLegacyVMs(buildPayload());

    expect(report.dictionaryValidation).toBeDefined();
    expect(report.dictionaryValidation.validEntries).toBe(2);
    expect(report.dictionaryValidation.invalidEntries).toBe(0);
    expect(report.successCount).toBe(2);
  });

  // Dictionary validation
  test('rejects entries with invalid tag values', async () => {
    const payload = buildPayload({
      vmEntries: [
        {
          vmName: 'BAD-VM',
          tags: {
            Application: 'APP001',
            Tier: 'InvalidTier',
            Environment: 'Production',
            Compliance: ['PCI'],
            DataClassification: 'Confidential'
          }
        }
      ]
    });

    const report = await orchestrator.onboardLegacyVMs(payload);

    expect(report.dictionaryValidation.invalidEntries).toBe(1);
    expect(report.dictionaryValidation.invalidDetails[0].errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Invalid Tier')])
    );
  });

  // Mixed valid and invalid
  test('partitions valid and invalid entries correctly', async () => {
    const payload = buildPayload({
      vmEntries: [
        {
          vmName: 'VALID-VM',
          tags: {
            Application: 'APP001', Tier: 'Web', Environment: 'Production',
            Compliance: ['PCI'], DataClassification: 'Confidential'
          }
        },
        {
          vmName: 'INVALID-VM',
          tags: {
            Application: 'APP002', Tier: 'BadTier', Environment: 'BadEnv',
            Compliance: ['None'], DataClassification: 'Internal'
          }
        }
      ]
    });

    const report = await orchestrator.onboardLegacyVMs(payload);

    expect(report.dictionaryValidation.validEntries).toBe(1);
    expect(report.dictionaryValidation.invalidEntries).toBe(1);
  });

  // Dry run
  test('dry run mode prevents tag application', async () => {
    const report = await orchestrator.onboardLegacyVMs(buildPayload({ dryRun: true }));

    expect(report.dryRun).toBe(true);
    expect(deps.tagOperations.applyTags).not.toHaveBeenCalled();
  });

  // Empty entries
  test('handles empty vmEntries gracefully', async () => {
    const report = await orchestrator.onboardLegacyVMs(buildPayload({ vmEntries: [] }));

    expect(report.dictionaryValidation.totalEntries).toBe(0);
    expect(report.totalVMs).toBe(0);
  });

  // Missing vmName
  test('rejects entries without vmName', async () => {
    const payload = buildPayload({
      vmEntries: [{ tags: { Application: 'APP001', Tier: 'Web', Environment: 'Production', Compliance: ['None'], DataClassification: 'Internal' } }]
    });

    const report = await orchestrator.onboardLegacyVMs(payload);

    expect(report.dictionaryValidation.invalidEntries).toBe(1);
  });

  // Missing tags object
  test('rejects entries without tags', async () => {
    const payload = buildPayload({
      vmEntries: [{ vmName: 'NO-TAGS-VM' }]
    });

    const report = await orchestrator.onboardLegacyVMs(payload);

    expect(report.dictionaryValidation.invalidEntries).toBe(1);
  });

  // Missing required tags
  test('rejects entries missing required tag fields', async () => {
    const payload = buildPayload({
      vmEntries: [{ vmName: 'PARTIAL-VM', tags: { Application: 'APP001' } }]
    });

    const report = await orchestrator.onboardLegacyVMs(payload);

    expect(report.dictionaryValidation.invalidEntries).toBe(1);
    expect(report.dictionaryValidation.invalidDetails[0].errors.length).toBeGreaterThan(0);
  });

  // Report structure
  test('report contains dictionary validation section', async () => {
    const report = await orchestrator.onboardLegacyVMs(buildPayload());

    expect(report.dictionaryValidation).toHaveProperty('totalEntries');
    expect(report.dictionaryValidation).toHaveProperty('validEntries');
    expect(report.dictionaryValidation).toHaveProperty('invalidEntries');
    expect(report.dictionaryValidation).toHaveProperty('invalidDetails');
  });

  // All invalid
  test('handles case where all entries are invalid', async () => {
    const payload = buildPayload({
      vmEntries: [
        { vmName: 'BAD-1', tags: { Application: 'APP001', Tier: 'INVALID', Environment: 'Production', Compliance: ['None'], DataClassification: 'Internal' } },
        { vmName: 'BAD-2', tags: { Application: 'APP002', Tier: 'INVALID', Environment: 'Production', Compliance: ['None'], DataClassification: 'Internal' } }
      ]
    });

    const report = await orchestrator.onboardLegacyVMs(payload);

    expect(report.dictionaryValidation.validEntries).toBe(0);
    expect(report.dictionaryValidation.invalidEntries).toBe(2);
    expect(report.totalVMs).toBe(0);
  });
});
