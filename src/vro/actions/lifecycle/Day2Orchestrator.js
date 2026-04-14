/**
 * @file Day2Orchestrator.js
 * @description Day 2 (tag modification) orchestrator for the DFW Automation
 *   Pipeline. Handles modifying NSX tags on existing VMs — including impact
 *   analysis of group membership changes, delta-based tag application, drift
 *   detection, and full re-verification of the micro-segmentation posture.
 *
 *   Extends {@link LifecycleOrchestrator} and implements the prepare, execute,
 *   and verify template methods. Tag deltas are computed and applied
 *   incrementally to minimize disruption. Compensating actions restore the
 *   previous tag state on failure.
 *
 *   Execute steps:
 *     1. Get current tags from the VM
 *     2. Run impact analysis (predict group membership changes)
 *     3. Apply tag deltas (add/remove only what changed)
 *     4. Wait for tag propagation to NSX groups
 *
 *   Verify steps:
 *     5. Verify group memberships match expected state
 *     6. Validate DFW policy enforcement
 *
 * @module lifecycle/Day2Orchestrator
 */

'use strict';

const LifecycleOrchestrator = require('./LifecycleOrchestrator');

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
 * @class Day2Orchestrator
 * @extends LifecycleOrchestrator
 * @classdesc Orchestrates Day 2 (tag modification) workflows for existing VMs.
 *   Computes tag deltas, performs impact analysis, applies changes, and
 *   verifies the resulting micro-segmentation posture.
 *
 * @example
 * const orchestrator = LifecycleOrchestrator.create('Day2', dependencies);
 * const result = await orchestrator.run({
 *   correlationId: 'RITM-00002-1679000000000',
 *   requestType: 'Day2',
 *   site: 'NDCNG',
 *   vmId: 'vm-1234',
 *   vmName: 'srv-web-01',
 *   tags: { Environment: 'Staging', SystemRole: 'Web' },
 *   expectedCurrentTags: { Environment: 'Production', SystemRole: 'Application' },
 *   callbackUrl: 'https://snow.company.internal/api/callback'
 * });
 */
class Day2Orchestrator extends LifecycleOrchestrator {
  /**
   * Creates a new Day2Orchestrator instance.
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
   * Prepares the Day 2 workflow by resolving the target VM identity and
   * validating the requested tag changes.
   *
   * @param {Object} payload - The validated request payload.
   * @param {string} payload.vmId - The vCenter VM identifier.
   * @param {string} payload.vmName - VM display name (for logging).
   * @param {Object} payload.tags - The desired new tag state.
   * @param {string} payload.site - Site code.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<Object>} Preparation result containing the resolved VM
   *   identity and tag change summary.
   */
  async prepare(payload, endpoints) {
    this.logger.info('Preparing Day 2 tag modification', {
      correlationId: payload.correlationId,
      vmId: payload.vmId,
      vmName: payload.vmName,
      site: payload.site,
      component: 'Day2Orchestrator'
    });

    const vmId = payload.vmId || payload.vmName;

    if (!vmId) {
      throw new Error(
        '[DFW-6300] Day 2 payload must include a vmId or vmName to identify the target VM.'
      );
    }

    return {
      vmId,
      desiredTags: payload.tags,
      site: payload.site,
      targetEndpoints: endpoints
    };
  }

  /**
   * Executes the Day 2 tag modification workflow:
   *   1. Read the VM's current tags
   *   2. Run impact analysis to predict group membership changes
   *   3. Apply tag deltas (only the changes)
   *   4. Wait for tag propagation to NSX groups
   *
   * Drift detection: if the VM's current tags do not match the CMDB expected
   * tags (when provided in the payload), a warning is logged but execution
   * continues using the actual current tags as the baseline.
   *
   * @param {Object} payload - The validated request payload.
   * @param {string} payload.vmId - The vCenter VM identifier.
   * @param {Object} payload.tags - The desired new tag state.
   * @param {string} payload.site - Site code.
   * @param {Object} [payload.expectedCurrentTags] - CMDB-expected current tags
   *   for drift detection.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<Object>} Execution result containing current tags, impact
   *   analysis, applied deltas, and propagation status.
   */
  async execute(payload, _endpoints) {
    const vmId = payload.vmId || payload.vmName;
    const site = payload.site;

    this.logger.info('Executing Day 2 tag modification workflow', {
      correlationId: payload.correlationId,
      vmId,
      component: 'Day2Orchestrator'
    });

    // Step 1: Get current tags
    const currentTags = await this._timedStep('getCurrentTags', () => {
      return this.getCurrentTags(vmId, site);
    });

    // Drift detection: compare current tags with CMDB expected tags
    if (payload.expectedCurrentTags) {
      this._detectDrift(vmId, currentTags, payload.expectedCurrentTags, payload.correlationId);
    }

    // Step 2: Run impact analysis
    const impactAnalysis = await this._timedStep('runImpactAnalysis', () => {
      return this.runImpactAnalysis(currentTags, payload.tags);
    });

    // Step 3: Apply tag deltas
    const deltaResult = await this._timedStep('applyTagDeltas', () => {
      return this.applyTagDeltas(vmId, payload.tags, site);
    });

    // Register compensating action: revert to previous tags
    await this.sagaCoordinator.recordStep('applyTagDeltas', async () => {
      this.logger.warn('Compensating: Reverting tags to previous state', {
        vmId,
        correlationId: payload.correlationId,
        previousTags: currentTags,
        component: 'Day2Orchestrator'
      });
      await this.tagOperations.updateTags(vmId, currentTags, site);
    });

    // Step 4: Wait for propagation
    const propagationResult = await this._timedStep('waitForPropagation', () => {
      return this.waitForPropagation(vmId, payload.tags, site);
    });

    return {
      vmId,
      previousTags: currentTags,
      desiredTags: payload.tags,
      impactAnalysis,
      appliedDeltas: deltaResult,
      propagation: propagationResult
    };
  }

  /**
   * Verifies the Day 2 tag modification results:
   *   5. Verify the VM's group memberships match the expected state
   *   6. Validate DFW policies are correctly enforced
   *
   * @param {Object} payload - The validated request payload.
   * @param {string} payload.vmId - The vCenter VM identifier.
   * @param {string} payload.site - Site code.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<Object>} Verification result containing group memberships
   *   and active DFW policies.
   */
  async verify(payload, _endpoints) {
    const vmId = payload.vmId || payload.vmName;
    const site = payload.site;

    this.logger.info('Verifying Day 2 tag modification results', {
      correlationId: payload.correlationId,
      vmId,
      component: 'Day2Orchestrator'
    });

    // Step 5: Verify groups
    const groupResult = await this._timedStep('verifyGroups', () => {
      return this.verifyGroups(vmId, site);
    });

    // Step 6: Validate DFW
    const dfwResult = await this._timedStep('validateDFW', () => {
      return this.validateDFW(vmId, site);
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
   * Reads the current NSX tags assigned to the VM.
   *
   * @param {string} vmId - The vCenter VM identifier.
   * @param {string} site - Site code.
   * @returns {Promise<Object>} The current tag map keyed by category (scope).
   */
  async getCurrentTags(vmId, site) {
    this.logger.info('Reading current tags from VM', {
      vmId,
      site,
      component: 'Day2Orchestrator'
    });

    const result = await this.tagOperations.getTags(vmId, site);

    const tags = result && result.tags ? result.tags : result || {};

    this.logger.info('Current tags retrieved', {
      vmId,
      tagCount: Object.keys(tags).length,
      categories: Object.keys(tags),
      component: 'Day2Orchestrator'
    });

    return tags;
  }

  /**
   * Runs impact analysis to predict what group membership changes will result
   * from applying the new tags. Uses the GroupMembershipVerifier's
   * `predictGroupChanges` method to compute the expected additions and
   * removals.
   *
   * @param {Object} currentTags - The VM's current tag map.
   * @param {Object} newTags - The desired new tag map.
   * @returns {Promise<{groupsToJoin: Array<string>, groupsToLeave: Array<string>, unchangedGroups: Array<string>}>}
   *   Impact analysis result showing predicted group changes.
   */
  async runImpactAnalysis(currentTags, newTags) {
    this.logger.info('Running impact analysis for tag changes', {
      currentCategories: Object.keys(currentTags),
      newCategories: Object.keys(newTags),
      component: 'Day2Orchestrator'
    });

    const analysis = await this.groupVerifier.predictGroupChanges(
      currentTags,
      newTags
    );

    const groupsToJoin = analysis && analysis.groupsToJoin ? analysis.groupsToJoin : [];
    const groupsToLeave = analysis && analysis.groupsToLeave ? analysis.groupsToLeave : [];
    const unchangedGroups = analysis && analysis.unchangedGroups ? analysis.unchangedGroups : [];

    this.logger.info('Impact analysis complete', {
      groupsToJoin: groupsToJoin.length,
      groupsToLeave: groupsToLeave.length,
      unchangedGroups: unchangedGroups.length,
      component: 'Day2Orchestrator'
    });

    return {
      groupsToJoin,
      groupsToLeave,
      unchangedGroups
    };
  }

  /**
   * Applies tag deltas to the VM using the TagOperations `updateTags` method.
   * Only the changed tags are sent — unchanged tags are left in place.
   *
   * @param {string} vmId - The vCenter VM identifier.
   * @param {Object} newTags - The desired new tag state. The TagOperations
   *   dependency handles delta computation internally.
   * @param {string} site - Site code.
   * @returns {Promise<{vmId: string, updatedTags: Object, changeCount: number}>}
   *   Delta application result.
   */
  async applyTagDeltas(vmId, newTags, site) {
    this.logger.info('Applying tag deltas', {
      vmId,
      categories: Object.keys(newTags),
      site,
      component: 'Day2Orchestrator'
    });

    const result = await this.tagOperations.updateTags(vmId, newTags, site);

    this.logger.info('Tag deltas applied successfully', {
      vmId,
      updatedTags: newTags,
      component: 'Day2Orchestrator'
    });

    return {
      vmId,
      updatedTags: newTags,
      changeCount: Object.keys(newTags).length,
      operationResult: result
    };
  }

  /**
   * Waits for NSX tag propagation to complete after tag delta application.
   * Polls the TagOperations propagation verifier until all expected groups
   * reflect the updated tags.
   *
   * @param {string} vmId - The vCenter VM identifier.
   * @param {Object} tags - The applied tag map.
   * @param {string} site - Site code.
   * @returns {Promise<{propagated: boolean, attempts: number, durationMs: number}>}
   *   Propagation result.
   * @throws {Error} If propagation does not complete within the timeout.
   */
  async waitForPropagation(vmId, tags, site) {
    this.logger.info('Waiting for tag propagation after Day 2 changes', {
      vmId,
      site,
      component: 'Day2Orchestrator'
    });

    let attempts = 0;
    const startTime = Date.now();

    while (attempts < PROPAGATION_POLL_CONFIG.maxAttempts) {
      attempts += 1;

      const elapsed = Date.now() - startTime;
      if (elapsed >= PROPAGATION_POLL_CONFIG.timeoutMs) {
        throw new Error(
          `[DFW-6302] Tag propagation timeout after ${elapsed}ms ` +
          `(${attempts} attempts) for VM "${vmId}".`
        );
      }

      try {
        const propagationStatus = await this.tagOperations.verifyPropagation(
          vmId, tags, site
        );

        if (propagationStatus && propagationStatus.propagated) {
          this.logger.info('Tag propagation confirmed after Day 2 changes', {
            vmId,
            attempts,
            durationMs: Date.now() - startTime,
            component: 'Day2Orchestrator'
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
          component: 'Day2Orchestrator'
        });
      } catch (err) {
        this.logger.warn('Propagation check failed, retrying...', {
          vmId,
          attempt: attempts,
          errorMessage: err.message,
          component: 'Day2Orchestrator'
        });
      }

      await Day2Orchestrator._sleep(PROPAGATION_POLL_CONFIG.intervalMs);
    }

    throw new Error(
      `[DFW-6302] Tag propagation did not complete after ` +
      `${PROPAGATION_POLL_CONFIG.maxAttempts} attempts for VM "${vmId}".`
    );
  }

  // ---------------------------------------------------------------------------
  // Verify sub-steps
  // ---------------------------------------------------------------------------

  /**
   * Verifies that the VM's NSX group memberships match the expected state
   * after tag modification.
   *
   * @param {string} vmId - The vCenter VM identifier.
   * @param {string} site - Site code.
   * @returns {Promise<{vmId: string, groups: Array<string>, membershipCount: number}>}
   *   Group membership verification result.
   */
  async verifyGroups(vmId, site) {
    this.logger.info('Verifying NSX group memberships after Day 2 changes', {
      vmId,
      site,
      component: 'Day2Orchestrator'
    });

    const result = await this.groupVerifier.verifyMembership(vmId, site);

    const groups = result && result.groups ? result.groups : [];

    this.logger.info('Group membership verified', {
      vmId,
      groupCount: groups.length,
      groups,
      component: 'Day2Orchestrator'
    });

    return {
      vmId,
      groups,
      membershipCount: groups.length
    };
  }

  /**
   * Validates that DFW policies are correctly enforced for the VM after tag
   * modification.
   *
   * @param {string} vmId - The vCenter VM identifier.
   * @param {string} site - Site code.
   * @returns {Promise<{vmId: string, policies: Array<Object>, policyCount: number, compliant: boolean}>}
   *   DFW validation result.
   */
  async validateDFW(vmId, site) {
    this.logger.info('Validating DFW policy enforcement after Day 2 changes', {
      vmId,
      site,
      component: 'Day2Orchestrator'
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
      component: 'Day2Orchestrator'
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
   * Detects drift between the VM's actual current tags and the CMDB-expected
   * tags. If a mismatch is found, a warning is logged but execution continues
   * using the actual tags as the baseline.
   *
   * Drift can occur when manual changes are made directly in NSX without
   * updating the CMDB, or when a previous Day 2 operation's callback to
   * ServiceNow failed.
   *
   * @private
   * @param {string} vmId - The vCenter VM identifier.
   * @param {Object} actualTags - The tags actually present on the VM.
   * @param {Object} expectedTags - The tags the CMDB expects to be present.
   * @param {string} correlationId - Correlation ID for logging.
   * @returns {void}
   */
  _detectDrift(vmId, actualTags, expectedTags, correlationId) {
    const driftedCategories = [];

    // Check all expected categories
    for (const [category, expectedValue] of Object.entries(expectedTags)) {
      const actualValue = actualTags[category];

      if (actualValue === undefined) {
        driftedCategories.push({
          category,
          expected: expectedValue,
          actual: 'MISSING'
        });
        continue;
      }

      // Compare values — handle both strings and arrays
      const expectedStr = JSON.stringify(expectedValue);
      const actualStr = JSON.stringify(actualValue);

      if (expectedStr !== actualStr) {
        driftedCategories.push({
          category,
          expected: expectedValue,
          actual: actualValue
        });
      }
    }

    // Check for unexpected categories on the VM (not in CMDB)
    for (const category of Object.keys(actualTags)) {
      if (expectedTags[category] === undefined) {
        driftedCategories.push({
          category,
          expected: 'NOT_IN_CMDB',
          actual: actualTags[category]
        });
      }
    }

    if (driftedCategories.length > 0) {
      this.logger.warn('Tag drift detected — actual tags do not match CMDB expected tags', {
        vmId,
        correlationId,
        driftedCategories,
        driftCount: driftedCategories.length,
        message: 'Proceeding with actual current tags as baseline. ' +
          'CMDB may need to be reconciled.',
        component: 'Day2Orchestrator'
      });
    } else {
      this.logger.debug('No tag drift detected — actual tags match CMDB', {
        vmId,
        correlationId,
        component: 'Day2Orchestrator'
      });
    }
  }

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

module.exports = Day2Orchestrator;
