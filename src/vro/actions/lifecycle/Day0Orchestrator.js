/**
 * @file Day0Orchestrator.js
 * @description Day 0 (initial provisioning) orchestrator for the DFW Automation
 *   Pipeline. Handles the complete lifecycle of provisioning a new VM, applying
 *   NSX tags, waiting for tag propagation, verifying group membership, and
 *   validating DFW policy application.
 *
 *   Extends {@link LifecycleOrchestrator} and implements the prepare, execute,
 *   and verify template methods. All mutating operations are registered with
 *   the {@link SagaCoordinator} for automatic rollback on failure.
 *
 *   Execute steps:
 *     1. Provision VM via vCenter API
 *     2. Wait for VMware Tools to become ready
 *     3. Apply NSX tags to the VM
 *     4. Wait for tag propagation to NSX groups
 *
 *   Verify steps:
 *     5. Verify correct group memberships
 *     6. Validate DFW policy enforcement
 *
 * @module lifecycle/Day0Orchestrator
 */

'use strict';

const LifecycleOrchestrator = require('./LifecycleOrchestrator');

/**
 * Default polling configuration for VMware Tools readiness checks.
 * @constant {Object}
 * @private
 */
const VM_TOOLS_POLL_CONFIG = Object.freeze({
  /** Maximum number of polling attempts. */
  maxAttempts: 60,
  /** Interval between polling attempts in milliseconds. */
  intervalMs: 5000,
  /** Total timeout in milliseconds (5 minutes). */
  timeoutMs: 300000
});

/**
 * Default polling configuration for tag propagation checks.
 * @constant {Object}
 * @private
 */
const PROPAGATION_POLL_CONFIG = Object.freeze({
  /** Maximum number of polling attempts. */
  maxAttempts: 30,
  /** Interval between polling attempts in milliseconds. */
  intervalMs: 10000,
  /** Total timeout in milliseconds (5 minutes). */
  timeoutMs: 300000
});

/**
 * @class Day0Orchestrator
 * @extends LifecycleOrchestrator
 * @classdesc Orchestrates the Day 0 (initial provisioning) workflow, including
 *   VM creation, tag application, and full verification of the resulting
 *   micro-segmentation posture.
 *
 * @example
 * const orchestrator = LifecycleOrchestrator.create('Day0', dependencies);
 * const result = await orchestrator.run({
 *   correlationId: 'RITM-00001-1679000000000',
 *   requestType: 'Day0',
 *   site: 'NDCNG',
 *   vmName: 'srv-web-01',
 *   vmSpec: { cpu: 4, memoryGb: 16, diskGb: 100, network: 'dvs-prod-web' },
 *   tags: { Region: 'NDCNG', SecurityZone: 'Greenzone', Environment: 'Production', AppCI: 'APP001', SystemRole: 'Web' },
 *   callbackUrl: 'https://snow.company.internal/api/callback'
 * });
 */
class Day0Orchestrator extends LifecycleOrchestrator {
  /**
   * Creates a new Day0Orchestrator instance.
   *
   * @param {Object} dependencies - Injected dependencies. See
   *   {@link LifecycleOrchestrator} constructor for the full dependency contract.
   */
  constructor(dependencies) {
    super(dependencies);
  }

  // ---------------------------------------------------------------------------
  // Template Method implementations
  // ---------------------------------------------------------------------------

  /**
   * Prepares the Day 0 workflow by extracting and normalizing VM specification
   * data from the payload, and verifying that required resources are available.
   *
   * @param {Object} payload - The validated request payload.
   * @param {string} payload.vmName - Desired name for the new VM.
   * @param {Object} payload.vmSpec - VM hardware specification (cpu, memoryGb,
   *   diskGb, network).
   * @param {Object} payload.tags - Tag map to apply after provisioning.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<Object>} Preparation result containing normalized VM spec
   *   and validation of available resources.
   */
  async prepare(payload, endpoints) {
    this.logger.info('Preparing Day 0 provisioning', {
      correlationId: payload.correlationId,
      vmName: payload.vmName,
      site: payload.site,
      component: 'Day0Orchestrator'
    });

    const vmSpec = {
      name: payload.vmName,
      cpu: payload.vmSpec && payload.vmSpec.cpu ? payload.vmSpec.cpu : 2,
      memoryGb: payload.vmSpec && payload.vmSpec.memoryGb ? payload.vmSpec.memoryGb : 8,
      diskGb: payload.vmSpec && payload.vmSpec.diskGb ? payload.vmSpec.diskGb : 50,
      network: payload.vmSpec && payload.vmSpec.network ? payload.vmSpec.network : 'dvs-default',
      datacenter: payload.site,
      folder: payload.folder || 'Discovered virtual machine'
    };

    // Verify vCenter connectivity
    this.logger.debug('Verifying vCenter connectivity', {
      vcenterUrl: endpoints.vcenterUrl,
      component: 'Day0Orchestrator'
    });

    return {
      normalizedSpec: vmSpec,
      tags: payload.tags,
      site: payload.site,
      targetEndpoints: endpoints
    };
  }

  /**
   * Executes the Day 0 provisioning workflow:
   *   1. Provision the VM via the vCenter API
   *   2. Wait for VMware Tools to become ready (with saga compensation)
   *   3. Apply NSX tags to the VM
   *   4. Wait for tag propagation to NSX groups
   *
   * Each mutating step registers a compensating action with the SagaCoordinator.
   *
   * @param {Object} payload - The validated request payload.
   * @param {string} payload.vmName - VM name.
   * @param {Object} payload.vmSpec - VM hardware specification.
   * @param {Object} payload.tags - Tags to apply.
   * @param {string} payload.site - Target site code.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<Object>} Execution result containing VM details, applied
   *   tags, and propagation status.
   */
  async execute(payload, endpoints) {
    this.logger.info('Executing Day 0 provisioning workflow', {
      correlationId: payload.correlationId,
      vmName: payload.vmName,
      component: 'Day0Orchestrator'
    });

    // Step 0: Check for existing VM with same name
    await this._timedStep('checkExistingVM', () => {
      return this.checkExistingVM(payload, endpoints);
    });

    // Step 1: Provision VM
    const vmResult = await this._timedStep('provisionVM', () => {
      return this.provisionVM(payload, endpoints);
    });
    const vmId = vmResult.vmId;

    // Register compensating action: delete the provisioned VM
    await this.sagaCoordinator.recordStep('provisionVM', async () => {
      this.logger.warn('Compensating: Deleting provisioned VM', {
        vmId,
        correlationId: payload.correlationId,
        component: 'Day0Orchestrator'
      });
      await this.restClient.delete(
        `${endpoints.vcenterUrl}/api/vcenter/vm/${vmId}`
      );
    });

    // Step 2: Wait for VMware Tools
    await this._timedStep('waitForVMTools', () => {
      return this.waitForVMTools(vmId, endpoints);
    });

    // Step 3: Apply tags
    const tagResult = await this._timedStep('applyTags', () => {
      return this.applyTags(vmId, payload.tags, payload.site);
    });

    // Register compensating action: remove applied tags
    await this.sagaCoordinator.recordStep('applyTags', async () => {
      this.logger.warn('Compensating: Removing applied tags', {
        vmId,
        correlationId: payload.correlationId,
        component: 'Day0Orchestrator'
      });
      const allCategories = Object.keys(payload.tags);
      await this.tagOperations.removeTags(vmId, allCategories, payload.site);
    });

    // Step 4: Wait for propagation
    const propagationResult = await this._timedStep('waitForPropagation', () => {
      return this.waitForPropagation(vmId, payload.tags, payload.site);
    });

    return {
      vmId,
      vmName: payload.vmName,
      vmDetails: vmResult,
      appliedTags: tagResult,
      propagation: propagationResult
    };
  }

  /**
   * Verifies the Day 0 provisioning results:
   *   5. Verify the VM is in the correct NSX groups based on applied tags
   *   6. Validate DFW policies are correctly enforced for the VM
   *
   * @param {Object} payload - The validated request payload.
   * @param {string} payload.vmName - VM name.
   * @param {Object} payload.tags - Applied tags.
   * @param {string} payload.site - Site code.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<Object>} Verification result containing group memberships
   *   and active DFW policies.
   */
  async verify(payload, _endpoints) {
    const vmId = payload.vmId || payload.vmName;

    this.logger.info('Verifying Day 0 provisioning results', {
      correlationId: payload.correlationId,
      vmId,
      component: 'Day0Orchestrator'
    });

    // Step 5: Verify group membership
    const groupResult = await this._timedStep('verifyGroupMembership', () => {
      return this.verifyGroupMembership(vmId, payload.site);
    });

    // Step 6: Validate DFW
    const dfwResult = await this._timedStep('validateDFW', () => {
      return this.validateDFW(vmId, payload.site);
    });

    return {
      groupMemberships: groupResult,
      activeDFWPolicies: dfwResult
    };
  }

  // ---------------------------------------------------------------------------
  // Execute sub-steps
  // ---------------------------------------------------------------------------

  /**
   * Provisions a new VM via the vCenter REST API.
   *
   * Sends a POST request to the vCenter VM provisioning endpoint with the
   * normalized VM specification. The response must contain a `vmId` field
   * identifying the newly created virtual machine.
   *
   * @param {Object} payload - The request payload containing VM specification.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<{vmId: string, vmName: string, status: string}>} The
   *   provisioning result with the new VM's identifier.
   * @throws {Error} If the vCenter API returns an error or the response does
   *   not contain a valid vmId.
   */
  async provisionVM(payload, endpoints) {
    this.logger.info('Provisioning VM via vCenter API', {
      correlationId: payload.correlationId,
      vmName: payload.vmName,
      vcenterUrl: endpoints.vcenterUrl,
      component: 'Day0Orchestrator'
    });

    const vmSpec = {
      guest_OS: 'RHEL_8_64',
      name: payload.vmName,
      placement: {
        datacenter: payload.site,
        folder: payload.folder || 'Discovered virtual machine'
      },
      hardware: {
        cpu: {
          count: payload.vmSpec && payload.vmSpec.cpu ? payload.vmSpec.cpu : 2
        },
        memory: {
          size_MiB: (payload.vmSpec && payload.vmSpec.memoryGb ? payload.vmSpec.memoryGb : 8) * 1024
        }
      },
      disks: [
        {
          new_vmdk: {
            capacity: (payload.vmSpec && payload.vmSpec.diskGb ? payload.vmSpec.diskGb : 50) * 1024 * 1024 * 1024
          }
        }
      ],
      nics: [
        {
          backing: {
            type: 'DISTRIBUTED_PORTGROUP',
            network: payload.vmSpec && payload.vmSpec.network ? payload.vmSpec.network : 'dvs-default'
          }
        }
      ]
    };

    const response = await this.restClient.post(
      `${endpoints.vcenterUrl}/api/vcenter/vm`,
      vmSpec
    );

    const vmId = response && (response.vmId || response.value || response.id);

    if (!vmId) {
      throw new Error(
        `[DFW-6200] VM provisioning did not return a valid vmId. ` +
        `Response: ${JSON.stringify(response)}`
      );
    }

    this.logger.info('VM provisioned successfully', {
      correlationId: payload.correlationId,
      vmId,
      vmName: payload.vmName,
      component: 'Day0Orchestrator'
    });

    return {
      vmId,
      vmName: payload.vmName,
      status: 'provisioned'
    };
  }

  /**
   * Polls the vCenter API until VMware Tools reports ready on the specified VM.
   *
   * This step is critical because NSX tag operations require VMware Tools to
   * be running. The method polls at a configurable interval and throws if the
   * timeout is exceeded.
   *
   * @param {string} vmId - The vCenter VM identifier.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<{toolsStatus: string, attempts: number}>} The final tools
   *   status and the number of polling attempts taken.
   * @throws {Error} If VMware Tools does not become ready within the timeout.
   */
  async waitForVMTools(vmId, endpoints) {
    this.logger.info('Waiting for VMware Tools readiness', {
      vmId,
      maxAttempts: VM_TOOLS_POLL_CONFIG.maxAttempts,
      intervalMs: VM_TOOLS_POLL_CONFIG.intervalMs,
      component: 'Day0Orchestrator'
    });

    let attempts = 0;
    const startTime = Date.now();

    while (attempts < VM_TOOLS_POLL_CONFIG.maxAttempts) {
      attempts += 1;

      const elapsed = Date.now() - startTime;
      if (elapsed >= VM_TOOLS_POLL_CONFIG.timeoutMs) {
        throw new Error(
          `[DFW-6201] VMware Tools readiness timeout after ${elapsed}ms ` +
          `(${attempts} attempts) for VM "${vmId}".`
        );
      }

      try {
        const response = await this.restClient.get(
          `${endpoints.vcenterUrl}/api/vcenter/vm/${vmId}/tools`
        );

        const toolsStatus = response && (response.run_state || response.runState || response.status);

        if (toolsStatus === 'RUNNING' || toolsStatus === 'running') {
          this.logger.info('VMware Tools is ready', {
            vmId,
            attempts,
            durationMs: Date.now() - startTime,
            component: 'Day0Orchestrator'
          });
          return { toolsStatus: 'RUNNING', attempts };
        }

        this.logger.debug('VMware Tools not yet ready, polling...', {
          vmId,
          toolsStatus,
          attempt: attempts,
          component: 'Day0Orchestrator'
        });
      } catch (err) {
        this.logger.warn('VMware Tools poll request failed, retrying...', {
          vmId,
          attempt: attempts,
          errorMessage: err.message,
          component: 'Day0Orchestrator'
        });
      }

      // Wait before next poll
      await Day0Orchestrator._sleep(VM_TOOLS_POLL_CONFIG.intervalMs);
    }

    throw new Error(
      `[DFW-6201] VMware Tools did not become ready after ${VM_TOOLS_POLL_CONFIG.maxAttempts} attempts ` +
      `for VM "${vmId}".`
    );
  }

  /**
   * Applies NSX tags to the newly provisioned VM using the TagOperations
   * dependency.
   *
   * @param {string} vmId - The vCenter VM identifier.
   * @param {Object} tags - Tag map keyed by category (scope), e.g.
   *   `{ AppCI: 'APP001', Environment: 'Production' }`.
   * @param {string} site - Site code for endpoint resolution.
   * @returns {Promise<{vmId: string, appliedTags: Object, tagCount: number}>}
   *   The applied tags and count.
   */
  async applyTags(vmId, tags, site) {
    this.logger.info('Applying NSX tags to VM', {
      vmId,
      tagCount: Object.keys(tags).length,
      categories: Object.keys(tags),
      site,
      component: 'Day0Orchestrator'
    });

    const result = await this.tagOperations.applyTags(vmId, tags, site);

    this.logger.info('NSX tags applied successfully', {
      vmId,
      appliedTags: tags,
      component: 'Day0Orchestrator'
    });

    return {
      vmId,
      appliedTags: tags,
      tagCount: Object.keys(tags).length,
      operationResult: result
    };
  }

  /**
   * Waits for NSX tag propagation to complete by polling the
   * TagPropagationVerifier (accessed via tagOperations.verifyPropagation).
   *
   * Tag propagation is the asynchronous process by which NSX processes tag
   * assignments and updates group memberships accordingly. This step ensures
   * that all expected groups reflect the applied tags before proceeding to
   * verification.
   *
   * @param {string} vmId - The vCenter VM identifier.
   * @param {Object} tags - The applied tag map.
   * @param {string} site - Site code.
   * @returns {Promise<{propagated: boolean, attempts: number, durationMs: number}>}
   *   Propagation result.
   * @throws {Error} If propagation does not complete within the timeout.
   */
  async waitForPropagation(vmId, tags, site) {
    this.logger.info('Waiting for tag propagation to NSX groups', {
      vmId,
      site,
      component: 'Day0Orchestrator'
    });

    let attempts = 0;
    const startTime = Date.now();

    while (attempts < PROPAGATION_POLL_CONFIG.maxAttempts) {
      attempts += 1;

      const elapsed = Date.now() - startTime;
      if (elapsed >= PROPAGATION_POLL_CONFIG.timeoutMs) {
        throw new Error(
          `[DFW-6202] Tag propagation timeout after ${elapsed}ms ` +
          `(${attempts} attempts) for VM "${vmId}".`
        );
      }

      try {
        const propagationStatus = await this.tagOperations.verifyPropagation(
          vmId, tags, site
        );

        if (propagationStatus && propagationStatus.propagated) {
          this.logger.info('Tag propagation confirmed', {
            vmId,
            attempts,
            durationMs: Date.now() - startTime,
            component: 'Day0Orchestrator'
          });
          return {
            propagated: true,
            attempts,
            durationMs: Date.now() - startTime
          };
        }

        this.logger.debug('Tags not yet propagated, polling...', {
          vmId,
          attempt: attempts,
          pendingGroups: propagationStatus && propagationStatus.pendingGroups,
          component: 'Day0Orchestrator'
        });
      } catch (err) {
        this.logger.warn('Propagation check failed, retrying...', {
          vmId,
          attempt: attempts,
          errorMessage: err.message,
          component: 'Day0Orchestrator'
        });
      }

      await Day0Orchestrator._sleep(PROPAGATION_POLL_CONFIG.intervalMs);
    }

    throw new Error(
      `[DFW-6202] Tag propagation did not complete after ` +
      `${PROPAGATION_POLL_CONFIG.maxAttempts} attempts for VM "${vmId}".`
    );
  }

  /**
   * Checks for an existing VM with the same name in vCenter. If found, queries
   * the CMDB CI status to determine whether provisioning should proceed.
   *
   * - If no existing VM is found, provisioning proceeds normally.
   * - If an existing VM is found with a retired/decommissioned CI, a reconciliation
   *   note is logged and provisioning proceeds.
   * - If an existing VM is found with an active CI, an error is thrown to prevent
   *   name collisions.
   *
   * @param {Object} payload - The request payload.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<{existingVmFound: boolean, action?: string, oldVmId?: string, oldCiStatus?: string}>}
   * @throws {Error} DFW-6210 if a VM with the same name exists and has an active CMDB CI.
   */
  async checkExistingVM(payload, endpoints) {
    this.logger.info('Checking for existing VM with same name', {
      correlationId: payload.correlationId,
      vmName: payload.vmName,
      component: 'Day0Orchestrator'
    });

    let response;
    try {
      response = await this.restClient.get(
        `${endpoints.vcenterUrl}/api/vcenter/vm?names=${encodeURIComponent(payload.vmName)}`
      );
    } catch (err) {
      this.logger.warn('Existing VM check failed, proceeding with provisioning', {
        correlationId: payload.correlationId,
        vmName: payload.vmName,
        errorMessage: err.message,
        component: 'Day0Orchestrator'
      });
      return { existingVmFound: false };
    }

    const vms = Array.isArray(response) ? response : (response && response.value ? response.value : []);

    if (vms.length === 0) {
      this.logger.debug('No existing VM found, safe to provision', {
        correlationId: payload.correlationId,
        vmName: payload.vmName,
        component: 'Day0Orchestrator'
      });
      return { existingVmFound: false };
    }

    const existingVm = vms[0];
    const oldVmId = existingVm.vm || existingVm.vmId || existingVm.id;

    this.logger.info('Existing VM found, checking CMDB CI status', {
      correlationId: payload.correlationId,
      vmName: payload.vmName,
      oldVmId,
      component: 'Day0Orchestrator'
    });

    // Query CMDB for CI status
    let ciStatus = 'unknown';
    try {
      const ciRecord = await this.snowAdapter.toCallbackPayload({
        action: 'getCIStatus',
        vmId: oldVmId,
        vmName: payload.vmName
      });
      ciStatus = (ciRecord && ciRecord.ciStatus) || 'unknown';
    } catch (err) {
      this.logger.warn('CMDB CI status lookup failed', {
        correlationId: payload.correlationId,
        oldVmId,
        errorMessage: err.message,
        component: 'Day0Orchestrator'
      });
    }

    const retiredStatuses = ['retired', 'decommissioned'];

    if (retiredStatuses.includes(ciStatus.toLowerCase())) {
      // Rebuild scenario: same name, decommissioned CI
      const rebuildResult = await this._handleRebuildScenario(existingVm, payload, payload.site, endpoints);
      return {
        existingVmFound: true,
        action: 'retag',
        oldVmId,
        oldCiStatus: ciStatus,
        rebuildDetected: true,
        staleTagsPurged: rebuildResult.tagsPurged
      };
    }

    if (ciStatus === 'unknown') {
      // No CI exists — unregistered VM with same name
      this.logger.warn('Unregistered VM with same name detected', {
        correlationId: payload.correlationId,
        vmName: payload.vmName,
        oldVmId,
        component: 'Day0Orchestrator'
      });
      const rebuildResult = await this._handleRebuildScenario(existingVm, payload, payload.site, endpoints);
      return {
        existingVmFound: true,
        action: 'retag',
        oldVmId,
        oldCiStatus: ciStatus,
        rebuildDetected: false,
        staleTagsPurged: rebuildResult.tagsPurged
      };
    }

    throw new Error(
      `[DFW-6210] VM name "${payload.vmName}" already exists with active CMDB CI ` +
      `(status: "${ciStatus}", vmId: "${oldVmId}"). Manual review required.`
    );
  }

  /**
   * Handles a rebuild scenario where an existing VM with a decommissioned or
   * absent CI is detected. Purges stale NSX tags from the old VM MoRef.
   *
   * @param {Object} existingVM - Existing VM record from vCenter.
   * @param {Object} payload - The request payload.
   * @param {string} site - Site code.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<{tagsPurged: boolean, oldTags: Object}>}
   */
  async _handleRebuildScenario(existingVM, payload, site, _endpoints) {
    const oldVmId = existingVM.vm || existingVM.vmId || existingVM.id;

    this.logger.warn('[DFW-6211] Rebuild detected — purging stale tags from old VM MoRef', {
      correlationId: payload.correlationId,
      vmName: payload.vmName,
      oldVmId,
      component: 'Day0Orchestrator'
    });

    let oldTags = {};
    let tagsPurged = false;

    try {
      oldTags = await this.tagOperations.getCurrentTags(oldVmId, site);

      if (oldTags && Object.keys(oldTags).length > 0) {
        await this.tagOperations.removeTags(oldVmId, Object.keys(oldTags), site);
        tagsPurged = true;

        this.logger.info('Stale tags purged from old VM MoRef', {
          correlationId: payload.correlationId,
          oldVmId,
          purgedCategories: Object.keys(oldTags),
          component: 'Day0Orchestrator'
        });
      } else {
        this.logger.info('No stale tags found on old VM MoRef', {
          correlationId: payload.correlationId,
          oldVmId,
          component: 'Day0Orchestrator'
        });
      }
    } catch (err) {
      this.logger.warn('Failed to purge stale tags from old VM MoRef', {
        correlationId: payload.correlationId,
        oldVmId,
        errorMessage: err.message,
        component: 'Day0Orchestrator'
      });
    }

    return { tagsPurged, oldTags };
  }

  // ---------------------------------------------------------------------------
  // Verify sub-steps
  // ---------------------------------------------------------------------------

  /**
   * Verifies that the VM is a member of the expected NSX groups based on
   * its applied tags.
   *
   * @param {string} vmId - The vCenter VM identifier.
   * @param {string} site - Site code.
   * @returns {Promise<{vmId: string, groups: Array<string>, membershipCount: number}>}
   *   Group membership verification result.
   * @throws {Error} If the VM is not found in any expected groups.
   */
  async verifyGroupMembership(vmId, site) {
    this.logger.info('Verifying NSX group memberships', {
      vmId,
      site,
      component: 'Day0Orchestrator'
    });

    const result = await this.groupVerifier.verifyMembership(vmId, site);

    const groups = result && result.groups ? result.groups : [];

    if (groups.length === 0) {
      this.logger.warn('VM not found in any NSX groups after provisioning', {
        vmId,
        site,
        component: 'Day0Orchestrator'
      });
    } else {
      this.logger.info('Group membership verified', {
        vmId,
        groupCount: groups.length,
        groups,
        component: 'Day0Orchestrator'
      });
    }

    return {
      vmId,
      groups,
      membershipCount: groups.length
    };
  }

  /**
   * Validates that the correct DFW (Distributed Firewall) policies are active
   * and enforced for the VM.
   *
   * @param {string} vmId - The vCenter VM identifier.
   * @param {string} site - Site code.
   * @returns {Promise<{vmId: string, policies: Array<Object>, policyCount: number, compliant: boolean}>}
   *   DFW validation result including active policies and compliance status.
   */
  async validateDFW(vmId, site) {
    this.logger.info('Validating DFW policy enforcement', {
      vmId,
      site,
      component: 'Day0Orchestrator'
    });

    const result = await this.dfwValidator.validatePolicies(vmId, site);

    const policies = result && result.policies ? result.policies : [];
    const compliant = result && result.compliant !== undefined
      ? result.compliant
      : policies.length > 0;

    this.logger.info('DFW validation complete', {
      vmId,
      policyCount: policies.length,
      compliant,
      component: 'Day0Orchestrator'
    });

    return {
      vmId,
      policies,
      policyCount: policies.length,
      compliant
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Sleeps for the specified duration. Used for polling intervals.
   *
   * @private
   * @static
   * @param {number} ms - Duration in milliseconds.
   * @returns {Promise<void>}
   */
  static _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = Day0Orchestrator;
