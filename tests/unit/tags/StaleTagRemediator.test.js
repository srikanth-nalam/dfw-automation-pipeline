'use strict';

const StaleTagRemediator = require('../../../src/vro/actions/tags/StaleTagRemediator');

describe('StaleTagRemediator', () => {
  let remediator;
  let deps;

  beforeEach(() => {
    deps = {
      restClient: {
        get: jest.fn(),
        post: jest.fn(),
        patch: jest.fn(),
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
      tagOperations: {
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        getCurrentTags: jest.fn().mockResolvedValue({}),
        removeTags: jest.fn().mockResolvedValue({ removed: true })
      },
      cmdbValidator: {
        validateQuality: jest.fn().mockResolvedValue({
          staleVMs: [
            { vmId: 'vm-1', vmName: 'NDCNG-APP001-WEB-P01', currentTags: { AppCI: 'APP001' } },
            { vmId: 'vm-2', vmName: 'NDCNG-APP002-DB-D01', currentTags: {} }
          ]
        })
      },
      snowAdapter: {
        toCallbackPayload: jest.fn()
      }
    };

    remediator = new StaleTagRemediator(deps);
  });

  // Constructor
  test('throws when dependencies is null', () => {
    expect(() => new StaleTagRemediator(null)).toThrow(/DFW-8900/);
  });

  // remediate — dry run with active CMDB records
  test('reports remediation in dry run mode', async () => {
    deps.snowAdapter.toCallbackPayload
      .mockResolvedValueOnce({ ciStatus: 'active', tags: { AppCI: 'APP001', Environment: 'Production' } })
      .mockResolvedValueOnce({ ciStatus: 'active', tags: { AppCI: 'APP002', Environment: 'Development' } });

    const report = await remediator.remediate('NDCNG', { dryRun: true });

    expect(report.totalStaleVMs).toBe(2);
    expect(report.remediatedVMs).toBe(2);
    expect(report.quarantinedVMs).toBe(0);
    expect(report.report[0].action).toBe('DRY_RUN_REMEDIATE');
  });

  // remediate — applies tags when not dry run
  test('applies corrected tags when not dry run', async () => {
    deps.snowAdapter.toCallbackPayload
      .mockResolvedValueOnce({ ciStatus: 'active', tags: { AppCI: 'APP001', Environment: 'Production' } })
      .mockResolvedValueOnce({ ciStatus: 'active', tags: { AppCI: 'APP002', Environment: 'Development' } });

    const report = await remediator.remediate('NDCNG', { dryRun: false });

    expect(report.remediatedVMs).toBe(2);
    expect(deps.tagOperations.applyTags).toHaveBeenCalledTimes(2);
  });

  // remediate — quarantines VMs without CMDB records
  test('quarantines VMs without CMDB records when quarantineOrphans is true', async () => {
    // getCITags calls return decommissioned, then quarantine calls succeed
    deps.snowAdapter.toCallbackPayload
      .mockResolvedValueOnce({ ciStatus: 'decommissioned', tags: null })
      .mockResolvedValueOnce({ status: 'quarantined' }) // quarantine call for vm-1
      .mockResolvedValueOnce({ ciStatus: 'decommissioned', tags: null })
      .mockResolvedValueOnce({ status: 'quarantined' }); // quarantine call for vm-2

    const report = await remediator.remediate('NDCNG', { dryRun: false, quarantineOrphans: true });

    expect(report.quarantinedVMs).toBe(2);
    expect(report.report[0].action).toBe('QUARANTINED');
  });

  // remediate — adds to manual review when quarantineOrphans is false
  test('adds VMs to manual review when quarantineOrphans is false', async () => {
    deps.snowAdapter.toCallbackPayload
      .mockResolvedValueOnce({ ciStatus: 'decommissioned', tags: null })
      .mockResolvedValueOnce({ ciStatus: 'decommissioned', tags: null });

    const report = await remediator.remediate('NDCNG', { dryRun: false, quarantineOrphans: false });

    expect(report.manualReviewVMs).toBe(2);
    expect(report.report[0].action).toBe('MANUAL_REVIEW');
  });

  // remediate — handles CMDB lookup failure
  test('handles CMDB lookup failure for individual VM', async () => {
    deps.snowAdapter.toCallbackPayload
      .mockRejectedValueOnce(new Error('CMDB timeout'))
      .mockResolvedValueOnce({ ciStatus: 'active', tags: { AppCI: 'APP002' } });

    const report = await remediator.remediate('NDCNG', { dryRun: false });

    expect(report.failedVMs).toBe(1);
    expect(report.remediatedVMs).toBe(1);
    expect(report.report[0].action).toBe('CMDB_LOOKUP_FAILED');
  });

  // remediate — handles tag application failure
  test('handles tag application failure', async () => {
    deps.snowAdapter.toCallbackPayload
      .mockResolvedValueOnce({ ciStatus: 'active', tags: { AppCI: 'APP001' } })
      .mockResolvedValueOnce({ ciStatus: 'active', tags: { AppCI: 'APP002' } });

    deps.tagOperations.applyTags
      .mockRejectedValueOnce(new Error('NSX error'))
      .mockResolvedValueOnce({ applied: true });

    const report = await remediator.remediate('NDCNG', { dryRun: false });

    expect(report.failedVMs).toBe(1);
    expect(report.remediatedVMs).toBe(1);
  });

  // remediate — wraps errors with DFW-8900
  test('wraps errors with DFW-8900', async () => {
    deps.cmdbValidator.validateQuality.mockRejectedValue(new Error('Validator failed'));

    await expect(remediator.remediate('NDCNG')).rejects.toThrow(/DFW-8900/);
  });

  // report structure
  test('report contains all required fields', async () => {
    deps.snowAdapter.toCallbackPayload
      .mockResolvedValueOnce({ ciStatus: 'active', tags: {} })
      .mockResolvedValueOnce({ ciStatus: 'active', tags: {} });

    const report = await remediator.remediate('NDCNG');

    expect(report).toHaveProperty('site');
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('totalStaleVMs');
    expect(report).toHaveProperty('remediatedVMs');
    expect(report).toHaveProperty('quarantinedVMs');
    expect(report).toHaveProperty('manualReviewVMs');
    expect(report).toHaveProperty('failedVMs');
    expect(report).toHaveProperty('report');
  });
});
