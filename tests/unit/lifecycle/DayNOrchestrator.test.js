'use strict';

const DayNOrchestrator = require('../../../src/vro/actions/lifecycle/DayNOrchestrator');
const LifecycleOrchestrator = require('../../../src/vro/actions/lifecycle/LifecycleOrchestrator');

// Stub out _sleep to avoid real delays in tests
beforeAll(() => {
  jest.spyOn(DayNOrchestrator, '_sleep').mockResolvedValue(undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('DayNOrchestrator', () => {
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
        enqueue: jest.fn().mockReturnValue('DLQ-dayN-001')
      },
      tagOperations: {
        getTags: jest.fn().mockResolvedValue({
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'APP001',
          SystemRole: 'Web'
        }),
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        removeTags: jest.fn().mockResolvedValue({ removed: true }),
        verifyPropagation: jest.fn().mockResolvedValue({ propagated: true })
      },
      groupVerifier: {
        // _getGroupMemberships calls getEffectiveGroups (returns array of group names)
        getEffectiveGroups: jest.fn().mockResolvedValue(
          ['APP001_Web_Production', 'All-Production-VMs']
        ),
        // _checkDependencies calls getGroupMembers for each group
        getGroupMembers: jest.fn().mockResolvedValue({ members: ['vm-456', 'vm-789'] }),
        verifyMembership: jest.fn().mockResolvedValue({
          verified: true,
          groups: []
        })
      },
      dfwValidator: {
        // _verifyCleanup calls validatePolicies
        validatePolicies: jest.fn().mockResolvedValue({
          compliant: false,
          policies: []
        }),
        // _checkOrphanedRules calls checkOrphanedRules
        checkOrphanedRules: jest.fn().mockResolvedValue({
          orphanedRules: []
        }),
        // _checkDependencies calls getRulesReferencingGroup
        getRulesReferencingGroup: jest.fn().mockResolvedValue({ rules: [] }),
        getEffectiveRules: jest.fn().mockResolvedValue([])
      },
      snowAdapter: {
        updateCI: jest.fn().mockResolvedValue({ updated: true }),
        toCallbackPayload: jest.fn().mockImplementation(r => r),
        toErrorCallback: jest.fn().mockImplementation(e => e)
      }
    };

    // For the full run() flow:
    // First call to getEffectiveGroups (execute phase: _getGroupMemberships) returns groups.
    // Subsequent calls (verify phase: _verifyGroupRemoval polling) return empty = fully removed.
    deps.groupVerifier.getEffectiveGroups
      .mockResolvedValueOnce(['APP001_Web_Production', 'All-Production-VMs'])
      .mockResolvedValue([]);

    orchestrator = new DayNOrchestrator(deps);
  });

  const validPayload = {
    correlationId: 'RITM-3456-1700000000',
    requestType: 'DayN',
    vmId: 'vm-456',
    vmName: 'NDCNG-APP001-WEB-P01',
    site: 'NDCNG',
    callbackUrl: 'https://snow.test/callback',
    callbackToken: 'test-token'
  };

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------
  describe('happy path', () => {
    test('all cleanup and decommission steps succeed', async () => {
      const result = await orchestrator.run(validPayload);

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.correlationId).toBe('RITM-3456-1700000000');
      expect(result.requestType).toBe('DayN');

      // Verify all key steps were called
      expect(deps.payloadValidator.validate).toHaveBeenCalledWith(validPayload);
      expect(deps.configLoader.getEndpointsForSite).toHaveBeenCalledWith('NDCNG');
      expect(deps.sagaCoordinator.begin).toHaveBeenCalledWith('RITM-3456-1700000000');

      // Step 1: Current tags read
      expect(deps.tagOperations.getTags).toHaveBeenCalledWith('vm-456', 'NDCNG');

      // Step 2: Group memberships read via getEffectiveGroups
      expect(deps.groupVerifier.getEffectiveGroups).toHaveBeenCalledWith('vm-456', 'NDCNG');

      // Step 4: Orphaned rules checked — called with the groups array from memberships
      expect(deps.dfwValidator.checkOrphanedRules).toHaveBeenCalledWith(
        ['APP001_Web_Production', 'All-Production-VMs'],
        'NDCNG'
      );

      // Step 5: Tags removed — categories are the Object.keys of the tags
      expect(deps.tagOperations.removeTags).toHaveBeenCalledWith(
        'vm-456',
        ['Region', 'SecurityZone', 'Environment', 'AppCI', 'SystemRole'],
        'NDCNG'
      );

      // Step 8: VM deprovisioned (power off + delete)
      expect(deps.restClient.post).toHaveBeenCalledWith(
        'https://vcenter-ndcng.test/api/vcenter/vm/vm-456/power',
        { action: 'stop' }
      );
      expect(deps.restClient.delete).toHaveBeenCalledWith(
        'https://vcenter-ndcng.test/api/vcenter/vm/vm-456'
      );

      // Step 9: CMDB updated
      expect(deps.snowAdapter.updateCI).toHaveBeenCalled();
    });

    test('execution result contains decommission data', async () => {
      const result = await orchestrator.run(validPayload);

      expect(result.execution).toBeDefined();
      expect(result.execution.vmId).toBe('vm-456');
      expect(result.execution.previousTags).toEqual({
        Region: 'NDCNG',
        SecurityZone: 'Greenzone',
        Environment: 'Production',
        AppCI: 'APP001',
        SystemRole: 'Web'
      });
      expect(result.execution.previousGroups).toBeDefined();
      expect(result.execution.previousGroups.groups).toEqual(
        ['APP001_Web_Production', 'All-Production-VMs']
      );
      expect(result.execution.dependencyCheck.hasDependencies).toBe(false);
      expect(result.execution.orphanedRulesCheck.hasOrphanedRules).toBe(false);
      expect(result.execution.tagRemoval).toBeDefined();
    });

    test('verification includes group removal and cleanup', async () => {
      const result = await orchestrator.run(validPayload);

      expect(result.verification).toBeDefined();
      expect(result.verification.groupRemoval).toBeDefined();
      expect(result.verification.groupRemoval.fullyRemoved).toBe(true);
      expect(result.verification.cleanupValidation).toBeDefined();
      expect(result.verification.deprovision).toBeDefined();
      expect(result.verification.deprovision.status).toBe('deprovisioned');
      expect(result.verification.cmdbUpdate).toBeDefined();
    });

    test('sends success callback to ServiceNow', async () => {
      await orchestrator.run(validPayload);

      expect(deps.restClient.post).toHaveBeenCalledWith(
        'https://snow.test/callback',
        expect.objectContaining({
          correlationId: 'RITM-3456-1700000000',
          status: 'completed'
        })
      );
    });

    test('records removeTags in saga for rollback', async () => {
      await orchestrator.run(validPayload);

      expect(deps.sagaCoordinator.recordStep).toHaveBeenCalledWith(
        'removeTags',
        expect.any(Function)
      );
    });

    test('workflowStepDurations is populated in result', async () => {
      const result = await orchestrator.run(validPayload);

      expect(result.workflowStepDurations).toBeDefined();
      expect(typeof result.workflowStepDurations).toBe('object');
    });
  });

  // ---------------------------------------------------------------------------
  // Dependency check halts decommission
  // ---------------------------------------------------------------------------
  describe('dependency check', () => {
    test('halts decommission when VM is sole member of group with referencing rules', async () => {
      // The VM is the only member of each group
      deps.groupVerifier.getGroupMembers.mockResolvedValue({ members: ['vm-456'] });
      // DFW rules reference these groups
      deps.dfwValidator.getRulesReferencingGroup.mockResolvedValue({
        rules: [{ ruleId: 'rule-001', ruleName: 'Allow-HTTPS' }]
      });
      deps.sagaCoordinator.isActive.mockReturnValue(true);

      const result = await orchestrator.run(validPayload);

      expect(result.success).toBe(false);
      expect(result.error.message).toContain('dependencies found');

      // Tags should NOT have been removed (dependency check halts before removeTags)
      expect(deps.tagOperations.removeTags).not.toHaveBeenCalled();

      // VM should NOT have been deleted
      expect(deps.restClient.delete).not.toHaveBeenCalled();
    });

    test('dependency error includes group details in message', async () => {
      deps.groupVerifier.getGroupMembers.mockResolvedValue({ members: ['vm-456'] });
      deps.dfwValidator.getRulesReferencingGroup.mockResolvedValue({
        rules: [{ ruleId: 'rule-001' }]
      });
      deps.sagaCoordinator.isActive.mockReturnValue(true);

      const result = await orchestrator.run(validPayload);

      expect(result.success).toBe(false);
      // The error message should include group names from the dependency details
      expect(result.error.message).toContain('APP001_Web_Production');
    });
  });

  // ---------------------------------------------------------------------------
  // Orphaned rule detection
  // ---------------------------------------------------------------------------
  describe('orphaned rule detection', () => {
    test('orphaned rules are detected and logged as warnings', async () => {
      deps.dfwValidator.checkOrphanedRules.mockResolvedValue({
        orphanedRules: [
          { ruleId: 'rule-001', ruleName: 'Allow-HTTPS', group: 'APP001_Web_Production' }
        ]
      });

      const result = await orchestrator.run(validPayload);

      // Workflow should still succeed - orphaned rules are warnings, not blockers
      expect(result.success).toBe(true);
      expect(result.execution.orphanedRulesCheck.hasOrphanedRules).toBe(true);
      expect(result.execution.orphanedRulesCheck.orphanedRules).toHaveLength(1);

      // Warning should be logged
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Orphaned DFW rules detected'),
        expect.objectContaining({
          orphanedRuleCount: 1
        })
      );
    });

    test('no orphaned rules produces clean result', async () => {
      const result = await orchestrator.run(validPayload);

      expect(result.execution.orphanedRulesCheck.hasOrphanedRules).toBe(false);
      expect(result.execution.orphanedRulesCheck.orphanedRules).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Tag removal failure triggers saga compensation
  // ---------------------------------------------------------------------------
  describe('tag removal failure', () => {
    test('tag removal failure triggers saga compensation', async () => {
      deps.tagOperations.removeTags.mockRejectedValue(new Error('NSX tag removal failed'));
      deps.sagaCoordinator.isActive.mockReturnValue(true);

      const result = await orchestrator.run(validPayload);

      expect(result.success).toBe(false);
      expect(result.error.message).toContain('NSX tag removal failed');
      expect(deps.sagaCoordinator.compensate).toHaveBeenCalled();
    });

    test('tag removal failure enqueues to dead letter queue', async () => {
      deps.tagOperations.removeTags.mockRejectedValue(new Error('NSX tag removal failed'));
      deps.sagaCoordinator.isActive.mockReturnValue(true);

      const result = await orchestrator.run(validPayload);

      expect(deps.deadLetterQueue.enqueue).toHaveBeenCalledWith(
        validPayload,
        expect.any(Error),
        'RITM-3456-1700000000'
      );
      expect(result.dlqId).toBe('DLQ-dayN-001');
    });
  });

  // ---------------------------------------------------------------------------
  // Sub-step: _checkDependencies
  // ---------------------------------------------------------------------------
  describe('_checkDependencies', () => {
    test('returns no dependencies when safe to decommission', async () => {
      // Multiple members in group: removing vm-456 still leaves vm-789
      deps.groupVerifier.getGroupMembers.mockResolvedValue({ members: ['vm-456', 'vm-789'] });

      const groupMemberships = { groups: ['APP001_Web_Production'], membershipCount: 1 };
      const result = await orchestrator._checkDependencies('vm-456', 'NDCNG', groupMemberships);

      expect(result.hasDependencies).toBe(false);
      expect(result.dependencies).toEqual([]);
    });

    test('throws DFW-7005 when dependencies found', async () => {
      // VM is sole member
      deps.groupVerifier.getGroupMembers.mockResolvedValue({ members: ['vm-456'] });
      // Rules reference this group
      deps.dfwValidator.getRulesReferencingGroup.mockResolvedValue({
        rules: [{ ruleId: 'rule-001' }]
      });

      const groupMemberships = { groups: ['APP001_Web_Production'], membershipCount: 1 };

      await expect(orchestrator._checkDependencies('vm-456', 'NDCNG', groupMemberships))
        .rejects.toThrow(/dependencies found/);

      try {
        await orchestrator._checkDependencies('vm-456', 'NDCNG', groupMemberships);
      } catch (err) {
        expect(err.code).toBe('DFW-7005');
        expect(err.name).toBe('DfwError');
      }
    });

    test('treats group check failure as safe (catches error and proceeds)', async () => {
      deps.groupVerifier.getGroupMembers.mockRejectedValue(new Error('API down'));

      const groupMemberships = { groups: ['APP001_Web_Production'], membershipCount: 1 };
      const result = await orchestrator._checkDependencies('vm-456', 'NDCNG', groupMemberships);

      expect(result.hasDependencies).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Sub-step: _checkOrphanedRules
  // ---------------------------------------------------------------------------
  describe('_checkOrphanedRules', () => {
    test('returns orphaned rules when found', async () => {
      deps.dfwValidator.checkOrphanedRules.mockResolvedValue({
        orphanedRules: [
          { ruleId: 'rule-001', group: 'APP001_Web_Production' }
        ]
      });

      const groupMemberships = { groups: ['APP001_Web_Production'], membershipCount: 1 };
      const result = await orchestrator._checkOrphanedRules(groupMemberships, 'NDCNG');

      expect(result.hasOrphanedRules).toBe(true);
      expect(result.orphanedRules).toHaveLength(1);
    });

    test('returns clean result when no orphaned rules', async () => {
      const groupMemberships = { groups: ['APP001_Web_Production'], membershipCount: 1 };
      const result = await orchestrator._checkOrphanedRules(groupMemberships, 'NDCNG');

      expect(result.hasOrphanedRules).toBe(false);
      expect(result.orphanedRules).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Sub-step: _removeTags
  // ---------------------------------------------------------------------------
  describe('_removeTags', () => {
    test('removes all tag categories', async () => {
      const categories = ['Region', 'SecurityZone', 'Environment', 'AppCI', 'SystemRole'];
      const result = await orchestrator._removeTags('vm-456', categories, 'NDCNG');

      expect(result.vmId).toBe('vm-456');
      expect(result.removedCategories).toEqual(categories);
      expect(result.categoryCount).toBe(5);
      expect(deps.tagOperations.removeTags).toHaveBeenCalledWith(
        'vm-456',
        categories,
        'NDCNG'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Sub-step: _deprovisionVM
  // ---------------------------------------------------------------------------
  describe('_deprovisionVM', () => {
    test('powers off and deletes VM', async () => {
      const endpoints = { vcenterUrl: 'https://vcenter-ndcng.test' };
      const result = await orchestrator._deprovisionVM('vm-456', endpoints);

      expect(result.vmId).toBe('vm-456');
      expect(result.status).toBe('deprovisioned');
      expect(result.deprovisionedAt).toBeDefined();

      // Power off call
      expect(deps.restClient.post).toHaveBeenCalledWith(
        'https://vcenter-ndcng.test/api/vcenter/vm/vm-456/power',
        { action: 'stop' }
      );

      // Delete call
      expect(deps.restClient.delete).toHaveBeenCalledWith(
        'https://vcenter-ndcng.test/api/vcenter/vm/vm-456'
      );
    });

    test('continues if power-off fails (VM may already be off)', async () => {
      deps.restClient.post.mockRejectedValue(new Error('VM already powered off'));
      const endpoints = { vcenterUrl: 'https://vcenter-ndcng.test' };

      const result = await orchestrator._deprovisionVM('vm-456', endpoints);

      expect(result.status).toBe('deprovisioned');
      expect(deps.restClient.delete).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Sub-step: _updateCMDB
  // ---------------------------------------------------------------------------
  describe('_updateCMDB', () => {
    test('updates CMDB via snowAdapter', async () => {
      const result = await orchestrator._updateCMDB(validPayload);

      expect(result.updated).toBe(true);
      expect(result.status).toBe('decommissioned');
      expect(deps.snowAdapter.updateCI).toHaveBeenCalledWith(
        'NDCNG-APP001-WEB-P01',
        expect.objectContaining({
          correlationId: 'RITM-3456-1700000000',
          status: 'decommissioned'
        })
      );
    });

    test('returns failure status when CMDB update fails (does not throw)', async () => {
      deps.snowAdapter.updateCI.mockRejectedValue(new Error('SNOW unreachable'));

      const result = await orchestrator._updateCMDB(validPayload);

      expect(result.updated).toBe(false);
      expect(result.status).toBe('cmdb_update_failed');
      expect(result.error).toContain('SNOW unreachable');
    });
  });

  // ---------------------------------------------------------------------------
  // prepare() — vmId resolution
  // ---------------------------------------------------------------------------
  describe('prepare', () => {
    test('uses vmId when present', async () => {
      const endpoints = { vcenterUrl: 'https://vcenter-ndcng.test' };
      const result = await orchestrator.prepare(validPayload, endpoints);

      expect(result.vmId).toBe('vm-456');
      expect(result.intent).toBe('decommission');
    });

    test('falls back to vmName when vmId is missing', async () => {
      const payloadWithoutVmId = { ...validPayload, vmId: undefined };
      const endpoints = { vcenterUrl: 'https://vcenter-ndcng.test' };
      const result = await orchestrator.prepare(payloadWithoutVmId, endpoints);

      expect(result.vmId).toBe('NDCNG-APP001-WEB-P01');
    });

    test('throws when neither vmId nor vmName is provided', async () => {
      const payloadNoVm = { ...validPayload, vmId: undefined, vmName: undefined };
      const endpoints = { vcenterUrl: 'https://vcenter-ndcng.test' };

      await expect(orchestrator.prepare(payloadNoVm, endpoints))
        .rejects.toThrow(/vmId or vmName/);
    });
  });

  // ---------------------------------------------------------------------------
  // Factory method
  // ---------------------------------------------------------------------------
  test('factory method creates correct orchestrator type', () => {
    const dayN = LifecycleOrchestrator.create('DayN', deps);
    expect(dayN).toBeInstanceOf(DayNOrchestrator);
  });
});
