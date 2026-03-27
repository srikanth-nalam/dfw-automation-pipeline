/**
 * @file QuarantineOrchestrator.js
 * @description Emergency Quarantine orchestrator for the DFW Automation Pipeline.
 *   Applies a Quarantine tag to a VM, blocking all traffic except management
 *   access, and schedules automatic expiry after the specified duration.
 *
 *   Extends {@link LifecycleOrchestrator} and implements the prepare, execute,
 *   and verify template methods. All mutating operations are registered with
 *   the {@link SagaCoordinator} for automatic rollback on failure.
 *
 * @module lifecycle/QuarantineOrchestrator
 */

'use strict';

const LifecycleOrchestrator = require('./LifecycleOrchestrator');

/**
 * Default polling configuration for quarantine propagation checks.
 * @constant {Object}
 * @private
 */
const QUARANTINE_PROPAGATION_CONFIG = Object.freeze({
  maxAttempts: 12,
  intervalMs: 5000,
  timeoutMs: 60000
});

/**
 * Valid quarantine duration options in minutes.
 * @constant {number[]}
 * @private
 */
const VALID_DURATIONS = [15, 30, 60, 120, 240, 480, 1440];

/**
 * @class QuarantineOrchestrator
 * @extends LifecycleOrchestrator
 * @classdesc Orchestrates the Emergency Quarantine workflow: applying a
 *   Quarantine tag, verifying security group membership, and scheduling
 *   automatic expiry.
 */
class QuarantineOrchestrator extends LifecycleOrchestrator {
  /**
   * Creates a new QuarantineOrchestrator instance.
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
   * Prepares the quarantine workflow by validating quarantine-specific fields
   * and resolving target endpoints.
   *
   * @param {Object} payload - The validated request payload.
   * @param {string} payload.vmId - VM identifier to quarantine.
   * @param {string} payload.vmName - VM display name.
   * @param {string} payload.site - Target site code.
   * @param {string} payload.justification - Quarantine justification.
   * @param {number} payload.durationMinutes - Duration in minutes.
   * @param {string} payload.initiatedBy - User who initiated the quarantine.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<Object>} Preparation result.
   */
  async prepare(payload, endpoints) {
    this.logger.info('Preparing emergency quarantine', {
      correlationId: payload.correlationId,
      vmId: payload.vmId,
      vmName: payload.vmName,
      site: payload.site,
      durationMinutes: payload.durationMinutes,
      component: 'QuarantineOrchestrator'
    });

    const durationMinutes = payload.durationMinutes || 60;

    if (!VALID_DURATIONS.includes(durationMinutes)) {
      throw new Error(
        `[DFW-8100] Invalid quarantine duration "${durationMinutes}" minutes. ` +
        `Valid values: ${VALID_DURATIONS.join(', ')}`
      );
    }

    if (!payload.justification || payload.justification.length < 50) {
      throw new Error(
        '[DFW-8101] Quarantine justification is required and must be at least 50 characters'
      );
    }

    return {
      vmId: payload.vmId || payload.vmName,
      vmName: payload.vmName,
      site: payload.site,
      durationMinutes,
      justification: payload.justification,
      initiatedBy: payload.initiatedBy || 'SYSTEM',
      targetEndpoints: endpoints
    };
  }

  /**
   * Executes the quarantine workflow:
   *   1. Read current tags (preserve for rollback)
   *   2. Apply Quarantine tag
   *   3. Register saga compensation
   *   4. Wait for propagation
   *   5. Record quarantine metadata
   *
   * @param {Object} payload - The validated request payload.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<Object>} Execution result.
   */
  async execute(payload, endpoints) {
    const vmId = payload.vmId || payload.vmName;
    const durationMinutes = payload.durationMinutes || 60;

    this.logger.info('Executing emergency quarantine workflow', {
      correlationId: payload.correlationId,
      vmId,
      component: 'QuarantineOrchestrator'
    });

    // Step 1: Read current tags for rollback
    const previousTags = await this._timedStep('readCurrentTags', () => {
      return this.tagOperations.getTags(vmId, payload.site);
    });

    // Step 2: Apply Quarantine tag
    const quarantineTag = { Quarantine: 'ACTIVE' };
    const tagResult = await this._timedStep('applyQuarantineTag', () => {
      return this.tagOperations.applyTags(vmId, quarantineTag, payload.site);
    });

    // Step 3: Register saga compensation — remove Quarantine tag on failure
    await this.sagaCoordinator.recordStep('applyQuarantineTag', async () => {
      this.logger.warn('Compensating: Removing quarantine tag', {
        vmId,
        correlationId: payload.correlationId,
        component: 'QuarantineOrchestrator'
      });
      await this.tagOperations.removeTags(vmId, ['Quarantine'], payload.site);
    });

    // Step 4: Wait for propagation
    const propagationResult = await this._timedStep('waitForQuarantinePropagation', () => {
      return this._waitForQuarantinePropagation(vmId, payload.site);
    });

    // Step 5: Record quarantine metadata
    const now = new Date();
    const expiryTime = new Date(now.getTime() + durationMinutes * 60 * 1000);

    const quarantineMetadata = {
      vmId,
      vmName: payload.vmName,
      site: payload.site,
      startTime: now.toISOString(),
      expiryTime: expiryTime.toISOString(),
      durationMinutes,
      justification: payload.justification,
      initiatedBy: payload.initiatedBy || 'SYSTEM',
      previousTags
    };

    this.logger.info('Quarantine metadata recorded', {
      correlationId: payload.correlationId,
      vmId,
      expiryTime: expiryTime.toISOString(),
      component: 'QuarantineOrchestrator'
    });

    return {
      vmId,
      vmName: payload.vmName,
      quarantineApplied: true,
      tagResult,
      propagation: propagationResult,
      metadata: quarantineMetadata
    };
  }

  /**
   * Verifies the quarantine enforcement:
   *   6. Verify VM is in Quarantine security group
   *   7. Verify DFW quarantine policy is active
   *   8. Generate expiry payload
   *
   * @param {Object} payload - The validated request payload.
   * @param {Object} endpoints - Resolved site endpoints.
   * @returns {Promise<Object>} Verification result.
   */
  async verify(payload, _endpoints) {
    const vmId = payload.vmId || payload.vmName;

    this.logger.info('Verifying quarantine enforcement', {
      correlationId: payload.correlationId,
      vmId,
      component: 'QuarantineOrchestrator'
    });

    // Step 6: Verify group membership
    const groupResult = await this._timedStep('verifyQuarantineGroup', () => {
      return this.groupVerifier.verifyMembership(vmId, payload.site);
    });

    // Step 7: Validate DFW quarantine policy
    const dfwResult = await this._timedStep('validateQuarantineDFW', () => {
      return this.dfwValidator.validatePolicies(vmId, payload.site);
    });

    // Step 8: Generate expiry payload
    const durationMinutes = payload.durationMinutes || 60;
    const expiryPayload = QuarantineOrchestrator.createExpiryPayload({
      correlationId: payload.correlationId,
      vmId,
      vmName: payload.vmName,
      site: payload.site,
      durationMinutes
    });

    return {
      quarantineGroupVerified: groupResult && groupResult.verified !== false,
      groupDetails: groupResult,
      dfwPolicyActive: dfwResult && dfwResult.compliant !== false,
      dfwDetails: dfwResult,
      expiryPayload
    };
  }

  // ---------------------------------------------------------------------------
  // Quarantine-specific helpers
  // ---------------------------------------------------------------------------

  /**
   * Waits for the Quarantine tag to propagate and the VM to join the
   * Quarantine security group.
   *
   * @private
   * @async
   * @param {string} vmId - VM identifier.
   * @param {string} site - Site code.
   * @returns {Promise<Object>} Propagation result.
   */
  async _waitForQuarantinePropagation(vmId, site) {
    let attempts = 0;
    const startTime = Date.now();

    while (attempts < QUARANTINE_PROPAGATION_CONFIG.maxAttempts) {
      attempts += 1;

      const elapsed = Date.now() - startTime;
      if (elapsed >= QUARANTINE_PROPAGATION_CONFIG.timeoutMs) {
        throw new Error(
          `[DFW-8102] Quarantine propagation timeout after ${elapsed}ms ` +
          `(${attempts} attempts) for VM "${vmId}".`
        );
      }

      try {
        const result = await this.tagOperations.verifyPropagation(
          vmId, { Quarantine: 'ACTIVE' }, site
        );

        if (result && result.propagated) {
          this.logger.info('Quarantine tag propagation confirmed', {
            vmId,
            attempts,
            durationMs: Date.now() - startTime,
            component: 'QuarantineOrchestrator'
          });
          return { propagated: true, attempts, durationMs: Date.now() - startTime };
        }
      } catch (err) {
        this.logger.warn('Quarantine propagation check failed, retrying...', {
          vmId,
          attempt: attempts,
          errorMessage: err.message,
          component: 'QuarantineOrchestrator'
        });
      }

      await QuarantineOrchestrator._sleep(QUARANTINE_PROPAGATION_CONFIG.intervalMs);
    }

    throw new Error(
      `[DFW-8102] Quarantine propagation did not complete after ` +
      `${QUARANTINE_PROPAGATION_CONFIG.maxAttempts} attempts for VM "${vmId}".`
    );
  }

  /**
   * Generates the payload for the quarantine expiry workflow.
   *
   * @static
   * @param {Object} quarantineResult - Quarantine execution result.
   * @param {string} quarantineResult.correlationId - Correlation ID.
   * @param {string} quarantineResult.vmId - VM identifier.
   * @param {string} quarantineResult.vmName - VM name.
   * @param {string} quarantineResult.site - Site code.
   * @param {number} quarantineResult.durationMinutes - Duration in minutes.
   * @returns {Object} Expiry workflow payload.
   */
  static createExpiryPayload(quarantineResult) {
    const expiryTime = new Date(
      Date.now() + (quarantineResult.durationMinutes || 60) * 60 * 1000
    );

    return {
      correlationId: `${quarantineResult.correlationId}-EXPIRY`,
      requestType: 'quarantine_expiry',
      vmId: quarantineResult.vmId,
      vmName: quarantineResult.vmName,
      site: quarantineResult.site,
      scheduledExpiryTime: expiryTime.toISOString(),
      action: 'remove_quarantine'
    };
  }

  /**
   * Sleeps for the specified duration.
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

module.exports = QuarantineOrchestrator;
