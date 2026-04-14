'use strict';

const UntaggedVMScanner = require('../../../src/vro/actions/tags/UntaggedVMScanner');

describe('UntaggedVMScanner', () => {
  let scanner;
  let deps;

  beforeEach(() => {
    deps = {
      restClient: {
        get: jest.fn().mockResolvedValue([
          { vm: 'vm-1', name: 'NDCNG-APP001-WEB-P01' },
          { vm: 'vm-2', name: 'NDCNG-APP002-DB-D01' },
          { vm: 'vm-3', name: 'LEGACY-UNKNOWN-001' }
        ])
      },
      tagOperations: {
        getTags: jest.fn()
          .mockResolvedValueOnce({ Region: 'NDCNG', SecurityZone: 'Greenzone', Environment: 'Production', AppCI: 'APP001', SystemRole: 'Web' })
          .mockResolvedValueOnce({ AppCI: 'APP002' })
          .mockResolvedValueOnce({})
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      },
      configLoader: {
        getEndpointsForSite: jest.fn().mockReturnValue({
          vcenterUrl: 'https://vcenter-ndcng.test'
        })
      }
    };

    scanner = new UntaggedVMScanner(deps);
  });

  // Constructor
  test('throws when dependencies is null', () => {
    expect(() => new UntaggedVMScanner(null)).toThrow(/DFW-8600/);
  });

  // Full scan
  test('classifies VMs by tag coverage', async () => {
    const report = await scanner.scanForUntaggedVMs('NDCNG');

    expect(report.totalVMs).toBe(3);
    expect(report.fullyTagged).toBe(1);
    expect(report.partiallyTagged).toBe(1);
    expect(report.untagged).toBe(1);
  });

  // Coverage percent
  test('calculates coverage percentage', async () => {
    const report = await scanner.scanForUntaggedVMs('NDCNG');

    expect(report.coveragePercent).toBe(33); // 1 of 3
  });

  // Suggestions for partially tagged
  test('generates suggestions for partially tagged VMs', async () => {
    const report = await scanner.scanForUntaggedVMs('NDCNG');

    const partialVM = report.untaggedVMs.find(vm => vm.vmId === 'vm-2');
    expect(partialVM).toBeDefined();
    expect(partialVM.missingCategories).toContain('SystemRole');
    expect(partialVM.missingCategories).toContain('Environment');
    expect(partialVM.suggestions.length).toBeGreaterThan(0);
  });

  // Name pattern matching
  test('suggests SystemRole based on VM name patterns', () => {
    const suggestions = scanner.suggestClassification('NDCNG-APP001-WEB-P01', {});

    const roleSuggestion = suggestions.find(s => s.category === 'SystemRole');
    expect(roleSuggestion).toBeDefined();
    expect(roleSuggestion.suggestedValue).toBe('Web');
  });

  test('suggests Environment based on VM name patterns', () => {
    const suggestions = scanner.suggestClassification('NDCNG-APP001-WEB-P01', {});

    const envSuggestion = suggestions.find(s => s.category === 'Environment');
    expect(envSuggestion).toBeDefined();
    expect(envSuggestion.suggestedValue).toBe('Production');
  });

  test('extracts AppCI code from VM name', () => {
    const suggestions = scanner.suggestClassification('NDCNG-APP001-WEB-P01', {});

    const appSuggestion = suggestions.find(s => s.category === 'AppCI');
    expect(appSuggestion).toBeDefined();
    expect(appSuggestion.suggestedValue).toBe('APP001');
  });

  // Confidence levels
  test('upgrades confidence when multiple heuristics match', () => {
    const suggestions = scanner.suggestClassification('NDCNG-APP001-WEB-P01', {});

    const highConfidence = suggestions.filter(s => s.confidence === 'HIGH');
    expect(highConfidence.length).toBeGreaterThan(0);
  });

  // Empty inventory
  test('handles empty VM inventory', async () => {
    deps.restClient.get.mockResolvedValue([]);

    const report = await scanner.scanForUntaggedVMs('NDCNG');

    expect(report.totalVMs).toBe(0);
    expect(report.coveragePercent).toBe(100);
  });

  // Tag retrieval failure
  test('handles tag retrieval failure for individual VM', async () => {
    deps.tagOperations.getTags = jest.fn()
      .mockResolvedValueOnce({ Region: 'NDCNG', SecurityZone: 'Greenzone', Environment: 'Production', AppCI: 'APP001', SystemRole: 'Web' })
      .mockRejectedValueOnce(new Error('NSX error'))
      .mockResolvedValueOnce({});

    const report = await scanner.scanForUntaggedVMs('NDCNG');

    // Failed VM should be treated as untagged
    expect(report.totalVMs).toBe(3);
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  // Report structure
  test('report contains all required fields', async () => {
    const report = await scanner.scanForUntaggedVMs('NDCNG');

    expect(report).toHaveProperty('totalVMs');
    expect(report).toHaveProperty('fullyTagged');
    expect(report).toHaveProperty('partiallyTagged');
    expect(report).toHaveProperty('untagged');
    expect(report).toHaveProperty('coveragePercent');
    expect(report).toHaveProperty('untaggedVMs');
  });
});
