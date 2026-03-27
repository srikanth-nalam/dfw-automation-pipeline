'use strict';

const QuarantineOrchestrator = require('../../../src/vro/actions/lifecycle/QuarantineOrchestrator');
const LifecycleOrchestrator = require('../../../src/vro/actions/lifecycle/LifecycleOrchestrator');

// Stub out _sleep to avoid real delays in tests
beforeAll(() => {
  jest.spyOn(QuarantineOrchestrator, '_sleep').mockResolvedValue(undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('QuarantineOrchestrator', () => {
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
        debug: jest.fn()
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
        enqueue: jest.fn().mockReturnValue('DLQ-quarantine-001')
      },
      tagOperations: {
        getTags: jest.fn().mockResolvedValue({
          Application: 'APP001',
          Tier: 'Web',
          Environment: 'Production'
        }),
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        removeTags: jest.fn().mockResolvedValue({ removed: true }),
        verifyPropagation: jest.fn().mockResolvedValue({ propagated: true })
      },
      groupVerifier: {
        verifyMembership: jest.fn().mockResolvedValue({
          verified: true,
          groups: ['SG-Quarantine']
        })
      },
      dfwValidator: {
        validatePolicies: jest.fn().mockResolvedValue({
          compliant: true,
          policies: [{ policyName: 'Emergency-Quarantine-Policy' }]
        })
      },
      snowAdapter: {
        toCallbackPayload: jest.fn().mockImplementation(r => r),
        toErrorCallback: jest.fn().mockImplementation(e => e)
      }
    };

    orchestrator = new QuarantineOrchestrator(deps);
  });

  const validPayload = {
    correlationId: 'RITM-Q001-1700000000',
    requestType: 'Quarantine',
    vmId: 'vm-compromised-001',
    vmName: 'NDCNG-APP001-WEB-P01',
    site: 'NDCNG',
    justification: 'Security incident SI-2024-001: Suspected lateral movement detected from this VM requiring immediate isolation.',
    durationMinutes: 60,
    initiatedBy: 'sec-arch-jdoe',
    callbackUrl: 'https://snow.test/callback'
  };

  // Happy path
  test('happy path - quarantine workflow completes successfully', async () => {
    const result = await orchestrator.run(validPayload);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.correlationId).toBe('RITM-Q001-1700000000');
    expect(deps.tagOperations.getTags).toHaveBeenCalled();
    expect(deps.tagOperations.applyTags).toHaveBeenCalledWith(
      'vm-compromised-001',
      { Quarantine: 'ACTIVE' },
      'NDCNG'
    );
    expect(deps.sagaCoordinator.begin).toHaveBeenCalledWith('RITM-Q001-1700000000');
  });

  test('execution result contains quarantine metadata', async () => {
    const result = await orchestrator.run(validPayload);

    expect(result.execution).toBeDefined();
    expect(result.execution.quarantineApplied).toBe(true);
    expect(result.execution.metadata).toBeDefined();
    expect(result.execution.metadata.expiryTime).toBeDefined();
    expect(result.execution.metadata.justification).toContain('Security incident');
  });

  test('verification generates expiry payload', async () => {
    const result = await orchestrator.run(validPayload);

    expect(result.verification).toBeDefined();
    expect(result.verification.expiryPayload).toBeDefined();
    expect(result.verification.expiryPayload.action).toBe('remove_quarantine');
    expect(result.verification.expiryPayload.correlationId).toContain('EXPIRY');
  });

  test('sends callback to ServiceNow on success', async () => {
    await orchestrator.run(validPayload);

    expect(deps.restClient.post).toHaveBeenCalledWith(
      'https://snow.test/callback',
      expect.objectContaining({
        correlationId: 'RITM-Q001-1700000000',
        status: 'completed'
      })
    );
  });

  // Validation failures
  test('rejects invalid quarantine duration', async () => {
    const badPayload = { ...validPayload, durationMinutes: 45 };
    const result = await orchestrator.run(badPayload);

    expect(result.success).toBe(false);
    expect(result.error.message).toContain('DFW-8100');
  });

  test('rejects short justification', async () => {
    const badPayload = { ...validPayload, justification: 'Too short' };
    const result = await orchestrator.run(badPayload);

    expect(result.success).toBe(false);
    expect(result.error.message).toContain('DFW-8101');
  });

  // Saga rollback
  test('saga rollback on tag apply failure', async () => {
    deps.tagOperations.applyTags.mockRejectedValue(new Error('NSX API error'));
    deps.sagaCoordinator.isActive.mockReturnValue(true);

    const result = await orchestrator.run(validPayload);

    expect(result.success).toBe(false);
    expect(deps.sagaCoordinator.compensate).toHaveBeenCalled();
  });

  // Propagation timeout
  test('handles propagation timeout', async () => {
    deps.tagOperations.verifyPropagation.mockRejectedValue(
      new Error('Propagation check failed')
    );
    deps.sagaCoordinator.isActive.mockReturnValue(true);

    const result = await orchestrator.run(validPayload);

    expect(result.success).toBe(false);
    expect(result.error.message).toContain('DFW-8102');
  });

  // Dead letter queue
  test('failed workflow enqueues to dead letter queue', async () => {
    deps.tagOperations.applyTags.mockRejectedValue(new Error('NSX unreachable'));
    deps.sagaCoordinator.isActive.mockReturnValue(true);

    const result = await orchestrator.run(validPayload);

    expect(result.success).toBe(false);
    expect(deps.deadLetterQueue.enqueue).toHaveBeenCalledWith(
      validPayload,
      expect.any(Error),
      'RITM-Q001-1700000000'
    );
  });

  // Factory method
  test('factory creates QuarantineOrchestrator for Quarantine type', () => {
    const q = LifecycleOrchestrator.create('Quarantine', deps);
    expect(q).toBeInstanceOf(QuarantineOrchestrator);
  });

  // Static createExpiryPayload
  test('createExpiryPayload generates correct structure', () => {
    const payload = QuarantineOrchestrator.createExpiryPayload({
      correlationId: 'RITM-Q001',
      vmId: 'vm-123',
      vmName: 'test-vm',
      site: 'NDCNG',
      durationMinutes: 120
    });

    expect(payload.correlationId).toBe('RITM-Q001-EXPIRY');
    expect(payload.requestType).toBe('quarantine_expiry');
    expect(payload.vmId).toBe('vm-123');
    expect(payload.action).toBe('remove_quarantine');
    expect(payload.scheduledExpiryTime).toBeDefined();
  });

  // Uses vmName as fallback when vmId is missing
  test('uses vmName when vmId is not provided', async () => {
    const payloadNoVmId = { ...validPayload };
    delete payloadNoVmId.vmId;

    const result = await orchestrator.run(payloadNoVmId);

    expect(result.success).toBe(true);
    expect(deps.tagOperations.applyTags).toHaveBeenCalledWith(
      'NDCNG-APP001-WEB-P01',
      { Quarantine: 'ACTIVE' },
      'NDCNG'
    );
  });
});
