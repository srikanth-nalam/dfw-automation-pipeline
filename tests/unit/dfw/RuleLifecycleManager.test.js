'use strict';

const RuleLifecycleManager = require('../../../src/vro/actions/dfw/RuleLifecycleManager');

const { RULE_STATES, STATE_TRANSITIONS } = RuleLifecycleManager;

describe('RuleLifecycleManager', () => {
  let manager;
  let deps;
  let registeredRules;

  beforeEach(() => {
    registeredRules = {};

    deps = {
      ruleRegistry: {
        generateRuleId: jest.fn().mockReturnValue('DFW-R-0001'),
        register: jest.fn().mockImplementation((rule) => {
          registeredRules[rule.ruleId] = { ...rule };
          return Promise.resolve({ ...rule });
        }),
        getRule: jest.fn().mockImplementation((ruleId) => {
          const rule = registeredRules[ruleId];
          if (!rule) {
            return Promise.reject(new Error(`Rule "${ruleId}" not found`));
          }
          return Promise.resolve({ ...rule });
        }),
        updateState: jest.fn().mockImplementation((ruleId, newState, metadata) => {
          if (registeredRules[ruleId]) {
            registeredRules[ruleId].state = newState;
            registeredRules[ruleId] = { ...registeredRules[ruleId], ...metadata };
          }
          return Promise.resolve({ ...registeredRules[ruleId] });
        }),
        getHistory: jest.fn().mockResolvedValue([
          { timestamp: '2026-01-01T00:00:00Z', fromState: null, toState: 'REQUESTED' },
          { timestamp: '2026-01-02T00:00:00Z', fromState: 'REQUESTED', toState: 'IMPACT_ANALYZED' }
        ])
      },
      policyDeployer: {
        deploy: jest.fn().mockResolvedValue({
          success: true,
          policyName: 'test-policy',
          rulesDeployed: 1
        })
      },
      ruleConflictDetector: {
        analyze: jest.fn().mockReturnValue({
          conflicts: [],
          shadows: [],
          duplicates: [],
          hasIssues: false
        })
      },
      restClient: {
        get: jest.fn().mockResolvedValue({}),
        post: jest.fn().mockResolvedValue({})
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      }
    };

    manager = new RuleLifecycleManager(deps);
  });

  const buildRuleRequest = (overrides = {}) => ({
    name: 'allow-web-to-db',
    source_groups: ['web-tier'],
    destination_groups: ['db-tier'],
    services: ['TCP/3306'],
    action: 'ALLOW',
    owner: 'john.doe',
    ...overrides
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    test('throws DFW-10001 when dependencies is null', () => {
      expect(() => new RuleLifecycleManager(null)).toThrow(/DFW-10001/);
    });

    test('throws DFW-10001 when ruleRegistry is missing', () => {
      const { ruleRegistry, ...rest } = deps;
      expect(() => new RuleLifecycleManager(rest)).toThrow(/DFW-10001/);
    });

    test('throws DFW-10001 when policyDeployer is missing', () => {
      const { policyDeployer, ...rest } = deps;
      expect(() => new RuleLifecycleManager(rest)).toThrow(/DFW-10001/);
    });

    test('throws DFW-10001 when ruleConflictDetector is missing', () => {
      const { ruleConflictDetector, ...rest } = deps;
      expect(() => new RuleLifecycleManager(rest)).toThrow(/DFW-10001/);
    });

    test('throws DFW-10001 when restClient is missing', () => {
      const { restClient, ...rest } = deps;
      expect(() => new RuleLifecycleManager(rest)).toThrow(/DFW-10001/);
    });

    test('throws DFW-10001 when logger is missing', () => {
      const { logger, ...rest } = deps;
      expect(() => new RuleLifecycleManager(rest)).toThrow(/DFW-10001/);
    });

    test('creates instance with all dependencies', () => {
      expect(() => new RuleLifecycleManager(deps)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Static exports
  // ---------------------------------------------------------------------------
  describe('static exports', () => {
    test('exports RULE_STATES', () => {
      expect(RuleLifecycleManager.RULE_STATES).toBeDefined();
      expect(RuleLifecycleManager.RULE_STATES.REQUESTED).toBe('REQUESTED');
      expect(RuleLifecycleManager.RULE_STATES.ENFORCED).toBe('ENFORCED');
    });

    test('exports STATE_TRANSITIONS', () => {
      expect(RuleLifecycleManager.STATE_TRANSITIONS).toBeDefined();
      expect(RuleLifecycleManager.STATE_TRANSITIONS.REQUESTED).toContain('IMPACT_ANALYZED');
    });

    test('RULE_STATES is frozen', () => {
      expect(Object.isFrozen(RULE_STATES)).toBe(true);
    });

    test('STATE_TRANSITIONS is frozen', () => {
      expect(Object.isFrozen(STATE_TRANSITIONS)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // submitRule
  // ---------------------------------------------------------------------------
  describe('submitRule', () => {
    test('assigns unique ID and registers rule with REQUESTED state', async () => {
      const result = await manager.submitRule(buildRuleRequest());

      expect(result.ruleId).toBe('DFW-R-0001');
      expect(result.state).toBe(RULE_STATES.REQUESTED);
      expect(deps.ruleRegistry.generateRuleId).toHaveBeenCalled();
      expect(deps.ruleRegistry.register).toHaveBeenCalled();
    });

    test('preserves all fields from the request', async () => {
      const request = buildRuleRequest({ owner: 'test-owner' });
      await manager.submitRule(request);

      const registered = deps.ruleRegistry.register.mock.calls[0][0];
      expect(registered.name).toBe('allow-web-to-db');
      expect(registered.source_groups).toEqual(['web-tier']);
      expect(registered.owner).toBe('test-owner');
    });

    test('throws DFW-10003 when request is null', async () => {
      await expect(manager.submitRule(null)).rejects.toThrow(/DFW-10003/);
    });

    test('throws DFW-10003 when name is missing', async () => {
      await expect(manager.submitRule({})).rejects.toThrow(/DFW-10003/);
    });

    test('includes submittedAt timestamp', async () => {
      await manager.submitRule(buildRuleRequest());

      const registered = deps.ruleRegistry.register.mock.calls[0][0];
      expect(registered.submittedAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // analyzeImpact
  // ---------------------------------------------------------------------------
  describe('analyzeImpact', () => {
    beforeEach(async () => {
      await manager.submitRule(buildRuleRequest());
    });

    test('runs conflict detection and transitions to IMPACT_ANALYZED', async () => {
      const { rule, impactResult } = await manager.analyzeImpact('DFW-R-0001');

      expect(rule.state).toBe(RULE_STATES.IMPACT_ANALYZED);
      expect(impactResult.hasIssues).toBe(false);
      expect(deps.ruleConflictDetector.analyze).toHaveBeenCalled();
      expect(deps.ruleRegistry.updateState).toHaveBeenCalledWith(
        'DFW-R-0001',
        RULE_STATES.IMPACT_ANALYZED,
        expect.any(Object)
      );
    });

    test('reports issues when conflicts are detected', async () => {
      deps.ruleConflictDetector.analyze.mockReturnValue({
        conflicts: [{ ruleA: 'a', ruleB: 'b', reason: 'contradiction' }],
        shadows: [],
        duplicates: [],
        hasIssues: true
      });

      const { impactResult } = await manager.analyzeImpact('DFW-R-0001');

      expect(impactResult.hasIssues).toBe(true);
      expect(impactResult.conflicts).toHaveLength(1);
    });

    test('throws DFW-10004 when ruleId is empty', async () => {
      await expect(manager.analyzeImpact('')).rejects.toThrow(/DFW-10004/);
    });

    test('throws on invalid state transition', async () => {
      // Move rule past REQUESTED
      registeredRules['DFW-R-0001'].state = RULE_STATES.ENFORCED;

      await expect(manager.analyzeImpact('DFW-R-0001')).rejects.toThrow(/DFW-10002/);
    });
  });

  // ---------------------------------------------------------------------------
  // deployMonitorMode
  // ---------------------------------------------------------------------------
  describe('deployMonitorMode', () => {
    beforeEach(async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.APPROVED;
    });

    test('deploys rule in monitor mode and transitions state', async () => {
      const result = await manager.deployMonitorMode('DFW-R-0001', 'NDCNG');

      expect(result.state).toBe(RULE_STATES.MONITOR_MODE);
      expect(result.site).toBe('NDCNG');
      expect(deps.policyDeployer.deploy).toHaveBeenCalled();
    });

    test('deploys with logged=true for monitoring', async () => {
      await manager.deployMonitorMode('DFW-R-0001', 'NDCNG');

      const deployedPolicy = deps.policyDeployer.deploy.mock.calls[0][0];
      expect(deployedPolicy.rules[0].logged).toBe(true);
      expect(deployedPolicy.rules[0].tag).toBe('MONITOR_MODE');
    });

    test('throws DFW-10005 when ruleId is missing', async () => {
      await expect(manager.deployMonitorMode('', 'NDCNG')).rejects.toThrow(/DFW-10005/);
    });

    test('throws DFW-10005 when site is missing', async () => {
      await expect(manager.deployMonitorMode('DFW-R-0001', '')).rejects.toThrow(/DFW-10005/);
    });

    test('throws DFW-10002 from wrong state', async () => {
      registeredRules['DFW-R-0001'].state = RULE_STATES.REQUESTED;

      await expect(manager.deployMonitorMode('DFW-R-0001', 'NDCNG')).rejects.toThrow(/DFW-10002/);
    });

    test('throws DFW-10005 when deployment fails', async () => {
      deps.policyDeployer.deploy.mockRejectedValue(new Error('NSX unreachable'));

      await expect(manager.deployMonitorMode('DFW-R-0001', 'NDCNG')).rejects.toThrow(/DFW-10005/);
    });
  });

  // ---------------------------------------------------------------------------
  // promoteToEnforce
  // ---------------------------------------------------------------------------
  describe('promoteToEnforce', () => {
    beforeEach(async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.MONITOR_MODE;
    });

    test('promotes rule through VALIDATED to ENFORCED', async () => {
      const result = await manager.promoteToEnforce('DFW-R-0001', 'NDCNG');

      expect(result.state).toBe(RULE_STATES.ENFORCED);
      expect(result.site).toBe('NDCNG');

      // Should have two updateState calls: VALIDATED then ENFORCED
      const updateCalls = deps.ruleRegistry.updateState.mock.calls;
      expect(updateCalls.some((c) => c[1] === RULE_STATES.VALIDATED)).toBe(true);
      expect(updateCalls.some((c) => c[1] === RULE_STATES.ENFORCED)).toBe(true);
    });

    test('deploys rule with real action', async () => {
      await manager.promoteToEnforce('DFW-R-0001', 'NDCNG');

      const deployedPolicy = deps.policyDeployer.deploy.mock.calls[0][0];
      expect(deployedPolicy.rules[0].action).toBe('ALLOW');
    });

    test('throws DFW-10006 when ruleId or site is missing', async () => {
      await expect(manager.promoteToEnforce('', 'NDCNG')).rejects.toThrow(/DFW-10006/);
      await expect(manager.promoteToEnforce('DFW-R-0001', '')).rejects.toThrow(/DFW-10006/);
    });

    test('throws DFW-10002 from wrong state', async () => {
      registeredRules['DFW-R-0001'].state = RULE_STATES.REQUESTED;

      await expect(manager.promoteToEnforce('DFW-R-0001', 'NDCNG')).rejects.toThrow(/DFW-10002/);
    });

    test('throws DFW-10006 when deployment fails', async () => {
      deps.policyDeployer.deploy.mockRejectedValue(new Error('Deploy failure'));

      await expect(manager.promoteToEnforce('DFW-R-0001', 'NDCNG')).rejects.toThrow(/DFW-10006/);
    });
  });

  // ---------------------------------------------------------------------------
  // rollbackRule
  // ---------------------------------------------------------------------------
  describe('rollbackRule', () => {
    test('rolls back from MONITOR_MODE', async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.MONITOR_MODE;

      const result = await manager.rollbackRule('DFW-R-0001', 'NDCNG');

      expect(result.state).toBe(RULE_STATES.ROLLED_BACK);
      expect(deps.policyDeployer.deploy).toHaveBeenCalled();
    });

    test('rolls back from ENFORCED', async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.ENFORCED;

      const result = await manager.rollbackRule('DFW-R-0001', 'NDCNG');

      expect(result.state).toBe(RULE_STATES.ROLLED_BACK);
    });

    test('rolls back from VALIDATED', async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.VALIDATED;

      const result = await manager.rollbackRule('DFW-R-0001', 'NDCNG');

      expect(result.state).toBe(RULE_STATES.ROLLED_BACK);
    });

    test('rolls back from IMPACT_ANALYZED', async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.IMPACT_ANALYZED;

      const result = await manager.rollbackRule('DFW-R-0001', 'NDCNG');

      expect(result.state).toBe(RULE_STATES.ROLLED_BACK);
    });

    test('deploys with disabled=true', async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.ENFORCED;

      await manager.rollbackRule('DFW-R-0001', 'NDCNG');

      const deployedPolicy = deps.policyDeployer.deploy.mock.calls[0][0];
      expect(deployedPolicy.rules[0].disabled).toBe(true);
    });

    test('throws DFW-10007 when params missing', async () => {
      await expect(manager.rollbackRule('', 'NDCNG')).rejects.toThrow(/DFW-10007/);
      await expect(manager.rollbackRule('DFW-R-0001', '')).rejects.toThrow(/DFW-10007/);
    });

    test('throws DFW-10002 from EXPIRED state', async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.EXPIRED;

      await expect(manager.rollbackRule('DFW-R-0001', 'NDCNG')).rejects.toThrow(/DFW-10002/);
    });

    test('throws DFW-10007 when deploy fails', async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.ENFORCED;
      deps.policyDeployer.deploy.mockRejectedValue(new Error('Deploy error'));

      await expect(manager.rollbackRule('DFW-R-0001', 'NDCNG')).rejects.toThrow(/DFW-10007/);
    });
  });

  // ---------------------------------------------------------------------------
  // certifyRule
  // ---------------------------------------------------------------------------
  describe('certifyRule', () => {
    beforeEach(async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.ENFORCED;
    });

    test('certifies rule and sets review date', async () => {
      const result = await manager.certifyRule('DFW-R-0001', 'security-architect');

      expect(result.state).toBe(RULE_STATES.CERTIFIED);
      expect(result.certifiedBy).toBe('security-architect');
      expect(result.reviewDate).toBeDefined();
    });

    test('sets review date ~90 days in the future', async () => {
      const result = await manager.certifyRule('DFW-R-0001', 'security-architect');

      const reviewDate = new Date(result.reviewDate);
      const now = new Date();
      const daysDiff = Math.round((reviewDate - now) / (1000 * 60 * 60 * 24));
      expect(daysDiff).toBeGreaterThanOrEqual(89);
      expect(daysDiff).toBeLessThanOrEqual(91);
    });

    test('throws DFW-10008 when certifierId is missing', async () => {
      await expect(manager.certifyRule('DFW-R-0001', '')).rejects.toThrow(/DFW-10008/);
    });

    test('throws DFW-10002 from wrong state', async () => {
      registeredRules['DFW-R-0001'].state = RULE_STATES.REQUESTED;

      await expect(manager.certifyRule('DFW-R-0001', 'certifier')).rejects.toThrow(/DFW-10002/);
    });
  });

  // ---------------------------------------------------------------------------
  // expireRule
  // ---------------------------------------------------------------------------
  describe('expireRule', () => {
    test('expires rule from REVIEW_DUE', async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.REVIEW_DUE;

      const result = await manager.expireRule('DFW-R-0001');

      expect(result.state).toBe(RULE_STATES.EXPIRED);
      expect(result.expiredAt).toBeDefined();
    });

    test('expires rule from CERTIFIED', async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.CERTIFIED;

      const result = await manager.expireRule('DFW-R-0001');

      expect(result.state).toBe(RULE_STATES.EXPIRED);
    });

    test('throws DFW-10009 when ruleId is missing', async () => {
      await expect(manager.expireRule('')).rejects.toThrow(/DFW-10009/);
    });

    test('throws DFW-10002 from wrong state', async () => {
      await manager.submitRule(buildRuleRequest());
      registeredRules['DFW-R-0001'].state = RULE_STATES.REQUESTED;

      await expect(manager.expireRule('DFW-R-0001')).rejects.toThrow(/DFW-10002/);
    });
  });

  // ---------------------------------------------------------------------------
  // getAuditTrail
  // ---------------------------------------------------------------------------
  describe('getAuditTrail', () => {
    test('returns full history from registry', async () => {
      const trail = await manager.getAuditTrail('DFW-R-0001');

      expect(trail).toHaveLength(2);
      expect(trail[0].toState).toBe('REQUESTED');
      expect(trail[1].toState).toBe('IMPACT_ANALYZED');
    });

    test('throws DFW-10004 when ruleId is missing', async () => {
      await expect(manager.getAuditTrail('')).rejects.toThrow(/DFW-10004/);
    });
  });

  // ---------------------------------------------------------------------------
  // submitEmergency
  // ---------------------------------------------------------------------------
  describe('submitEmergency', () => {
    test('fast-tracks through to APPROVED state', async () => {
      const result = await manager.submitEmergency(
        buildRuleRequest({ name: 'block-threat' }),
        'INC0012345'
      );

      expect(result.ruleId).toBe('DFW-R-0001');
      expect(result.state).toBe(RULE_STATES.APPROVED);
      expect(result.emergency).toBe(true);
      expect(result.incidentId).toBe('INC0012345');
    });

    test('registers rule then fast-tracks state transitions', async () => {
      await manager.submitEmergency(buildRuleRequest(), 'INC001');

      expect(deps.ruleRegistry.register).toHaveBeenCalled();

      const updateCalls = deps.ruleRegistry.updateState.mock.calls;
      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[0][1]).toBe(RULE_STATES.IMPACT_ANALYZED);
      expect(updateCalls[1][1]).toBe(RULE_STATES.APPROVED);
    });

    test('throws DFW-10010 when name is missing', async () => {
      await expect(manager.submitEmergency({}, 'INC001')).rejects.toThrow(/DFW-10010/);
    });

    test('throws DFW-10010 when incidentId is missing', async () => {
      await expect(manager.submitEmergency(buildRuleRequest(), '')).rejects.toThrow(/DFW-10010/);
    });
  });

  // ---------------------------------------------------------------------------
  // _validateTransition
  // ---------------------------------------------------------------------------
  describe('_validateTransition', () => {
    test('allows valid transitions', () => {
      expect(() => manager._validateTransition('REQUESTED', 'IMPACT_ANALYZED')).not.toThrow();
      expect(() => manager._validateTransition('ENFORCED', 'CERTIFIED')).not.toThrow();
      expect(() => manager._validateTransition('ENFORCED', 'ROLLED_BACK')).not.toThrow();
      expect(() => manager._validateTransition('ROLLED_BACK', 'REQUESTED')).not.toThrow();
    });

    test('rejects invalid transitions', () => {
      expect(() => manager._validateTransition('REQUESTED', 'ENFORCED')).toThrow(/DFW-10002/);
      expect(() => manager._validateTransition('EXPIRED', 'REQUESTED')).toThrow(/DFW-10002/);
      expect(() => manager._validateTransition('CERTIFIED', 'MONITOR_MODE')).toThrow(/DFW-10002/);
    });

    test('rejects transitions from unknown states', () => {
      expect(() => manager._validateTransition('NONEXISTENT', 'REQUESTED')).toThrow(/DFW-10002/);
    });
  });
});
