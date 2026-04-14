'use strict';

const Day2Orchestrator = require('../../../src/vro/actions/lifecycle/Day2Orchestrator');
const LifecycleOrchestrator = require('../../../src/vro/actions/lifecycle/LifecycleOrchestrator');

// Stub out _sleep to avoid real delays in tests
beforeAll(() => {
  jest.spyOn(Day2Orchestrator, '_sleep').mockResolvedValue(undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('Day2Orchestrator', () => {
  let orchestrator;
  let deps;

  beforeEach(() => {
    deps = {
      configLoader: {
        getEndpointsForSite: jest.fn().mockReturnValue({
          vcenterUrl: 'https://vcenter-ndcng.test',
          nsxUrl: 'https://nsx-ndcng.test',
          nsxGlobalUrl: 'https://nsx-global.test'
        })
      },
      restClient: {
        get: jest.fn().mockResolvedValue({ results: [] }),
        post: jest.fn().mockResolvedValue({ status: 200 }),
        patch: jest.fn().mockResolvedValue({ status: 200 }),
        delete: jest.fn().mockResolvedValue({ status: 200 })
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        withCorrelation: jest.fn().mockReturnThis()
      },
      payloadValidator: {
        validate: jest.fn().mockReturnValue({ valid: true, errors: [] })
      },
      sagaCoordinator: {
        begin: jest.fn(),
        recordStep: jest.fn(),
        compensate: jest.fn().mockResolvedValue({ compensated: 1, failed: 0, errors: [] }),
        getJournal: jest.fn().mockReturnValue([]),
        isActive: jest.fn().mockReturnValue(false)
      },
      deadLetterQueue: {
        enqueue: jest.fn().mockReturnValue('DLQ-day2-001')
      },
      tagOperations: {
        getTags: jest.fn().mockResolvedValue({
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'APP001',
          SystemRole: 'Web',
          Compliance: ['PCI']
        }),
        updateTags: jest.fn().mockResolvedValue({ updated: true }),
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        removeTags: jest.fn().mockResolvedValue({ removed: true }),
        verifyPropagation: jest.fn().mockResolvedValue({ propagated: true })
      },
      groupVerifier: {
        verifyMembership: jest.fn().mockResolvedValue({
          verified: true,
          groups: ['APP002_Web_Production', 'All-Production-VMs']
        }),
        predictGroupChanges: jest.fn().mockResolvedValue({
          groupsToJoin: ['APP002_Web_Production'],
          groupsToLeave: ['APP001_Web_Production'],
          unchangedGroups: ['All-Production-VMs']
        })
      },
      dfwValidator: {
        validatePolicies: jest.fn().mockResolvedValue({
          compliant: true,
          policies: [{ policyName: 'APP002-Application-Policy' }]
        }),
        getEffectiveRules: jest.fn().mockResolvedValue([])
      },
      snowAdapter: {
        toCallbackPayload: jest.fn().mockImplementation(r => r),
        toErrorCallback: jest.fn().mockImplementation(e => e)
      }
    };

    orchestrator = new Day2Orchestrator(deps);
  });

  const validPayload = {
    correlationId: 'RITM-2345-1700000000',
    requestType: 'Day2',
    vmId: 'vm-123',
    vmName: 'NDCNG-APP001-WEB-P01',
    site: 'NDCNG',
    tags: {
      Region: 'NDCNG',
      SecurityZone: 'Greenzone',
      Environment: 'Production',
      AppCI: 'APP002',
      SystemRole: 'Web',
      Compliance: ['HIPAA']
    },
    expectedCurrentTags: {
      Region: 'NDCNG',
      SecurityZone: 'Greenzone',
      Environment: 'Production',
      AppCI: 'APP001',
      SystemRole: 'Web',
      Compliance: ['PCI']
    },
    callbackUrl: 'https://snow.test/callback',
    callbackToken: 'test-token'
  };

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------
  describe('happy path', () => {
    test('tag update succeeds with propagation and verification', async () => {
      const result = await orchestrator.run(validPayload);

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.correlationId).toBe('RITM-2345-1700000000');
      expect(result.requestType).toBe('Day2');

      // Verify all key steps were called
      expect(deps.payloadValidator.validate).toHaveBeenCalledWith(validPayload);
      expect(deps.configLoader.getEndpointsForSite).toHaveBeenCalledWith('NDCNG');
      expect(deps.sagaCoordinator.begin).toHaveBeenCalledWith('RITM-2345-1700000000');

      // Verify current tags fetched
      expect(deps.tagOperations.getTags).toHaveBeenCalledWith('vm-123', 'NDCNG');

      // Verify impact analysis ran
      expect(deps.groupVerifier.predictGroupChanges).toHaveBeenCalled();

      // Verify tag deltas applied
      expect(deps.tagOperations.updateTags).toHaveBeenCalledWith(
        'vm-123',
        validPayload.tags,
        'NDCNG'
      );

      // Verify propagation waited
      expect(deps.tagOperations.verifyPropagation).toHaveBeenCalled();

      // Verify group membership checked
      expect(deps.groupVerifier.verifyMembership).toHaveBeenCalledWith('vm-123', 'NDCNG');

      // Verify DFW validated
      expect(deps.dfwValidator.validatePolicies).toHaveBeenCalledWith('vm-123', 'NDCNG');
    });

    test('execution result contains previous and desired tags', async () => {
      const result = await orchestrator.run(validPayload);

      expect(result.execution).toBeDefined();
      expect(result.execution.previousTags).toEqual({
        Region: 'NDCNG',
        SecurityZone: 'Greenzone',
        Environment: 'Production',
        AppCI: 'APP001',
        SystemRole: 'Web',
        Compliance: ['PCI']
      });
      expect(result.execution.desiredTags).toEqual(validPayload.tags);
      expect(result.execution.appliedDeltas).toBeDefined();
      expect(result.execution.propagation.propagated).toBe(true);
    });

    test('sends success callback to ServiceNow', async () => {
      await orchestrator.run(validPayload);

      expect(deps.restClient.post).toHaveBeenCalledWith(
        'https://snow.test/callback',
        expect.objectContaining({
          correlationId: 'RITM-2345-1700000000',
          status: 'completed'
        })
      );
    });

    test('records applyTagDeltas in saga for rollback', async () => {
      await orchestrator.run(validPayload);

      expect(deps.sagaCoordinator.recordStep).toHaveBeenCalledWith(
        'applyTagDeltas',
        expect.any(Function)
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Impact analysis
  // ---------------------------------------------------------------------------
  describe('impact analysis', () => {
    test('returns predicted group changes from tag update', async () => {
      const result = await orchestrator.run(validPayload);

      expect(result.execution.impactAnalysis).toBeDefined();
      expect(result.execution.impactAnalysis.groupsToJoin).toEqual(['APP002_Web_Production']);
      expect(result.execution.impactAnalysis.groupsToLeave).toEqual(['APP001_Web_Production']);
      expect(result.execution.impactAnalysis.unchangedGroups).toEqual(['All-Production-VMs']);

      expect(deps.groupVerifier.predictGroupChanges).toHaveBeenCalledWith(
        expect.objectContaining({ AppCI: 'APP001' }),
        validPayload.tags
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Drift detection
  // ---------------------------------------------------------------------------
  describe('drift detection', () => {
    test('warns when current tags do not match expected', async () => {
      // Return tags that differ from expectedCurrentTags
      deps.tagOperations.getTags.mockResolvedValue({
        Region: 'NDCNG',
        SecurityZone: 'Greenzone',
        Environment: 'Production',
        AppCI: 'APP_WRONG',
        SystemRole: 'Web',
        Compliance: ['PCI']
      });

      const result = await orchestrator.run(validPayload);

      expect(result.success).toBe(true);
      // Drift detection should have logged a warning
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Tag drift detected'),
        expect.objectContaining({
          vmId: 'vm-123',
          driftCount: expect.any(Number)
        })
      );
    });

    test('no drift warning when actual tags match expected', async () => {
      // Return tags that exactly match expectedCurrentTags
      deps.tagOperations.getTags.mockResolvedValue({
        Region: 'NDCNG',
        SecurityZone: 'Greenzone',
        Environment: 'Production',
        AppCI: 'APP001',
        SystemRole: 'Web',
        Compliance: ['PCI']
      });

      await orchestrator.run(validPayload);

      // Should not log drift warning
      const driftWarnings = deps.logger.warn.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('Tag drift detected')
      );
      expect(driftWarnings).toHaveLength(0);
    });

    test('detects drift when CMDB has categories not on VM', async () => {
      // Return tags missing a category that expectedCurrentTags has
      deps.tagOperations.getTags.mockResolvedValue({
        AppCI: 'APP001',
        SystemRole: 'Web'
        // Missing Region, SecurityZone, Environment, and Compliance
      });

      await orchestrator.run(validPayload);

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Tag drift detected'),
        expect.objectContaining({
          driftCount: expect.any(Number)
        })
      );
    });

    test('skips drift detection when expectedCurrentTags not provided', async () => {
      const payloadWithoutExpected = { ...validPayload };
      delete payloadWithoutExpected.expectedCurrentTags;

      await orchestrator.run(payloadWithoutExpected);

      // Drift detection should not have logged warning
      const driftWarnings = deps.logger.warn.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('Tag drift detected')
      );
      expect(driftWarnings).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Failure and rollback
  // ---------------------------------------------------------------------------
  describe('failure and rollback', () => {
    test('tag update failure triggers saga rollback to previous tags', async () => {
      deps.tagOperations.updateTags.mockRejectedValue(new Error('NSX API error'));
      deps.sagaCoordinator.isActive.mockReturnValue(true);

      const result = await orchestrator.run(validPayload);

      expect(result.success).toBe(false);
      expect(result.error.message).toContain('NSX API error');
      expect(deps.sagaCoordinator.compensate).toHaveBeenCalled();
    });

    test('propagation failure triggers saga rollback', async () => {
      deps.tagOperations.verifyPropagation.mockRejectedValue(
        new Error('Propagation check failed')
      );
      deps.sagaCoordinator.isActive.mockReturnValue(true);

      const result = await orchestrator.run(validPayload);

      expect(result.success).toBe(false);
      expect(deps.sagaCoordinator.compensate).toHaveBeenCalled();
    });

    test('DFW validation failure produces error result', async () => {
      deps.dfwValidator.validatePolicies.mockRejectedValue(
        new Error('DFW policy check failed')
      );
      deps.sagaCoordinator.isActive.mockReturnValue(true);

      const result = await orchestrator.run(validPayload);

      expect(result.success).toBe(false);
      expect(result.error.message).toContain('DFW policy check failed');
    });

    test('failed workflow enqueues to dead letter queue', async () => {
      deps.tagOperations.updateTags.mockRejectedValue(new Error('NSX error'));
      deps.sagaCoordinator.isActive.mockReturnValue(true);

      const result = await orchestrator.run(validPayload);

      expect(deps.deadLetterQueue.enqueue).toHaveBeenCalledWith(
        validPayload,
        expect.any(Error),
        'RITM-2345-1700000000'
      );
      expect(result.dlqId).toBe('DLQ-day2-001');
    });
  });

  // ---------------------------------------------------------------------------
  // Sub-step: getCurrentTags
  // ---------------------------------------------------------------------------
  describe('getCurrentTags', () => {
    test('reads tags from tagOperations', async () => {
      const tags = await orchestrator.getCurrentTags('vm-123', 'NDCNG');

      expect(tags).toEqual({
        Region: 'NDCNG',
        SecurityZone: 'Greenzone',
        Environment: 'Production',
        AppCI: 'APP001',
        SystemRole: 'Web',
        Compliance: ['PCI']
      });
      expect(deps.tagOperations.getTags).toHaveBeenCalledWith('vm-123', 'NDCNG');
    });
  });

  // ---------------------------------------------------------------------------
  // Sub-step: runImpactAnalysis
  // ---------------------------------------------------------------------------
  describe('runImpactAnalysis', () => {
    test('predicts group membership changes', async () => {
      const currentTags = { AppCI: 'APP001', SystemRole: 'Web' };
      const newTags = { AppCI: 'APP002', SystemRole: 'Web' };

      const result = await orchestrator.runImpactAnalysis(currentTags, newTags);

      expect(result.groupsToJoin).toEqual(['APP002_Web_Production']);
      expect(result.groupsToLeave).toEqual(['APP001_Web_Production']);
      expect(result.unchangedGroups).toEqual(['All-Production-VMs']);
      expect(deps.groupVerifier.predictGroupChanges).toHaveBeenCalledWith(
        currentTags,
        newTags
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Sub-step: applyTagDeltas
  // ---------------------------------------------------------------------------
  describe('applyTagDeltas', () => {
    test('applies tag updates via tagOperations', async () => {
      const newTags = { AppCI: 'APP002' };
      const result = await orchestrator.applyTagDeltas('vm-123', newTags, 'NDCNG');

      expect(result.vmId).toBe('vm-123');
      expect(result.updatedTags).toEqual(newTags);
      expect(result.changeCount).toBe(1);
      expect(deps.tagOperations.updateTags).toHaveBeenCalledWith('vm-123', newTags, 'NDCNG');
    });
  });

  // ---------------------------------------------------------------------------
  // Factory method
  // ---------------------------------------------------------------------------
  test('factory method creates correct orchestrator type', () => {
    const day2 = LifecycleOrchestrator.create('Day2', deps);
    expect(day2).toBeInstanceOf(Day2Orchestrator);
  });
});
