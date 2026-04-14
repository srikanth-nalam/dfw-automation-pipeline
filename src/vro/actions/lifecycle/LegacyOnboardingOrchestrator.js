/**
 * @file LegacyOnboardingOrchestrator.js
 * @description CSV-based legacy VM onboarding orchestrator for the DFW Automation
 *   Pipeline. Wraps BulkTagOrchestrator with Enterprise Tag Dictionary validation
 *   and legacy-specific partitioning logic.
 *
 * @module lifecycle/LegacyOnboardingOrchestrator
 */

'use strict';

const BulkTagOrchestrator = require('./BulkTagOrchestrator');

/**
 * Enterprise Tag Dictionary reference set for validation.
 * @constant {Object}
 * @private
 */
const TAG_DICTIONARY = Object.freeze({
  Region: ['NDCNG', 'TULNG'],
  SecurityZone: ['Greenzone', 'DMZ', 'Restricted', 'Management', 'External'],
  Environment: ['Production', 'Staging', 'Development', 'UAT', 'Sandbox', 'DR'],
  SystemRole: ['Web', 'Application', 'Database', 'Middleware', 'Utility', 'SharedServices'],
  DataClassification: ['Public', 'Internal', 'Confidential', 'Restricted'],
  Compliance: ['PCI', 'HIPAA', 'SOX', 'GDPR', 'None']
});

/**
 * @class LegacyOnboardingOrchestrator
 * @classdesc Orchestrates CSV-based legacy VM onboarding by validating tag
 *   values against the Enterprise Tag Dictionary before delegating to
 *   BulkTagOrchestrator for actual tag application.
 *
 * @example
 * const orchestrator = new LegacyOnboardingOrchestrator(dependencies);
 * const report = await orchestrator.onboardLegacyVMs(payload);
 */
class LegacyOnboardingOrchestrator {
  /**
   * Creates a new LegacyOnboardingOrchestrator.
   *
   * @param {Object} dependencies - Injected dependencies. Same as
   *   BulkTagOrchestrator plus payloadValidator.
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-8400] LegacyOnboardingOrchestrator requires dependencies');
    }

    /** @private */
    this.bulkOrchestrator = new BulkTagOrchestrator(dependencies);
    /** @private */
    this.payloadValidator = dependencies.payloadValidator;
    /** @private */
    this.logger = dependencies.logger;
  }

  /**
   * Onboards legacy VMs by validating against the Enterprise Tag Dictionary
   * and delegating valid entries to BulkTagOrchestrator.
   *
   * @async
   * @param {Object} payload - Onboarding payload.
   * @param {string} payload.correlationId - Correlation identifier.
   * @param {string} payload.site - Target site code.
   * @param {Array<{vmName: string, vmId?: string, tags: Object}>} payload.vmEntries - VM entries from CSV.
   * @param {boolean} [payload.dryRun=false] - Dry run mode.
   * @param {number} [payload.batchSize=10] - Batch size.
   * @param {string} [payload.callbackUrl] - Callback URL.
   * @returns {Promise<Object>} Legacy onboarding report.
   */
  async onboardLegacyVMs(payload) {
    const correlationId = payload.correlationId;
    const vmEntries = payload.vmEntries || [];

    this.logger.info('Starting legacy VM onboarding', {
      correlationId,
      totalEntries: vmEntries.length,
      site: payload.site,
      dryRun: payload.dryRun === true,
      component: 'LegacyOnboardingOrchestrator'
    });

    try {
      // Step 1: Dictionary validation
      const { validEntries, invalidEntries, invalidDetails } =
        this._validateAgainstDictionary(vmEntries);

      this.logger.info('Dictionary validation complete', {
        correlationId,
        validCount: validEntries.length,
        invalidCount: invalidEntries.length,
        component: 'LegacyOnboardingOrchestrator'
      });

      // Step 2: Partition - only valid entries go to bulk processor
      let bulkReport = {
        correlationId,
        status: 'completed',
        totalVMs: 0,
        successCount: 0,
        failureCount: 0,
        skippedCount: 0,
        executionTimeMs: 0,
        averageTimePerVM: 0,
        results: [],
        failedVMs: [],
        dryRun: payload.dryRun === true
      };

      if (validEntries.length > 0) {
        // Step 3/4: Delegate to BulkTagOrchestrator
        const bulkPayload = {
          correlationId,
          requestType: 'bulk_tag',
          site: payload.site,
          batchSize: payload.batchSize || 10,
          concurrency: payload.concurrency || 5,
          vms: validEntries.map((entry) => ({
            vmId: entry.vmId || entry.vmName,
            vmName: entry.vmName,
            tags: entry.tags
          })),
          callbackUrl: null, // We handle callback ourselves
          dryRun: payload.dryRun === true
        };

        bulkReport = await this.bulkOrchestrator.executeBulk(bulkPayload);
      }

      // Step 5: Build legacy onboarding report
      const report = {
        ...bulkReport,
        dictionaryValidation: {
          totalEntries: vmEntries.length,
          validEntries: validEntries.length,
          invalidEntries: invalidEntries.length,
          invalidDetails
        }
      };

      // Send callback if configured
      if (payload.callbackUrl) {
        try {
          const restClient = this.bulkOrchestrator.restClient ||
            (this.bulkOrchestrator && this.bulkOrchestrator.restClient);
          if (restClient) {
            await restClient.post(payload.callbackUrl, report);
          }
        } catch (err) {
          this.logger.warn('Failed to send legacy onboarding callback', {
            correlationId,
            errorMessage: err.message,
            component: 'LegacyOnboardingOrchestrator'
          });
        }
      }

      this.logger.info('Legacy VM onboarding completed', {
        correlationId,
        totalEntries: vmEntries.length,
        validProcessed: validEntries.length,
        invalidRejected: invalidEntries.length,
        component: 'LegacyOnboardingOrchestrator'
      });

      return report;
    } catch (err) {
      this.logger.error('Legacy VM onboarding failed', {
        correlationId,
        errorMessage: err.message,
        component: 'LegacyOnboardingOrchestrator'
      });
      throw err;
    }
  }

  /**
   * Validates VM entries against the Enterprise Tag Dictionary.
   *
   * @private
   * @param {Array} vmEntries - VM entries to validate.
   * @returns {Object} Partition of valid and invalid entries.
   */
  _validateAgainstDictionary(vmEntries) {
    const validEntries = [];
    const invalidEntries = [];
    const invalidDetails = [];

    for (const entry of vmEntries) {
      const errors = this._validateEntry(entry);

      if (errors.length === 0) {
        validEntries.push(entry);
      } else {
        invalidEntries.push(entry);
        invalidDetails.push({
          vmName: entry.vmName,
          errors
        });
      }
    }

    return { validEntries, invalidEntries, invalidDetails };
  }

  /**
   * Validates a single VM entry against the dictionary.
   *
   * @private
   * @param {Object} entry - VM entry with vmName and tags.
   * @returns {string[]} Array of validation error messages.
   */
  _validateEntry(entry) {
    const errors = [];

    if (!entry.vmName) {
      errors.push('Missing vmName');
      return errors;
    }

    if (!entry.tags || typeof entry.tags !== 'object') {
      errors.push('Missing or invalid tags object');
      return errors;
    }

    // Check required tag fields
    const requiredFields = ['Region', 'SecurityZone', 'Environment', 'AppCI', 'SystemRole'];
    for (const field of requiredFields) {
      if (!entry.tags[field]) {
        errors.push(`Missing required tag: ${field}`);
      }
    }

    // Validate against dictionary
    for (const [category, allowedValues] of Object.entries(TAG_DICTIONARY)) {
      const tagValue = entry.tags[category];
      if (tagValue === undefined || tagValue === null) {
        continue;
      }

      if (category === 'Compliance') {
        const values = Array.isArray(tagValue) ? tagValue : [tagValue];
        for (const val of values) {
          if (!allowedValues.includes(val)) {
            errors.push(`Invalid ${category} value: "${val}". Allowed: ${allowedValues.join(', ')}`);
          }
        }
      } else {
        if (!allowedValues.includes(tagValue)) {
          errors.push(`Invalid ${category} value: "${tagValue}". Allowed: ${allowedValues.join(', ')}`);
        }
      }
    }

    return errors;
  }
}

module.exports = LegacyOnboardingOrchestrator;
