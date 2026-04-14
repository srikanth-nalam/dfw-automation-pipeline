'use strict';

const OrphanGroupCleaner = require('../../../src/vro/actions/groups/OrphanGroupCleaner');

describe('OrphanGroupCleaner', () => {
  let cleaner;
  let deps;

  beforeEach(() => {
    deps = {
      restClient: {
        get: jest.fn(),
        post: jest.fn(),
        patch: jest.fn(),
        delete: jest.fn().mockResolvedValue({ status: 200 })
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      },
      configLoader: {
        getEndpointsForSite: jest.fn().mockReturnValue({
          nsxUrl: 'https://nsx-ndcng.test',
          vcenterUrl: 'https://vcenter-ndcng.test'
        })
      },
      dfwValidator: {},
      ruleRegistry: {}
    };

    cleaner = new OrphanGroupCleaner(deps);
  });

  // Constructor
  test('throws when dependencies is null', () => {
    expect(() => new OrphanGroupCleaner(null)).toThrow(/DFW-8700/);
  });

  // sweep — dry run with empty groups
  test('identifies empty groups in dry run', async () => {
    // Groups: one empty, one with members
    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [
            { id: 'grp-empty', display_name: 'Empty-Group', _last_modified_time: Date.now() - (48 * 60 * 60 * 1000) },
            { id: 'grp-active', display_name: 'Active-Group', _last_modified_time: Date.now() }
          ]
        }
      })
      // grp-empty members = 0
      .mockResolvedValueOnce({ body: { results: [] } })
      // grp-empty referencing rules = none
      .mockResolvedValueOnce({ body: { results: [] } })
      // grp-active members = 2
      .mockResolvedValueOnce({ body: { results: [{ id: 'vm-1' }, { id: 'vm-2' }] } });

    const report = await cleaner.sweep('NDCNG', { dryRun: true });

    expect(report.site).toBe('NDCNG');
    expect(report.totalGroups).toBe(2);
    expect(report.emptyGroups).toBe(1);
    expect(report.orphanedGroups).toBe(1);
    expect(report.deletedGroups).toBe(0);
    expect(report.archivedDefinitions).toHaveLength(1);
    expect(report.report[0].status).toBe('DRY_RUN');
  });

  // sweep — deletes safe groups when not dry run
  test('deletes orphan groups when not dry run', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [
            { id: 'grp-orphan', display_name: 'Orphan-Group', _last_modified_time: Date.now() - (48 * 60 * 60 * 1000) }
          ]
        }
      })
      .mockResolvedValueOnce({ body: { results: [] } }) // members = 0
      .mockResolvedValueOnce({ body: { results: [] } }); // no referencing rules

    const report = await cleaner.sweep('NDCNG', { dryRun: false });

    expect(report.deletedGroups).toBe(1);
    expect(deps.restClient.delete).toHaveBeenCalled();
  });

  // sweep — skips groups with referencing rules
  test('blocks deletion when group is referenced by rules', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [
            { id: 'grp-referenced', display_name: 'Referenced-Group', _last_modified_time: Date.now() - (48 * 60 * 60 * 1000) }
          ]
        }
      })
      .mockResolvedValueOnce({ body: { results: [] } }) // members = 0
      .mockResolvedValueOnce({
        body: {
          results: [{
            id: 'policy-1',
            display_name: 'Test-Policy',
            rules: [{ id: 'rule-1', display_name: 'Rule1', source_groups: ['/infra/domains/default/groups/grp-referenced'], destination_groups: [] }]
          }]
        }
      });

    const report = await cleaner.sweep('NDCNG', { dryRun: false });

    expect(report.orphanedGroups).toBe(1);
    expect(report.deletedGroups).toBe(0);
    expect(report.skippedGroups).toBe(1);
    expect(report.report[0].status).toBe('BLOCKED');
  });

  // sweep — skips groups below minimum age
  test('skips groups below minimum age threshold', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [
            { id: 'grp-new', display_name: 'New-Empty-Group', _last_modified_time: Date.now() - (1 * 60 * 60 * 1000) }
          ]
        }
      })
      .mockResolvedValueOnce({ body: { results: [] } }); // members = 0

    const report = await cleaner.sweep('NDCNG', { dryRun: true, minAgeHours: 24 });

    expect(report.emptyGroups).toBe(1);
    expect(report.skippedGroups).toBe(1);
    expect(report.report[0].status).toBe('SKIPPED_TOO_RECENT');
  });

  // sweep — handles empty inventory
  test('handles site with no groups', async () => {
    deps.restClient.get.mockResolvedValueOnce({ body: { results: [] } });

    const report = await cleaner.sweep('NDCNG');

    expect(report.totalGroups).toBe(0);
    expect(report.emptyGroups).toBe(0);
  });

  // sweep — wraps errors with DFW-8700
  test('wraps errors with DFW-8700', async () => {
    deps.restClient.get.mockRejectedValue(new Error('NSX unreachable'));

    await expect(cleaner.sweep('NDCNG')).rejects.toThrow(/DFW-8700/);
  });

  // sweep — handles deletion failure
  test('handles deletion failure gracefully', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [
            { id: 'grp-fail', display_name: 'Fail-Group', _last_modified_time: Date.now() - (48 * 60 * 60 * 1000) }
          ]
        }
      })
      .mockResolvedValueOnce({ body: { results: [] } })
      .mockResolvedValueOnce({ body: { results: [] } });

    deps.restClient.delete.mockRejectedValue(new Error('Permission denied'));

    const report = await cleaner.sweep('NDCNG', { dryRun: false });

    expect(report.deletedGroups).toBe(0);
    expect(report.skippedGroups).toBe(1);
    expect(report.report[0].status).toBe('DELETE_FAILED');
  });

  // report structure
  test('report contains all required fields', async () => {
    deps.restClient.get.mockResolvedValueOnce({ body: { results: [] } });

    const report = await cleaner.sweep('NDCNG');

    expect(report).toHaveProperty('site');
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('totalGroups');
    expect(report).toHaveProperty('emptyGroups');
    expect(report).toHaveProperty('orphanedGroups');
    expect(report).toHaveProperty('deletedGroups');
    expect(report).toHaveProperty('skippedGroups');
    expect(report).toHaveProperty('archivedDefinitions');
    expect(report).toHaveProperty('report');
  });
});
