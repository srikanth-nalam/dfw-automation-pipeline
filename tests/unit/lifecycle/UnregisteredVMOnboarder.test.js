'use strict';

const UnregisteredVMOnboarder = require('../../../src/vro/actions/lifecycle/UnregisteredVMOnboarder');

describe('UnregisteredVMOnboarder', () => {
  let onboarder;
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
      snowAdapter: {
        toCallbackPayload: jest.fn().mockResolvedValue({ ciId: 'CI-NEW-001' })
      },
      tagOperations: {
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        getTags: jest.fn().mockResolvedValue({})
      },
      untaggedVMScanner: {
        scanWithCMDBCrossRef: jest.fn().mockResolvedValue({
          classifiedVMs: [
            { vmId: 'vm-unreg-1', vmName: 'NDCNG-APP001-WEB-P01', classification: 'UNTAGGED_UNREGISTERED', currentTags: {} },
            { vmId: 'vm-unreg-2', vmName: 'LEGACY-UNKNOWN-001', classification: 'UNTAGGED_UNREGISTERED', currentTags: {} },
            { vmId: 'vm-tagged', vmName: 'NDCNG-APP002-DB-D01', classification: 'TAGGED_UNREGISTERED', currentTags: { AppCI: 'APP002' } }
          ]
        }),
        suggestClassification: jest.fn()
      }
    };

    // High confidence suggestions for vm-unreg-1
    deps.untaggedVMScanner.suggestClassification
      .mockImplementation((vmName) => {
        if (vmName.includes('APP001-WEB-P01')) {
          return [
            { category: 'SystemRole', suggestedValue: 'Web', confidence: 'HIGH' },
            { category: 'Environment', suggestedValue: 'Production', confidence: 'HIGH' },
            { category: 'AppCI', suggestedValue: 'APP001', confidence: 'MEDIUM' }
          ];
        }
        return [
          { category: 'SystemRole', suggestedValue: 'Unknown', confidence: 'LOW' }
        ];
      });

    onboarder = new UnregisteredVMOnboarder(deps);
  });

  // Constructor
  test('throws when dependencies is null', () => {
    expect(() => new UnregisteredVMOnboarder(null)).toThrow(/DFW-9200/);
  });

  // onboard — dry run
  test('reports onboarding plan in dry run mode', async () => {
    const report = await onboarder.onboard('NDCNG', { dryRun: true });

    expect(report.totalUnregistered).toBe(2); // only UNTAGGED_UNREGISTERED
    expect(report.onboarded).toBe(1); // vm-unreg-1 with HIGH confidence
    expect(report.manualReview).toBe(1); // vm-unreg-2 with LOW confidence
    expect(report.report[0].action).toBe('DRY_RUN_ONBOARD');
  });

  // onboard — applies tags for high confidence VMs
  test('applies tags for high confidence VMs when not dry run', async () => {
    const report = await onboarder.onboard('NDCNG', { dryRun: false });

    expect(report.onboarded).toBe(1);
    expect(deps.tagOperations.applyTags).toHaveBeenCalledWith(
      'vm-unreg-1',
      expect.objectContaining({ SystemRole: 'Web', Environment: 'Production' }),
      'NDCNG'
    );
  });

  // onboard — creates CMDB CI when autoCreateCI is true
  test('creates CMDB CI when autoCreateCI is true', async () => {
    const report = await onboarder.onboard('NDCNG', { dryRun: false, autoCreateCI: true });

    expect(deps.snowAdapter.toCallbackPayload).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'createCI', vmId: 'vm-unreg-1' })
    );
  });

  // onboard — handles CI creation failure
  test('handles CMDB CI creation failure', async () => {
    deps.snowAdapter.toCallbackPayload.mockRejectedValueOnce(new Error('SNOW error'));

    const report = await onboarder.onboard('NDCNG', { dryRun: false, autoCreateCI: true });

    expect(report.failed).toBeGreaterThanOrEqual(1);
  });

  // onboard — adds low confidence VMs to manual review
  test('adds low confidence VMs to manual review', async () => {
    const report = await onboarder.onboard('NDCNG', { dryRun: false });

    expect(report.manualReview).toBe(1);
    const manualEntry = report.report.find(r => r.action === 'MANUAL_REVIEW');
    expect(manualEntry).toBeDefined();
    expect(manualEntry.vmId).toBe('vm-unreg-2');
  });

  // onboard — handles tag application failure
  test('handles tag application failure', async () => {
    deps.tagOperations.applyTags.mockRejectedValue(new Error('NSX error'));

    const report = await onboarder.onboard('NDCNG', { dryRun: false });

    expect(report.failed).toBeGreaterThanOrEqual(1);
  });

  // onboard — merges default tags
  test('merges default tags with suggestions', async () => {
    const report = await onboarder.onboard('NDCNG', {
      dryRun: false,
      defaultTags: { Region: 'DFW' }
    });

    expect(deps.tagOperations.applyTags).toHaveBeenCalledWith(
      'vm-unreg-1',
      expect.objectContaining({ Region: 'DFW', SystemRole: 'Web' }),
      'NDCNG'
    );
  });

  // onboard — wraps errors with DFW-9200
  test('wraps errors with DFW-9200', async () => {
    deps.untaggedVMScanner.scanWithCMDBCrossRef.mockRejectedValue(new Error('Scan failed'));

    await expect(onboarder.onboard('NDCNG')).rejects.toThrow(/DFW-9200/);
  });

  // report structure
  test('report contains all required fields', async () => {
    const report = await onboarder.onboard('NDCNG');

    expect(report).toHaveProperty('site');
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('totalUnregistered');
    expect(report).toHaveProperty('onboarded');
    expect(report).toHaveProperty('manualReview');
    expect(report).toHaveProperty('failed');
    expect(report).toHaveProperty('report');
  });
});
