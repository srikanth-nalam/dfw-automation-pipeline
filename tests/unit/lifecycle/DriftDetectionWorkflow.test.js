'use strict';

const DriftDetectionWorkflow = require('../../../src/vro/actions/lifecycle/DriftDetectionWorkflow');

describe('DriftDetectionWorkflow', () => {
  let workflow;
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
        applyTags: jest.fn().mockResolvedValue({ applied: true })
      },
      groupVerifier: {
        verifyMembership: jest.fn().mockResolvedValue({ verified: true, groups: [] })
      },
      groupReconciler: {
        reconcile: jest.fn().mockResolvedValue({ discrepancies: [] })
      },
      restClient: {
        get: jest.fn().mockResolvedValue([
          { vm: 'vm-1', name: 'VM-001' },
          { vm: 'vm-2', name: 'VM-002' }
        ]),
        post: jest.fn().mockResolvedValue({ status: 200 })
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      },
      configLoader: {
        getEndpointsForSite: jest.fn().mockReturnValue({
          vcenterUrl: 'https://vcenter-ndcng.test',
          nsxUrl: 'https://nsx-ndcng.test'
        })
      },
      snowAdapter: {
        getExpectedTags: jest.fn().mockResolvedValue({
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'APP001',
          SystemRole: 'Web'
        }),
        createIncident: jest.fn().mockResolvedValue({ incidentId: 'INC001' })
      }
    };

    workflow = new DriftDetectionWorkflow(deps);
  });

  const buildPayload = (overrides = {}) => ({
    correlationId: 'DRIFT-001',
    site: 'NDCNG',
    scope: 'full',
    autoRemediate: false,
    callbackUrl: 'https://snow.test/callback',
    ...overrides
  });

  // Constructor
  test('throws when dependencies is null', () => {
    expect(() => new DriftDetectionWorkflow(null)).toThrow(/DFW-8300/);
  });

  // Happy path - no drift
  test('reports zero drift when all VMs match CMDB', async () => {
    const report = await workflow.runDriftScan(buildPayload());

    expect(report.totalVMsScanned).toBe(2);
    expect(report.driftedVMCount).toBe(0);
    expect(report.remediatedCount).toBe(0);
  });

  // Drift detected
  test('detects drift when actual tags differ from expected', async () => {
    deps.tagOperations.getTags.mockResolvedValue({
      Region: 'NDCNG',
      SecurityZone: 'Greenzone',
      Environment: 'Development',  // Drifted from Production
      AppCI: 'APP001',
      SystemRole: 'Web'
    });

    const report = await workflow.runDriftScan(buildPayload());

    expect(report.driftedVMCount).toBe(2);
    expect(report.driftDetails).toHaveLength(2);
    expect(report.driftDetails[0].driftedCategories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'Environment' })
      ])
    );
  });

  // Auto-remediation
  test('auto-remediates when enabled', async () => {
    deps.tagOperations.getTags.mockResolvedValue({
      Region: 'NDCNG',
      SecurityZone: 'Greenzone',
      Environment: 'Development',
      AppCI: 'APP001',
      SystemRole: 'Web'
    });

    const report = await workflow.runDriftScan(buildPayload({ autoRemediate: true }));

    expect(report.remediatedCount).toBe(2);
    expect(report.unresolvedCount).toBe(0);
    expect(deps.tagOperations.applyTags).toHaveBeenCalled();
  });

  // Auto-remediation failure
  test('records error when remediation fails', async () => {
    deps.tagOperations.getTags.mockResolvedValue({
      Region: 'NDCNG',
      SecurityZone: 'Greenzone',
      Environment: 'Production',
      AppCI: 'WRONG',
      SystemRole: 'Web'
    });
    deps.tagOperations.applyTags.mockRejectedValue(new Error('NSX error'));

    const report = await workflow.runDriftScan(buildPayload({ autoRemediate: true }));

    expect(report.driftedVMCount).toBe(2);
    expect(report.unresolvedCount).toBe(2);
    expect(report.driftDetails[0].error).toContain('NSX error');
  });

  // Targeted scan
  test('targeted scan only processes specified VMs', async () => {
    const report = await workflow.runDriftScan(buildPayload({
      scope: 'targeted',
      targetVmIds: ['vm-specific-1']
    }));

    expect(report.totalVMsScanned).toBe(1);
  });

  // Callback to ServiceNow
  test('sends callback with drift report', async () => {
    await workflow.runDriftScan(buildPayload());

    expect(deps.restClient.post).toHaveBeenCalledWith(
      'https://snow.test/callback',
      expect.objectContaining({
        correlationId: 'DRIFT-001',
        site: 'NDCNG'
      })
    );
  });

  // Incident creation for unresolved drift
  test('creates incidents for unresolved drift', async () => {
    deps.tagOperations.getTags.mockResolvedValue({
      Region: 'NDCNG',
      SecurityZone: 'Greenzone',
      Environment: 'Production',
      AppCI: 'WRONG',
      SystemRole: 'Web'
    });

    await workflow.runDriftScan(buildPayload({ autoRemediate: false }));

    expect(deps.snowAdapter.createIncident).toHaveBeenCalled();
  });

  // VM scan error isolation
  test('continues scanning when individual VM fails', async () => {
    deps.tagOperations.getTags
      .mockRejectedValueOnce(new Error('VM unreachable'))
      .mockResolvedValueOnce({
        Region: 'NDCNG',
        SecurityZone: 'Greenzone',
        Environment: 'Production',
        AppCI: 'APP001',
        SystemRole: 'Web'
      });

    const report = await workflow.runDriftScan(buildPayload());

    expect(report.totalVMsScanned).toBe(2);
    // First VM fails but drift is still recorded
    expect(report.driftedVMCount).toBeGreaterThanOrEqual(1);
  });

  // Group discrepancies
  test('records group discrepancies for drifted VMs', async () => {
    deps.tagOperations.getTags.mockResolvedValue({
      Region: 'NDCNG',
      SecurityZone: 'Greenzone',
      Environment: 'Production',
      AppCI: 'WRONG',
      SystemRole: 'Web'
    });
    deps.groupReconciler.reconcile.mockResolvedValue({
      discrepancies: [{ group: 'SG-Web-Production', action: 'add' }]
    });

    const report = await workflow.runDriftScan(buildPayload());

    expect(report.groupDiscrepancies.length).toBeGreaterThan(0);
  });

  // Full scan fetches from vCenter
  test('full scan fetches VM list from vCenter API', async () => {
    await workflow.runDriftScan(buildPayload());

    expect(deps.restClient.get).toHaveBeenCalledWith(
      'https://vcenter-ndcng.test/api/vcenter/vm'
    );
  });

  // Report structure
  test('drift report contains all required fields', async () => {
    const report = await workflow.runDriftScan(buildPayload());

    expect(report).toHaveProperty('correlationId');
    expect(report).toHaveProperty('scanTimestamp');
    expect(report).toHaveProperty('site');
    expect(report).toHaveProperty('totalVMsScanned');
    expect(report).toHaveProperty('driftedVMCount');
    expect(report).toHaveProperty('remediatedCount');
    expect(report).toHaveProperty('unresolvedCount');
    expect(report).toHaveProperty('driftDetails');
    expect(report).toHaveProperty('groupDiscrepancies');
  });
});
