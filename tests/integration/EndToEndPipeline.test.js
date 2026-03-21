'use strict';

/**
 * End-to-end integration test for the Day0 provisioning pipeline.
 *
 * Uses the REAL Day0Orchestrator and SagaCoordinator from source, with
 * mock external dependencies (vCenter, NSX, ServiceNow). Verifies:
 *   1. All steps execute in correct order
 *   2. Data flows correctly between components
 *   3. Success callback is sent with the right payload
 *   4. On failure, saga rollback executes compensating actions in reverse
 *   5. Dead letter queue receives failed payloads
 */

const Day0Orchestrator = require('../../src/vro/actions/lifecycle/Day0Orchestrator');
const LifecycleOrchestrator = require('../../src/vro/actions/lifecycle/LifecycleOrchestrator');
const SagaCoordinator = require('../../src/vro/actions/lifecycle/SagaCoordinator');

// Stub out _sleep to avoid real delays in tests
beforeAll(() => {
  jest.spyOn(Day0Orchestrator, '_sleep').mockResolvedValue(undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('EndToEndPipeline - Day0 Flow', () => {
  let deps;
  let orchestrator;
  let executionOrder;
  let logger;
  let sagaCoordinator;

  beforeEach(() => {
    executionOrder = [];

    logger = {
      info: jest.fn().mockImplementation((msg) => {
        executionOrder.push(`log:${msg}`);
      }),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    // Use the REAL SagaCoordinator
    sagaCoordinator = new SagaCoordinator(logger);

    deps = {
      configLoader: {
        getEndpointsForSite: jest.fn().mockImplementation((site) => {
          executionOrder.push(`resolveEndpoints:${site}`);
          return {
            vcenterUrl: `https://vcenter-${site.toLowerCase()}.test`,
            nsxUrl: `https://nsx-${site.toLowerCase()}.test`,
            nsxGlobalUrl: `https://nsx-global-${site.toLowerCase()}.test`
          };
        })
      },
      restClient: {
        get: jest.fn().mockImplementation((url) => {
          if (url.includes('/tools')) {
            executionOrder.push('waitForVMTools');
            return Promise.resolve({ run_state: 'RUNNING' });
          }
          return Promise.resolve({});
        }),
        post: jest.fn().mockImplementation((url, body) => {
          if (url.includes('/api/vcenter/vm') && !url.includes('/power')) {
            executionOrder.push('provisionVM');
            return Promise.resolve({ vmId: 'vm-e2e-001' });
          }
          if (url.includes('/callback')) {
            executionOrder.push('sendCallback');
            return Promise.resolve({ status: 200 });
          }
          return Promise.resolve({ status: 200 });
        }),
        patch: jest.fn().mockResolvedValue({ status: 200 }),
        delete: jest.fn().mockImplementation((url) => {
          executionOrder.push('deleteVM');
          return Promise.resolve({ status: 200 });
        })
      },
      logger,
      payloadValidator: {
        validate: jest.fn().mockImplementation((payload) => {
          executionOrder.push('validate');
          return { valid: true, errors: [] };
        })
      },
      sagaCoordinator,
      deadLetterQueue: {
        enqueue: jest.fn().mockImplementation((payload, error, correlationId) => {
          executionOrder.push('enqueueDLQ');
          return `DLQ-${correlationId}`;
        })
      },
      tagOperations: {
        applyTags: jest.fn().mockImplementation((vmId, tags, site) => {
          executionOrder.push('applyTags');
          return Promise.resolve({ applied: true });
        }),
        removeTags: jest.fn().mockImplementation((vmId, categories, site) => {
          executionOrder.push('removeTags');
          return Promise.resolve({ removed: true });
        }),
        verifyPropagation: jest.fn().mockImplementation((vmId, tags, site) => {
          executionOrder.push('verifyPropagation');
          return Promise.resolve({ propagated: true });
        })
      },
      groupVerifier: {
        verifyMembership: jest.fn().mockImplementation((vmId, site) => {
          executionOrder.push('verifyGroupMembership');
          return Promise.resolve({
            verified: true,
            groups: ['APP001_Web_Production', 'All-Production-VMs', 'All-PCI-VMs']
          });
        })
      },
      dfwValidator: {
        validatePolicies: jest.fn().mockImplementation((vmId, site) => {
          executionOrder.push('validateDFW');
          return Promise.resolve({
            compliant: true,
            policies: [
              {
                policyName: 'APP001-Web-Allow-HTTPS',
                action: 'ALLOW',
                sourceGroups: ['Load-Balancers'],
                destinationGroups: ['APP001_Web_Production'],
                services: ['TCP/443']
              }
            ]
          });
        })
      },
      snowAdapter: {
        toCallbackPayload: jest.fn().mockImplementation(r => r),
        toErrorCallback: jest.fn().mockImplementation(e => e)
      }
    };

    orchestrator = new Day0Orchestrator(deps);
  });

  const validPayload = {
    correlationId: 'RITM-E2E-001-1700000000',
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
      DataClassification: 'Confidential'
    },
    callbackUrl: 'https://snow.test/callback',
    callbackToken: 'test-token'
  };

  // ---------------------------------------------------------------------------
  // Full happy path - steps execute in correct order
  // ---------------------------------------------------------------------------
  describe('full happy path', () => {
    test('all steps execute in correct order and returns success', async () => {
      const result = await orchestrator.run(validPayload);

      // Verify success
      expect(result.success).toBe(true);
      expect(result.correlationId).toBe('RITM-E2E-001-1700000000');
      expect(result.requestType).toBe('Day0');

      // Verify execution data populated
      expect(result.execution).toBeDefined();
      expect(result.execution.vmId).toBe('vm-e2e-001');
      expect(result.execution.vmName).toBe('NDCNG-APP001-WEB-P01');
      expect(result.execution.appliedTags).toBeDefined();
      expect(result.execution.propagation.propagated).toBe(true);

      // Verify verification data populated
      expect(result.verification).toBeDefined();
      expect(result.verification.groupMemberships).toBeDefined();
      expect(result.verification.groupMemberships.groups).toEqual(
        expect.arrayContaining(['APP001_Web_Production', 'All-Production-VMs'])
      );
      expect(result.verification.activeDFWPolicies).toBeDefined();
      expect(result.verification.activeDFWPolicies.policies).toHaveLength(1);
      expect(result.verification.activeDFWPolicies.compliant).toBe(true);

      // Verify step timing data collected (callback duration is recorded
      // after the result object is built, so it is not included)
      expect(result.workflowStepDurations).toBeDefined();
      expect(result.workflowStepDurations.validate).toBeDefined();
      expect(result.workflowStepDurations.resolveEndpoints).toBeDefined();
      expect(result.workflowStepDurations.prepare).toBeDefined();
      expect(result.workflowStepDurations.execute).toBeDefined();
      expect(result.workflowStepDurations.verify).toBeDefined();
    });

    test('steps execute in the expected order', async () => {
      await orchestrator.run(validPayload);

      // Filter to only the meaningful step markers
      const keySteps = executionOrder.filter(step =>
        ['validate', 'provisionVM', 'waitForVMTools', 'applyTags',
         'verifyPropagation', 'verifyGroupMembership', 'validateDFW',
         'sendCallback'].includes(step)
      );

      expect(keySteps).toEqual([
        'validate',
        'provisionVM',
        'waitForVMTools',
        'applyTags',
        'verifyPropagation',
        'verifyGroupMembership',
        'validateDFW',
        'sendCallback'
      ]);
    });

    test('saga records compensating steps for provisionVM and applyTags', async () => {
      await orchestrator.run(validPayload);

      // Real SagaCoordinator should have recorded the steps
      const journal = sagaCoordinator.getJournal();
      expect(journal).toHaveLength(2);
      expect(journal[0].stepName).toBe('provisionVM');
      expect(journal[1].stepName).toBe('applyTags');
      expect(typeof journal[0].compensatingAction).toBe('function');
      expect(typeof journal[1].compensatingAction).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // Success callback format verification
  // ---------------------------------------------------------------------------
  describe('success callback format', () => {
    test('sends correctly formatted callback to ServiceNow', async () => {
      await orchestrator.run(validPayload);

      // Find the callback POST call (to the callbackUrl, not vCenter)
      const callbackCalls = deps.restClient.post.mock.calls.filter(
        call => call[0].includes('/callback')
      );
      expect(callbackCalls).toHaveLength(1);

      const callbackPayload = callbackCalls[0][1];
      expect(callbackPayload.correlationId).toBe('RITM-E2E-001-1700000000');
      expect(callbackPayload.requestType).toBe('Day0');
      expect(callbackPayload.status).toBe('completed');
      expect(callbackPayload.result).toBeDefined();
      expect(callbackPayload.result.success).toBe(true);
      expect(callbackPayload.timestamp).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Failure scenario with full saga rollback
  // ---------------------------------------------------------------------------
  describe('failure with full saga rollback', () => {
    test('DFW validation failure triggers saga compensation in reverse order', async () => {
      const compensationOrder = [];

      // Track compensation calls
      deps.restClient.delete = jest.fn().mockImplementation((url) => {
        compensationOrder.push('deleteVM:compensation');
        return Promise.resolve({ status: 200 });
      });
      deps.tagOperations.removeTags = jest.fn().mockImplementation((vmId, categories, site) => {
        compensationOrder.push('removeTags:compensation');
        return Promise.resolve({ removed: true });
      });

      // Make DFW validation fail (this happens in verify(), after execute() has completed)
      deps.dfwValidator.validatePolicies.mockRejectedValue(
        new Error('[DFW-7006] Unable to validate DFW coverage for vm-e2e-001')
      );

      const result = await orchestrator.run(validPayload);

      // Result should be failure
      expect(result.success).toBe(false);
      expect(result.error.message).toContain('DFW-7006');

      // Real SagaCoordinator should have compensated
      expect(sagaCoordinator.isActive()).toBe(false);

      // Compensating actions should execute in REVERSE order:
      //   1. applyTags compensation (removeTags) runs first
      //   2. provisionVM compensation (deleteVM) runs second
      expect(compensationOrder).toEqual([
        'removeTags:compensation',
        'deleteVM:compensation'
      ]);
    });

    test('tag propagation failure triggers rollback before verification', async () => {
      // Make verifyPropagation always fail (loop exhaustion)
      deps.tagOperations.verifyPropagation.mockRejectedValue(
        new Error('[DFW-6202] Tag propagation timeout')
      );

      const result = await orchestrator.run(validPayload);

      expect(result.success).toBe(false);
      expect(result.error.message).toContain('DFW-6202');

      // Group verification should NOT have been reached
      expect(deps.groupVerifier.verifyMembership).not.toHaveBeenCalled();
      // DFW validation should NOT have been reached
      expect(deps.dfwValidator.validatePolicies).not.toHaveBeenCalled();

      // Saga should have compensated
      expect(sagaCoordinator.isActive()).toBe(false);
    });

    test('VM provisioning failure short-circuits all subsequent steps', async () => {
      deps.restClient.post.mockImplementation((url) => {
        if (url.includes('/api/vcenter/vm') && !url.includes('/power')) {
          return Promise.reject(new Error('vCenter API unavailable'));
        }
        return Promise.resolve({ status: 200 });
      });

      const result = await orchestrator.run(validPayload);

      expect(result.success).toBe(false);
      expect(result.error.message).toContain('vCenter API unavailable');

      // No tags applied
      expect(deps.tagOperations.applyTags).not.toHaveBeenCalled();
      // No propagation check
      expect(deps.tagOperations.verifyPropagation).not.toHaveBeenCalled();
      // No group verification
      expect(deps.groupVerifier.verifyMembership).not.toHaveBeenCalled();
    });

    test('error callback sent to ServiceNow on failure', async () => {
      deps.dfwValidator.validatePolicies.mockRejectedValue(
        new Error('DFW validation error')
      );

      const result = await orchestrator.run(validPayload);

      // Find the callback POST call
      const callbackCalls = deps.restClient.post.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('/callback')
      );
      expect(callbackCalls.length).toBeGreaterThan(0);

      const errorCallback = callbackCalls[callbackCalls.length - 1][1];
      expect(errorCallback.status).toBe('failed');
      expect(errorCallback.result.success).toBe(false);
      expect(errorCallback.result.error.message).toContain('DFW validation error');
    });
  });

  // ---------------------------------------------------------------------------
  // DLQ entry on persistent failure
  // ---------------------------------------------------------------------------
  describe('dead letter queue on persistent failure', () => {
    test('failed workflow enqueues payload to DLQ', async () => {
      deps.restClient.post.mockImplementation((url) => {
        if (url.includes('/api/vcenter/vm') && !url.includes('/power')) {
          return Promise.reject(new Error('Persistent vCenter failure'));
        }
        return Promise.resolve({ status: 200 });
      });

      const result = await orchestrator.run(validPayload);

      expect(result.success).toBe(false);
      expect(deps.deadLetterQueue.enqueue).toHaveBeenCalledWith(
        validPayload,
        expect.any(Error),
        'RITM-E2E-001-1700000000'
      );
      expect(result.dlqId).toBe('DLQ-RITM-E2E-001-1700000000');
    });

    test('DLQ entry contains error details for reprocessing', async () => {
      deps.tagOperations.applyTags.mockRejectedValue(
        new Error('[DFW-6300] NSX tag API unreachable')
      );

      await orchestrator.run(validPayload);

      const dlqCall = deps.deadLetterQueue.enqueue.mock.calls[0];
      const [enqueuedPayload, enqueuedError, enqueuedCorrelationId] = dlqCall;

      expect(enqueuedPayload).toEqual(validPayload);
      expect(enqueuedError.message).toContain('DFW-6300');
      expect(enqueuedCorrelationId).toBe('RITM-E2E-001-1700000000');
    });
  });

  // ---------------------------------------------------------------------------
  // Validation failure - no infrastructure changes
  // ---------------------------------------------------------------------------
  describe('validation failure', () => {
    test('invalid payload prevents all infrastructure operations', async () => {
      deps.payloadValidator.validate.mockReturnValue({
        valid: false,
        errors: ['Missing required field: vmName']
      });

      const result = await orchestrator.run(validPayload);

      expect(result.success).toBe(false);
      expect(result.error.message).toContain('Payload validation failed');

      // No infrastructure calls should have been made
      const vCenterCalls = deps.restClient.post.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('vcenter')
      );
      expect(vCenterCalls).toHaveLength(0);
      expect(deps.tagOperations.applyTags).not.toHaveBeenCalled();
      expect(deps.groupVerifier.verifyMembership).not.toHaveBeenCalled();
      expect(deps.dfwValidator.validatePolicies).not.toHaveBeenCalled();

      // Saga should not have started
      expect(sagaCoordinator.isActive()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Factory method integration
  // ---------------------------------------------------------------------------
  describe('factory method integration', () => {
    test('LifecycleOrchestrator.create produces working Day0 orchestrator', async () => {
      const factoryOrchestrator = LifecycleOrchestrator.create('Day0', deps);
      expect(factoryOrchestrator).toBeInstanceOf(Day0Orchestrator);

      const result = await factoryOrchestrator.run(validPayload);
      expect(result.success).toBe(true);
    });
  });
});
