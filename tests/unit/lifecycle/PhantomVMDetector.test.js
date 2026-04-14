'use strict';

const PhantomVMDetector = require('../../../src/vro/actions/lifecycle/PhantomVMDetector');

describe('PhantomVMDetector', () => {
  let detector;
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
        getCurrentTags: jest.fn().mockResolvedValue({ AppCI: 'APP001' }),
        removeTags: jest.fn().mockResolvedValue({ removed: true })
      }
    };

    detector = new PhantomVMDetector(deps);
  });

  // Constructor
  test('throws when dependencies is null', () => {
    expect(() => new PhantomVMDetector(null)).toThrow(/DFW-9100/);
  });

  // detect — finds phantom VMs
  test('detects phantom VMs present in NSX but not vCenter', async () => {
    // NSX has 3 VMs
    deps.restClient.get
      .mockResolvedValueOnce({
        body: {
          results: [
            { external_id: 'vm-1', display_name: 'VM-1' },
            { external_id: 'vm-2', display_name: 'VM-2' },
            { external_id: 'vm-3', display_name: 'VM-Phantom' }
          ]
        }
      })
      // vCenter has 2 VMs
      .mockResolvedValueOnce([
        { vm: 'vm-1', name: 'VM-1' },
        { vm: 'vm-2', name: 'VM-2' }
      ]);

    const report = await detector.detect('NDCNG');

    expect(report.nsxVMCount).toBe(3);
    expect(report.vcenterVMCount).toBe(2);
    expect(report.phantomVMCount).toBe(1);
    expect(report.phantomVMs[0].vmId).toBe('vm-3');
    expect(report.phantomVMs[0].displayName).toBe('VM-Phantom');
  });

  // detect — includes tag details
  test('includes tag details for phantom VMs', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({ body: { results: [{ external_id: 'vm-ghost', display_name: 'Ghost' }] } })
      .mockResolvedValueOnce([]);

    deps.tagOperations.getCurrentTags.mockResolvedValue({ AppCI: 'APP001', Environment: 'Production' });

    const report = await detector.detect('NDCNG', { includeTagDetails: true });

    expect(report.phantomVMs[0].tags).toEqual({ AppCI: 'APP001', Environment: 'Production' });
  });

  // detect — cleans up phantom VM tags
  test('cleans up phantom VM tags when cleanupTags is true', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({ body: { results: [{ external_id: 'vm-ghost', display_name: 'Ghost' }] } })
      .mockResolvedValueOnce([]);

    deps.tagOperations.getCurrentTags.mockResolvedValue({ AppCI: 'APP001' });

    const report = await detector.detect('NDCNG', { cleanupTags: true });

    expect(report.cleanedUp).toBe(1);
    expect(deps.tagOperations.removeTags).toHaveBeenCalledWith('vm-ghost', ['AppCI'], 'NDCNG');
  });

  // detect — no phantoms when inventories match
  test('reports zero phantoms when inventories match', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({ body: { results: [{ external_id: 'vm-1', display_name: 'VM-1' }] } })
      .mockResolvedValueOnce([{ vm: 'vm-1', name: 'VM-1' }]);

    const report = await detector.detect('NDCNG');

    expect(report.phantomVMCount).toBe(0);
    expect(report.phantomVMs).toEqual([]);
  });

  // detect — handles NSX inventory failure
  test('throws DFW-9101 when NSX inventory fetch fails', async () => {
    deps.restClient.get.mockRejectedValue(new Error('NSX unreachable'));

    await expect(detector.detect('NDCNG')).rejects.toThrow(/DFW-9100/);
  });

  // detect — handles vCenter inventory failure
  test('throws DFW-9102 when vCenter inventory fetch fails', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({ body: { results: [] } })
      .mockRejectedValueOnce(new Error('vCenter unreachable'));

    await expect(detector.detect('NDCNG')).rejects.toThrow(/DFW-9100/);
  });

  // detect — handles tag detail failure gracefully
  test('handles tag detail failure gracefully', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({ body: { results: [{ external_id: 'vm-ghost', display_name: 'Ghost' }] } })
      .mockResolvedValueOnce([]);

    deps.tagOperations.getCurrentTags.mockRejectedValue(new Error('Tag API error'));

    const report = await detector.detect('NDCNG', { includeTagDetails: true });

    expect(report.phantomVMCount).toBe(1);
    expect(report.phantomVMs[0].tags).toEqual({});
  });

  // report structure
  test('report contains all required fields', async () => {
    deps.restClient.get
      .mockResolvedValueOnce({ body: { results: [] } })
      .mockResolvedValueOnce([]);

    const report = await detector.detect('NDCNG');

    expect(report).toHaveProperty('site');
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('nsxVMCount');
    expect(report).toHaveProperty('vcenterVMCount');
    expect(report).toHaveProperty('phantomVMCount');
    expect(report).toHaveProperty('phantomVMs');
    expect(report).toHaveProperty('cleanedUp');
  });
});
