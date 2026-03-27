'use strict';

const ImpactAnalysisAction = require('../../../src/vro/actions/lifecycle/ImpactAnalysisAction');

describe('ImpactAnalysisAction', () => {
  let action;
  let deps;

  beforeEach(() => {
    deps = {
      tagOperations: {
        getTags: jest.fn().mockResolvedValue({
          Application: 'APP001',
          Tier: 'Web',
          Environment: 'Development',
          Compliance: ['None'],
          DataClassification: 'Internal'
        })
      },
      groupVerifier: {
        predictGroupChanges: jest.fn().mockReturnValue({
          vmId: 'vm-123',
          groupsToJoin: ['SG-Web-Production'],
          groupsToLeave: ['SG-Web-Staging'],
          unchangedGroups: []
        })
      },
      dfwValidator: {
        validatePolicies: jest.fn().mockResolvedValue({
          compliant: true,
          policies: [{ policyName: 'APP001-Policy' }]
        })
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      }
    };

    action = new ImpactAnalysisAction(deps);
  });

  // Constructor validation
  test('throws when tagOperations is missing', () => {
    expect(() => new ImpactAnalysisAction({ logger: deps.logger, groupVerifier: deps.groupVerifier, dfwValidator: deps.dfwValidator }))
      .toThrow(/DFW-8001/);
  });

  test('throws when groupVerifier is missing', () => {
    expect(() => new ImpactAnalysisAction({ tagOperations: deps.tagOperations, logger: deps.logger, dfwValidator: deps.dfwValidator }))
      .toThrow(/DFW-8002/);
  });

  test('throws when dfwValidator is missing', () => {
    expect(() => new ImpactAnalysisAction({ tagOperations: deps.tagOperations, groupVerifier: deps.groupVerifier, logger: deps.logger }))
      .toThrow(/DFW-8003/);
  });

  test('throws when logger is missing', () => {
    expect(() => new ImpactAnalysisAction({ tagOperations: deps.tagOperations, groupVerifier: deps.groupVerifier, dfwValidator: deps.dfwValidator }))
      .toThrow(/DFW-8004/);
  });

  // Happy path
  test('returns complete impact analysis result', async () => {
    const result = await action.analyze({
      vmId: 'vm-123',
      site: 'NDCNG',
      proposedTags: { Environment: 'Production' }
    });

    expect(result.vmId).toBe('vm-123');
    expect(result.site).toBe('NDCNG');
    expect(result.currentTags).toBeDefined();
    expect(result.proposedTags).toEqual({ Environment: 'Production' });
    expect(result.tagDelta).toBeDefined();
    expect(result.groupChanges).toBeDefined();
    expect(result.groupChanges.joining).toEqual(['SG-Web-Production']);
    expect(result.groupChanges.leaving).toEqual(['SG-Web-Staging']);
    expect(result.riskLevel).toBeDefined();
    expect(result.riskReasons).toBeDefined();
    expect(result.analysisTimestamp).toBeDefined();
  });

  // Risk assessment
  test('assigns HIGH risk for Production environment changes', async () => {
    const result = await action.analyze({
      vmId: 'vm-123',
      site: 'NDCNG',
      proposedTags: { Environment: 'Production' }
    });

    expect(result.riskLevel).toBe('HIGH');
    expect(result.requiresSecurityArchitectApproval).toBe(true);
  });

  test('assigns MEDIUM risk for compliance changes', async () => {
    deps.groupVerifier.predictGroupChanges.mockReturnValue({
      vmId: 'vm-123',
      groupsToJoin: ['SG-PCI-Compliance'],
      groupsToLeave: [],
      unchangedGroups: []
    });

    const result = await action.analyze({
      vmId: 'vm-123',
      site: 'NDCNG',
      proposedTags: { Compliance: ['PCI'] }
    });

    expect(result.riskLevel).toBe('MEDIUM');
    expect(result.requiresSecurityArchitectApproval).toBe(false);
  });

  test('assigns LOW risk for non-impactful changes', async () => {
    deps.tagOperations.getTags.mockResolvedValue({
      Application: 'APP001',
      Tier: 'Web',
      Environment: 'Development',
      Compliance: ['None'],
      DataClassification: 'Internal'
    });
    deps.groupVerifier.predictGroupChanges.mockReturnValue({
      vmId: 'vm-123',
      groupsToJoin: [],
      groupsToLeave: [],
      unchangedGroups: ['SG-Web-Staging']
    });

    const result = await action.analyze({
      vmId: 'vm-123',
      site: 'NDCNG',
      proposedTags: { Application: 'APP002' }
    });

    expect(result.riskLevel).toBe('LOW');
    expect(result.requiresSecurityArchitectApproval).toBe(false);
  });

  // Tag delta computation
  test('correctly identifies added, changed, and unchanged tags', async () => {
    deps.tagOperations.getTags.mockResolvedValue({
      Application: 'APP001',
      Tier: 'Web'
    });
    deps.groupVerifier.predictGroupChanges.mockReturnValue({
      vmId: 'vm-123',
      groupsToJoin: [],
      groupsToLeave: [],
      unchangedGroups: []
    });

    const result = await action.analyze({
      vmId: 'vm-123',
      site: 'NDCNG',
      proposedTags: { Application: 'APP001', Tier: 'App', Environment: 'Production' }
    });

    expect(result.tagDelta.unchanged).toHaveProperty('Application');
    expect(result.tagDelta.changed).toHaveProperty('Tier');
    expect(result.tagDelta.added).toHaveProperty('Environment');
  });

  // Error handling
  test('rethrows when tag retrieval fails', async () => {
    deps.tagOperations.getTags.mockRejectedValue(new Error('NSX API unreachable'));

    await expect(action.analyze({
      vmId: 'vm-123',
      site: 'NDCNG',
      proposedTags: { Tier: 'App' }
    })).rejects.toThrow('NSX API unreachable');

    expect(deps.logger.error).toHaveBeenCalled();
  });

  // DFW rule fallback
  test('returns empty rules when DFW query fails', async () => {
    deps.dfwValidator.validatePolicies.mockRejectedValue(new Error('DFW error'));
    deps.groupVerifier.predictGroupChanges.mockReturnValue({
      vmId: 'vm-123',
      groupsToJoin: ['SG-Web-Production'],
      groupsToLeave: [],
      unchangedGroups: []
    });

    const result = await action.analyze({
      vmId: 'vm-123',
      site: 'NDCNG',
      proposedTags: { Tier: 'Web' }
    });

    expect(result.affectedDFWRules).toEqual([]);
  });

  // No group changes means empty rules
  test('returns empty rules when no group changes predicted', async () => {
    deps.groupVerifier.predictGroupChanges.mockReturnValue({
      vmId: 'vm-123',
      groupsToJoin: [],
      groupsToLeave: [],
      unchangedGroups: ['SG-Web-Staging']
    });

    const result = await action.analyze({
      vmId: 'vm-123',
      site: 'NDCNG',
      proposedTags: { Application: 'APP002' }
    });

    expect(result.affectedDFWRules).toEqual([]);
    // validatePolicies should not be called when no groups change
    expect(deps.dfwValidator.validatePolicies).not.toHaveBeenCalled();
  });
});
