/**
 * @file BulkTagOrchestrator.js
 * @description Bulk tag operations orchestrator for the DFW Automation Pipeline.
 *   Processes multiple VMs in configurable batches with parallel execution,
 *   per-VM error isolation, progress callbacks, and completion reporting.
 *
 *   This is NOT an extension of LifecycleOrchestrator due to its fundamentally
 *   different workflow shape (batch-oriented vs single-VM).
 *
 * @module lifecycle/BulkTagOrchestrator
 */

'use strict';

/**
 * Inline semaphore for concurrency control.
 * @private
 */
class Semaphore {
  /**
   * @param {number} max - Maximum concurrent permits.
   */
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  /**
   * Acquires a permit, waiting if none available.
   * @returns {Promise<void>}
   */
  async acquire() {
    if (this.current < this.max) {
      this.current += 1;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Releases a permit, unblocking a waiting caller if any.
   */
  release() {
    this.current -= 1;
    if (this.queue.length > 0) {
      this.current += 1;
      const next = this.queue.shift();
      next();
    }
  }
}

/**
 * @class BulkTagOrchestrator
 * @classdesc Orchestrates bulk tag operations across multiple VMs with
 *   configurable batching, parallelism, per-VM error isolation, and
 *   progress reporting.
 *
 * @example
 * const orchestrator = new BulkTagOrchestrator(dependencies);
 * const report = await orchestrator.executeBulk(payload);
 */
class BulkTagOrchestrator {
  /**
   * Creates a new BulkTagOrchestrator.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.tagOperations - Tag management operations.
   * @param {Object} dependencies.groupVerifier - Group membership verifier.
   * @param {Object} dependencies.dfwValidator - DFW policy validator.
   * @param {Object} dependencies.sagaCoordinator - Saga coordinator.
   * @param {Object} dependencies.logger - Structured logger instance.
   * @param {Object} dependencies.restClient - HTTP client.
   * @param {Object} dependencies.configLoader - Configuration loader.
   * @param {Object} dependencies.snowAdapter - ServiceNow adapter.
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-8200] BulkTagOrchestrator requires dependencies');
    }

    /** @private */
    this.tagOperations = dependencies.tagOperations;
    /** @private */
    this.groupVerifier = dependencies.groupVerifier;
    /** @private */
    this.dfwValidator = dependencies.dfwValidator;
    /** @private */
    this.sagaCoordinator = dependencies.sagaCoordinator;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.configLoader = dependencies.configLoader;
    /** @private */
    this.snowAdapter = dependencies.snowAdapter;
  }

  /**
   * Executes bulk tag operations across multiple VMs.
   *
   * @async
   * @param {Object} payload - Bulk operation payload.
   * @param {string} payload.correlationId - Correlation identifier.
   * @param {string} payload.site - Target site code.
   * @param {number} [payload.batchSize=10] - VMs per batch (1-50).
   * @param {number} [payload.concurrency=5] - Parallel VMs per batch (1-10).
   * @param {Array<{vmId: string, vmName: string, tags: Object}>} payload.vms - VM entries.
   * @param {string} [payload.callbackUrl] - Final callback URL.
   * @param {string} [payload.progressCallbackUrl] - Progress callback URL.
   * @param {boolean} [payload.dryRun=false] - Dry run mode.
   * @returns {Promise<Object>} Completion report.
   */
  async executeBulk(payload) {
    const startTime = Date.now();
    const correlationId = payload.correlationId;
    const batchSize = Math.min(Math.max(payload.batchSize || 10, 1), 50);
    const concurrency = Math.min(Math.max(payload.concurrency || 5, 1), 10);
    const dryRun = payload.dryRun === true;
    const vms = payload.vms || [];

    this.logger.info('Starting bulk tag operation', {
      correlationId,
      totalVMs: vms.length,
      batchSize,
      concurrency,
      dryRun,
      site: payload.site,
      component: 'BulkTagOrchestrator'
    });

    if (vms.length === 0) {
      return this._buildReport(correlationId, [], startTime, dryRun);
    }

    // Split into batches
    const batches = this._splitIntoBatches(vms, batchSize);
    const totalBatches = batches.length;
    const allResults = [];
    let processedCount = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];

      this.logger.info('Processing batch', {
        correlationId,
        batchIndex: batchIndex + 1,
        totalBatches,
        batchVMCount: batch.length,
        component: 'BulkTagOrchestrator'
      });

      // Process batch with concurrency limit
      const batchResults = await this._processBatch(
        batch, payload.site, concurrency, dryRun, correlationId
      );

      allResults.push(...batchResults);
      processedCount += batch.length;

      // Send progress callback if configured
      if (payload.progressCallbackUrl) {
        await this._sendProgressCallback(payload.progressCallbackUrl, {
          correlationId,
          processedCount,
          totalCount: vms.length,
          successCount: allResults.filter((r) => r.status === 'success').length,
          failureCount: allResults.filter((r) => r.status === 'failed').length,
          currentBatch: batchIndex + 1,
          totalBatches
        });
      }
    }

    // Build completion report
    const report = this._buildReport(correlationId, allResults, startTime, dryRun);

    // Send final callback
    if (payload.callbackUrl) {
      await this._sendCallback(payload.callbackUrl, report);
    }

    this.logger.info('Bulk tag operation completed', {
      correlationId,
      status: report.status,
      totalVMs: report.totalVMs,
      successCount: report.successCount,
      failureCount: report.failureCount,
      executionTimeMs: report.executionTimeMs,
      component: 'BulkTagOrchestrator'
    });

    return report;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Splits VM array into batches.
   *
   * @private
   * @param {Array} vms - VM entries.
   * @param {number} batchSize - Max VMs per batch.
   * @returns {Array<Array>} Array of batches.
   */
  _splitIntoBatches(vms, batchSize) {
    const batches = [];
    for (let i = 0; i < vms.length; i += batchSize) {
      batches.push(vms.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Processes a batch of VMs with concurrency control.
   *
   * @private
   * @async
   * @param {Array} batch - VM entries in this batch.
   * @param {string} site - Target site code.
   * @param {number} concurrency - Max parallel operations.
   * @param {boolean} dryRun - Dry run mode.
   * @param {string} correlationId - Correlation identifier.
   * @returns {Promise<Array>} Results for each VM.
   */
  async _processBatch(batch, site, concurrency, dryRun, correlationId) {
    const semaphore = new Semaphore(concurrency);
    const promises = batch.map((vm) => this._processVMWithSemaphore(
      semaphore, vm, site, dryRun, correlationId
    ));
    return Promise.all(promises);
  }

  /**
   * Processes a single VM within semaphore-controlled concurrency.
   *
   * @private
   * @async
   * @param {Semaphore} semaphore - Concurrency controller.
   * @param {Object} vm - VM entry with vmId, vmName, tags.
   * @param {string} site - Site code.
   * @param {boolean} dryRun - Dry run mode.
   * @param {string} correlationId - Correlation identifier.
   * @returns {Promise<Object>} VM processing result.
   */
  async _processVMWithSemaphore(semaphore, vm, site, dryRun, correlationId) {
    await semaphore.acquire();
    try {
      return await this._processSingleVM(vm, site, dryRun, correlationId);
    } finally {
      semaphore.release();
    }
  }

  /**
   * Processes a single VM — isolated error handling per VM.
   *
   * @private
   * @async
   * @param {Object} vm - VM entry.
   * @param {string} site - Site code.
   * @param {boolean} dryRun - Dry run mode.
   * @param {string} correlationId - Correlation identifier.
   * @returns {Promise<Object>} VM result.
   */
  async _processSingleVM(vm, site, dryRun, correlationId) {
    const vmId = vm.vmId || vm.vmName;

    try {
      // Read current tags
      const currentTags = await this.tagOperations.getTags(vmId, site);

      // Compute delta
      const delta = this._computeDelta(currentTags, vm.tags);

      // No-op detection
      if (Object.keys(delta.changes).length === 0 && Object.keys(delta.additions).length === 0) {
        this.logger.debug('VM already in desired state, skipping', {
          vmId,
          correlationId,
          component: 'BulkTagOrchestrator'
        });
        return {
          vmId,
          vmName: vm.vmName,
          status: 'skipped',
          delta
        };
      }

      if (dryRun) {
        // Predict group changes without mutating
        const groupChanges = this.groupVerifier.predictGroupChanges(
          vmId, currentTags, { ...currentTags, ...vm.tags }
        );
        return {
          vmId,
          vmName: vm.vmName,
          status: 'success',
          delta,
          groupChanges,
          appliedTags: vm.tags
        };
      }

      // Apply tags
      const tagResult = await this.tagOperations.applyTags(vmId, vm.tags, site);

      return {
        vmId,
        vmName: vm.vmName,
        status: 'success',
        appliedTags: vm.tags,
        delta,
        operationResult: tagResult
      };
    } catch (err) {
      this.logger.error('Failed to process VM in bulk operation', {
        vmId,
        vmName: vm.vmName,
        correlationId,
        errorMessage: err.message,
        component: 'BulkTagOrchestrator'
      });

      return {
        vmId,
        vmName: vm.vmName,
        status: 'failed',
        error: err.message
      };
    }
  }

  /**
   * Computes the delta between current and desired tags.
   *
   * @private
   * @param {Object} currentTags - Current tag values.
   * @param {Object} desiredTags - Desired tag values.
   * @returns {Object} Delta with additions and changes.
   */
  _computeDelta(currentTags, desiredTags) {
    const additions = {};
    const changes = {};

    for (const [category, value] of Object.entries(desiredTags)) {
      if (currentTags[category] === undefined) {
        additions[category] = value;
      } else if (JSON.stringify(currentTags[category]) !== JSON.stringify(value)) {
        changes[category] = { from: currentTags[category], to: value };
      }
    }

    return { additions, changes };
  }

  /**
   * Builds the completion report.
   *
   * @private
   * @param {string} correlationId - Correlation identifier.
   * @param {Array} results - All VM results.
   * @param {number} startTime - Operation start timestamp.
   * @param {boolean} dryRun - Dry run flag.
   * @returns {Object} Completion report.
   */
  _buildReport(correlationId, results, startTime, dryRun) {
    const executionTimeMs = Date.now() - startTime;
    const successCount = results.filter((r) => r.status === 'success').length;
    const failureCount = results.filter((r) => r.status === 'failed').length;
    const skippedCount = results.filter((r) => r.status === 'skipped').length;
    const totalVMs = results.length;

    let status = 'completed';
    if (failureCount > 0 && successCount > 0) {
      status = 'completed_with_errors';
    } else if (failureCount > 0 && successCount === 0 && totalVMs > 0) {
      status = 'failed';
    }

    return {
      correlationId,
      status,
      totalVMs,
      successCount,
      failureCount,
      skippedCount,
      executionTimeMs,
      averageTimePerVM: totalVMs > 0 ? Math.round(executionTimeMs / totalVMs) : 0,
      results,
      failedVMs: results
        .filter((r) => r.status === 'failed')
        .map((r) => ({ vmId: r.vmId, vmName: r.vmName, error: r.error })),
      dryRun
    };
  }

  /**
   * Sends a progress callback to ServiceNow.
   *
   * @private
   * @async
   * @param {string} url - Progress callback URL.
   * @param {Object} progress - Progress data.
   * @returns {Promise<void>}
   */
  async _sendProgressCallback(url, progress) {
    try {
      await this.restClient.post(url, progress);
    } catch (err) {
      this.logger.warn('Failed to send progress callback', {
        url,
        errorMessage: err.message,
        component: 'BulkTagOrchestrator'
      });
    }
  }

  /**
   * Sends the final callback to ServiceNow.
   *
   * @private
   * @async
   * @param {string} url - Callback URL.
   * @param {Object} report - Completion report.
   * @returns {Promise<void>}
   */
  async _sendCallback(url, report) {
    try {
      await this.restClient.post(url, report);
    } catch (err) {
      this.logger.warn('Failed to send final callback', {
        url,
        correlationId: report.correlationId,
        errorMessage: err.message,
        component: 'BulkTagOrchestrator'
      });
    }
  }
}

module.exports = BulkTagOrchestrator;
