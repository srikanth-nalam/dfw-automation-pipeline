'use strict';

const Day0Orchestrator = require('../../../src/vro/actions/lifecycle/Day0Orchestrator');
const LifecycleOrchestrator = require('../../../src/vro/actions/lifecycle/LifecycleOrchestrator');

// Stub out _sleep to avoid real delays in tests
beforeAll(() => {
  jest.spyOn(Day0Orchestrator, '_sleep').mockResolvedValue(undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('Day0Orchestrator', () => {
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
        get: jest.fn().mockResolvedValue({ run_state: 'RUNNING' }),
        post: jest.fn().mockResolvedValue({ vmId: 'vm-123' }),
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
        compensate: jest.fn().mockResolvedValue({ compensated: 0, failed: 0, errors: [] }),
        getJournal: jest.fn().mockReturnValue([]),
        isActive: jest.fn().mockReturnValue(false)
      },
      deadLetterQueue: {
        enqueue: jest.fn().mockReturnValue('DLQ-test-123')
      },
      tagOperations: {
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        getCurrentTags: jest.fn().mockResolvedValue({}),
        removeTags: jest.fn().mockResolvedValue({ removed: true }),
        verifyPropagation: jest.fn().mockResolvedValue({ propagated: true })
      },
      tagPropagationVerifier: {
        verifyPropagation: jest.fn().mockResolvedValue({ synced: true, duration: 5000 })
      },
      groupVerifier: {
        verifyMembership: jest.fn().mockResolvedValue({
          verified: true,
          groups: ['APP001_Web_Production', 'All-Production-VMs']
        }),
        getEffectiveGroups: jest.fn().mockResolvedValue(['APP001_Web_Production'])
      },
      dfwValidator: {
        validatePolicies: jest.fn().mockResolvedValue({
          compliant: true,
          policies: [{ policyName: 'APP001-Application-Policy' }]
        }),
        validateCoverage: jest.fn().mockResolvedValue({
          covered: true,
          policies: [{ policyName: 'APP001-Application-Policy' }]
        }),
        getEffectiveRules: jest.fn().mockResolvedValue([])
      },
      snowAdapter: {
        toCallbackPayload: jest.fn().mockImplementation(r => r),
        toErrorCallback: jest.fn().mockImplementation(e => e)
      }
    };

    orchestrator = new Day0Orchestrator(deps);
  });

  const validPayload = {
    correlationId: 'RITM-1234-1700000000',
    requestType: 'Day0',
    vmName: 'NDCNG-APP001-WEB-P01',
    vmSpec: {
      cpu: 4,
      memoryGb: 16,
      diskGb: 80,
      network: 'VLAN-PROD-WEB-172.20.10.0'
    },
    site: 'NDCNG',
    tags: {
      Application: 'APP001',
      Tier: 'Web',
      Environment: 'Production',
      Compliance: ['PCI'],
      DataClassification: 'Confidential',
      CostCenter: 'CC-IT-INFRA-001'
    },
    callbackUrl: 'https://snow.test/callback',
    callbackToken: 'test-token'
  };

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------
  test('happy path - all steps succeed and returns success result', async () => {
    const result = await orchestrator.run(validPayload);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.correlationId).toBe('RITM-1234-1700000000');
    expect(result.requestType).toBe('Day0');

    // Verify validate was called
    expect(deps.payloadValidator.validate).toHaveBeenCalledWith(validPayload);

    // Verify endpoints resolved for site
    expect(deps.configLoader.getEndpointsForSite).toHaveBeenCalledWith('NDCNG');

    // Verify VM provisioned via restClient.post
    expect(deps.restClient.post).toHaveBeenCalledWith(
      'https://vcenter-ndcng.test/api/vcenter/vm',
      expect.objectContaining({ name: 'NDCNG-APP001-WEB-P01' })
    );

    // Verify tags applied
    expect(deps.tagOperations.applyTags).toHaveBeenCalledWith(
      'vm-123',
      validPayload.tags,
      'NDCNG'
    );

    // Verify propagation waited
    expect(deps.tagOperations.verifyPropagation).toHaveBeenCalled();

    // Verify group membership checked (verify() uses payload.vmId || payload.vmName)
    expect(deps.groupVerifier.verifyMembership).toHaveBeenCalledWith('NDCNG-APP001-WEB-P01', 'NDCNG');

    // Verify DFW validated (verify() uses payload.vmId || payload.vmName)
    expect(deps.dfwValidator.validatePolicies).toHaveBeenCalledWith('NDCNG-APP001-WEB-P01', 'NDCNG');

    // Verify saga was started
    expect(deps.sagaCoordinator.begin).toHaveBeenCalledWith('RITM-1234-1700000000');

    // Verify saga steps were recorded for provisionVM and applyTags
    expect(deps.sagaCoordinator.recordStep).toHaveBeenCalledWith(
      'provisionVM',
      expect.any(Function)
    );
    expect(deps.sagaCoordinator.recordStep).toHaveBeenCalledWith(
      'applyTags',
      expect.any(Function)
    );
  });

  test('success result contains execution and verification data', async () => {
    const result = await orchestrator.run(validPayload);

    // Execution result should have VM info
    expect(result.execution).toBeDefined();
    expect(result.execution.vmId).toBe('vm-123');
    expect(result.execution.vmName).toBe('NDCNG-APP001-WEB-P01');
    expect(result.execution.appliedTags).toBeDefined();
    expect(result.execution.propagation).toBeDefined();
    expect(result.execution.propagation.propagated).toBe(true);

    // Verification result should have group and DFW info
    expect(result.verification).toBeDefined();
    expect(result.verification.groupMemberships).toBeDefined();
    expect(result.verification.activeDFWPolicies).toBeDefined();

    // Step durations tracked
    expect(result.workflowStepDurations).toBeDefined();
  });

  test('sends success callback to ServiceNow', async () => {
    await orchestrator.run(validPayload);

    // The callback step posts to the callbackUrl
    expect(deps.restClient.post).toHaveBeenCalledWith(
      'https://snow.test/callback',
      expect.objectContaining({
        correlationId: 'RITM-1234-1700000000',
        status: 'completed'
      })
    );
  });

  // ---------------------------------------------------------------------------
  // Saga rollback on tag propagation failure
  // ---------------------------------------------------------------------------
  test('saga rollback on tag propagation failure', async () => {
    // Make tagOperations.verifyPropagation always reject to trigger propagation timeout
    deps.tagOperations.verifyPropagation.mockRejectedValue(new Error('Propagation timeout'));

    // After saga begins, mark it as active so compensation runs
    deps.sagaCoordinator.isActive.mockReturnValue(true);

    const result = await orchestrator.run(validPayload);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(deps.sagaCoordinator.compensate).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Validation failure short-circuits
  // ---------------------------------------------------------------------------
  test('validation failure short-circuits before infrastructure changes', async () => {
    deps.payloadValidator.validate.mockReturnValue({
      valid: false,
      errors: ['Missing correlationId']
    });

    const result = await orchestrator.run(validPayload);

    expect(result.success).toBe(false);
    expect(result.error.message).toContain('Payload validation failed');

    // No VM provisioning attempted (only the callback post, not the vCenter post)
    const vCenterCalls = deps.restClient.post.mock.calls.filter(
      call => call[0].includes('vcenter')
    );
    expect(vCenterCalls).toHaveLength(0);

    // No tags applied
    expect(deps.tagOperations.applyTags).not.toHaveBeenCalled();

    // Saga should not have been started (validation fails before begin)
    expect(deps.sagaCoordinator.begin).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Error callback on VM provision failure
  // ---------------------------------------------------------------------------
  test('error callback sent to ServiceNow on failure', async () => {
    deps.restClient.post.mockRejectedValue(new Error('VM provision failed'));
    deps.sagaCoordinator.isActive.mockReturnValue(true);

    const result = await orchestrator.run(validPayload);

    expect(result.success).toBe(false);
    expect(result.error.message).toContain('VM provision failed');
    expect(result.dlqId).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Factory method
  // ---------------------------------------------------------------------------
  test('factory method creates correct orchestrator type', () => {
    const day0 = LifecycleOrchestrator.create('Day0', deps);
    expect(day0).toBeInstanceOf(Day0Orchestrator);
  });

  test('factory method throws for unknown request type', () => {
    expect(() => LifecycleOrchestrator.create('Unknown', deps)).toThrow(/Unknown request type/);
  });

  // ---------------------------------------------------------------------------
  // Dead letter queue on failure
  // ---------------------------------------------------------------------------
  test('failed workflow enqueues to dead letter queue', async () => {
    deps.restClient.post.mockRejectedValue(new Error('vCenter unreachable'));
    deps.sagaCoordinator.isActive.mockReturnValue(true);

    const result = await orchestrator.run(validPayload);

    expect(result.success).toBe(false);
    expect(deps.deadLetterQueue.enqueue).toHaveBeenCalledWith(
      validPayload,
      expect.any(Error),
      'RITM-1234-1700000000'
    );
    expect(result.dlqId).toBe('DLQ-test-123');
  });

  // ---------------------------------------------------------------------------
  // Sub-step: provisionVM
  // ---------------------------------------------------------------------------
  test('provisionVM calls vCenter API with correct spec', async () => {
    const endpoints = { vcenterUrl: 'https://vcenter-ndcng.test' };
    const result = await orchestrator.provisionVM(validPayload, endpoints);

    expect(result.vmId).toBe('vm-123');
    expect(result.vmName).toBe('NDCNG-APP001-WEB-P01');
    expect(result.status).toBe('provisioned');

    expect(deps.restClient.post).toHaveBeenCalledWith(
      'https://vcenter-ndcng.test/api/vcenter/vm',
      expect.objectContaining({
        name: 'NDCNG-APP001-WEB-P01',
        hardware: expect.objectContaining({
          cpu: { count: 4 },
          memory: { size_MiB: 16384 }
        })
      })
    );
  });

  test('provisionVM throws when no vmId in response', async () => {
    deps.restClient.post.mockResolvedValue({});
    const endpoints = { vcenterUrl: 'https://vcenter-ndcng.test' };

    await expect(orchestrator.provisionVM(validPayload, endpoints))
      .rejects.toThrow(/DFW-6200/);
  });

  // ---------------------------------------------------------------------------
  // Sub-step: applyTags
  // ---------------------------------------------------------------------------
  test('applyTags delegates to tagOperations', async () => {
    const tags = { Application: 'APP001', Tier: 'Web' };
    const result = await orchestrator.applyTags('vm-123', tags, 'NDCNG');

    expect(result.vmId).toBe('vm-123');
    expect(result.appliedTags).toEqual(tags);
    expect(result.tagCount).toBe(2);
    expect(deps.tagOperations.applyTags).toHaveBeenCalledWith('vm-123', tags, 'NDCNG');
  });

  // ---------------------------------------------------------------------------
  // Sub-step: verifyGroupMembership
  // ---------------------------------------------------------------------------
  test('verifyGroupMembership returns groups from groupVerifier', async () => {
    const result = await orchestrator.verifyGroupMembership('vm-123', 'NDCNG');

    expect(result.vmId).toBe('vm-123');
    expect(result.groups).toEqual(['APP001_Web_Production', 'All-Production-VMs']);
    expect(result.membershipCount).toBe(2);
  });

  test('verifyGroupMembership warns when no groups found', async () => {
    deps.groupVerifier.verifyMembership.mockResolvedValue({ groups: [] });

    const result = await orchestrator.verifyGroupMembership('vm-123', 'NDCNG');

    expect(result.groups).toEqual([]);
    expect(result.membershipCount).toBe(0);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'VM not found in any NSX groups after provisioning',
      expect.any(Object)
    );
  });

  // ---------------------------------------------------------------------------
  // Sub-step: validateDFW
  // ---------------------------------------------------------------------------
  test('validateDFW returns policies from dfwValidator', async () => {
    const result = await orchestrator.validateDFW('vm-123', 'NDCNG');

    expect(result.vmId).toBe('vm-123');
    expect(result.policies).toHaveLength(1);
    expect(result.compliant).toBe(true);
    expect(result.policyCount).toBe(1);
  });
});
