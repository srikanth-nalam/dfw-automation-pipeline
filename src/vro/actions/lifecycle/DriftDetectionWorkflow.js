/**
 * @file DriftDetectionWorkflow.js
 * @description Scheduled drift detection workflow for the DFW Automation Pipeline.
 *   Scans VMs to compare actual NSX tag state against CMDB expected state,
 *   generates drift reports, and optionally auto-remediates drifted tags.
 *
 * @module lifecycle/DriftDetectionWorkflow
 */

'use strict';

/**
 * Default batch size for VM scanning.
 * @constant {number}
 * @private
 */
const SCAN_BATCH_SIZE = 20;

/**
 * @class DriftDetectionWorkflow
 * @classdesc Scans VM inventory for tag drift between NSX actual state and
 *   CMDB expected state, with optional auto-remediation.
 *
 * @example
 * const workflow = new DriftDetectionWorkflow(dependencies);
 * const report = await workflow.runDriftScan(payload);
 */
class DriftDetectionWorkflow {
  /**
   * Creates a new DriftDetectionWorkflow.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.tagOperations - Tag management operations.
   * @param {Object} dependencies.groupVerifier - Group membership verifier.
   * @param {Object} dependencies.groupReconciler - Group reconciliation engine.
   * @param {Object} dependencies.restClient - HTTP client.
   * @param {Object} dependencies.logger - Structured logger instance.
   * @param {Object} dependencies.configLoader - Configuration loader.
   * @param {Object} dependencies.snowAdapter - ServiceNow adapter.
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-8300] DriftDetectionWorkflow requires dependencies');
    }

    /** @private */
    this.tagOperations = dependencies.tagOperations;
    /** @private */
    this.groupVerifier = dependencies.groupVerifier;
    /** @private */
    this.groupReconciler = dependencies.groupReconciler;
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
   * Executes a drift detection scan.
   *
   * @async
   * @param {Object} payload - Scan configuration.
   * @param {string} payload.correlationId - Correlation identifier.
   * @param {string} payload.site - Target site code.
   * @param {string} [payload.scope='full'] - Scan scope: 'full' or 'targeted'.
   * @param {string[]} [payload.targetVmIds] - VM IDs for targeted scans.
   * @param {boolean} [payload.autoRemediate=false] - Auto-remediate drifted tags.
   * @param {string} [payload.callbackUrl] - Callback URL for results.
   * @returns {Promise<Object>} Drift report.
   */
  async runDriftScan(payload) {
    const correlationId = payload.correlationId;
    const site = payload.site;
    const scope = payload.scope || 'full';
    const autoRemediate = payload.autoRemediate === true;
    const scanTimestamp = new Date().toISOString();

    this.logger.info('Starting drift detection scan', {
      correlationId,
      site,
      scope,
      autoRemediate,
      component: 'DriftDetectionWorkflow'
    });

    try {
      // Step 1: Get VM inventory
      const vms = await this._getVMInventory(site, scope, payload.targetVmIds);

      this.logger.info('VM inventory retrieved', {
        correlationId,
        vmCount: vms.length,
        component: 'DriftDetectionWorkflow'
      });

      // Step 2: Scan VMs in batches
      const driftDetails = [];
      const groupDiscrepancies = [];
      let remediatedCount = 0;

      const batches = this._splitIntoBatches(vms, SCAN_BATCH_SIZE);

      for (const batch of batches) {
        for (const vm of batch) {
          const result = await this._scanVM(vm, site, autoRemediate, correlationId);

          if (result.drifted) {
            driftDetails.push(result.detail);

            if (result.remediated) {
              remediatedCount += 1;
            }

            // Step 3: Check group reconciliation for drifted VMs
            const groupResult = await this._checkGroupReconciliation(
              vm, site, correlationId
            );
            if (groupResult && groupResult.discrepancies && groupResult.discrepancies.length > 0) {
              groupDiscrepancies.push({
                vmId: vm.vm || vm.vmId,
                discrepancies: groupResult.discrepancies
              });
            }
          }
        }
      }

      const driftedVMCount = driftDetails.length;
      const unresolvedCount = driftedVMCount - remediatedCount;

      // Build drift report
      const report = {
        correlationId,
        scanTimestamp,
        site,
        totalVMsScanned: vms.length,
        driftedVMCount,
        remediatedCount,
        unresolvedCount,
        driftDetails,
        groupDiscrepancies
      };

      // Step 5: Callback to ServiceNow
      if (payload.callbackUrl) {
        await this._sendCallback(payload.callbackUrl, report, correlationId);
      }

      // Step 6: Create incidents for unresolved drift
      if (unresolvedCount > 0) {
        await this._createDriftIncidents(
          driftDetails.filter((d) => !d.remediated),
          correlationId
        );
      }

      this.logger.info('Drift detection scan completed', {
        correlationId,
        totalVMsScanned: vms.length,
        driftedVMCount,
        remediatedCount,
        unresolvedCount,
        component: 'DriftDetectionWorkflow'
      });

      return report;
    } catch (err) {
      this.logger.error('Drift detection scan failed', {
        correlationId,
        site,
        errorMessage: err.message,
        component: 'DriftDetectionWorkflow'
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Gets VM inventory from vCenter.
   *
   * @private
   * @async
   * @param {string} site - Site code.
   * @param {string} scope - Scan scope.
   * @param {string[]} [targetVmIds] - Targeted VM IDs.
   * @returns {Promise<Array>} VM list.
   */
  async _getVMInventory(site, scope, targetVmIds) {
    if (scope === 'targeted' && Array.isArray(targetVmIds) && targetVmIds.length > 0) {
      return targetVmIds.map((id) => ({ vm: id, vmId: id }));
    }

    const endpoints = this.configLoader.getEndpointsForSite(site);
    const response = await this.restClient.get(
      `${endpoints.vcenterUrl}/api/vcenter/vm`
    );

    if (Array.isArray(response)) {
      return response;
    }
    if (response && Array.isArray(response.value)) {
      return response.value;
    }
    return [];
  }

  /**
   * Scans a single VM for drift.
   *
   * @private
   * @async
   * @param {Object} vm - VM object from vCenter.
   * @param {string} site - Site code.
   * @param {boolean} autoRemediate - Auto-remediate flag.
   * @param {string} correlationId - Correlation ID.
   * @returns {Promise<Object>} Scan result.
   */
  async _scanVM(vm, site, autoRemediate, correlationId) {
    const vmId = vm.vm || vm.vmId;
    const vmName = vm.name || vm.vmName || vmId;

    try {
      // Read actual NSX tags
      const actualTags = await this.tagOperations.getTags(vmId, site);

      // Read expected tags from CMDB
      const expectedTags = await this._getExpectedTags(vmId);

      // Compare
      const driftedCategories = this._detectDrift(actualTags, expectedTags);

      if (driftedCategories.length === 0) {
        return { drifted: false };
      }

      this.logger.warn('Tag drift detected', {
        vmId,
        vmName,
        driftedCategories: driftedCategories.map((d) => d.category),
        correlationId,
        component: 'DriftDetectionWorkflow'
      });

      let remediated = false;
      let error = null;

      // Auto-remediate if configured
      if (autoRemediate) {
        try {
          await this.tagOperations.applyTags(vmId, expectedTags, site);
          remediated = true;

          this.logger.info('Drift auto-remediated', {
            vmId,
            correlationId,
            component: 'DriftDetectionWorkflow'
          });
        } catch (remediateErr) {
          error = remediateErr.message;
          this.logger.error('Auto-remediation failed', {
            vmId,
            errorMessage: remediateErr.message,
            correlationId,
            component: 'DriftDetectionWorkflow'
          });
        }
      }

      return {
        drifted: true,
        remediated,
        detail: {
          vmId,
          vmName,
          driftedCategories,
          remediated,
          error
        }
      };
    } catch (err) {
      this.logger.error('Failed to scan VM for drift', {
        vmId,
        errorMessage: err.message,
        correlationId,
        component: 'DriftDetectionWorkflow'
      });

      return {
        drifted: true,
        remediated: false,
        detail: {
          vmId,
          vmName,
          driftedCategories: [],
          remediated: false,
          error: err.message
        }
      };
    }
  }

  /**
   * Gets expected tags from CMDB.
   *
   * @private
   * @async
   * @param {string} vmId - VM identifier.
   * @returns {Promise<Object>} Expected tag map.
   */
  async _getExpectedTags(vmId) {
    try {
      if (this.snowAdapter && typeof this.snowAdapter.getExpectedTags === 'function') {
        return await this.snowAdapter.getExpectedTags(vmId);
      }
    } catch (err) {
      this.logger.warn('CMDB expected tag lookup failed', {
        vmId,
        errorMessage: err.message,
        component: 'DriftDetectionWorkflow'
      });
    }
    return {};
  }

  /**
   * Detects drift between actual and expected tags.
   *
   * @private
   * @param {Object} actual - Actual tags from NSX.
   * @param {Object} expected - Expected tags from CMDB.
   * @returns {Array<{category: string, expected: *, actual: *}>} Drifted categories.
   */
  _detectDrift(actual, expected) {
    const drifted = [];

    for (const [category, expectedValue] of Object.entries(expected)) {
      const actualValue = actual[category];

      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        drifted.push({
          category,
          expected: expectedValue,
          actual: actualValue !== undefined ? actualValue : null
        });
      }
    }

    return drifted;
  }

  /**
   * Checks group reconciliation for a drifted VM.
   *
   * @private
   * @async
   * @param {Object} vm - VM object.
   * @param {string} site - Site code.
   * @param {string} correlationId - Correlation ID.
   * @returns {Promise<Object|null>} Reconciliation result.
   */
  async _checkGroupReconciliation(vm, site, correlationId) {
    const vmId = vm.vm || vm.vmId;

    try {
      if (this.groupReconciler && typeof this.groupReconciler.reconcile === 'function') {
        return await this.groupReconciler.reconcile(vmId, site);
      }
    } catch (err) {
      this.logger.warn('Group reconciliation check failed', {
        vmId,
        correlationId,
        errorMessage: err.message,
        component: 'DriftDetectionWorkflow'
      });
    }
    return null;
  }

  /**
   * Creates ServiceNow incidents for unresolved drift.
   *
   * @private
   * @async
   * @param {Array} unresolvedDrift - Unresolved drift details.
   * @param {string} correlationId - Correlation ID.
   * @returns {Promise<void>}
   */
  async _createDriftIncidents(unresolvedDrift, correlationId) {
    try {
      if (this.snowAdapter && typeof this.snowAdapter.createIncident === 'function') {
        for (const drift of unresolvedDrift) {
          await this.snowAdapter.createIncident({
            correlationId,
            vmId: drift.vmId,
            vmName: drift.vmName,
            type: 'TAG_DRIFT',
            details: drift.driftedCategories,
            severity: 'medium'
          });
        }
      }
    } catch (err) {
      this.logger.warn('Failed to create drift incidents', {
        correlationId,
        errorMessage: err.message,
        component: 'DriftDetectionWorkflow'
      });
    }
  }

  /**
   * Splits array into batches.
   *
   * @private
   * @param {Array} items - Items to split.
   * @param {number} size - Batch size.
   * @returns {Array<Array>} Batched items.
   */
  _splitIntoBatches(items, size) {
    const batches = [];
    for (let i = 0; i < items.length; i += size) {
      batches.push(items.slice(i, i + size));
    }
    return batches;
  }

  /**
   * Sends callback to ServiceNow.
   *
   * @private
   * @async
   * @param {string} url - Callback URL.
   * @param {Object} report - Drift report.
   * @param {string} correlationId - Correlation ID.
   * @returns {Promise<void>}
   */
  async _sendCallback(url, report, correlationId) {
    try {
      await this.restClient.post(url, report);
    } catch (err) {
      this.logger.warn('Failed to send drift report callback', {
        correlationId,
        errorMessage: err.message,
        component: 'DriftDetectionWorkflow'
      });
    }
  }
}

module.exports = DriftDetectionWorkflow;
