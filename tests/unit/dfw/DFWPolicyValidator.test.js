'use strict';

const DFWPolicyValidator = require('../../../src/vro/actions/dfw/DFWPolicyValidator');

describe('DFWPolicyValidator', () => {
  let restClient;
  let logger;
  let configLoader;
  let validator;

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
        nsxUrl: 'https://nsx-manager-NDCNG.company.internal',
        vcenterUrl: 'https://vcenter-NDCNG.company.internal',
        nsxGlobalUrl: 'https://nsx-global-NDCNG.company.internal'
      }),
      get: jest.fn().mockReturnValue(undefined)
    };

    validator = new DFWPolicyValidator(restClient, logger, configLoader);
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('throws when restClient is missing', () => {
      expect(() => new DFWPolicyValidator(null, logger))
        .toThrow('DFWPolicyValidator requires a restClient instance');
    });

    it('throws when logger is missing', () => {
      expect(() => new DFWPolicyValidator(restClient, null))
        .toThrow('DFWPolicyValidator requires a logger instance');
    });
  });

  // ---------------------------------------------------------------------------
  // validateCoverage — covered=true
  // ---------------------------------------------------------------------------
  describe('validateCoverage', () => {
    it('returns covered=true when VM has active policies', async () => {
      restClient.get.mockResolvedValue({
        body: {
          results: [
            {
              id: 'rule-1',
              display_name: 'Allow-HTTPS-Inbound',
              action: 'ALLOW',
              disabled: false,
              source_groups: ['Load-Balancer-Pools'],
              destination_groups: ['APP001_Web_Production'],
              services: ['TCP/443']
            },
            {
              id: 'rule-2',
              display_name: 'Allow-SSH-Management',
              action: 'ALLOW',
              disabled: false,
              source_groups: ['Management-Subnet'],
              destination_groups: ['APP001_Web_Production'],
              services: ['TCP/22']
            }
          ]
        }
      });

      const result = await validator.validateCoverage('vm-123', 'NDCNG');

      expect(result.covered).toBe(true);
      expect(result.policies).toHaveLength(2);
      expect(result.policies[0].display_name).toBe('Allow-HTTPS-Inbound');
    });

    it('excludes disabled rules from active policies', async () => {
      restClient.get.mockResolvedValue({
        body: {
          results: [
            {
              id: 'rule-1',
              display_name: 'Active-Rule',
              action: 'ALLOW',
              disabled: false
            },
            {
              id: 'rule-2',
              display_name: 'Disabled-Rule',
              action: 'DROP',
              disabled: true
            }
          ]
        }
      });

      const result = await validator.validateCoverage('vm-123', 'NDCNG');

      expect(result.covered).toBe(true);
      expect(result.policies).toHaveLength(1);
      expect(result.policies[0].display_name).toBe('Active-Rule');
    });

    // -------------------------------------------------------------------------
    // validateCoverage — covered=false (DFW-7006)
    // -------------------------------------------------------------------------
    it('returns covered=false and error DFW-7006 when no policies apply', async () => {
      restClient.get.mockResolvedValue({
        body: { results: [] }
      });

      const result = await validator.validateCoverage('vm-orphan', 'NDCNG');

      expect(result.covered).toBe(false);
      expect(result.policies).toEqual([]);
    });

    it('returns covered=false when all rules are disabled', async () => {
      restClient.get.mockResolvedValue({
        body: {
          results: [
            { id: 'rule-1', display_name: 'Disabled-Only', disabled: true }
          ]
        }
      });

      const result = await validator.validateCoverage('vm-123', 'NDCNG');

      expect(result.covered).toBe(false);
      expect(result.policies).toEqual([]);
    });

    it('throws DFW-7006 when API call fails', async () => {
      restClient.get.mockRejectedValue(new Error('Connection refused'));

      await expect(
        validator.validateCoverage('vm-123', 'NDCNG')
      ).rejects.toThrow(/DFW-7006/);
    });

    it('throws DFW-7006 when vmId is empty', async () => {
      await expect(
        validator.validateCoverage('', 'NDCNG')
      ).rejects.toThrow(/DFW-7006/);
    });

    it('throws DFW-7006 when site is empty', async () => {
      await expect(
        validator.validateCoverage('vm-123', '')
      ).rejects.toThrow(/DFW-7006/);
    });
  });

  // ---------------------------------------------------------------------------
  // getEffectiveRules
  // ---------------------------------------------------------------------------
  describe('getEffectiveRules', () => {
    it('returns rules from NSX API', async () => {
      const mockRules = [
        {
          id: 'rule-1',
          display_name: 'Allow-HTTPS',
          action: 'ALLOW',
          source_groups: ['ANY'],
          destination_groups: ['APP001_Web'],
          services: ['TCP/443']
        },
        {
          id: 'rule-2',
          display_name: 'Deny-All',
          action: 'DROP',
          source_groups: ['ANY'],
          destination_groups: ['ANY'],
          services: ['ANY']
        }
      ];

      restClient.get.mockResolvedValue({
        body: { results: mockRules }
      });

      const rules = await validator.getEffectiveRules('vm-123', 'NDCNG');

      expect(rules).toEqual(mockRules);
      expect(rules).toHaveLength(2);
      expect(restClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/realized-state/enforcement-points/default/virtual-machines/vm-123/rules')
      );
    });

    it('returns empty array for unexpected response structure', async () => {
      restClient.get.mockResolvedValue({
        body: { someUnexpectedField: 'foo' }
      });

      const rules = await validator.getEffectiveRules('vm-123', 'NDCNG');
      expect(rules).toEqual([]);
    });

    it('throws DFW-7006 on API error', async () => {
      restClient.get.mockRejectedValue(new Error('timeout'));

      await expect(
        validator.getEffectiveRules('vm-123', 'NDCNG')
      ).rejects.toThrow(/DFW-7006/);
    });

    it('throws DFW-7006 on non-200 status', async () => {
      restClient.get.mockResolvedValue({
        status: 500,
        body: { error: 'Internal Server Error' }
      });

      await expect(
        validator.getEffectiveRules('vm-123', 'NDCNG')
      ).rejects.toThrow(/DFW-7006/);
    });
  });

  // ---------------------------------------------------------------------------
  // checkOrphanedRules (DFW-7007)
  // ---------------------------------------------------------------------------
  describe('checkOrphanedRules', () => {
    it('detects orphaned rules when group has expressions but no members', async () => {
      // Members endpoint returns empty
      const membersResponse = { body: { results: [] } };
      // Group endpoint returns expressions
      const groupResponse = {
        body: {
          expression: [
            { member_type: 'VirtualMachine', value: 'tag|scope=Application|APP001' }
          ]
        }
      };

      restClient.get
        .mockResolvedValueOnce(membersResponse)
        .mockResolvedValueOnce(groupResponse);

      try {
        await validator.checkOrphanedRules('web-tier-group', 'NDCNG');
        // Should not reach here
        expect(true).toBe(false);
      } catch (err) {
        expect(err.message).toMatch(/DFW-7007/);
        expect(err.code).toBe('DFW-7007');
        expect(err.context.orphaned).toBe(true);
        expect(err.context.memberCount).toBe(0);
        expect(err.context.ruleCount).toBeGreaterThan(0);
      }
    });

    it('returns non-orphaned result when group has both members and expressions', async () => {
      const membersResponse = {
        body: {
          results: [
            { display_name: 'vm-001', external_id: 'vm-001' },
            { display_name: 'vm-002', external_id: 'vm-002' }
          ]
        }
      };
      const groupResponse = {
        body: {
          expression: [
            { member_type: 'VirtualMachine', value: 'tag|scope=Application|APP001' }
          ]
        }
      };

      restClient.get
        .mockResolvedValueOnce(membersResponse)
        .mockResolvedValueOnce(groupResponse);

      const result = await validator.checkOrphanedRules('web-tier-group', 'NDCNG');

      expect(result.orphaned).toBe(false);
      expect(result.memberCount).toBe(2);
      expect(result.ruleCount).toBe(1);
      expect(result.groupId).toBe('web-tier-group');
    });

    it('returns non-orphaned when group has no expressions', async () => {
      const membersResponse = { body: { results: [] } };
      const groupResponse = { body: { expression: [] } };

      restClient.get
        .mockResolvedValueOnce(membersResponse)
        .mockResolvedValueOnce(groupResponse);

      const result = await validator.checkOrphanedRules('empty-group', 'NDCNG');

      expect(result.orphaned).toBe(false);
      expect(result.ruleCount).toBe(0);
      expect(result.memberCount).toBe(0);
    });

    it('throws DFW-7006 when API call fails', async () => {
      restClient.get.mockRejectedValue(new Error('Network error'));

      await expect(
        validator.checkOrphanedRules('web-tier-group', 'NDCNG')
      ).rejects.toThrow(/DFW-7006/);
    });

    it('throws DFW-7006 when groupId is empty', async () => {
      await expect(
        validator.checkOrphanedRules('', 'NDCNG')
      ).rejects.toThrow(/DFW-7006/);
    });
  });
});
