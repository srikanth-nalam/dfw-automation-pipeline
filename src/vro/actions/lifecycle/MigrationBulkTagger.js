/**
 * @file MigrationBulkTagger.js
 * @description Migration-event-driven bulk tagging for the DFW Automation Pipeline.
 *   Handles tagging of VMs during migration waves (e.g., ~9,500 Greenzone VMs).
 *   Provides manifest loading, pre-validation, wave execution, post-migration
 *   verification, wave reporting, and overall migration progress tracking.
 *
 *   The 5-tag mandatory model enforced during migration:
 *     - Region, SecurityZone, Environment, AppCI, SystemRole
 *   Optional tags preserved when present:
 *     - Compliance, DataClassification, CostCenter
 *
 * @module lifecycle/MigrationBulkTagger
 */

'use strict';

/**
 * Mandatory tag categories that must be present on every migrated VM.
 * @constant {string[]}
 */
const MANDATORY_TAG_CATEGORIES = [
  'Region',
  'SecurityZone',
  'Environment',
  'AppCI',
  'SystemRole'
];

/**
 * Optional tag categories that are preserved if present but not required.
 * @constant {string[]}
 */
const OPTIONAL_TAG_CATEGORIES = [
  'Compliance',
  'DataClassification',
  'CostCenter'
];

/**
 * All tag categories (mandatory + optional).
 * @constant {string[]}
 */
const ALL_TAG_CATEGORIES = [...MANDATORY_TAG_CATEGORIES, ...OPTIONAL_TAG_CATEGORIES];

/**
 * Maximum number of VMs that can be processed in a single migration wave.
 * @constant {number}
 */
const MAX_WAVE_VMS = 500;

/**
 * @class MigrationBulkTagger
 * @classdesc Orchestrates bulk tagging for migration waves. Coordinates with
 *   CMDB validation, bulk tag orchestration, and post-migration verification
 *   to ensure tag consistency across vMotion events.
 *
 * @example
 * const tagger = new MigrationBulkTagger(dependencies);
 * const manifest = await tagger.loadManifest(manifestData);
 * const preCheck = await tagger.preValidate(manifest.manifest, 'NDCNG');
 * const result = await tagger.executeWave(manifest.waveId, 'NDCNG');
 */
class MigrationBulkTagger {
  /**
   * Creates a new MigrationBulkTagger.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.tagOperations - Tag management operations
   *   (getTags, applyTags, verifyPropagation).
   * @param {Object} dependencies.cmdbValidator - CMDB CI record validator for
   *   tag completeness checks.
   * @param {Object} dependencies.migrationVerifier - Post-vMotion tag
   *   preservation verifier.
   * @param {Object} dependencies.bulkTagOrchestrator - Batch-oriented tag
   *   application orchestrator.
   * @param {Object} dependencies.restClient - HTTP client for REST API calls.
   * @param {Object} dependencies.logger - Structured logger instance.
   * @throws {Error} If dependencies are not provided (DFW-8600).
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-8600] MigrationBulkTagger requires dependencies');
    }
    if (!dependencies.tagOperations) {
      throw new Error('[DFW-8601] MigrationBulkTagger requires tagOperations dependency');
    }
    if (!dependencies.cmdbValidator) {
      throw new Error('[DFW-8602] MigrationBulkTagger requires cmdbValidator dependency');
    }
    if (!dependencies.migrationVerifier) {
      throw new Error('[DFW-8603] MigrationBulkTagger requires migrationVerifier dependency');
    }
    if (!dependencies.bulkTagOrchestrator) {
      throw new Error('[DFW-8604] MigrationBulkTagger requires bulkTagOrchestrator dependency');
    }
    if (!dependencies.logger) {
      throw new Error('[DFW-8605] MigrationBulkTagger requires logger dependency');
    }

    /** @private */
    this.tagOperations = dependencies.tagOperations;
    /** @private */
    this.cmdbValidator = dependencies.cmdbValidator;
    /** @private */
    this.migrationVerifier = dependencies.migrationVerifier;
    /** @private */
    this.bulkTagOrchestrator = dependencies.bulkTagOrchestrator;
    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;

    /**
     * In-memory store of loaded wave manifests keyed by waveId.
     * @private
     * @type {Map<string, Object>}
     */
    this._waves = new Map();

    /**
     * In-memory store of wave execution results keyed by waveId.
     * @private
     * @type {Map<string, Object>}
     */
    this._waveResults = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Loads and validates a migration wave manifest.
   *
   * The manifest must contain:
   *   - waveId: unique identifier for the migration wave
   *   - vms: array of VM objects with vmId, vmName, and tags
   *   - site: target site code (e.g., 'NDCNG', 'TULNG')
   *   - scheduledDate: ISO 8601 date string for the scheduled migration
   *
   * Each VM's tags object is validated against the mandatory 5-tag model
   * (Region, SecurityZone, Environment, AppCI, SystemRole).
   *
   * @async
   * @param {Object} manifestData - The migration wave manifest.
   * @param {string} manifestData.waveId - Unique wave identifier.
   * @param {Array<Object>} manifestData.vms - Array of VM entries.
   * @param {string} manifestData.vms[].vmId - VM identifier.
   * @param {string} manifestData.vms[].vmName - VM display name.
   * @param {Object} manifestData.vms[].tags - Tag key-value map.
   * @param {string} manifestData.site - Target site code.
   * @param {string} manifestData.scheduledDate - Scheduled migration date.
   * @returns {Promise<Object>} Manifest loading result with validation summary.
   * @throws {Error} If manifest structure is invalid (DFW-8610).
   */
  async loadManifest(manifestData) {
    this.logger.info('Loading migration wave manifest', {
      waveId: manifestData && manifestData.waveId,
      component: 'MigrationBulkTagger'
    });

    const structureErrors = this._validateManifestStructure(manifestData);
    if (structureErrors.length > 0) {
      throw new Error(
        '[DFW-8610] Invalid manifest structure: ' + structureErrors.join('; ')
      );
    }

    const { waveId, vms, site, scheduledDate } = manifestData;
    const validVMs = [];
    const invalidVMs = [];

    for (let i = 0; i < vms.length; i++) {
      const vm = vms[i];
      const vmErrors = this._validateVMEntry(vm, i);

      if (vmErrors.length > 0) {
        invalidVMs.push({
          index: i,
          vmId: vm.vmId || 'unknown',
          vmName: vm.vmName || 'unknown',
          errors: vmErrors
        });
      } else {
        validVMs.push(vm);
      }
    }

    const manifest = {
      waveId,
      site,
      scheduledDate,
      vms: validVMs,
      invalidVMs,
      loadedAt: new Date().toISOString()
    };

    this._waves.set(waveId, manifest);

    this.logger.info('Migration wave manifest loaded', {
      waveId,
      totalVMs: vms.length,
      validVMs: validVMs.length,
      invalidVMs: invalidVMs.length,
      site,
      scheduledDate,
      component: 'MigrationBulkTagger'
    });

    return {
      waveId,
      totalVMs: vms.length,
      validVMs: validVMs.length,
      invalidVMs: invalidVMs.length,
      manifest
    };
  }

  /**
   * Pre-validates all VMs in a manifest against CMDB before migration.
   *
   * Uses the cmdbValidator to check tag completeness for each VM,
   * verifying that all mandatory tag categories have values in CMDB.
   * VMs that fail pre-validation are flagged with gap details.
   *
   * @async
   * @param {Object} manifest - The loaded manifest (from loadManifest).
   * @param {string} site - The target site code.
   * @returns {Promise<Object>} Pre-validation result with ready/not-ready counts.
   * @throws {Error} If manifest is not valid (DFW-8620).
   */
  async preValidate(manifest, site) {
    if (!manifest || !manifest.waveId || !Array.isArray(manifest.vms)) {
      throw new Error('[DFW-8620] Valid manifest with waveId and vms array is required for pre-validation');
    }

    if (!site || typeof site !== 'string') {
      throw new Error('[DFW-8621] Site is required for pre-validation');
    }

    this.logger.info('Starting pre-migration CMDB validation', {
      waveId: manifest.waveId,
      vmCount: manifest.vms.length,
      site,
      component: 'MigrationBulkTagger'
    });

    const readyVMs = [];
    const notReadyVMs = [];
    const gapDetails = [];

    for (const vm of manifest.vms) {
      try {
        const validation = await this.cmdbValidator.validateTagCompleteness(
          vm.vmId, MANDATORY_TAG_CATEGORIES
        );

        if (validation && validation.complete) {
          readyVMs.push({
            vmId: vm.vmId,
            vmName: vm.vmName,
            status: 'ready'
          });
        } else {
          const missingCategories = (validation && validation.missingCategories) || [];
          notReadyVMs.push({
            vmId: vm.vmId,
            vmName: vm.vmName,
            status: 'not_ready',
            missingCategories
          });
          gapDetails.push({
            vmId: vm.vmId,
            vmName: vm.vmName,
            missingCategories
          });
        }
      } catch (err) {
        this.logger.warn('CMDB validation failed for VM', {
          vmId: vm.vmId,
          vmName: vm.vmName,
          errorMessage: err.message,
          component: 'MigrationBulkTagger'
        });

        notReadyVMs.push({
          vmId: vm.vmId,
          vmName: vm.vmName,
          status: 'validation_error',
          error: err.message
        });
      }
    }

    this.logger.info('Pre-migration CMDB validation completed', {
      waveId: manifest.waveId,
      readyCount: readyVMs.length,
      notReadyCount: notReadyVMs.length,
      site,
      component: 'MigrationBulkTagger'
    });

    return {
      waveId: manifest.waveId,
      site,
      readyCount: readyVMs.length,
      notReadyCount: notReadyVMs.length,
      readyVMs,
      notReadyVMs,
      gapDetails
    };
  }

  /**
   * Executes tagging for a migration wave by delegating to the
   * bulkTagOrchestrator.
   *
   * Only VMs from the loaded manifest for the specified wave are processed.
   * The wave must be loaded via {@link loadManifest} before execution.
   *
   * @async
   * @param {string} waveId - The wave identifier from the loaded manifest.
   * @param {string} site - The target site code.
   * @returns {Promise<Object>} Execution result with per-VM outcomes.
   * @throws {Error} If the wave is not loaded (DFW-8630).
   */
  async executeWave(waveId, site) {
    const wave = this._waves.get(waveId);
    if (!wave) {
      throw new Error(`[DFW-8630] Wave "${waveId}" not loaded. Call loadManifest first.`);
    }

    if (!site || typeof site !== 'string') {
      throw new Error('[DFW-8631] Site is required for wave execution');
    }

    this.logger.info('Executing migration wave tagging', {
      waveId,
      vmCount: wave.vms.length,
      site,
      component: 'MigrationBulkTagger'
    });

    const startTime = Date.now();

    try {
      const bulkPayload = {
        correlationId: `MIGRATION-${waveId}`,
        site,
        batchSize: 25,
        concurrency: 5,
        vms: wave.vms.map((vm) => ({
          vmId: vm.vmId,
          vmName: vm.vmName,
          tags: vm.tags
        })),
        dryRun: false
      };

      const bulkResult = await this.bulkTagOrchestrator.executeBulk(bulkPayload);

      const executionResult = {
        waveId,
        site,
        processedCount: bulkResult.totalVMs || 0,
        successCount: bulkResult.successCount || 0,
        failureCount: bulkResult.failureCount || 0,
        skippedCount: bulkResult.skippedCount || 0,
        executionTimeMs: Date.now() - startTime,
        results: bulkResult.results || [],
        failedVMs: bulkResult.failedVMs || [],
        status: bulkResult.status || 'completed'
      };

      this._waveResults.set(waveId, executionResult);

      this.logger.info('Migration wave tagging completed', {
        waveId,
        status: executionResult.status,
        processedCount: executionResult.processedCount,
        successCount: executionResult.successCount,
        failureCount: executionResult.failureCount,
        executionTimeMs: executionResult.executionTimeMs,
        component: 'MigrationBulkTagger'
      });

      return executionResult;
    } catch (err) {
      this.logger.error('Migration wave execution failed', {
        waveId,
        site,
        errorMessage: err.message,
        component: 'MigrationBulkTagger'
      });

      const failedResult = {
        waveId,
        site,
        processedCount: 0,
        successCount: 0,
        failureCount: wave.vms.length,
        skippedCount: 0,
        executionTimeMs: Date.now() - startTime,
        results: [],
        failedVMs: [],
        status: 'failed',
        error: err.message
      };

      this._waveResults.set(waveId, failedResult);
      throw err;
    }
  }

  /**
   * Verifies tags on all VMs in a wave after vMotion completion.
   *
   * Uses the migrationVerifier to check each VM at the destination site
   * and detect drift, missing tags, or tags that were lost during migration.
   *
   * @async
   * @param {string} waveId - The wave identifier.
   * @param {string} site - The destination site code (post-migration).
   * @returns {Promise<Object>} Verification result with per-VM details.
   * @throws {Error} If the wave is not loaded (DFW-8640).
   */
  async verifyPostMigration(waveId, site) {
    const wave = this._waves.get(waveId);
    if (!wave) {
      throw new Error(`[DFW-8640] Wave "${waveId}" not loaded. Call loadManifest first.`);
    }

    if (!site || typeof site !== 'string') {
      throw new Error('[DFW-8641] Site is required for post-migration verification');
    }

    this.logger.info('Starting post-migration verification', {
      waveId,
      vmCount: wave.vms.length,
      site,
      component: 'MigrationBulkTagger'
    });

    let verifiedCount = 0;
    let driftedCount = 0;
    let missingCount = 0;
    const details = [];

    for (const vm of wave.vms) {
      try {
        const verifyResult = await this.migrationVerifier.verifyPostMigration({
          correlationId: `MIGRATION-${waveId}-VERIFY`,
          vmId: vm.vmId,
          vmName: vm.vmName,
          sourceSite: wave.site,
          destinationSite: site,
          expectedTags: vm.tags
        });

        if (verifyResult.tagsPreserved) {
          verifiedCount += 1;
          details.push({
            vmId: vm.vmId,
            vmName: vm.vmName,
            status: 'verified',
            tagsPreserved: true
          });
        } else if (verifyResult.reapplied) {
          driftedCount += 1;
          details.push({
            vmId: vm.vmId,
            vmName: vm.vmName,
            status: 'drifted_reapplied',
            tagsPreserved: false,
            reapplied: true,
            missingTags: verifyResult.missingTags
          });
        } else {
          driftedCount += 1;
          details.push({
            vmId: vm.vmId,
            vmName: vm.vmName,
            status: 'drifted',
            tagsPreserved: false,
            reapplied: false,
            missingTags: verifyResult.missingTags
          });
        }
      } catch (err) {
        missingCount += 1;
        details.push({
          vmId: vm.vmId,
          vmName: vm.vmName,
          status: 'verification_failed',
          error: err.message
        });

        this.logger.warn('Post-migration verification failed for VM', {
          vmId: vm.vmId,
          vmName: vm.vmName,
          waveId,
          errorMessage: err.message,
          component: 'MigrationBulkTagger'
        });
      }
    }

    this.logger.info('Post-migration verification completed', {
      waveId,
      verifiedCount,
      driftedCount,
      missingCount,
      site,
      component: 'MigrationBulkTagger'
    });

    return {
      waveId,
      site,
      verifiedCount,
      driftedCount,
      missingCount,
      totalVMs: wave.vms.length,
      details
    };
  }

  /**
   * Generates a migration wave completion report.
   *
   * Combines manifest data, execution results, and any post-migration
   * verification data into a comprehensive report object.
   *
   * @async
   * @param {string} waveId - The wave identifier.
   * @returns {Promise<Object>} Comprehensive wave report.
   * @throws {Error} If the wave is not loaded (DFW-8650).
   */
  async generateWaveReport(waveId) {
    const wave = this._waves.get(waveId);
    if (!wave) {
      throw new Error(`[DFW-8650] Wave "${waveId}" not loaded. Cannot generate report.`);
    }

    const executionResult = this._waveResults.get(waveId);

    this.logger.info('Generating migration wave report', {
      waveId,
      component: 'MigrationBulkTagger'
    });

    const report = {
      waveId,
      site: wave.site,
      scheduledDate: wave.scheduledDate,
      loadedAt: wave.loadedAt,
      totalVMs: wave.vms.length,
      invalidVMs: wave.invalidVMs ? wave.invalidVMs.length : 0,
      execution: executionResult || null,
      generatedAt: new Date().toISOString()
    };

    if (executionResult) {
      report.summary = {
        processedCount: executionResult.processedCount,
        successCount: executionResult.successCount,
        failureCount: executionResult.failureCount,
        skippedCount: executionResult.skippedCount,
        executionTimeMs: executionResult.executionTimeMs,
        status: executionResult.status,
        successRate: executionResult.processedCount > 0
          ? Math.round((executionResult.successCount / executionResult.processedCount) * 100)
          : 0
      };
    }

    return report;
  }

  /**
   * Retrieves overall migration progress across all loaded waves.
   *
   * Aggregates data from all in-memory wave manifests and their execution
   * results to provide a high-level progress view.
   *
   * @async
   * @returns {Promise<Object>} Aggregated migration progress.
   */
  async getMigrationProgress() {
    const waves = [];
    let totalVMs = 0;
    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;

    for (const [waveId, wave] of this._waves.entries()) {
      const executionResult = this._waveResults.get(waveId);
      const waveInfo = {
        waveId,
        site: wave.site,
        scheduledDate: wave.scheduledDate,
        totalVMs: wave.vms.length,
        status: executionResult ? executionResult.status : 'pending'
      };

      if (executionResult) {
        waveInfo.processedCount = executionResult.processedCount;
        waveInfo.successCount = executionResult.successCount;
        waveInfo.failureCount = executionResult.failureCount;
        totalProcessed += executionResult.processedCount;
        totalSucceeded += executionResult.successCount;
        totalFailed += executionResult.failureCount;
      }

      totalVMs += wave.vms.length;
      waves.push(waveInfo);
    }

    this.logger.info('Migration progress retrieved', {
      totalWaves: waves.length,
      totalVMs,
      totalProcessed,
      totalSucceeded,
      totalFailed,
      component: 'MigrationBulkTagger'
    });

    return {
      totalWaves: waves.length,
      totalVMs,
      totalProcessed,
      totalSucceeded,
      totalFailed,
      overallProgress: totalVMs > 0 ? Math.round((totalProcessed / totalVMs) * 100) : 0,
      waves
    };
  }

  // ---------------------------------------------------------------------------
  // Private -- Validation helpers
  // ---------------------------------------------------------------------------

  /**
   * Validates the top-level manifest structure.
   *
   * @private
   * @param {Object} manifestData - The manifest to validate.
   * @returns {string[]} Array of validation error messages.
   */
  _validateManifestStructure(manifestData) {
    const errors = [];

    if (!manifestData || typeof manifestData !== 'object') {
      errors.push('Manifest must be a non-null object');
      return errors;
    }

    if (!manifestData.waveId || typeof manifestData.waveId !== 'string' || manifestData.waveId.trim() === '') {
      errors.push('waveId is required and must be a non-empty string');
    }

    if (!Array.isArray(manifestData.vms) || manifestData.vms.length === 0) {
      errors.push('vms must be a non-empty array');
    }

    if (Array.isArray(manifestData.vms) && manifestData.vms.length > MAX_WAVE_VMS) {
      errors.push(`vms exceeds maximum wave size of ${MAX_WAVE_VMS}. Received: ${manifestData.vms.length}`);
    }

    if (!manifestData.site || typeof manifestData.site !== 'string' || manifestData.site.trim() === '') {
      errors.push('site is required and must be a non-empty string');
    }

    if (!manifestData.scheduledDate || typeof manifestData.scheduledDate !== 'string') {
      errors.push('scheduledDate is required and must be a string');
    }

    return errors;
  }

  /**
   * Validates an individual VM entry within a manifest.
   *
   * Checks for required identifiers and mandatory tag categories.
   *
   * @private
   * @param {Object} vm - The VM entry to validate.
   * @param {number} index - VM index in the array (for error messages).
   * @returns {string[]} Array of validation error messages.
   */
  _validateVMEntry(vm, index) {
    const errors = [];
    const prefix = `VM[${index}]: `;

    if (!vm || typeof vm !== 'object') {
      errors.push(`${prefix}must be a non-null object`);
      return errors;
    }

    if (!vm.vmId || typeof vm.vmId !== 'string' || vm.vmId.trim() === '') {
      errors.push(`${prefix}vmId is required`);
    }

    if (!vm.vmName || typeof vm.vmName !== 'string' || vm.vmName.trim() === '') {
      errors.push(`${prefix}vmName is required`);
    }

    if (!vm.tags || typeof vm.tags !== 'object') {
      errors.push(`${prefix}tags object is required`);
      return errors;
    }

    // Validate mandatory tag categories are present
    for (const category of MANDATORY_TAG_CATEGORIES) {
      const value = vm.tags[category];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        errors.push(`${prefix}mandatory tag "${category}" is missing or empty`);
      }
    }

    return errors;
  }
}

/**
 * Exported constants for external use and testing.
 * @type {Object}
 */
MigrationBulkTagger.MANDATORY_TAG_CATEGORIES = MANDATORY_TAG_CATEGORIES;
MigrationBulkTagger.OPTIONAL_TAG_CATEGORIES = OPTIONAL_TAG_CATEGORIES;
MigrationBulkTagger.ALL_TAG_CATEGORIES = ALL_TAG_CATEGORIES;
MigrationBulkTagger.MAX_WAVE_VMS = MAX_WAVE_VMS;

module.exports = MigrationBulkTagger;
