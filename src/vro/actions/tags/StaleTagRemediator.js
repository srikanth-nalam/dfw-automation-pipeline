/**
 * @file StaleTagRemediator.js
 * @description Re-applies correct CMDB tag values to VMs with stale tags. If a VM
 *   no longer exists in CMDB, it can be flagged for quarantine or manual review.
 *
 * Error codes:
 *   - DFW-8900  StaleTagRemediator general error
 *   - DFW-8901  CMDB lookup failed for VM
 *   - DFW-8902  Tag remediation failed for VM
 *
 * @module tags/StaleTagRemediator
 */

'use strict';

/**
 * @class StaleTagRemediator
 * @classdesc Remediates stale tags on VMs by re-applying correct values from CMDB.
 *
 * @example
 * const remediator = new StaleTagRemediator(dependencies);
 * const report = await remediator.remediate('NDCNG', { dryRun: true });
 */
class StaleTagRemediator {
  /**
   * Creates a new StaleTagRemediator.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.restClient - HTTP client.
   * @param {Object} dependencies.logger - Structured logger.
   * @param {Object} dependencies.configLoader - Configuration loader.
   * @param {Object} dependencies.tagOperations - Tag management operations.
   * @param {Object} dependencies.cmdbValidator - CMDB validator for quality checks.
   * @param {Object} dependencies.snowAdapter - ServiceNow adapter for CMDB queries.
   *
   * @throws {Error} DFW-8900 when required dependencies are missing.
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-8900] StaleTagRemediator requires dependencies');
    }

    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this.configLoader = dependencies.configLoader;
    /** @private */
    this.tagOperations = dependencies.tagOperations;
    /** @private */
    this.cmdbValidator = dependencies.cmdbValidator;
    /** @private */
    this.snowAdapter = dependencies.snowAdapter;
  }

  /**
   * Remediates stale tags for a site.
   *
   * @async
   * @param {string} site - Site code (NDCNG or TULNG).
   * @param {Object} [options={}] - Remediation options.
   * @param {boolean} [options.dryRun=true] - If true, report only.
   * @param {number} [options.stalenessThresholdDays=90] - Days before tags are stale.
   * @param {boolean} [options.quarantineOrphans=false] - Quarantine VMs without CMDB records.
   * @returns {Promise<Object>} Remediation report.
   *
   * @throws {Error} DFW-8900 on general failure.
   */
  async remediate(site, options = {}) {
    const dryRun = options.dryRun !== false;
    const quarantineOrphans = options.quarantineOrphans === true;

    this.logger.info('Starting stale tag remediation', {
      site,
      dryRun,
      quarantineOrphans,
      component: 'StaleTagRemediator'
    });

    try {
      // Step 1: Get stale tag report from CMDBValidator
      const qualityReport = await this.cmdbValidator.validateQuality(site);
      const staleVMs = qualityReport.staleVMs || qualityReport.results || [];

      let remediatedVMs = 0;
      let quarantinedVMs = 0;
      let manualReviewVMs = 0;
      let failedVMs = 0;
      const report = [];

      // Step 2: Process each stale VM
      for (const vm of staleVMs) {
        const vmId = vm.vmId || vm.vm;
        const vmName = vm.vmName || vm.name || vmId;

        // Step 2a: Query CMDB for expected tags
        let expectedTags;
        let cmdbStatus;
        try {
          const cmdbResult = await this._getExpectedTagsFromCMDB(vmId, vmName);
          expectedTags = cmdbResult.tags;
          cmdbStatus = cmdbResult.status;
        } catch (cmdbErr) {
          this.logger.warn('CMDB lookup failed for VM', {
            vmId,
            vmName,
            errorMessage: cmdbErr.message,
            component: 'StaleTagRemediator'
          });
          failedVMs += 1;
          report.push({
            vmId,
            vmName,
            action: 'CMDB_LOOKUP_FAILED',
            error: cmdbErr.message
          });
          continue;
        }

        // Step 2b: CMDB record active — remediate
        if (cmdbStatus === 'active' && expectedTags) {
          if (!dryRun) {
            try {
              await this._remediateVM(vmId, vm.currentTags || {}, expectedTags, site);
              remediatedVMs += 1;
              report.push({ vmId, vmName, action: 'REMEDIATED', expectedTags });
            } catch (remErr) {
              failedVMs += 1;
              report.push({
                vmId,
                vmName,
                action: 'REMEDIATION_FAILED',
                error: remErr.message
              });
            }
          } else {
            remediatedVMs += 1;
            report.push({ vmId, vmName, action: 'DRY_RUN_REMEDIATE', expectedTags });
          }
          continue;
        }

        // Step 2c-d: CMDB record decommissioned or absent
        if (quarantineOrphans) {
          if (!dryRun) {
            await this._flagForQuarantine(vmId, site, `CMDB status: ${cmdbStatus || 'absent'}`);
          }
          quarantinedVMs += 1;
          report.push({ vmId, vmName, action: 'QUARANTINED', reason: cmdbStatus || 'absent' });
        } else {
          manualReviewVMs += 1;
          report.push({ vmId, vmName, action: 'MANUAL_REVIEW', reason: cmdbStatus || 'absent' });
        }
      }

      const result = {
        site,
        timestamp: new Date().toISOString(),
        totalStaleVMs: staleVMs.length,
        remediatedVMs,
        quarantinedVMs,
        manualReviewVMs,
        failedVMs,
        report
      };

      this.logger.info('Stale tag remediation completed', {
        site,
        totalStaleVMs: staleVMs.length,
        remediatedVMs,
        quarantinedVMs,
        manualReviewVMs,
        failedVMs,
        component: 'StaleTagRemediator'
      });

      return result;
    } catch (err) {
      this.logger.error('Stale tag remediation failed', {
        site,
        errorMessage: err.message,
        component: 'StaleTagRemediator'
      });
      throw new Error(`[DFW-8900] StaleTagRemediator remediation failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Queries CMDB for expected tags for a VM.
   *
   * @private
   * @async
   * @param {string} vmId - VM identifier.
   * @param {string} vmName - VM display name.
   * @returns {Promise<{tags: Object, status: string}>} Expected tags and CI status.
   */
  async _getExpectedTagsFromCMDB(vmId, vmName) {
    const result = await this.snowAdapter.toCallbackPayload({
      action: 'getCITags',
      vmId,
      vmName
    });

    return {
      tags: result.tags || result.expectedTags || null,
      status: result.ciStatus || result.status || 'unknown'
    };
  }

  /**
   * Applies corrected tags to a VM.
   *
   * @private
   * @async
   * @param {string} vmId - VM identifier.
   * @param {Object} currentTags - Current tag values on the VM.
   * @param {Object} expectedTags - Expected tag values from CMDB.
   * @param {string} site - Site code.
   * @returns {Promise<Object>} Tag application result.
   */
  async _remediateVM(vmId, currentTags, expectedTags, site) {
    this.logger.info('Remediating stale tags on VM', {
      vmId,
      site,
      component: 'StaleTagRemediator'
    });

    const result = await this.tagOperations.applyTags(vmId, expectedTags, site);
    return result;
  }

  /**
   * Flags a VM for quarantine.
   *
   * @private
   * @async
   * @param {string} vmId - VM identifier.
   * @param {string} site - Site code.
   * @param {string} reason - Quarantine reason.
   * @returns {Promise<void>}
   */
  async _flagForQuarantine(vmId, site, reason) {
    this.logger.warn('Flagging VM for quarantine', {
      vmId,
      site,
      reason,
      component: 'StaleTagRemediator'
    });

    await this.snowAdapter.toCallbackPayload({
      action: 'quarantine',
      vmId,
      site,
      reason
    });
  }
}

module.exports = StaleTagRemediator;
