'use strict';

const StaleRuleReaper = require('../../../src/vro/actions/dfw/StaleRuleReaper');

describe('StaleRuleReaper', () => {
  let reaper;
  let deps;

  beforeEach(() => {
    deps = {
      restClient: {
        get: jest.fn(),
        post: jest.fn(),
        patch: jest.fn().mockResolvedValue({ status: 200 }),
        delete: jest.fn()
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
      ruleRegistry: {
        getRule: jest.fn().mockReturnValue(null)
      },
      dfwValidator: {}
    };

    reaper = new StaleRuleReaper(deps);
  });

  // Constructor
  test('throws when dependencies is null', () => {
    expect(() => new StaleRuleReaper(null)).toThrow(/DFW-8800/);
  });

  // reap — classifies stale rules with empty source groups
  test('classifies rules with empty source groups as stale', async () => {
    // Policies with rules
    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [{
            id: 'policy-1',
            display_name: 'Test-Policy',
            rules: [
              {
                id: 'rule-stale',
                display_name: 'Stale-Rule',
                disabled: false,
                source_groups: ['/infra/domains/default/groups/empty-grp'],
                destination_groups: ['ANY'],
                action: 'ALLOW'
              }
            ]
          }]
        }
      })
      // empty-grp members = 0
      .mockResolvedValueOnce({ body: { results: [] } });

    const report = await reaper.reap('NDCNG', { dryRun: true });

    expect(report.totalRules).toBe(1);
    expect(report.staleRules).toBe(1);
    expect(report.activeRules).toBe(0);
    expect(report.archivedDefinitions).toHaveLength(1);
    expect(report.archivedDefinitions[0].classification).toBe('STALE_EMPTY_SOURCE');
  });

  // reap — classifies expired rules
  test('classifies expired rules correctly', async () => {
    const pastDate = new Date(Date.now() - (90 * 24 * 60 * 60 * 1000)).toISOString();
    deps.ruleRegistry.getRule.mockReturnValue({ reviewDate: pastDate });

    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [{
            id: 'policy-1',
            rules: [{
              id: 'rule-expired',
              disabled: false,
              source_groups: ['ANY'],
              destination_groups: ['ANY']
            }]
          }]
        }
      });

    const report = await reaper.reap('NDCNG', { dryRun: true, gracePeriodDays: 30 });

    expect(report.expiredRules).toBe(1);
  });

  // reap — classifies unmanaged rules
  test('classifies unmanaged rules when includeUnmanaged is true', async () => {
    deps.ruleRegistry.getRule.mockReturnValue(null);

    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [{
            id: 'policy-1',
            rules: [{
              id: 'rule-unmanaged',
              disabled: false,
              source_groups: ['ANY'],
              destination_groups: ['ANY']
            }]
          }]
        }
      });

    const report = await reaper.reap('NDCNG', { dryRun: true, includeUnmanaged: true });

    expect(report.unmanagedRules).toBe(1);
  });

  // reap — disables stale rules when not dry run
  test('disables stale rules when not dry run', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [{
            id: 'policy-1',
            rules: [{
              id: 'rule-stale',
              disabled: false,
              source_groups: ['/infra/domains/default/groups/empty-grp'],
              destination_groups: ['ANY']
            }]
          }]
        }
      })
      .mockResolvedValueOnce({ body: { results: [] } }); // empty group

    const report = await reaper.reap('NDCNG', { dryRun: false });

    expect(report.disabledRules).toBe(1);
    expect(deps.restClient.patch).toHaveBeenCalledWith(
      expect.stringContaining('/rules/rule-stale'),
      { disabled: true }
    );
  });

  // reap — skips already disabled rules
  test('skips already disabled rules', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [{
            id: 'policy-1',
            rules: [{
              id: 'rule-disabled',
              disabled: true,
              source_groups: ['/infra/domains/default/groups/empty-grp'],
              destination_groups: ['ANY']
            }]
          }]
        }
      });

    const report = await reaper.reap('NDCNG', { dryRun: true });

    expect(report.activeRules).toBe(1);
    expect(report.staleRules).toBe(0);
  });

  // reap — handles disable failure
  test('handles rule disable failure', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [{
            id: 'policy-1',
            rules: [{
              id: 'rule-fail',
              disabled: false,
              source_groups: ['/infra/domains/default/groups/empty-grp'],
              destination_groups: ['ANY']
            }]
          }]
        }
      })
      .mockResolvedValueOnce({ body: { results: [] } });

    deps.restClient.patch.mockRejectedValue(new Error('API error'));

    const report = await reaper.reap('NDCNG', { dryRun: false });

    expect(report.disabledRules).toBe(0);
    expect(report.skippedRules).toBe(1);
  });

  // reap — wraps errors with DFW-8800
  test('wraps errors with DFW-8800', async () => {
    deps.restClient.get.mockRejectedValue(new Error('NSX unreachable'));

    await expect(reaper.reap('NDCNG')).rejects.toThrow(/DFW-8800/);
  });

  // reap — handles empty policy list
  test('handles empty policy list', async () => {
    deps.restClient.get.mockResolvedValueOnce({ body: { results: [] } });

    const report = await reaper.reap('NDCNG');

    expect(report.totalRules).toBe(0);
    expect(report.activeRules).toBe(0);
  });

  // report structure
  test('report contains all required fields', async () => {
    deps.restClient.get.mockResolvedValueOnce({ body: { results: [] } });

    const report = await reaper.reap('NDCNG');

    expect(report).toHaveProperty('site');
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('totalRules');
    expect(report).toHaveProperty('activeRules');
    expect(report).toHaveProperty('staleRules');
    expect(report).toHaveProperty('expiredRules');
    expect(report).toHaveProperty('unmanagedRules');
    expect(report).toHaveProperty('disabledRules');
    expect(report).toHaveProperty('skippedRules');
    expect(report).toHaveProperty('archivedDefinitions');
  });
});
