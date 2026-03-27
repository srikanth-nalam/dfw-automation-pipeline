/**
 * @file UntaggedVMScanner.js
 * @description vCenter inventory scanner for discovering VMs missing mandatory
 *   NSX tags. Classifies VMs by tag coverage and suggests tags based on
 *   VM naming convention heuristics.
 *
 * @module tags/UntaggedVMScanner
 */

'use strict';

/**
 * Mandatory tag categories that every VM must have.
 * @constant {string[]}
 * @private
 */
const MANDATORY_TAGS = ['Application', 'Tier', 'Environment'];

/**
 * VM name pattern matchers for auto-classification.
 * @constant {Object}
 * @private
 */
const NAME_PATTERNS = Object.freeze({
  tier: [
    { pattern: /[_\-]WEB[_\-\d]/i, value: 'Web' },
    { pattern: /[_\-]APP[_\-\d]/i, value: 'App' },
    { pattern: /[_\-]DB[_\-\d]/i,  value: 'DB' },
    { pattern: /WEB/i,             value: 'Web' },
    { pattern: /APP/i,             value: 'App' },
    { pattern: /DB/i,              value: 'DB' }
  ],
  environment: [
    { pattern: /[_\-]P\d{2}$/i,       value: 'Production' },
    { pattern: /PROD/i,               value: 'Production' },
    { pattern: /[_\-]D\d{2}$/i,       value: 'Development' },
    { pattern: /DEV/i,                value: 'Development' },
    { pattern: /UAT/i,                value: 'UAT' },
    { pattern: /STG|STAGING/i,        value: 'Staging' }
  ],
  application: [
    { pattern: /[A-Z]{3,6}\d{3}/,    extract: true }
  ]
});

/**
 * @class UntaggedVMScanner
 * @classdesc Scans vCenter inventory to discover VMs missing mandatory tags
 *   and suggests classification based on naming conventions.
 *
 * @example
 * const scanner = new UntaggedVMScanner(dependencies);
 * const report = await scanner.scanForUntaggedVMs('NDCNG');
 */
class UntaggedVMScanner {
  /**
   * Creates a new UntaggedVMScanner.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.restClient - HTTP client.
   * @param {Object} dependencies.tagOperations - Tag management operations.
   * @param {Object} dependencies.logger - Structured logger instance.
   * @param {Object} dependencies.configLoader - Configuration loader.
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-8600] UntaggedVMScanner requires dependencies');
    }

    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.tagOperations = dependencies.tagOperations;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this.configLoader = dependencies.configLoader;
  }

  /**
   * Scans a site for VMs missing mandatory tags.
   *
   * @async
   * @param {string} site - Site code (NDCNG or TULNG).
   * @returns {Promise<Object>} Scan report.
   */
  async scanForUntaggedVMs(site) {
    this.logger.info('Starting untagged VM scan', {
      site,
      component: 'UntaggedVMScanner'
    });

    try {
      // Step 1: Get all VMs from vCenter
      const endpoints = this.configLoader.getEndpointsForSite(site);
      const vms = await this._getAllVMs(endpoints);

      this.logger.info('VM inventory retrieved', {
        site,
        vmCount: vms.length,
        component: 'UntaggedVMScanner'
      });

      let fullyTagged = 0;
      let partiallyTagged = 0;
      let untagged = 0;
      const untaggedVMs = [];

      // Step 2-4: Check tags for each VM
      for (const vm of vms) {
        const vmId = vm.vm || vm.vmId;
        const vmName = vm.name || vm.vmName || vmId;

        let currentTags = {};
        try {
          currentTags = await this.tagOperations.getTags(vmId, site);
        } catch (err) {
          this.logger.warn('Failed to get tags for VM', {
            vmId,
            vmName,
            errorMessage: err.message,
            component: 'UntaggedVMScanner'
          });
        }

        const missingCategories = this._findMissingMandatoryTags(currentTags);

        if (missingCategories.length === 0) {
          fullyTagged += 1;
        } else if (missingCategories.length < MANDATORY_TAGS.length) {
          partiallyTagged += 1;

          // Step 5: Run classification suggestions
          const suggestions = this.suggestClassification(vmName, currentTags);
          untaggedVMs.push({
            vmId,
            vmName,
            site,
            currentTags,
            missingCategories,
            suggestions
          });
        } else {
          untagged += 1;

          const suggestions = this.suggestClassification(vmName, currentTags);
          untaggedVMs.push({
            vmId,
            vmName,
            site,
            currentTags,
            missingCategories,
            suggestions
          });
        }
      }

      const totalVMs = vms.length;
      const coveragePercent = totalVMs > 0
        ? Math.round((fullyTagged / totalVMs) * 100)
        : 100;

      const report = {
        totalVMs,
        fullyTagged,
        partiallyTagged,
        untagged,
        coveragePercent,
        untaggedVMs
      };

      this.logger.info('Untagged VM scan completed', {
        site,
        totalVMs,
        fullyTagged,
        partiallyTagged,
        untagged,
        coveragePercent,
        component: 'UntaggedVMScanner'
      });

      return report;
    } catch (err) {
      this.logger.error('Untagged VM scan failed', {
        site,
        errorMessage: err.message,
        component: 'UntaggedVMScanner'
      });
      throw err;
    }
  }

  /**
   * Suggests tag classifications based on VM name heuristics.
   *
   * @param {string} vmName - VM display name.
   * @param {Object} currentTags - Current tag values.
   * @returns {Array<{category: string, suggestedValue: string, confidence: string}>}
   */
  suggestClassification(vmName, currentTags) {
    const suggestions = [];
    let matchCount = 0;

    // Tier suggestion
    if (!currentTags.Tier) {
      const tierMatch = this._matchPattern(vmName, NAME_PATTERNS.tier);
      if (tierMatch) {
        suggestions.push({
          category: 'Tier',
          suggestedValue: tierMatch,
          confidence: 'MEDIUM'
        });
        matchCount += 1;
      }
    }

    // Environment suggestion
    if (!currentTags.Environment) {
      const envMatch = this._matchPattern(vmName, NAME_PATTERNS.environment);
      if (envMatch) {
        suggestions.push({
          category: 'Environment',
          suggestedValue: envMatch,
          confidence: 'MEDIUM'
        });
        matchCount += 1;
      }
    }

    // Application suggestion from naming convention
    if (!currentTags.Application) {
      const appMatch = this._extractApplication(vmName);
      if (appMatch) {
        suggestions.push({
          category: 'Application',
          suggestedValue: appMatch,
          confidence: 'LOW'
        });
        matchCount += 1;
      }
    }

    // Upgrade confidence if multiple heuristics matched
    if (matchCount >= 2) {
      for (const suggestion of suggestions) {
        if (suggestion.confidence === 'MEDIUM') {
          suggestion.confidence = 'HIGH';
        } else if (suggestion.confidence === 'LOW') {
          suggestion.confidence = 'MEDIUM';
        }
      }
    }

    return suggestions;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Gets all VMs from vCenter.
   *
   * @private
   * @async
   * @param {Object} endpoints - Site endpoints.
   * @returns {Promise<Array>} VM list.
   */
  async _getAllVMs(endpoints) {
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
   * Finds mandatory tags that are missing.
   *
   * @private
   * @param {Object} currentTags - Current tag map.
   * @returns {string[]} Missing category names.
   */
  _findMissingMandatoryTags(currentTags) {
    return MANDATORY_TAGS.filter(
      (cat) => currentTags[cat] === undefined || currentTags[cat] === null
    );
  }

  /**
   * Matches VM name against pattern list.
   *
   * @private
   * @param {string} vmName - VM name.
   * @param {Array} patterns - Pattern definitions.
   * @returns {string|null} Matched value or null.
   */
  _matchPattern(vmName, patterns) {
    for (const entry of patterns) {
      if (entry.pattern.test(vmName)) {
        return entry.value;
      }
    }
    return null;
  }

  /**
   * Extracts application code from VM name.
   *
   * @private
   * @param {string} vmName - VM name.
   * @returns {string|null} Extracted application code or null.
   */
  _extractApplication(vmName) {
    const match = vmName.match(/([A-Z]{3,6}\d{3})/);
    return match ? match[1] : null;
  }
}

module.exports = UntaggedVMScanner;
