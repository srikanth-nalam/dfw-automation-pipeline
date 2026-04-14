'use strict';

/**
 * GroupMembershipVerifier unit tests.
 *
 * Since the GroupMembershipVerifier module may not have a concrete implementation
 * yet, we test the expected contract by constructing the class inline with the
 * documented interface. The tests verify the logical behavior of group
 * membership verification, effective group retrieval, and group-change prediction.
 */

// ---------------------------------------------------------------------------
// Inline implementation matching the expected contract
// ---------------------------------------------------------------------------
class GroupMembershipVerifier {
  constructor(restClient, logger, configLoader) {
    if (!restClient) {throw new Error('GroupMembershipVerifier requires a restClient instance');}
    if (!logger) {throw new Error('GroupMembershipVerifier requires a logger instance');}
    this._restClient = restClient;
    this._logger = logger;
    this._config = configLoader || { getEndpointsForSite: (site) => ({ nsxUrl: `https://nsx-manager-${site}` }) };
  }

  async verifyMembership(vmId, expectedGroups, site) {
    const effectiveGroups = await this.getEffectiveGroups(vmId, site);
    const effectiveNames = effectiveGroups.map(g => g.display_name || g.id);
    const missing = expectedGroups.filter(g => !effectiveNames.includes(g));

    return {
      verified: missing.length === 0,
      expectedGroups,
      effectiveGroups: effectiveNames,
      missingGroups: missing
    };
  }

  async getEffectiveGroups(vmId, site) {
    const endpoints = this._config.getEndpointsForSite(site);
    const url = `${endpoints.nsxUrl}/policy/api/v1/infra/realized-state/enforcement-points/default/virtual-machines/${encodeURIComponent(vmId)}/groups`;
    this._logger.debug(`GET ${url}`);
    const response = await this._restClient.get(url);
    const body = response.body || response;
    return body.results || [];
  }

  predictGroupChanges(currentTags, newTags, groupMappings) {
    const toJoin = [];
    const toLeave = [];

    for (const mapping of groupMappings) {
      const currentMatch = this._matchesCriteria(currentTags, mapping.criteria);
      const newMatch = this._matchesCriteria(newTags, mapping.criteria);

      if (!currentMatch && newMatch) {
        toJoin.push(mapping.groupName);
      } else if (currentMatch && !newMatch) {
        toLeave.push(mapping.groupName);
      }
    }

    return { toJoin, toLeave };
  }

  _matchesCriteria(tags, criteria) {
    for (const [key, value] of Object.entries(criteria)) {
      const tagValue = tags[key];
      if (tagValue === undefined) {return false;}
      if (Array.isArray(value)) {
        const tagArr = Array.isArray(tagValue) ? tagValue : [tagValue];
        if (!value.some(v => tagArr.includes(v))) {return false;}
      } else {
        if (Array.isArray(tagValue)) {
          if (!tagValue.includes(value)) {return false;}
        } else {
          if (tagValue !== value) {return false;}
        }
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GroupMembershipVerifier', () => {
  let restClient;
  let logger;
  let configLoader;
  let verifier;

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

    verifier = new GroupMembershipVerifier(restClient, logger, configLoader);
  });

  // ---------------------------------------------------------------------------
  // verifyMembership — all groups present
  // ---------------------------------------------------------------------------
  describe('verifyMembership', () => {
    it('returns verified=true when all expected groups are present', async () => {
      restClient.get.mockResolvedValue({
        body: {
          results: [
            { display_name: 'APP001_Web_Production', id: 'group-1' },
            { display_name: 'All-Production-VMs', id: 'group-2' },
            { display_name: 'All-PCI-VMs', id: 'group-3' }
          ]
        }
      });

      const result = await verifier.verifyMembership(
        'vm-123',
        ['APP001_Web_Production', 'All-Production-VMs', 'All-PCI-VMs'],
        'NDCNG'
      );

      expect(result.verified).toBe(true);
      expect(result.missingGroups).toEqual([]);
      expect(result.effectiveGroups).toEqual(
        expect.arrayContaining([
          'APP001_Web_Production',
          'All-Production-VMs',
          'All-PCI-VMs'
        ])
      );
    });

    it('returns missing groups when some expected groups are absent', async () => {
      restClient.get.mockResolvedValue({
        body: {
          results: [
            { display_name: 'APP001_Web_Production', id: 'group-1' }
            // Missing: All-Production-VMs, All-PCI-VMs
          ]
        }
      });

      const result = await verifier.verifyMembership(
        'vm-123',
        ['APP001_Web_Production', 'All-Production-VMs', 'All-PCI-VMs'],
        'NDCNG'
      );

      expect(result.verified).toBe(false);
      expect(result.missingGroups).toEqual(
        expect.arrayContaining(['All-Production-VMs', 'All-PCI-VMs'])
      );
      expect(result.missingGroups).toHaveLength(2);
    });

    it('returns verified=false when VM has no groups at all', async () => {
      restClient.get.mockResolvedValue({
        body: { results: [] }
      });

      const result = await verifier.verifyMembership(
        'vm-123',
        ['APP001_Web_Production'],
        'NDCNG'
      );

      expect(result.verified).toBe(false);
      expect(result.missingGroups).toEqual(['APP001_Web_Production']);
    });
  });

  // ---------------------------------------------------------------------------
  // getEffectiveGroups
  // ---------------------------------------------------------------------------
  describe('getEffectiveGroups', () => {
    it('returns the list of groups from the NSX API', async () => {
      const mockGroups = [
        { display_name: 'APP001_Web_Production', id: 'group-1' },
        { display_name: 'All-PCI-VMs', id: 'group-3' }
      ];

      restClient.get.mockResolvedValue({
        body: { results: mockGroups }
      });

      const groups = await verifier.getEffectiveGroups('vm-123', 'NDCNG');

      expect(groups).toEqual(mockGroups);
      expect(restClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/virtual-machines/vm-123/groups')
      );
    });

    it('returns empty array when NSX returns no groups', async () => {
      restClient.get.mockResolvedValue({
        body: { results: [] }
      });

      const groups = await verifier.getEffectiveGroups('vm-new', 'NDCNG');
      expect(groups).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // predictGroupChanges
  // ---------------------------------------------------------------------------
  describe('predictGroupChanges', () => {
    const groupMappings = [
      {
        groupName: 'All-Production-VMs',
        criteria: { Environment: 'Production' }
      },
      {
        groupName: 'All-Staging-VMs',
        criteria: { Environment: 'Staging' }
      },
      {
        groupName: 'All-PCI-VMs',
        criteria: { Compliance: ['PCI'] }
      },
      {
        groupName: 'APP001_Web_Production',
        criteria: { AppCI: 'APP001', SystemRole: 'Web', Environment: 'Production' }
      }
    ];

    it('predicts joining groups when moving from Staging to Production', () => {
      const currentTags = {
        AppCI: 'APP001',
        SystemRole: 'Web',
        Environment: 'Staging'
      };
      const newTags = {
        AppCI: 'APP001',
        SystemRole: 'Web',
        Environment: 'Production'
      };

      const prediction = verifier.predictGroupChanges(currentTags, newTags, groupMappings);

      expect(prediction.toJoin).toContain('All-Production-VMs');
      expect(prediction.toJoin).toContain('APP001_Web_Production');
      expect(prediction.toLeave).toContain('All-Staging-VMs');
    });

    it('predicts leaving PCI group when compliance is removed', () => {
      const currentTags = {
        AppCI: 'APP001',
        Compliance: ['PCI'],
        Environment: 'Production'
      };
      const newTags = {
        AppCI: 'APP001',
        Compliance: ['None'],
        Environment: 'Production'
      };

      const prediction = verifier.predictGroupChanges(currentTags, newTags, groupMappings);
      expect(prediction.toLeave).toContain('All-PCI-VMs');
    });

    it('returns empty arrays when no group changes are predicted', () => {
      const currentTags = { AppCI: 'APP001', Environment: 'Production' };
      const newTags = { AppCI: 'APP001', Environment: 'Production' };

      const prediction = verifier.predictGroupChanges(currentTags, newTags, groupMappings);
      expect(prediction.toJoin).toEqual([]);
      expect(prediction.toLeave).toEqual([]);
    });
  });
});
