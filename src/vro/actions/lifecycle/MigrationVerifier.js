/**
 * @file MigrationVerifier.js
 * @description Post-vMotion tag preservation verification for the DFW Automation
 *   Pipeline. Verifies that NSX tags are preserved after cross-site VM migration
 *   and re-applies missing tags from the source of truth.
 *
 * @module lifecycle/MigrationVerifier
 */

'use strict';

/**
 * @class MigrationVerifier
 * @classdesc Verifies tag preservation after VM migration between sites and
 *   re-applies missing tags when detected.
 *
 * @example
 * const verifier = new MigrationVerifier(dependencies);
 * const result = await verifier.verifyPostMigration(payload);
 */
class MigrationVerifier {
  /**
   * Creates a new MigrationVerifier.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.tagOperations - Tag management operations.
   * @param {Object} dependencies.groupVerifier - Group membership verifier.
   * @param {Object} dependencies.restClient - HTTP client.
   * @param {Object} dependencies.logger - Structured logger instance.
   * @param {Object} dependencies.configLoader - Configuration loader.
   * @param {Object} dependencies.snowAdapter - ServiceNow adapter.
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-8500] MigrationVerifier requires dependencies');
    }

    /** @private */
    this.tagOperations = dependencies.tagOperations;
    /** @private */
    this.groupVerifier = dependencies.groupVerifier;
    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this.configLoader = dependencies.configLoader;
    /** @private */
    this.snowAdapter = dependencies.snowAdapter;
  }

  /**
   * Verifies tag preservation after VM migration.
   *
   * @async
   * @param {Object} payload - Migration verification payload.
   * @param {string} payload.correlationId - Correlation identifier.
   * @param {string} payload.vmId - VM identifier.
   * @param {string} payload.vmName - VM display name.
   * @param {string} payload.sourceSite - Source site code.
   * @param {string} payload.destinationSite - Destination site code.
   * @param {Object} payload.expectedTags - Expected tags from source/CMDB.
   * @param {string} [payload.callbackUrl] - Callback URL.
   * @returns {Promise<Object>} Verification result.
   */
  async verifyPostMigration(payload) {
    const { correlationId, vmId, vmName, sourceSite, destinationSite, expectedTags } = payload;

    this.logger.info('Starting post-migration tag verification', {
      correlationId,
      vmId,
      vmName,
      sourceSite,
      destinationSite,
      component: 'MigrationVerifier'
    });

    try {
      // Step 1: Resolve destination site endpoints
      const endpoints = this.configLoader.getEndpointsForSite(destinationSite);

      this.logger.debug('Destination endpoints resolved', {
        correlationId,
        destinationSite,
        nsxUrl: endpoints.nsxUrl,
        component: 'MigrationVerifier'
      });

      // Step 2: Read tags at destination
      const destinationTags = await this.tagOperations.getTags(vmId, destinationSite);

      this.logger.info('Destination tags retrieved', {
        correlationId,
        vmId,
        tagCount: Object.keys(destinationTags).length,
        component: 'MigrationVerifier'
      });

      // Step 3: Compare with expected tags
      const missingTags = this._findMissingTags(expectedTags, destinationTags);
      const tagsPreserved = Object.keys(missingTags).length === 0;

      let reapplied = false;
      let groupMembershipVerified = false;

      if (tagsPreserved) {
        this.logger.info('All tags preserved after migration', {
          correlationId,
          vmId,
          component: 'MigrationVerifier'
        });
      } else {
        // Step 5a: Log tag loss event
        this.logger.warn('Tag loss detected after migration', {
          correlationId,
          vmId,
          missingCategories: Object.keys(missingTags),
          sourceSite,
          destinationSite,
          component: 'MigrationVerifier'
        });

        // Step 5b: Re-apply missing tags at destination
        try {
          await this.tagOperations.applyTags(vmId, missingTags, destinationSite);
          reapplied = true;

          this.logger.info('Missing tags re-applied at destination', {
            correlationId,
            vmId,
            reappliedCategories: Object.keys(missingTags),
            component: 'MigrationVerifier'
          });

          // Step 5c: Wait for propagation
          await this.tagOperations.verifyPropagation(
            vmId, { ...destinationTags, ...missingTags }, destinationSite
          );
        } catch (err) {
          this.logger.error('Failed to re-apply tags at destination', {
            correlationId,
            vmId,
            errorMessage: err.message,
            component: 'MigrationVerifier'
          });
        }
      }

      // Step 5d: Verify group membership at destination
      try {
        const groupResult = await this.groupVerifier.verifyMembership(
          vmId, destinationSite
        );
        groupMembershipVerified = groupResult && groupResult.verified !== false;
      } catch (err) {
        this.logger.warn('Group membership verification failed', {
          correlationId,
          vmId,
          errorMessage: err.message,
          component: 'MigrationVerifier'
        });
      }

      // Build result
      const result = {
        correlationId,
        vmId,
        vmName,
        sourceSite,
        destinationSite,
        tagsPreserved,
        missingTags,
        reapplied,
        groupMembershipVerified,
        verificationTimestamp: new Date().toISOString()
      };

      // Step 7: Callback to ServiceNow
      if (payload.callbackUrl) {
        await this._sendCallback(payload.callbackUrl, result, correlationId);
      }

      this.logger.info('Post-migration verification completed', {
        correlationId,
        vmId,
        tagsPreserved,
        reapplied,
        groupMembershipVerified,
        component: 'MigrationVerifier'
      });

      return result;
    } catch (err) {
      this.logger.error('Post-migration verification failed', {
        correlationId,
        vmId,
        errorMessage: err.message,
        component: 'MigrationVerifier'
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Finds tags that are in expected but missing or different at destination.
   *
   * @private
   * @param {Object} expected - Expected tag map.
   * @param {Object} actual - Actual tag map at destination.
   * @returns {Object} Missing or differing tags.
   */
  _findMissingTags(expected, actual) {
    const missing = {};

    for (const [category, value] of Object.entries(expected)) {
      if (actual[category] === undefined || actual[category] === null) {
        missing[category] = value;
      } else if (JSON.stringify(actual[category]) !== JSON.stringify(value)) {
        missing[category] = value;
      }
    }

    return missing;
  }

  /**
   * Sends callback to ServiceNow.
   *
   * @private
   * @async
   * @param {string} url - Callback URL.
   * @param {Object} result - Verification result.
   * @param {string} correlationId - Correlation ID.
   * @returns {Promise<void>}
   */
  async _sendCallback(url, result, correlationId) {
    try {
      await this.restClient.post(url, result);
    } catch (err) {
      this.logger.warn('Failed to send migration verification callback', {
        correlationId,
        errorMessage: err.message,
        component: 'MigrationVerifier'
      });
    }
  }
}

module.exports = MigrationVerifier;
