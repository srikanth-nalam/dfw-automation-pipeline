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
const CMDBValidator = require('../../src/vro/actions/cmdb/CMDBValidator');
const RuleLifecycleManager = require('../../src/vro/actions/dfw/RuleLifecycleManager');
const PolicyDeployer = require('../../src/vro/actions/dfw/PolicyDeployer');
const MigrationBulkTagger = require('../../src/vro/actions/lifecycle/MigrationBulkTagger');
const Day2Orchestrator = require('../../src/vro/actions/lifecycle/Day2Orchestrator');

// Stub out _sleep to avoid real delays in tests
beforeAll(() => {
  jest.spyOn(Day0Orchestrator, '_sleep').mockResolvedValue(undefined);
  jest.spyOn(Day2Orchestrator, '_sleep').mockResolvedValue(undefined);
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
      Region: 'NDCNG',
      SecurityZone: 'Greenzone',
      Environment: 'Production',
      AppCI: 'APP001',
      SystemRole: 'Web',
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

// ---------------------------------------------------------------------------
// CMDB Validation Flow
// ---------------------------------------------------------------------------
describe('EndToEndPipeline - CMDB Validation Flow', () => {
  let deps;
  let validator;
  let logger;

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    deps = {
      restClient: {
        get: jest.fn().mockResolvedValue({
          result: [
            {
              sys_id: 'vm-001',
              name: 'APP001-WEB-P01',
              u_region: 'NDCNG',
              u_security_zone: 'Greenzone',
              u_environment: 'Production',
              u_app_ci: 'APP001',
              u_system_role: 'Web',
              owned_by: 'team-alpha'
            },
            {
              sys_id: 'vm-002',
              name: 'APP002-DB-P01',
              u_region: 'NDCNG',
              u_security_zone: 'Greenzone',
              u_environment: 'Production',
              u_app_ci: 'APP002',
              u_system_role: 'Database',
              owned_by: 'team-beta'
            },
            {
              sys_id: 'vm-003',
              name: 'APP003-MW-P01',
              u_region: 'NDCNG',
              u_security_zone: null,
              u_environment: 'Production',
              u_app_ci: 'APP003',
              u_system_role: null,
              owned_by: 'team-gamma'
            },
            {
              sys_id: 'vm-004',
              name: 'APP004-WEB-D01',
              u_region: 'INVALID_REGION',
              u_security_zone: 'Greenzone',
              u_environment: 'Production',
              u_app_ci: 'APP004',
              u_system_role: 'Web',
              owned_by: 'team-delta'
            }
          ]
        }),
        post: jest.fn().mockResolvedValue({ status: 201 })
      },
      logger,
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

  test('full extraction to coverage to quality to gap report flow', async () => {
    const report = await validator.generateGapReport('NDCNG');

    expect(report.site).toBe('NDCNG');
    expect(report.timestamp).toBeDefined();
    expect(report.summary.totalVMs).toBe(4);
    expect(report.coverageMetrics).toBeDefined();
    expect(report.qualityMetrics).toBeDefined();
    expect(report.topGaps).toBeDefined();
    expect(report.recommendations).toBeDefined();
    expect(report.summary.readyForNSX).toBeDefined();
    expect(report.summary.needsRemediation).toBeDefined();
    expect(report.summary.readyForNSX + report.summary.needsRemediation).toBe(4);
  });

  test('handles missing CMDB entries gracefully with empty inventory', async () => {
    deps.restClient.get.mockResolvedValue({ result: [] });

    const report = await validator.generateGapReport('NDCNG');

    expect(report.summary.totalVMs).toBe(0);
    expect(report.coverageMetrics.fullyPopulated).toBe(0);
    expect(report.qualityMetrics.totalChecked).toBe(0);
    expect(report.summary.readyForNSX).toBe(0);
    expect(report.summary.needsRemediation).toBe(0);
  });

  test('reports coverage percentage correctly for partially-tagged VMs', async () => {
    const inventory = await validator.extractVMInventory('NDCNG');
    const coverage = await validator.validateCoverage(inventory);

    expect(coverage.totalVMs).toBe(4);
    // vm-001 and vm-002 are fully populated, vm-003 is missing 2 fields, vm-004 is fully populated
    expect(coverage.fullyPopulated).toBe(3);
    expect(coverage.partiallyPopulated).toBe(1);
    expect(coverage.unpopulated).toBe(0);
    // securityZone: 3 populated, 1 missing => 75%
    expect(coverage.coverageByField.securityZone.percent).toBe(75);
    // systemRole: 3 populated, 1 missing => 75%
    expect(coverage.coverageByField.systemRole.percent).toBe(75);
    // region, environment, appCI should all be 100%
    expect(coverage.coverageByField.region.percent).toBe(100);
    expect(coverage.coverageByField.environment.percent).toBe(100);
    expect(coverage.coverageByField.appCI.percent).toBe(100);
  });

  test('validates quality and catches invalid tag values', async () => {
    const inventory = await validator.extractVMInventory('NDCNG');
    const quality = await validator.validateQuality(inventory);

    expect(quality.totalChecked).toBeGreaterThan(0);
    expect(quality.invalidValues).toBeGreaterThan(0);
    // vm-004 has INVALID_REGION which is not in ALLOWED_VALUES for region
    const regionInvalid = quality.invalidEntries.find(
      e => e.vmId === 'vm-004' && e.field === 'region'
    );
    expect(regionInvalid).toBeDefined();
    expect(regionInvalid.value).toBe('INVALID_REGION');
  });

  test('getMetrics returns dashboard-ready KPI from gap report', async () => {
    const report = await validator.generateGapReport('NDCNG');
    const metrics = validator.getMetrics(report);

    expect(metrics.overallReadiness).toBeDefined();
    expect(metrics.coverageScore).toBeDefined();
    expect(metrics.qualityScore).toBeDefined();
    expect(metrics.estimatedRemediationDays).toBeDefined();
    expect(typeof metrics.overallReadiness).toBe('number');
    expect(metrics.overallReadiness).toBeGreaterThanOrEqual(0);
    expect(metrics.overallReadiness).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Rule Lifecycle Flow
// ---------------------------------------------------------------------------
describe('EndToEndPipeline - Rule Lifecycle Flow', () => {
  let deps;
  let manager;
  let logger;
  let ruleStore;
  let ruleIdCounter;

  beforeEach(() => {
    ruleStore = {};
    ruleIdCounter = 0;

    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    deps = {
      ruleRegistry: {
        generateRuleId: jest.fn().mockImplementation(() => {
          ruleIdCounter += 1;
          return `DFW-R-${String(ruleIdCounter).padStart(4, '0')}`;
        }),
        register: jest.fn().mockImplementation((rule) => {
          ruleStore[rule.ruleId] = { ...rule };
          return ruleStore[rule.ruleId];
        }),
        getRule: jest.fn().mockImplementation((ruleId) => {
          if (!ruleStore[ruleId]) {
            throw new Error(`[DFW-10004] Rule ${ruleId} not found`);
          }
          return { ...ruleStore[ruleId] };
        }),
        updateState: jest.fn().mockImplementation((ruleId, newState, metadata) => {
          if (ruleStore[ruleId]) {
            ruleStore[ruleId].state = newState;
            ruleStore[ruleId].metadata = metadata;
          }
          return ruleStore[ruleId];
        }),
        getHistory: jest.fn().mockReturnValue([])
      },
      policyDeployer: {
        deploy: jest.fn().mockResolvedValue({
          success: true,
          policyName: 'test-policy',
          rulesDeployed: 1
        })
      },
      ruleConflictDetector: {
        analyze: jest.fn().mockReturnValue({
          conflicts: [],
          shadows: [],
          duplicates: [],
          hasIssues: false
        })
      },
      restClient: {
        get: jest.fn().mockResolvedValue({}),
        post: jest.fn().mockResolvedValue({ status: 200 }),
        patch: jest.fn().mockResolvedValue({ status: 200 })
      },
      logger
    };

    manager = new RuleLifecycleManager(deps);
  });

  const sampleRuleRequest = {
    name: 'allow-web-to-db',
    source_groups: ['web-tier'],
    destination_groups: ['db-tier'],
    services: ['TCP/3306'],
    action: 'ALLOW',
    owner: 'security-team'
  };

  test('submitRule registers a rule with REQUESTED state', async () => {
    const rule = await manager.submitRule(sampleRuleRequest);

    expect(rule.ruleId).toBe('DFW-R-0001');
    expect(rule.state).toBe('REQUESTED');
    expect(rule.name).toBe('allow-web-to-db');
    expect(rule.submittedAt).toBeDefined();
    expect(deps.ruleRegistry.register).toHaveBeenCalledTimes(1);
  });

  test('analyzeImpact returns expected format with no issues', async () => {
    await manager.submitRule(sampleRuleRequest);
    const { rule, impactResult } = await manager.analyzeImpact('DFW-R-0001');

    expect(rule.state).toBe('IMPACT_ANALYZED');
    expect(impactResult).toBeDefined();
    expect(impactResult.hasIssues).toBe(false);
    expect(impactResult.conflicts).toEqual([]);
    expect(impactResult.shadows).toEqual([]);
    expect(deps.ruleConflictDetector.analyze).toHaveBeenCalledTimes(1);
  });

  test('analyzeImpact reports conflicts when detected', async () => {
    deps.ruleConflictDetector.analyze.mockReturnValue({
      conflicts: [{ ruleA: 'allow-web-to-db', ruleB: 'deny-all-to-db', type: 'contradictory' }],
      shadows: [],
      duplicates: [],
      hasIssues: true
    });

    await manager.submitRule(sampleRuleRequest);
    const { impactResult } = await manager.analyzeImpact('DFW-R-0001');

    expect(impactResult.hasIssues).toBe(true);
    expect(impactResult.conflicts).toHaveLength(1);
    expect(impactResult.conflicts[0].type).toBe('contradictory');
  });

  test('full lifecycle: submit -> impact -> approve -> monitor -> promote -> certify', async () => {
    // Submit
    const submitted = await manager.submitRule(sampleRuleRequest);
    expect(submitted.state).toBe('REQUESTED');

    // Impact analysis
    await manager.analyzeImpact(submitted.ruleId);
    expect(ruleStore[submitted.ruleId].state).toBe('IMPACT_ANALYZED');

    // Manually approve (simulate approval by updating state directly)
    ruleStore[submitted.ruleId].state = 'APPROVED';

    // Deploy in monitor mode
    const monitorResult = await manager.deployMonitorMode(submitted.ruleId, 'NDCNG');
    expect(monitorResult.state).toBe('MONITOR_MODE');
    expect(ruleStore[submitted.ruleId].state).toBe('MONITOR_MODE');

    // Promote to enforce
    const enforceResult = await manager.promoteToEnforce(submitted.ruleId, 'NDCNG');
    expect(enforceResult.state).toBe('ENFORCED');
    expect(ruleStore[submitted.ruleId].state).toBe('ENFORCED');

    // Certify
    const certifyResult = await manager.certifyRule(submitted.ruleId, 'security-architect');
    expect(certifyResult.state).toBe('CERTIFIED');
    expect(certifyResult.certifiedBy).toBe('security-architect');
    expect(certifyResult.reviewDate).toBeDefined();
    expect(ruleStore[submitted.ruleId].state).toBe('CERTIFIED');
  });

  test('invalid state transition throws DFW-10002', async () => {
    await manager.submitRule(sampleRuleRequest);

    // Attempt to deploy in monitor mode directly from REQUESTED (skipping impact analysis)
    await expect(
      manager.deployMonitorMode('DFW-R-0001', 'NDCNG')
    ).rejects.toThrow('DFW-10002');
  });
});

// ---------------------------------------------------------------------------
// Monitor-mode to Enforcement Transition
// ---------------------------------------------------------------------------
describe('EndToEndPipeline - Monitor-mode to Enforcement Transition', () => {
  let deployer;
  let restClient;
  let logger;

  const testPolicy = {
    name: 'APP001-Web-Allow-HTTPS',
    category: 'Application',
    rules: [
      {
        name: 'allow-https-inbound',
        source_groups: ['Load-Balancers'],
        destination_groups: ['APP001_Web_Production'],
        services: ['TCP/443'],
        action: 'DROP'
      }
    ]
  };

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    restClient = {
      get: jest.fn().mockResolvedValue({
        body: {
          display_name: 'APP001-Web-Allow-HTTPS',
          description: '[MONITOR] APP001-Web-Allow-HTTPS',
          rules: [
            {
              id: 'allow-https-inbound',
              display_name: 'allow-https-inbound',
              action: 'ALLOW',
              logged: true,
              _monitor_mode: true,
              source_groups: ['Load-Balancers'],
              destination_groups: ['APP001_Web_Production'],
              services: ['TCP/443']
            }
          ]
        }
      }),
      post: jest.fn().mockResolvedValue({ status: 200 }),
      patch: jest.fn().mockResolvedValue({ status: 200 })
    };

    deployer = new PolicyDeployer(restClient, logger);
  });

  test('deployMonitorMode deploys policy in monitor mode', async () => {
    const result = await deployer.deployMonitorMode(testPolicy, 'NDCNG');

    expect(result.mode).toBe('MONITOR');
    expect(result.policyName).toBeDefined();
    expect(result.rulesDeployed).toBe(1);
    expect(result.originalActions).toBeDefined();
    // Original action should be saved for later promotion
    const ruleKey = Object.keys(result.originalActions)[0];
    expect(result.originalActions[ruleKey]).toBe('DROP');
  });

  test('getDeploymentMode returns MONITOR for monitor-deployed policy', async () => {
    const status = await deployer.getDeploymentMode(
      'APP001-Web-Allow-HTTPS',
      'NDCNG'
    );

    expect(status.mode).toBe('MONITOR');
    expect(status.rulesInMonitor).toBe(1);
    expect(status.rulesInEnforce).toBe(0);
  });

  test('promoteToEnforce restores original actions and switches to ENFORCE', async () => {
    const originalActions = { 'allow-https-inbound': 'DROP' };

    const result = await deployer.promoteToEnforce(
      'APP001-Web-Allow-HTTPS',
      'NDCNG',
      originalActions
    );

    expect(result.mode).toBe('ENFORCE');
    expect(result.rulesPromoted).toBe(1);
    // Verify PATCH was called to update the policy
    expect(restClient.patch).toHaveBeenCalled();
  });

  test('full transition: deploy monitor -> verify -> promote -> verify enforcement', async () => {
    // Step 1: Deploy in monitor mode
    const monitorResult = await deployer.deployMonitorMode(testPolicy, 'NDCNG');
    expect(monitorResult.mode).toBe('MONITOR');

    // Step 2: Verify monitor mode status
    const monitorStatus = await deployer.getDeploymentMode(
      'APP001-Web-Allow-HTTPS',
      'NDCNG'
    );
    expect(monitorStatus.mode).toBe('MONITOR');

    // Step 3: Promote to enforcement
    const enforceResult = await deployer.promoteToEnforce(
      'APP001-Web-Allow-HTTPS',
      'NDCNG',
      monitorResult.originalActions
    );
    expect(enforceResult.mode).toBe('ENFORCE');

    // Step 4: Verify enforcement mode after promotion
    // Update mock to return enforced policy (no _monitor_mode, description without [MONITOR])
    restClient.get.mockResolvedValue({
      body: {
        display_name: 'APP001-Web-Allow-HTTPS',
        description: 'APP001-Web-Allow-HTTPS',
        rules: [
          {
            id: 'allow-https-inbound',
            display_name: 'allow-https-inbound',
            action: 'DROP',
            logged: true,
            source_groups: ['Load-Balancers'],
            destination_groups: ['APP001_Web_Production'],
            services: ['TCP/443']
          }
        ]
      }
    });

    const enforceStatus = await deployer.getDeploymentMode(
      'APP001-Web-Allow-HTTPS',
      'NDCNG'
    );
    expect(enforceStatus.mode).toBe('ENFORCE');
    expect(enforceStatus.rulesInEnforce).toBe(1);
    expect(enforceStatus.rulesInMonitor).toBe(0);
  });

  test('promoteToEnforce fails when originalActions is missing', async () => {
    await expect(
      deployer.promoteToEnforce('APP001-Web-Allow-HTTPS', 'NDCNG', null)
    ).rejects.toThrow('DFW-8006');
  });
});

// ---------------------------------------------------------------------------
// Migration Bulk Tagger Flow
// ---------------------------------------------------------------------------
describe('EndToEndPipeline - Migration Bulk Tagger Flow', () => {
  let deps;
  let tagger;
  let logger;

  const sampleManifest = {
    waveId: 'WAVE-001',
    site: 'NDCNG',
    scheduledDate: '2026-04-15T06:00:00Z',
    vms: [
      {
        vmId: 'vm-mig-001',
        vmName: 'APP001-WEB-P01',
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'APP001',
          SystemRole: 'Web'
        }
      },
      {
        vmId: 'vm-mig-002',
        vmName: 'APP002-DB-P01',
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'APP002',
          SystemRole: 'Database'
        }
      }
    ]
  };

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    deps = {
      tagOperations: {
        getTags: jest.fn().mockResolvedValue({ tags: {} }),
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        verifyPropagation: jest.fn().mockResolvedValue({ propagated: true })
      },
      cmdbValidator: {
        validateTagCompleteness: jest.fn().mockResolvedValue({
          complete: true,
          missingCategories: []
        })
      },
      migrationVerifier: {
        verifyPostMigration: jest.fn().mockResolvedValue({
          tagsPreserved: true,
          missingTags: []
        })
      },
      bulkTagOrchestrator: {
        executeBulk: jest.fn().mockResolvedValue({
          totalVMs: 2,
          successCount: 2,
          failureCount: 0,
          skippedCount: 0,
          status: 'completed',
          results: [
            { vmId: 'vm-mig-001', success: true },
            { vmId: 'vm-mig-002', success: true }
          ],
          failedVMs: []
        })
      },
      restClient: {
        get: jest.fn().mockResolvedValue({}),
        post: jest.fn().mockResolvedValue({ status: 200 })
      },
      logger
    };

    tagger = new MigrationBulkTagger(deps);
  });

  test('loadManifest validates and loads manifest successfully', async () => {
    const result = await tagger.loadManifest(sampleManifest);

    expect(result.waveId).toBe('WAVE-001');
    expect(result.totalVMs).toBe(2);
    expect(result.validVMs).toBe(2);
    expect(result.invalidVMs).toBe(0);
    expect(result.manifest).toBeDefined();
    expect(result.manifest.vms).toHaveLength(2);
    expect(result.manifest.site).toBe('NDCNG');
  });

  test('loadManifest rejects manifest with missing mandatory tags', async () => {
    const badManifest = {
      waveId: 'WAVE-BAD',
      site: 'NDCNG',
      scheduledDate: '2026-04-15T06:00:00Z',
      vms: [
        {
          vmId: 'vm-bad-001',
          vmName: 'BAD-VM-01',
          tags: {
            Region: 'NDCNG'
            // Missing SecurityZone, Environment, AppCI, SystemRole
          }
        }
      ]
    };

    const result = await tagger.loadManifest(badManifest);

    expect(result.validVMs).toBe(0);
    expect(result.invalidVMs).toBe(1);
    expect(result.manifest.invalidVMs).toHaveLength(1);
    expect(result.manifest.invalidVMs[0].errors.length).toBeGreaterThan(0);
  });

  test('executeWave completes bulk tagging and reports results', async () => {
    await tagger.loadManifest(sampleManifest);

    const result = await tagger.executeWave('WAVE-001', 'NDCNG');

    expect(result.waveId).toBe('WAVE-001');
    expect(result.processedCount).toBe(2);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
    expect(result.status).toBe('completed');
    expect(deps.bulkTagOrchestrator.executeBulk).toHaveBeenCalledTimes(1);

    // Verify the bulk payload included the correct VMs
    const bulkCall = deps.bulkTagOrchestrator.executeBulk.mock.calls[0][0];
    expect(bulkCall.vms).toHaveLength(2);
    expect(bulkCall.site).toBe('NDCNG');
    expect(bulkCall.correlationId).toContain('MIGRATION-WAVE-001');
  });
});

// ---------------------------------------------------------------------------
// Event-driven CMDB Sync
// ---------------------------------------------------------------------------
describe('EndToEndPipeline - Event-driven CMDB Sync', () => {
  let deps;
  let orchestrator;
  let logger;
  let sagaCoordinator;

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    sagaCoordinator = new SagaCoordinator(logger);

    deps = {
      configLoader: {
        getEndpointsForSite: jest.fn().mockReturnValue({
          vcenterUrl: 'https://vcenter-ndcng.test',
          nsxUrl: 'https://nsx-ndcng.test',
          nsxGlobalUrl: 'https://nsx-global-ndcng.test'
        })
      },
      restClient: {
        get: jest.fn().mockResolvedValue({}),
        post: jest.fn().mockResolvedValue({ status: 200 }),
        patch: jest.fn().mockResolvedValue({ status: 200 }),
        delete: jest.fn().mockResolvedValue({ status: 200 })
      },
      logger,
      payloadValidator: {
        validate: jest.fn().mockReturnValue({ valid: true, errors: [] })
      },
      sagaCoordinator,
      deadLetterQueue: {
        enqueue: jest.fn().mockImplementation((payload, error, correlationId) => {
          return `DLQ-${correlationId}`;
        })
      },
      tagOperations: {
        getTags: jest.fn().mockResolvedValue({
          tags: {
            Environment: 'Production',
            SystemRole: 'Application'
          }
        }),
        updateTags: jest.fn().mockResolvedValue({ updated: true }),
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        removeTags: jest.fn().mockResolvedValue({ removed: true }),
        verifyPropagation: jest.fn().mockResolvedValue({ propagated: true })
      },
      groupVerifier: {
        verifyMembership: jest.fn().mockResolvedValue({
          verified: true,
          groups: ['APP001_Web_Staging', 'All-Staging-VMs']
        }),
        predictGroupChanges: jest.fn().mockResolvedValue({
          groupsToJoin: ['APP001_Web_Staging'],
          groupsToLeave: ['APP001_App_Production'],
          unchangedGroups: ['All-PCI-VMs']
        })
      },
      dfwValidator: {
        validatePolicies: jest.fn().mockResolvedValue({
          compliant: true,
          policies: [
            {
              policyName: 'APP001-Web-Allow-HTTPS',
              action: 'ALLOW',
              sourceGroups: ['Load-Balancers'],
              destinationGroups: ['APP001_Web_Staging'],
              services: ['TCP/443']
            }
          ]
        })
      },
      snowAdapter: {
        toCallbackPayload: jest.fn().mockImplementation(r => r),
        toErrorCallback: jest.fn().mockImplementation(e => e)
      }
    };

    orchestrator = new Day2Orchestrator(deps);
  });

  const day2Payload = {
    correlationId: 'RITM-DAY2-001-1700000000',
    requestType: 'Day2',
    vmId: 'vm-ci-001',
    vmName: 'APP001-APP-P01',
    site: 'NDCNG',
    tags: {
      Environment: 'Staging',
      SystemRole: 'Web'
    },
    expectedCurrentTags: {
      Environment: 'Production',
      SystemRole: 'Application'
    },
    callbackUrl: 'https://snow.test/callback'
  };

  test('CI change triggers Day-2 orchestration with full pipeline', async () => {
    const result = await orchestrator.run(day2Payload);

    expect(result.success).toBe(true);
    expect(result.correlationId).toBe('RITM-DAY2-001-1700000000');
    expect(result.requestType).toBe('Day2');

    // Verify execution data
    expect(result.execution).toBeDefined();
    expect(result.execution.vmId).toBe('vm-ci-001');
    expect(result.execution.previousTags).toBeDefined();
    expect(result.execution.desiredTags).toEqual({
      Environment: 'Staging',
      SystemRole: 'Web'
    });
    expect(result.execution.impactAnalysis).toBeDefined();
    expect(result.execution.impactAnalysis.groupsToJoin).toEqual(
      expect.arrayContaining(['APP001_Web_Staging'])
    );
    expect(result.execution.propagation.propagated).toBe(true);

    // Verify verification data
    expect(result.verification).toBeDefined();
    expect(result.verification.groupMemberships).toBeDefined();
    expect(result.verification.activeDFWPolicies).toBeDefined();
    expect(result.verification.activeDFWPolicies.compliant).toBe(true);

    // Verify tag operations were called
    expect(deps.tagOperations.getTags).toHaveBeenCalledWith('vm-ci-001', 'NDCNG');
    expect(deps.tagOperations.updateTags).toHaveBeenCalledWith(
      'vm-ci-001',
      { Environment: 'Staging', SystemRole: 'Web' },
      'NDCNG'
    );
    expect(deps.tagOperations.verifyPropagation).toHaveBeenCalled();
  });

  test('Day-2 tag update completes successfully with callback', async () => {
    const result = await orchestrator.run(day2Payload);

    expect(result.success).toBe(true);

    // Verify callback was sent to ServiceNow
    const callbackCalls = deps.restClient.post.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('/callback')
    );
    expect(callbackCalls.length).toBeGreaterThan(0);

    const callbackPayload = callbackCalls[0][1];
    expect(callbackPayload.correlationId).toBe('RITM-DAY2-001-1700000000');
    expect(callbackPayload.status).toBe('completed');
    expect(callbackPayload.result.success).toBe(true);
  });

  test('Day-2 detects drift and still completes successfully', async () => {
    // Current tags differ from expectedCurrentTags — drift scenario
    deps.tagOperations.getTags.mockResolvedValue({
      tags: {
        Environment: 'Development',
        SystemRole: 'Utility'
      }
    });

    const result = await orchestrator.run(day2Payload);

    expect(result.success).toBe(true);
    // Drift should have been logged as a warning
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('drift'),
      expect.objectContaining({ vmId: 'vm-ci-001' })
    );
  });
});
