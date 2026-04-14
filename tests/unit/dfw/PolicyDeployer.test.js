'use strict';

jest.mock('../../../src/vro/actions/shared/ConfigLoader');
jest.mock('../../../src/vro/actions/dfw/RuleConflictDetector');

const PolicyDeployer = require('../../../src/vro/actions/dfw/PolicyDeployer');
const ConfigLoader = require('../../../src/vro/actions/shared/ConfigLoader');
const RuleConflictDetector = require('../../../src/vro/actions/dfw/RuleConflictDetector');

describe('PolicyDeployer', () => {
  let restClient;
  let logger;
  let configLoader;
  let deployer;

  const validPolicy = {
    name: 'test-web-policy',
    category: 'Application',
    description: 'Test policy for web tier',
    rules: [
      {
        name: 'allow-https',
        source_groups: ['web-servers'],
        destination_groups: ['app-servers'],
        services: ['TCP/443'],
        action: 'ALLOW'
      },
      {
        name: 'deny-ssh',
        source_groups: ['external'],
        destination_groups: ['db-servers'],
        services: ['TCP/22'],
        action: 'DROP'
      }
    ]
  };

  beforeEach(() => {
    restClient = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn()
    };

    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    configLoader = {
      getEndpointsForSite: jest.fn().mockReturnValue({
        nsxUrl: 'https://nsx-manager-NDCNG.company.internal'
      })
    };

    ConfigLoader.mockImplementation(() => configLoader);
    RuleConflictDetector.mockImplementation(() => ({
      analyze: jest.fn().mockReturnValue({ hasIssues: false, conflicts: [], shadows: [], duplicates: [] })
    }));

    deployer = new PolicyDeployer(restClient, logger, configLoader);
  });

  // ---------------------------------------------------------------------------
  // constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('throws when restClient is missing', () => {
      expect(() => new PolicyDeployer(null, logger))
        .toThrow('[DFW-8001] PolicyDeployer requires a restClient instance.');
    });

    it('throws when logger is missing', () => {
      expect(() => new PolicyDeployer(restClient, null))
        .toThrow('[DFW-8001] PolicyDeployer requires a logger instance.');
    });
  });

  // ---------------------------------------------------------------------------
  // deploy
  // ---------------------------------------------------------------------------
  describe('deploy', () => {
    it('deploys a valid policy', async () => {
      restClient.patch.mockResolvedValue({ status: 200 });

      const result = await deployer.deploy(validPolicy, 'NDCNG', 'GLOBAL');

      expect(result.success).toBe(true);
      expect(result.policyName).toBe('test-web-policy');
      expect(result.site).toBe('NDCNG');
      expect(result.scope).toBe('GLOBAL');
      expect(restClient.patch).toHaveBeenCalledTimes(1);
    });

    it('validates structure before deployment', async () => {
      const invalidPolicy = { name: 'bad-policy', category: 'Application' };

      await expect(deployer.deploy(invalidPolicy, 'NDCNG'))
        .rejects.toThrow('[DFW-8002]');
    });

    it('handles deployment failure when PATCH throws', async () => {
      restClient.patch.mockRejectedValue(new Error('Connection refused'));

      await expect(deployer.deploy(validPolicy, 'NDCNG'))
        .rejects.toThrow('[DFW-8004]');
      expect(logger.error).toHaveBeenCalled();
    });

    it('reports rule count in result', async () => {
      restClient.patch.mockResolvedValue({ status: 200 });

      const result = await deployer.deploy(validPolicy, 'NDCNG');

      expect(result.rulesDeployed).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // deployMonitorMode
  // ---------------------------------------------------------------------------
  describe('deployMonitorMode', () => {
    it('sets all actions to ALLOW with logging', async () => {
      restClient.patch.mockResolvedValue({ status: 200 });

      const result = await deployer.deployMonitorMode(validPolicy, 'NDCNG');

      expect(result.mode).toBe('MONITOR');
      const patchCall = restClient.patch.mock.calls[0];
      const payload = patchCall[1];
      for (const rule of payload.rules) {
        expect(rule.action).toBe('ALLOW');
        expect(rule.logged).toBe(true);
      }
    });

    it('preserves original actions map', async () => {
      restClient.patch.mockResolvedValue({ status: 200 });

      const result = await deployer.deployMonitorMode(validPolicy, 'NDCNG');

      expect(result.originalActions).toBeDefined();
      expect(Object.keys(result.originalActions)).toHaveLength(2);
      expect(Object.values(result.originalActions)).toContain('ALLOW');
      expect(Object.values(result.originalActions)).toContain('DROP');
    });

    it('tags policy description as monitor-mode', async () => {
      restClient.patch.mockResolvedValue({ status: 200 });

      await deployer.deployMonitorMode(validPolicy, 'NDCNG');

      const patchCall = restClient.patch.mock.calls[0];
      const payload = patchCall[1];
      expect(payload.description).toContain('[MONITOR]');
    });
  });

  // ---------------------------------------------------------------------------
  // promoteToEnforce
  // ---------------------------------------------------------------------------
  describe('promoteToEnforce', () => {
    it('restores original actions from map', async () => {
      const originalActions = { 'allow-https': 'ALLOW', 'deny-ssh': 'DROP' };

      restClient.get.mockResolvedValue({
        body: {
          display_name: 'test-web-policy',
          description: '[MONITOR] Test policy',
          rules: [
            { id: 'allow-https', action: 'ALLOW', logged: true, _monitor_mode: true },
            { id: 'deny-ssh', action: 'ALLOW', logged: true, _monitor_mode: true }
          ]
        }
      });
      restClient.patch.mockResolvedValue({ status: 200 });

      const result = await deployer.promoteToEnforce('test-web-policy', 'NDCNG', originalActions);

      expect(result.mode).toBe('ENFORCE');
      expect(result.rulesPromoted).toBe(2);
    });

    it('removes monitor-mode markers from description', async () => {
      const originalActions = { 'rule-1': 'DROP' };

      restClient.get.mockResolvedValue({
        body: {
          description: '[MONITOR] My policy description',
          rules: [
            { id: 'rule-1', action: 'ALLOW', logged: true, _monitor_mode: true }
          ]
        }
      });
      restClient.patch.mockResolvedValue({ status: 200 });

      await deployer.promoteToEnforce('my-policy', 'NDCNG', originalActions);

      const patchPayload = restClient.patch.mock.calls[0][1];
      expect(patchPayload.description).not.toContain('[MONITOR]');
    });

    it('validates policy exists before promotion', async () => {
      restClient.get.mockRejectedValue(new Error('404 Not found'));

      await expect(deployer.promoteToEnforce('nonexistent', 'NDCNG', { r: 'DROP' }))
        .rejects.toThrow('[DFW-8006]');
    });
  });

  // ---------------------------------------------------------------------------
  // getDeploymentMode
  // ---------------------------------------------------------------------------
  describe('getDeploymentMode', () => {
    it('returns MONITOR when all rules are logging', async () => {
      restClient.get.mockResolvedValue({
        body: {
          description: '[MONITOR] My policy',
          rules: [
            { action: 'ALLOW', logged: true, _monitor_mode: true },
            { action: 'ALLOW', logged: true, _monitor_mode: true }
          ]
        }
      });

      const result = await deployer.getDeploymentMode('my-policy', 'NDCNG');

      expect(result.mode).toBe('MONITOR');
      expect(result.rulesInMonitor).toBe(2);
      expect(result.rulesInEnforce).toBe(0);
    });

    it('returns ENFORCE when rules have real actions', async () => {
      restClient.get.mockResolvedValue({
        body: {
          description: 'My enforced policy',
          rules: [
            { action: 'DROP', logged: false },
            { action: 'ALLOW', logged: false }
          ]
        }
      });

      const result = await deployer.getDeploymentMode('my-policy', 'NDCNG');

      expect(result.mode).toBe('ENFORCE');
      expect(result.rulesInEnforce).toBe(2);
      expect(result.rulesInMonitor).toBe(0);
    });

    it('returns MIXED for partial states', async () => {
      restClient.get.mockResolvedValue({
        body: {
          description: '[MONITOR] Partial policy',
          rules: [
            { action: 'ALLOW', logged: true, _monitor_mode: true },
            { action: 'DROP', logged: false }
          ]
        }
      });

      const result = await deployer.getDeploymentMode('my-policy', 'NDCNG');

      expect(result.mode).toBe('MIXED');
      expect(result.rulesInMonitor).toBe(1);
      expect(result.rulesInEnforce).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // rollback
  // ---------------------------------------------------------------------------
  describe('rollback', () => {
    it('rolls back to a previous version', async () => {
      restClient.get.mockResolvedValue({
        body: {
          results: [
            { display_name: 'policy-a', name: 'policy-a', rules: [] }
          ]
        }
      });
      restClient.patch.mockResolvedValue({ status: 200 });

      const result = await deployer.rollback('abc123', 'NDCNG');

      expect(result.success).toBe(true);
      expect(result.commitHash).toBe('abc123');
      expect(result.site).toBe('NDCNG');
      expect(restClient.get).toHaveBeenCalled();
      expect(restClient.patch).toHaveBeenCalled();
    });

    it('handles rollback failure when PATCH throws', async () => {
      restClient.get.mockResolvedValue({
        body: {
          results: [
            { display_name: 'policy-a', name: 'policy-a' }
          ]
        }
      });
      restClient.patch.mockRejectedValue(new Error('Service unavailable'));

      await expect(deployer.rollback('abc123', 'NDCNG'))
        .rejects.toThrow('[DFW-8005]');
    });
  });

  // ---------------------------------------------------------------------------
  // validatePolicyStructure
  // ---------------------------------------------------------------------------
  describe('validatePolicyStructure', () => {
    it('accepts valid structure', () => {
      const result = deployer.validatePolicyStructure(validPolicy);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects missing name', () => {
      const policy = { category: 'Application', rules: [{ name: 'r', source_groups: [], destination_groups: [], services: [], action: 'ALLOW' }] };

      const result = deployer.validatePolicyStructure(policy);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('"name"'))).toBe(true);
    });

    it('rejects empty rules', () => {
      const policy = { name: 'test', category: 'Application', rules: [] };

      const result = deployer.validatePolicyStructure(policy);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('at least one rule'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------
  describe('_parsePolicy', () => {
    it('parses a JSON string into an object', () => {
      const json = JSON.stringify(validPolicy);
      const result = PolicyDeployer._parsePolicy(json);

      expect(result.name).toBe('test-web-policy');
    });

    it('returns an object as-is', () => {
      const result = PolicyDeployer._parsePolicy(validPolicy);

      expect(result).toBe(validPolicy);
    });

    it('throws on invalid JSON', () => {
      expect(() => PolicyDeployer._parsePolicy('not-json'))
        .toThrow('[DFW-8002]');
    });
  });

  describe('_sanitizePolicyName', () => {
    it('lowercases and replaces spaces', () => {
      expect(PolicyDeployer._sanitizePolicyName('My Policy Name'))
        .toBe('my-policy-name');
    });

    it('returns unnamed-policy for empty input', () => {
      expect(PolicyDeployer._sanitizePolicyName('')).toBe('unnamed-policy');
    });
  });
});
