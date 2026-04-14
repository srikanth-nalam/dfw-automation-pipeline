/**
 * @file UnregisteredVMOnboarder.js
 * @description Creates CMDB CIs for VMs discovered without CMDB records and applies
 *   initial tags. Uses UntaggedVMScanner's classification suggestions to auto-tag
 *   high-confidence VMs.
 *
 * Error codes:
 *   - DFW-9200  UnregisteredVMOnboarder general error
 *   - DFW-9201  CMDB CI creation failed
 *
 * @module lifecycle/UnregisteredVMOnboarder
 */

'use strict';

/**
 * @class UnregisteredVMOnboarder
 * @classdesc Onboards unregistered VMs by creating CMDB CIs and applying initial tags.
 *
 * @example
 * const onboarder = new UnregisteredVMOnboarder(dependencies);
 * const report = await onboarder.onboard('NDCNG', { dryRun: true });
 */
class UnregisteredVMOnboarder {
  /**
   * Creates a new UnregisteredVMOnboarder.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.restClient - HTTP client.
   * @param {Object} dependencies.logger - Structured logger.
   * @param {Object} dependencies.configLoader - Configuration loader.
   * @param {Object} dependencies.snowAdapter - ServiceNow adapter for CMDB operations.
   * @param {Object} dependencies.tagOperations - Tag management operations.
   * @param {Object} dependencies.untaggedVMScanner - UntaggedVMScanner for CMDB cross-ref.
   *
   * @throws {Error} DFW-9200 when required dependencies are missing.
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-9200] UnregisteredVMOnboarder requires dependencies');
    }

    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this.configLoader = dependencies.configLoader;
    /** @private */
    this.snowAdapter = dependencies.snowAdapter;
    /** @private */
    this.tagOperations = dependencies.tagOperations;
    /** @private */
    this.untaggedVMScanner = dependencies.untaggedVMScanner;
  }

  /**
   * Onboards unregistered VMs at a site.
   *
   * @async
   * @param {string} site - Site code (NDCNG or TULNG).
   * @param {Object} [options={}] - Onboarding options.
   * @param {boolean} [options.dryRun=true] - If true, report only.
   * @param {boolean} [options.autoCreateCI=false] - Auto-create CMDB CIs.
   * @param {Object} [options.defaultTags={}] - Default tags to apply.
   * @returns {Promise<Object>} Onboarding report.
   *
   * @throws {Error} DFW-9200 on general failure.
   */
  async onboard(site, options = {}) {
    const dryRun = options.dryRun !== false;
    const autoCreateCI = options.autoCreateCI === true;
    const defaultTags = options.defaultTags || {};

    this.logger.info('Starting unregistered VM onboarding', {
      site,
      dryRun,
      autoCreateCI,
      component: 'UnregisteredVMOnboarder'
    });

    try {
      // Step 1: Run CMDB cross-reference scan
      const scanResult = await this.untaggedVMScanner.scanWithCMDBCrossRef(site);
      const unregisteredVMs = (scanResult.classifiedVMs || []).filter(
        vm => vm.classification === 'UNTAGGED_UNREGISTERED'
      );

      let onboarded = 0;
      let manualReview = 0;
      let failed = 0;
      const report = [];

      // Step 2: Process each unregistered VM
      for (const vm of unregisteredVMs) {
        const vmId = vm.vmId;
        const vmName = vm.vmName || vmId;

        // Step 2a: Get tag suggestions
        const suggestions = this.untaggedVMScanner.suggestClassification(
          vmName, vm.currentTags || {}
        );
        const highConfidenceTags = {};
        let hasHighConfidence = false;

        for (const suggestion of suggestions) {
          if (suggestion.confidence === 'HIGH') {
            highConfidenceTags[suggestion.category] = suggestion.suggestedValue;
            hasHighConfidence = true;
          }
        }

        // Merge with default tags
        const tagsToApply = { ...defaultTags, ...highConfidenceTags };

        // Step 2b: Create CMDB CI if autoCreateCI
        if (autoCreateCI && !dryRun) {
          try {
            await this._createCMDBRecord({
              vmId,
              vmName,
              site,
              tags: tagsToApply
            }, site);
          } catch (ciErr) {
            this.logger.error('CMDB CI creation failed', {
              vmId,
              vmName,
              errorMessage: ciErr.message,
              component: 'UnregisteredVMOnboarder'
            });
            failed += 1;
            report.push({
              vmId,
              vmName,
              action: 'CI_CREATION_FAILED',
              error: ciErr.message
            });
            continue;
          }
        }

        // Step 2c-d: Apply tags or add to manual review
        if (hasHighConfidence && Object.keys(tagsToApply).length > 0) {
          if (!dryRun) {
            try {
              await this._applyInitialTags(vmId, tagsToApply, site);
              onboarded += 1;
              report.push({
                vmId,
                vmName,
                action: 'ONBOARDED',
                appliedTags: tagsToApply
              });
            } catch (tagErr) {
              failed += 1;
              report.push({
                vmId,
                vmName,
                action: 'TAG_APPLICATION_FAILED',
                error: tagErr.message
              });
            }
          } else {
            onboarded += 1;
            report.push({
              vmId,
              vmName,
              action: 'DRY_RUN_ONBOARD',
              suggestedTags: tagsToApply
            });
          }
        } else {
          manualReview += 1;
          report.push({
            vmId,
            vmName,
            action: 'MANUAL_REVIEW',
            suggestions
          });
        }
      }

      const result = {
        site,
        timestamp: new Date().toISOString(),
        totalUnregistered: unregisteredVMs.length,
        onboarded,
        manualReview,
        failed,
        report
      };

      this.logger.info('Unregistered VM onboarding completed', {
        site,
        totalUnregistered: unregisteredVMs.length,
        onboarded,
        manualReview,
        failed,
        component: 'UnregisteredVMOnboarder'
      });

      return result;
    } catch (err) {
      this.logger.error('Unregistered VM onboarding failed', {
        site,
        errorMessage: err.message,
        component: 'UnregisteredVMOnboarder'
      });
      throw new Error(`[DFW-9200] UnregisteredVMOnboarder onboarding failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Creates a CMDB CI record in ServiceNow.
   *
   * @private
   * @async
   * @param {Object} vmDetails - VM details for CI creation.
   * @param {string} site - Site code.
   * @returns {Promise<Object>} Created CI record.
   */
  async _createCMDBRecord(vmDetails, site) {
    this.logger.info('Creating CMDB CI for unregistered VM', {
      vmId: vmDetails.vmId,
      vmName: vmDetails.vmName,
      site,
      component: 'UnregisteredVMOnboarder'
    });

    try {
      const result = await this.snowAdapter.toCallbackPayload({
        action: 'createCI',
        vmId: vmDetails.vmId,
        vmName: vmDetails.vmName,
        site,
        tags: vmDetails.tags
      });
      return result;
    } catch (err) {
      throw new Error(`[DFW-9201] CMDB CI creation failed for "${vmDetails.vmName}": ${err.message}`);
    }
  }

  /**
   * Applies initial tags to a VM.
   *
   * @private
   * @async
   * @param {string} vmId - VM identifier.
   * @param {Object} tags - Tags to apply.
   * @param {string} site - Site code.
   * @returns {Promise<Object>} Tag application result.
   */
  async _applyInitialTags(vmId, tags, site) {
    this.logger.info('Applying initial tags to unregistered VM', {
      vmId,
      tagCount: Object.keys(tags).length,
      site,
      component: 'UnregisteredVMOnboarder'
    });

    return this.tagOperations.applyTags(vmId, tags, site);
  }
}

module.exports = UnregisteredVMOnboarder;
