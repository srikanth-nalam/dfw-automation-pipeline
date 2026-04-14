'use strict';

const CMDBValidator = require('../../../src/vro/actions/cmdb/CMDBValidator');

describe('CMDBValidator', () => {
  let validator;
  let deps;

  const buildVM = (overrides = {}) => ({
    sys_id: 'vm-001',
    name: 'NDCNG-WEB-001',
    u_region: 'NDCNG',
    u_security_zone: 'Greenzone',
    u_environment: 'Production',
    u_app_ci: 'APP001',
    u_system_role: 'Web',
    u_compliance: 'PCI',
    u_data_classification: 'Confidential',
    u_cost_center: 'CC-1234',
    owned_by: 'john.doe',
    sys_updated_on: '2026-01-15T10:00:00Z',
    ...overrides
  });

  const buildFullyTaggedVM = (id, name) => buildVM({
    sys_id: id,
    name
  });

  const buildPartialVM = (id, name) => buildVM({
    sys_id: id,
    name,
    u_security_zone: null,
    u_system_role: null
  });

  const buildUntaggedVM = (id, name) => ({
    sys_id: id,
    name,
    u_region: null,
    u_security_zone: null,
    u_environment: null,
    u_app_ci: null,
    u_system_role: null,
    owned_by: 'jane.doe',
    sys_updated_on: '2026-01-10T08:00:00Z'
  });

  beforeEach(() => {
    deps = {
      restClient: {
        get: jest.fn().mockResolvedValue({
          result: [
            buildFullyTaggedVM('vm-001', 'NDCNG-WEB-001'),
            buildPartialVM('vm-002', 'NDCNG-APP-002'),
            buildUntaggedVM('vm-003', 'LEGACY-UNKNOWN-003')
          ]
        }),
        post: jest.fn().mockResolvedValue({ result: { sys_id: 'task-001' } })
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      },
      configLoader: {
        getEndpointsForSite: jest.fn().mockReturnValue({
          snowUrl: 'https://snow.test',
          vcenterUrl: 'https://vcenter.test',
          nsxUrl: 'https://nsx.test'
        })
      }
    };

    validator = new CMDBValidator(deps);
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    test('throws DFW-9001 when dependencies is null', () => {
      expect(() => new CMDBValidator(null)).toThrow(/DFW-9001/);
    });

    test('throws DFW-9001 when restClient is missing', () => {
      expect(() => new CMDBValidator({ logger: deps.logger, configLoader: deps.configLoader }))
        .toThrow(/DFW-9001/);
    });

    test('throws DFW-9001 when logger is missing', () => {
      expect(() => new CMDBValidator({ restClient: deps.restClient, configLoader: deps.configLoader }))
        .toThrow(/DFW-9001/);
    });

    test('throws DFW-9001 when configLoader is missing', () => {
      expect(() => new CMDBValidator({ restClient: deps.restClient, logger: deps.logger }))
        .toThrow(/DFW-9001/);
    });

    test('creates instance with valid dependencies', () => {
      expect(() => new CMDBValidator(deps)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // extractVMInventory
  // ---------------------------------------------------------------------------
  describe('extractVMInventory', () => {
    test('returns normalised inventory for a site', async () => {
      const inventory = await validator.extractVMInventory('NDCNG');

      expect(inventory.totalVMs).toBe(3);
      expect(inventory.vms).toHaveLength(3);
      expect(inventory.vms[0].vmId).toBe('vm-001');
      expect(inventory.vms[0].vmName).toBe('NDCNG-WEB-001');
      expect(inventory.vms[0].region).toBe('NDCNG');
    });

    test('applies operational_status filter to query', async () => {
      await validator.extractVMInventory('NDCNG', { operational_status: 1 });

      const url = deps.restClient.get.mock.calls[0][0];
      expect(url).toContain('operational_status=1');
    });

    test('throws DFW-9002 when site is empty', async () => {
      await expect(validator.extractVMInventory('')).rejects.toThrow(/DFW-9002/);
    });

    test('throws DFW-9002 when site is not a string', async () => {
      await expect(validator.extractVMInventory(123)).rejects.toThrow(/DFW-9002/);
    });

    test('throws DFW-9002 when REST call fails', async () => {
      deps.restClient.get.mockRejectedValue(new Error('Connection refused'));

      await expect(validator.extractVMInventory('NDCNG')).rejects.toThrow(/DFW-9002/);
    });

    test('handles array response format', async () => {
      deps.restClient.get.mockResolvedValue([
        buildFullyTaggedVM('vm-010', 'VM-010')
      ]);

      const inventory = await validator.extractVMInventory('NDCNG');
      expect(inventory.totalVMs).toBe(1);
    });

    test('handles empty response', async () => {
      deps.restClient.get.mockResolvedValue({ result: [] });

      const inventory = await validator.extractVMInventory('NDCNG');
      expect(inventory.totalVMs).toBe(0);
      expect(inventory.vms).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // validateCoverage
  // ---------------------------------------------------------------------------
  describe('validateCoverage', () => {
    test('classifies fully tagged VMs correctly', async () => {
      const inventory = {
        totalVMs: 1,
        vms: [{
          vmId: 'vm-001', vmName: 'VM-001',
          region: 'NDCNG', securityZone: 'Greenzone', environment: 'Production',
          appCI: 'APP001', systemRole: 'Web'
        }]
      };

      const result = await validator.validateCoverage(inventory);

      expect(result.fullyPopulated).toBe(1);
      expect(result.partiallyPopulated).toBe(0);
      expect(result.unpopulated).toBe(0);
    });

    test('classifies partially tagged VMs correctly', async () => {
      const inventory = {
        totalVMs: 1,
        vms: [{
          vmId: 'vm-002', vmName: 'VM-002',
          region: 'NDCNG', securityZone: null, environment: 'Production',
          appCI: 'APP002', systemRole: null
        }]
      };

      const result = await validator.validateCoverage(inventory);

      expect(result.fullyPopulated).toBe(0);
      expect(result.partiallyPopulated).toBe(1);
      expect(result.vmsMissingFields).toHaveLength(1);
      expect(result.vmsMissingFields[0].missingFields).toContain('securityZone');
      expect(result.vmsMissingFields[0].missingFields).toContain('systemRole');
    });

    test('classifies completely untagged VMs correctly', async () => {
      const inventory = {
        totalVMs: 1,
        vms: [{
          vmId: 'vm-003', vmName: 'VM-003',
          region: null, securityZone: null, environment: null,
          appCI: null, systemRole: null
        }]
      };

      const result = await validator.validateCoverage(inventory);

      expect(result.unpopulated).toBe(1);
      expect(result.vmsMissingFields[0].missingFields).toHaveLength(5);
    });

    test('calculates per-field coverage percentages', async () => {
      const inventory = {
        totalVMs: 2,
        vms: [
          {
            vmId: 'vm-001', vmName: 'VM-001',
            region: 'NDCNG', securityZone: 'Greenzone', environment: 'Production',
            appCI: 'APP001', systemRole: 'Web'
          },
          {
            vmId: 'vm-002', vmName: 'VM-002',
            region: 'TULNG', securityZone: null, environment: null,
            appCI: 'APP002', systemRole: null
          }
        ]
      };

      const result = await validator.validateCoverage(inventory);

      expect(result.coverageByField.region.populated).toBe(2);
      expect(result.coverageByField.region.percent).toBe(100);
      expect(result.coverageByField.securityZone.populated).toBe(1);
      expect(result.coverageByField.securityZone.percent).toBe(50);
    });

    test('throws DFW-9003 when inventory is null', async () => {
      await expect(validator.validateCoverage(null)).rejects.toThrow(/DFW-9003/);
    });

    test('throws DFW-9003 when inventory.vms is not an array', async () => {
      await expect(validator.validateCoverage({ vms: 'invalid' })).rejects.toThrow(/DFW-9003/);
    });

    test('handles empty VM list with 100% coverage', async () => {
      const result = await validator.validateCoverage({ totalVMs: 0, vms: [] });

      expect(result.totalVMs).toBe(0);
      expect(result.fullyPopulated).toBe(0);
      expect(result.coverageByField.region.percent).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // validateQuality
  // ---------------------------------------------------------------------------
  describe('validateQuality', () => {
    test('validates correct tag values as valid', async () => {
      const inventory = {
        vms: [{
          vmId: 'vm-001', vmName: 'VM-001',
          region: 'NDCNG', securityZone: 'DMZ', environment: 'UAT',
          systemRole: 'Database'
        }]
      };

      const result = await validator.validateQuality(inventory);

      expect(result.validValues).toBe(4);
      expect(result.invalidValues).toBe(0);
      expect(result.invalidEntries).toEqual([]);
    });

    test('flags invalid region value', async () => {
      const inventory = {
        vms: [{
          vmId: 'vm-001', vmName: 'VM-001',
          region: 'INVALID_REGION', securityZone: 'Greenzone',
          environment: 'Production', systemRole: 'Web'
        }]
      };

      const result = await validator.validateQuality(inventory);

      expect(result.invalidValues).toBe(1);
      expect(result.invalidEntries[0].field).toBe('region');
      expect(result.invalidEntries[0].value).toBe('INVALID_REGION');
    });

    test('flags invalid security zone value', async () => {
      const inventory = {
        vms: [{
          vmId: 'vm-001', vmName: 'VM-001',
          region: 'NDCNG', securityZone: 'InvalidZone',
          environment: 'Production', systemRole: 'Web'
        }]
      };

      const result = await validator.validateQuality(inventory);

      expect(result.invalidValues).toBe(1);
      expect(result.invalidEntries[0].field).toBe('securityZone');
    });

    test('flags invalid environment value', async () => {
      const inventory = {
        vms: [{
          vmId: 'vm-001', vmName: 'VM-001',
          region: 'NDCNG', securityZone: 'Greenzone',
          environment: 'Testing', systemRole: 'Web'
        }]
      };

      const result = await validator.validateQuality(inventory);

      expect(result.invalidValues).toBe(1);
      expect(result.invalidEntries[0].field).toBe('environment');
    });

    test('flags invalid systemRole value', async () => {
      const inventory = {
        vms: [{
          vmId: 'vm-001', vmName: 'VM-001',
          region: 'NDCNG', securityZone: 'Greenzone',
          environment: 'Production', systemRole: 'InvalidRole'
        }]
      };

      const result = await validator.validateQuality(inventory);

      expect(result.invalidValues).toBe(1);
      expect(result.invalidEntries[0].field).toBe('systemRole');
    });

    test('skips null and empty values', async () => {
      const inventory = {
        vms: [{
          vmId: 'vm-001', vmName: 'VM-001',
          region: null, securityZone: '', environment: undefined,
          systemRole: 'Web'
        }]
      };

      const result = await validator.validateQuality(inventory);

      expect(result.totalChecked).toBe(1);
      expect(result.validValues).toBe(1);
    });

    test('throws DFW-9004 when inventory is null', async () => {
      await expect(validator.validateQuality(null)).rejects.toThrow(/DFW-9004/);
    });

    test('handles multiple invalid values across VMs', async () => {
      const inventory = {
        vms: [
          { vmId: 'vm-001', vmName: 'VM-001', region: 'BADSITE', systemRole: 'BadRole' },
          { vmId: 'vm-002', vmName: 'VM-002', environment: 'BadEnv' }
        ]
      };

      const result = await validator.validateQuality(inventory);

      expect(result.invalidValues).toBe(3);
      expect(result.invalidEntries).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // generateGapReport
  // ---------------------------------------------------------------------------
  describe('generateGapReport', () => {
    test('generates complete gap report for a site', async () => {
      const report = await validator.generateGapReport('NDCNG');

      expect(report.site).toBe('NDCNG');
      expect(report.timestamp).toBeDefined();
      expect(report.summary).toBeDefined();
      expect(report.summary.totalVMs).toBe(3);
      expect(report.summary.readyForNSX).toBeDefined();
      expect(report.summary.needsRemediation).toBeDefined();
      expect(report.coverageMetrics).toBeDefined();
      expect(report.qualityMetrics).toBeDefined();
      expect(report.topGaps).toBeDefined();
      expect(report.recommendations).toBeDefined();
    });

    test('throws DFW-9005 when site is empty', async () => {
      await expect(validator.generateGapReport('')).rejects.toThrow(/DFW-9005/);
    });

    test('throws DFW-9005 when inventory extraction fails', async () => {
      deps.restClient.get.mockRejectedValue(new Error('Network error'));

      await expect(validator.generateGapReport('NDCNG')).rejects.toThrow(/DFW-9005/);
    });

    test('counts NSX-ready VMs correctly', async () => {
      // Only fully tagged VMs with valid values should be counted as ready
      deps.restClient.get.mockResolvedValue({
        result: [
          buildFullyTaggedVM('vm-001', 'VM-001'),
          buildFullyTaggedVM('vm-002', 'VM-002')
        ]
      });

      const report = await validator.generateGapReport('NDCNG');

      expect(report.summary.readyForNSX).toBe(2);
      expect(report.summary.needsRemediation).toBe(0);
    });

    test('includes recommendations for low coverage fields', async () => {
      deps.restClient.get.mockResolvedValue({
        result: [
          buildUntaggedVM('vm-001', 'VM-001'),
          buildUntaggedVM('vm-002', 'VM-002'),
          buildUntaggedVM('vm-003', 'VM-003')
        ]
      });

      const report = await validator.generateGapReport('NDCNG');

      expect(report.recommendations.length).toBeGreaterThan(0);
      expect(report.recommendations.some((r) => r.includes('Critical'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // generateRemediationTasks
  // ---------------------------------------------------------------------------
  describe('generateRemediationTasks', () => {
    test('creates tasks grouped by owner', async () => {
      const gapReport = {
        site: 'NDCNG',
        coverageMetrics: {
          vmsMissingFields: [
            { vmId: 'vm-001', vmName: 'VM-001', owner: 'john.doe', missingFields: ['region'] },
            { vmId: 'vm-002', vmName: 'VM-002', owner: 'john.doe', missingFields: ['securityZone'] },
            { vmId: 'vm-003', vmName: 'VM-003', owner: 'jane.doe', missingFields: ['environment'] }
          ]
        }
      };

      const result = await validator.generateRemediationTasks(gapReport);

      expect(result.tasksCreated).toBe(2);
      expect(result.tasksByOwner).toHaveLength(2);
    });

    test('returns zero tasks when no VMs need remediation', async () => {
      const gapReport = {
        site: 'NDCNG',
        coverageMetrics: {
          vmsMissingFields: []
        }
      };

      const result = await validator.generateRemediationTasks(gapReport);

      expect(result.tasksCreated).toBe(0);
      expect(result.tasksByOwner).toEqual([]);
    });

    test('throws DFW-9006 when gap report is invalid', async () => {
      await expect(validator.generateRemediationTasks(null)).rejects.toThrow(/DFW-9006/);
    });

    test('throws DFW-9006 when REST post fails', async () => {
      deps.restClient.post.mockRejectedValue(new Error('Service unavailable'));

      const gapReport = {
        site: 'NDCNG',
        coverageMetrics: {
          vmsMissingFields: [
            { vmId: 'vm-001', vmName: 'VM-001', owner: 'john.doe', missingFields: ['region'] }
          ]
        }
      };

      await expect(validator.generateRemediationTasks(gapReport)).rejects.toThrow(/DFW-9006/);
    });

    test('assigns higher priority when VM count exceeds 10', async () => {
      const vmList = [];
      for (let i = 0; i < 12; i++) {
        vmList.push({
          vmId: `vm-${String(i).padStart(3, '0')}`,
          vmName: `VM-${i}`,
          owner: 'bulk.owner',
          missingFields: ['region']
        });
      }

      const gapReport = {
        site: 'NDCNG',
        coverageMetrics: { vmsMissingFields: vmList }
      };

      await validator.generateRemediationTasks(gapReport);

      const payload = deps.restClient.post.mock.calls[0][1];
      expect(payload.priority).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // getMetrics
  // ---------------------------------------------------------------------------
  describe('getMetrics', () => {
    test('calculates all KPI metrics', () => {
      const gapReport = {
        summary: { totalVMs: 100, readyForNSX: 80, needsRemediation: 20 },
        coverageMetrics: { fullyPopulated: 85 },
        qualityMetrics: { totalChecked: 400, validValues: 380 }
      };

      const metrics = validator.getMetrics(gapReport);

      expect(metrics.overallReadiness).toBe(80);
      expect(metrics.coverageScore).toBe(85);
      expect(metrics.qualityScore).toBe(95);
      expect(metrics.estimatedRemediationDays).toBe(1);
    });

    test('returns 100% for empty inventory', () => {
      const gapReport = {
        summary: { totalVMs: 0, readyForNSX: 0, needsRemediation: 0 },
        coverageMetrics: { fullyPopulated: 0 },
        qualityMetrics: { totalChecked: 0, validValues: 0 }
      };

      const metrics = validator.getMetrics(gapReport);

      expect(metrics.overallReadiness).toBe(100);
      expect(metrics.coverageScore).toBe(100);
      expect(metrics.qualityScore).toBe(100);
      expect(metrics.estimatedRemediationDays).toBe(0);
    });

    test('throws DFW-9005 when gap report is invalid', () => {
      expect(() => validator.getMetrics(null)).toThrow(/DFW-9005/);
      expect(() => validator.getMetrics({})).toThrow(/DFW-9005/);
      expect(() => validator.getMetrics({ summary: {} })).toThrow(/DFW-9005/);
    });

    test('calculates estimated remediation days correctly', () => {
      const gapReport = {
        summary: { totalVMs: 500, readyForNSX: 250, needsRemediation: 250 },
        coverageMetrics: { fullyPopulated: 300 },
        qualityMetrics: { totalChecked: 2000, validValues: 1800 }
      };

      const metrics = validator.getMetrics(gapReport);

      // 250 VMs / 50 per day = 5 days
      expect(metrics.estimatedRemediationDays).toBe(5);
    });
  });
});
