'use strict';

const TagOperations = require('../../../src/vro/actions/tags/TagOperations');

describe('TagOperations', () => {
  let restClient;
  let logger;
  let tagOps;

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

    tagOps = new TagOperations(restClient, logger);
  });

  // ---------------------------------------------------------------------------
  // Constructor validation
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('throws when restClient is missing', () => {
      expect(() => new TagOperations(null, logger))
        .toThrow('TagOperations requires a restClient instance');
    });

    it('throws when logger is missing', () => {
      expect(() => new TagOperations(restClient, null))
        .toThrow('TagOperations requires a logger instance');
    });
  });

  // ---------------------------------------------------------------------------
  // applyTags — new VM with no existing tags
  // ---------------------------------------------------------------------------
  describe('applyTags on new VM (no existing tags)', () => {
    it('applies all tags when VM has no existing tags', async () => {
      // GET returns empty tag set
      restClient.get.mockResolvedValue({
        body: { tags: [] }
      });
      // PATCH succeeds
      restClient.patch.mockResolvedValue({ status: 200 });

      const desiredTags = {
        Region: 'NDCNG',
        SecurityZone: 'Greenzone',
        Environment: 'Production',
        AppCI: 'APP001',
        SystemRole: 'Web',
        Compliance: ['PCI'],
        DataClassification: 'Confidential'
      };

      const result = await tagOps.applyTags('vm-new-001', desiredTags, 'site-east');

      expect(result.applied).toBe(true);
      expect(result.currentTags).toEqual({});
      expect(result.finalTags).toEqual(desiredTags);

      // Verify PATCH was called with the correct NSX tag array
      expect(restClient.patch).toHaveBeenCalledTimes(1);
      const patchCall = restClient.patch.mock.calls[0];
      expect(patchCall[0]).toContain('/api/v1/fabric/virtual-machines/vm-new-001/tags');
      const patchBody = patchCall[1];
      expect(patchBody.tags).toEqual(
        expect.arrayContaining([
          { tag: 'NDCNG', scope: 'Region' },
          { tag: 'Greenzone', scope: 'SecurityZone' },
          { tag: 'Production', scope: 'Environment' },
          { tag: 'APP001', scope: 'AppCI' },
          { tag: 'Web', scope: 'SystemRole' },
          { tag: 'PCI', scope: 'Compliance' },
          { tag: 'Confidential', scope: 'DataClassification' }
        ])
      );

      // Verify delta reflects all tags as additions
      expect(result.delta.toAdd.length).toBeGreaterThan(0);
      expect(result.delta.toRemove).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // applyTags idempotency
  // ---------------------------------------------------------------------------
  describe('applyTags idempotency', () => {
    it('does not issue a PATCH when tags already match desired state', async () => {
      const existingNsxTags = [
        { tag: 'NDCNG', scope: 'Region' },
        { tag: 'Greenzone', scope: 'SecurityZone' },
        { tag: 'Production', scope: 'Environment' },
        { tag: 'APP001', scope: 'AppCI' },
        { tag: 'PCI', scope: 'Compliance' }
      ];

      // GET returns NSX tags that already match desired
      restClient.get.mockResolvedValue({
        body: { tags: existingNsxTags }
      });

      const desiredTags = {
        Region: 'NDCNG',
        SecurityZone: 'Greenzone',
        Environment: 'Production',
        AppCI: 'APP001',
        Compliance: ['PCI']
      };

      const result = await tagOps.applyTags('vm-123', desiredTags, 'site-east');

      expect(result.applied).toBe(false);
      expect(result.delta.toAdd).toEqual([]);
      expect(result.delta.toRemove).toEqual([]);
      // PATCH should NOT have been called because nothing changed
      expect(restClient.patch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // updateTags — reads current, applies delta only
  // ---------------------------------------------------------------------------
  describe('updateTags', () => {
    it('reads current tags then applies only the delta', async () => {
      // Current VM has AppCI=APP001, SystemRole=Web
      restClient.get.mockResolvedValue({
        body: {
          tags: [
            { tag: 'APP001', scope: 'AppCI' },
            { tag: 'Web', scope: 'SystemRole' }
          ]
        }
      });
      restClient.patch.mockResolvedValue({ status: 200 });

      // Update AppCI to APP002 only
      const result = await tagOps.updateTags('vm-123', { AppCI: 'APP002' }, 'site-east');

      expect(result.updated).toBe(true);
      expect(result.previousTags).toEqual({ AppCI: 'APP001', SystemRole: 'Web' });
      expect(result.currentTags.AppCI).toBe('APP002');
      expect(result.currentTags.SystemRole).toBe('Web'); // SystemRole should remain

      // Delta should show APP002 added, APP001 removed
      expect(result.delta.toAdd).toEqual(
        expect.arrayContaining([{ tag: 'APP002', scope: 'AppCI' }])
      );
      expect(result.delta.toRemove).toEqual(
        expect.arrayContaining([{ tag: 'APP001', scope: 'AppCI' }])
      );

      // PATCH should be called exactly once
      expect(restClient.patch).toHaveBeenCalledTimes(1);
    });

    it('does not PATCH when new tags match current tags', async () => {
      restClient.get.mockResolvedValue({
        body: {
          tags: [
            { tag: 'APP001', scope: 'AppCI' },
            { tag: 'Web', scope: 'SystemRole' }
          ]
        }
      });

      const result = await tagOps.updateTags('vm-123', { AppCI: 'APP001' }, 'site-east');

      expect(result.updated).toBe(false);
      expect(restClient.patch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // removeTags
  // ---------------------------------------------------------------------------
  describe('removeTags', () => {
    it('removes specified categories and PATCHes the remaining set', async () => {
      restClient.get.mockResolvedValue({
        body: {
          tags: [
            { tag: 'APP001', scope: 'AppCI' },
            { tag: 'Web', scope: 'SystemRole' },
            { tag: 'PCI', scope: 'Compliance' }
          ]
        }
      });
      restClient.patch.mockResolvedValue({ status: 200 });

      const result = await tagOps.removeTags('vm-123', ['Compliance', 'SystemRole'], 'site-east');

      expect(result.removed).toBe(true);
      expect(result.removedCategories).toEqual(expect.arrayContaining(['Compliance', 'SystemRole']));
      expect(result.finalTags).toEqual({ AppCI: 'APP001' });

      // PATCH is called with only the remaining tags
      expect(restClient.patch).toHaveBeenCalledTimes(1);
      const patchBody = restClient.patch.mock.calls[0][1];
      expect(patchBody.tags).toEqual([{ tag: 'APP001', scope: 'AppCI' }]);
    });

    it('returns removed=false when categories are not present on VM', async () => {
      restClient.get.mockResolvedValue({
        body: {
          tags: [{ tag: 'APP001', scope: 'AppCI' }]
        }
      });

      const result = await tagOps.removeTags('vm-123', ['NonExistentCategory'], 'site-east');

      expect(result.removed).toBe(false);
      expect(result.removedCategories).toEqual([]);
      expect(restClient.patch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getCurrentTags — normalization from NSX format
  // ---------------------------------------------------------------------------
  describe('getCurrentTags', () => {
    it('returns normalized tag object from NSX-format response', async () => {
      restClient.get.mockResolvedValue({
        body: {
          tags: [
            { tag: 'NDCNG', scope: 'Region' },
            { tag: 'Greenzone', scope: 'SecurityZone' },
            { tag: 'Production', scope: 'Environment' },
            { tag: 'APP001', scope: 'AppCI' },
            { tag: 'Web', scope: 'SystemRole' },
            { tag: 'PCI', scope: 'Compliance' },
            { tag: 'HIPAA', scope: 'Compliance' },
            { tag: 'Confidential', scope: 'DataClassification' },
            { tag: 'CC-001', scope: 'CostCenter' }
          ]
        }
      });

      const tags = await tagOps.getCurrentTags('vm-123', 'site-east');

      // Single-value categories should be strings
      expect(tags.Region).toBe('NDCNG');
      expect(tags.SecurityZone).toBe('Greenzone');
      expect(tags.Environment).toBe('Production');
      expect(tags.AppCI).toBe('APP001');
      expect(tags.SystemRole).toBe('Web');
      expect(tags.DataClassification).toBe('Confidential');
      expect(tags.CostCenter).toBe('CC-001');

      // Multi-value categories should be arrays
      expect(tags.Compliance).toEqual(['PCI', 'HIPAA']);
    });

    it('handles NSX response with results array instead of tags array', async () => {
      restClient.get.mockResolvedValue({
        body: {
          results: [
            { tag: 'APP001', scope: 'AppCI' }
          ]
        }
      });

      const tags = await tagOps.getCurrentTags('vm-123', 'site-east');
      expect(tags.AppCI).toBe('APP001');
    });

    it('returns empty object when VM has no tags', async () => {
      restClient.get.mockResolvedValue({
        body: { tags: [] }
      });

      const tags = await tagOps.getCurrentTags('vm-123', 'site-east');
      expect(tags).toEqual({});
    });

    it('skips entries without a scope', async () => {
      restClient.get.mockResolvedValue({
        body: {
          tags: [
            { tag: 'APP001', scope: 'AppCI' },
            { tag: 'orphan-value', scope: '' },
            { tag: 'no-scope-value' }
          ]
        }
      });

      const tags = await tagOps.getCurrentTags('vm-123', 'site-east');
      expect(Object.keys(tags)).toEqual(['AppCI']);
    });

    it('deduplicates multi-value Compliance tags', async () => {
      restClient.get.mockResolvedValue({
        body: {
          tags: [
            { tag: 'PCI', scope: 'Compliance' },
            { tag: 'PCI', scope: 'Compliance' },
            { tag: 'HIPAA', scope: 'Compliance' }
          ]
        }
      });

      const tags = await tagOps.getCurrentTags('vm-123', 'site-east');
      expect(tags.Compliance).toEqual(['PCI', 'HIPAA']);
    });
  });

  // ---------------------------------------------------------------------------
  // applyTags — validation failure
  // ---------------------------------------------------------------------------
  describe('applyTags validation', () => {
    it('throws when tag combination is invalid (PCI + Sandbox)', async () => {
      restClient.get.mockResolvedValue({ body: { tags: [] } });

      await expect(
        tagOps.applyTags('vm-123', {
          Compliance: ['PCI'],
          Environment: 'Sandbox'
        }, 'site-east')
      ).rejects.toThrow('Tag validation failed');
    });
  });
});
