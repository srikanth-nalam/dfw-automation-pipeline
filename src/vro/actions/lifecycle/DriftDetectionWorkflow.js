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

  // ---------------------------------------------------------------------------
  // Drift trend tracking
  // ---------------------------------------------------------------------------

  /**
   * Stores drift scan results for historical trend comparison.
   * Uses a ServiceNow custom table or local state to persist scan history.
   *
   * @async
   * @param {Object} scanReport - The drift scan report from runDriftScan.
   * @returns {Promise<{stored: boolean, scanId: string}>}
   *
   * @throws {Error} When the scan report is missing required fields.
   *
   * @example
   * const result = await workflow.storeScanHistory(report);
   * console.log(result.scanId); // 'SCAN-NDCNG-1700000000'
   */
  async storeScanHistory(scanReport) {
    if (!scanReport || typeof scanReport !== 'object') {
      throw new Error('[DFW-8301] scanReport is required and must be a non-null object.');
    }
    if (!scanReport.site) {
      throw new Error('[DFW-8301] scanReport.site is required.');
    }

    const scanId = `SCAN-${scanReport.site}-${Date.now()}`;
    const record = {
      scanId,
      site: scanReport.site,
      timestamp: scanReport.scanTimestamp || new Date().toISOString(),
      totalVMsScanned: scanReport.totalVMsScanned || 0,
      driftedVMCount: scanReport.driftedVMCount || 0,
      remediatedCount: scanReport.remediatedCount || 0,
      unresolvedCount: scanReport.unresolvedCount || 0,
      driftDetails: scanReport.driftDetails || []
    };

    this.logger.info('Storing drift scan history', {
      scanId,
      site: scanReport.site,
      driftedVMCount: record.driftedVMCount,
      component: 'DriftDetectionWorkflow'
    });

    try {
      if (this.snowAdapter && typeof this.snowAdapter.storeScanRecord === 'function') {
        await this.snowAdapter.storeScanRecord(record);
      }
    } catch (err) {
      this.logger.warn('Failed to store scan history in ServiceNow', {
        scanId,
        errorMessage: err.message,
        component: 'DriftDetectionWorkflow'
      });
    }

    // Keep in-memory history for trend analysis within this session
    if (!this._scanHistory) {
      this._scanHistory = [];
    }
    this._scanHistory.push(record);

    return { stored: true, scanId };
  }

  /**
   * Compares current scan results with previous scans to identify drift trends.
   * Answers: Is drift increasing or decreasing over time?
   *
   * @async
   * @param {string} site - Target site.
   * @param {number} [lookbackScans=10] - Number of historical scans to compare.
   * @returns {Promise<{trend: string, currentDriftCount: number, previousDriftCount: number,
   *   driftHistory: Array<{scanDate: string, driftCount: number, remediatedCount: number}>,
   *   newDriftSinceLastScan: string[], resolvedSinceLastScan: string[]}>}
   *
   * @example
   * const trend = await workflow.analyzeDriftTrend('NDCNG', 5);
   * console.log(trend.trend); // 'IMPROVING', 'WORSENING', or 'STABLE'
   */
  async analyzeDriftTrend(site, lookbackScans = 10) {
    if (!site || typeof site !== 'string') {
      throw new Error('[DFW-8302] site is required and must be a non-empty string.');
    }

    const history = (this._scanHistory || [])
      .filter((s) => s.site === site)
      .slice(-lookbackScans);

    if (history.length === 0) {
      return {
        trend: 'STABLE',
        currentDriftCount: 0,
        previousDriftCount: 0,
        driftHistory: [],
        newDriftSinceLastScan: [],
        resolvedSinceLastScan: []
      };
    }

    const current = history[history.length - 1];
    const previous = history.length > 1 ? history[history.length - 2] : null;

    const currentDriftCount = current.driftedVMCount;
    const previousDriftCount = previous ? previous.driftedVMCount : 0;

    // Determine trend
    let trend;
    if (currentDriftCount < previousDriftCount) {
      trend = 'IMPROVING';
    } else if (currentDriftCount > previousDriftCount) {
      trend = 'WORSENING';
    } else {
      trend = 'STABLE';
    }

    // Compute new and resolved drift
    const currentVmIds = new Set((current.driftDetails || []).map((d) => d.vmId));
    const previousVmIds = previous
      ? new Set((previous.driftDetails || []).map((d) => d.vmId))
      : new Set();

    const newDriftSinceLastScan = [];
    for (const vmId of currentVmIds) {
      if (!previousVmIds.has(vmId)) {
        newDriftSinceLastScan.push(vmId);
      }
    }

    const resolvedSinceLastScan = [];
    for (const vmId of previousVmIds) {
      if (!currentVmIds.has(vmId)) {
        resolvedSinceLastScan.push(vmId);
      }
    }

    const driftHistory = history.map((s) => ({
      scanDate: s.timestamp,
      driftCount: s.driftedVMCount,
      remediatedCount: s.remediatedCount
    }));

    this.logger.info('Drift trend analysis complete', {
      site,
      trend,
      currentDriftCount,
      previousDriftCount,
      component: 'DriftDetectionWorkflow'
    });

    return {
      trend,
      currentDriftCount,
      previousDriftCount,
      driftHistory,
      newDriftSinceLastScan,
      resolvedSinceLastScan
    };
  }

  /**
   * Generates an executive drift summary with trend data.
   *
   * @async
   * @param {string} site - Target site.
   * @returns {Promise<{site: string, generatedAt: string, overallTrend: string,
   *   coveragePercent: number, driftRate: number,
   *   topDriftedCategories: Array<{category: string, count: number}>,
   *   trendChart: Array<{date: string, driftCount: number}>}>}
   *
   * @example
   * const summary = await workflow.generateDriftSummary('NDCNG');
   * console.log(summary.overallTrend); // 'IMPROVING'
   */
  async generateDriftSummary(site) {
    if (!site || typeof site !== 'string') {
      throw new Error('[DFW-8303] site is required and must be a non-empty string.');
    }

    const trendResult = await this.analyzeDriftTrend(site);

    const history = (this._scanHistory || []).filter((s) => s.site === site);
    const latest = history.length > 0 ? history[history.length - 1] : null;

    // Calculate coverage percent (scanned without drift / total)
    const totalScanned = latest ? latest.totalVMsScanned : 0;
    const drifted = latest ? latest.driftedVMCount : 0;
    const coveragePercent = totalScanned > 0
      ? Math.round(((totalScanned - drifted) / totalScanned) * 100)
      : 100;

    // Drift rate as a percentage
    const driftRate = totalScanned > 0
      ? Math.round((drifted / totalScanned) * 100)
      : 0;

    // Aggregate top drifted categories from latest scan
    const categoryMap = {};
    if (latest && Array.isArray(latest.driftDetails)) {
      for (const detail of latest.driftDetails) {
        for (const cat of (detail.driftedCategories || [])) {
          const catName = cat.category || cat;
          categoryMap[catName] = (categoryMap[catName] || 0) + 1;
        }
      }
    }

    const topDriftedCategories = Object.entries(categoryMap)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const trendChart = trendResult.driftHistory.map((h) => ({
      date: h.scanDate,
      driftCount: h.driftCount
    }));

    this.logger.info('Drift executive summary generated', {
      site,
      overallTrend: trendResult.trend,
      coveragePercent,
      driftRate,
      component: 'DriftDetectionWorkflow'
    });

    return {
      site,
      generatedAt: new Date().toISOString(),
      overallTrend: trendResult.trend,
      coveragePercent,
      driftRate,
      topDriftedCategories,
      trendChart
    };
  }
}

module.exports = DriftDetectionWorkflow;
