'use strict';

const BulkTagOrchestrator = require('../../../src/vro/actions/lifecycle/BulkTagOrchestrator');

describe('BulkTagOrchestrator', () => {
  let orchestrator;
  let deps;

  beforeEach(() => {
    deps = {
      tagOperations: {
        getTags: jest.fn().mockResolvedValue({
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'APP001',
          SystemRole: 'Web'
        }),
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        removeTags: jest.fn().mockResolvedValue({ removed: true }),
        verifyPropagation: jest.fn().mockResolvedValue({ propagated: true })
      },
      groupVerifier: {
        predictGroupChanges: jest.fn().mockReturnValue({
          vmId: 'vm-1',
          groupsToJoin: [],
          groupsToLeave: [],
          unchangedGroups: ['SG-Web-Production']
        })
      },
      dfwValidator: {
        validatePolicies: jest.fn().mockResolvedValue({ compliant: true, policies: [] })
      },
      sagaCoordinator: {
        begin: jest.fn(),
        recordStep: jest.fn()
      },
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
          vcenterUrl: 'https://vcenter-ndcng.test',
          nsxUrl: 'https://nsx-ndcng.test'
        })
      },
      snowAdapter: {
        toCallbackPayload: jest.fn().mockImplementation(r => r)
      }
    };

    orchestrator = new BulkTagOrchestrator(deps);
  });

  const buildPayload = (overrides = {}) => ({
    correlationId: 'BULK-001',
    requestType: 'bulk_tag',
    site: 'NDCNG',
    batchSize: 10,
    concurrency: 5,
    vms: [
      { vmId: 'vm-1', vmName: 'VM-001', tags: { SystemRole: 'App' } },
      { vmId: 'vm-2', vmName: 'VM-002', tags: { SystemRole: 'DB' } },
      { vmId: 'vm-3', vmName: 'VM-003', tags: { Environment: 'Staging' } }
    ],
    callbackUrl: 'https://snow.test/callback',
    dryRun: false,
    ...overrides
  });

  // Happy path
  test('processes all VMs successfully', async () => {
    const report = await orchestrator.executeBulk(buildPayload());

    expect(report.status).toBe('completed');
    expect(report.totalVMs).toBe(3);
    expect(report.successCount).toBe(3);
    expect(report.failureCount).toBe(0);
    expect(report.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(report.dryRun).toBe(false);
  });

  // Per-VM error isolation
  test('isolates per-VM errors - one failure does not block others', async () => {
    deps.tagOperations.getTags
      .mockResolvedValueOnce({ AppCI: 'APP001', SystemRole: 'Web' })
      .mockRejectedValueOnce(new Error('NSX error for vm-2'))
      .mockResolvedValueOnce({ AppCI: 'APP001', SystemRole: 'Web' });

    const report = await orchestrator.executeBulk(buildPayload());

    expect(report.status).toBe('completed_with_errors');
    expect(report.successCount).toBe(2);
    expect(report.failureCount).toBe(1);
    expect(report.failedVMs).toHaveLength(1);
    expect(report.failedVMs[0].vmId).toBe('vm-2');
  });

  // Dry run mode
  test('dry run does not apply tags', async () => {
    const report = await orchestrator.executeBulk(buildPayload({ dryRun: true }));

    expect(report.dryRun).toBe(true);
    expect(report.successCount).toBe(3);
    expect(deps.tagOperations.applyTags).not.toHaveBeenCalled();
    expect(deps.groupVerifier.predictGroupChanges).toHaveBeenCalled();
  });

  // Progress callbacks
  test('sends progress callbacks when URL provided', async () => {
    const payload = buildPayload({
      batchSize: 2,
      progressCallbackUrl: 'https://snow.test/progress'
    });

    await orchestrator.executeBulk(payload);

    const progressCalls = deps.restClient.post.mock.calls.filter(
      (call) => call[0] === 'https://snow.test/progress'
    );
    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
  });

  // Final callback
  test('sends final callback to ServiceNow', async () => {
    await orchestrator.executeBulk(buildPayload());

    expect(deps.restClient.post).toHaveBeenCalledWith(
      'https://snow.test/callback',
      expect.objectContaining({
        correlationId: 'BULK-001',
        status: 'completed'
      })
    );
  });

  // Empty VM list
  test('handles empty VM list gracefully', async () => {
    const report = await orchestrator.executeBulk(buildPayload({ vms: [] }));

    expect(report.status).toBe('completed');
    expect(report.totalVMs).toBe(0);
    expect(report.successCount).toBe(0);
  });

  // Batch size edge cases
  test('clamps batch size to valid range', async () => {
    const report = await orchestrator.executeBulk(buildPayload({ batchSize: 100 }));
    // Should not throw — batchSize is clamped to 50
    expect(report.status).toBe('completed');
  });

  // Concurrency limiting
  test('respects concurrency limit', async () => {
    const payload = buildPayload({ concurrency: 1 });
    const report = await orchestrator.executeBulk(payload);

    expect(report.status).toBe('completed');
    expect(report.totalVMs).toBe(3);
  });

  // Skipped VMs (no-op)
  test('marks VMs as skipped when already in desired state', async () => {
    deps.tagOperations.getTags.mockResolvedValue({
      AppCI: 'APP001',
      SystemRole: 'App'
    });

    const report = await orchestrator.executeBulk(buildPayload({
      vms: [{ vmId: 'vm-1', vmName: 'VM-001', tags: { SystemRole: 'App' } }]
    }));

    expect(report.skippedCount).toBe(1);
    expect(report.results[0].status).toBe('skipped');
  });

  // All VMs fail
  test('reports failed status when all VMs fail', async () => {
    deps.tagOperations.getTags.mockRejectedValue(new Error('All fail'));

    const report = await orchestrator.executeBulk(buildPayload());

    expect(report.status).toBe('failed');
    expect(report.failureCount).toBe(3);
    expect(report.successCount).toBe(0);
  });

  // Completion report structure
  test('completion report contains all required fields', async () => {
    const report = await orchestrator.executeBulk(buildPayload());

    expect(report).toHaveProperty('correlationId');
    expect(report).toHaveProperty('status');
    expect(report).toHaveProperty('totalVMs');
    expect(report).toHaveProperty('successCount');
    expect(report).toHaveProperty('failureCount');
    expect(report).toHaveProperty('skippedCount');
    expect(report).toHaveProperty('executionTimeMs');
    expect(report).toHaveProperty('averageTimePerVM');
    expect(report).toHaveProperty('results');
    expect(report).toHaveProperty('failedVMs');
    expect(report).toHaveProperty('dryRun');
  });

  // Constructor validation
  test('throws when dependencies is null', () => {
    expect(() => new BulkTagOrchestrator(null)).toThrow(/DFW-8200/);
  });

  // Progress callback failure does not break workflow
  test('continues when progress callback fails', async () => {
    deps.restClient.post.mockRejectedValueOnce(new Error('Progress callback failed'));
    // Subsequent calls succeed
    deps.restClient.post.mockResolvedValue({ status: 200 });

    const payload = buildPayload({
      batchSize: 2,
      progressCallbackUrl: 'https://snow.test/progress'
    });

    const report = await orchestrator.executeBulk(payload);
    expect(report.successCount).toBe(3);
  });

  // Average time per VM
  test('calculates average time per VM', async () => {
    const report = await orchestrator.executeBulk(buildPayload());
    expect(report.averageTimePerVM).toBeGreaterThanOrEqual(0);
    expect(typeof report.averageTimePerVM).toBe('number');
  });
});
