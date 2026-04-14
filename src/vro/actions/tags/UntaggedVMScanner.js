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
const MANDATORY_TAGS = ['Region', 'SecurityZone', 'Environment', 'AppCI', 'SystemRole'];

/**
 * VM name pattern matchers for auto-classification.
 * @constant {Object}
 * @private
 */
const NAME_PATTERNS = Object.freeze({
  systemRole: [
    { pattern: /[_\-]WEB[_\-\d]/i, value: 'Web' },
    { pattern: /[_\-]APP[_\-\d]/i, value: 'Application' },
    { pattern: /[_\-]DB[_\-\d]/i,  value: 'Database' },
    { pattern: /WEB/i,             value: 'Web' },
    { pattern: /APP/i,             value: 'Application' },
    { pattern: /DB/i,              value: 'Database' }
  ],
  environment: [
    { pattern: /[_\-]P\d{2}$/i,       value: 'Production' },
    { pattern: /PROD/i,               value: 'Production' },
    { pattern: /[_\-]D\d{2}$/i,       value: 'Development' },
    { pattern: /DEV/i,                value: 'Development' },
    { pattern: /UAT/i,                value: 'UAT' },
    { pattern: /STG|STAGING/i,        value: 'Staging' }
  ],
  appCI: [
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
    /** @private */
    this.snowAdapter = dependencies.snowAdapter || null;
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

    // SystemRole suggestion
    if (!currentTags.SystemRole) {
      const roleMatch = this._matchPattern(vmName, NAME_PATTERNS.systemRole);
      if (roleMatch) {
        suggestions.push({
          category: 'SystemRole',
          suggestedValue: roleMatch,
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

    // AppCI suggestion from naming convention
    if (!currentTags.AppCI) {
      const appMatch = this._extractAppCI(vmName);
      if (appMatch) {
        suggestions.push({
          category: 'AppCI',
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

  /**
   * Extends scanForUntaggedVMs to also check CMDB registration status for each VM.
   * Classifies VMs as UNTAGGED_REGISTERED, UNTAGGED_UNREGISTERED, or TAGGED_UNREGISTERED.
   *
   * @async
   * @param {string} site - Site code (NDCNG or TULNG).
   * @returns {Promise<Object>} Enriched scan report with CMDB classification.
   */
  async scanWithCMDBCrossRef(site) {
    this.logger.info('Starting CMDB cross-reference scan', {
      site,
      component: 'UntaggedVMScanner'
    });

    // Step 1: Run existing scan
    const scanReport = await this.scanForUntaggedVMs(site);

    // Step 2: Get full VM list for tagged-but-unregistered check
    const endpoints = this.configLoader.getEndpointsForSite(site);
    const allVMs = await this._getAllVMs(endpoints);

    const classifiedVMs = [];

    // Step 2-3: For each VM, query CMDB
    for (const vm of allVMs) {
      const vmId = vm.vm || vm.vmId;
      const vmName = vm.name || vm.vmName || vmId;

      let cmdbRegistered = false;
      try {
        if (this.snowAdapter) {
          const cmdbResult = await this.snowAdapter.toCallbackPayload({
            action: 'getCIStatus',
            vmId,
            vmName
          });
          cmdbRegistered = !!(cmdbResult && cmdbResult.ciStatus && cmdbResult.ciStatus !== 'not_found');
        }
      } catch (err) {
        this.logger.warn('CMDB lookup failed for VM during cross-ref', {
          vmId,
          vmName,
          errorMessage: err.message,
          component: 'UntaggedVMScanner'
        });
      }

      // Determine tag status
      const untaggedEntry = scanReport.untaggedVMs.find(u => u.vmId === vmId);
      const isUntagged = !!untaggedEntry;

      // Step 3: Classify
      let classification;
      if (isUntagged && cmdbRegistered) {
        classification = 'UNTAGGED_REGISTERED';
      } else if (isUntagged && !cmdbRegistered) {
        classification = 'UNTAGGED_UNREGISTERED';
      } else if (!isUntagged && !cmdbRegistered) {
        classification = 'TAGGED_UNREGISTERED';
      } else {
        continue; // tagged and registered — skip
      }

      let currentTags = {};
      if (untaggedEntry) {
        currentTags = untaggedEntry.currentTags || {};
      } else {
        try {
          currentTags = await this.tagOperations.getTags(vmId, site);
        } catch (err) {
          // Best effort
        }
      }

      classifiedVMs.push({
        vmId,
        vmName,
        classification,
        cmdbRegistered,
        currentTags,
        missingCategories: untaggedEntry ? untaggedEntry.missingCategories : [],
        suggestions: untaggedEntry ? untaggedEntry.suggestions : []
      });
    }

    const result = {
      ...scanReport,
      classifiedVMs,
      untaggedRegistered: classifiedVMs.filter(v => v.classification === 'UNTAGGED_REGISTERED').length,
      untaggedUnregistered: classifiedVMs.filter(v => v.classification === 'UNTAGGED_UNREGISTERED').length,
      taggedUnregistered: classifiedVMs.filter(v => v.classification === 'TAGGED_UNREGISTERED').length
    };

    this.logger.info('CMDB cross-reference scan completed', {
      site,
      untaggedRegistered: result.untaggedRegistered,
      untaggedUnregistered: result.untaggedUnregistered,
      taggedUnregistered: result.taggedUnregistered,
      component: 'UntaggedVMScanner'
    });

    return result;
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
   * Extracts AppCI code from VM name.
   *
   * @private
   * @param {string} vmName - VM name.
   * @returns {string|null} Extracted AppCI code or null.
   */
  _extractAppCI(vmName) {
    const match = vmName.match(/([A-Z]{3,6}\d{3})/);
    return match ? match[1] : null;
  }
}

module.exports = UntaggedVMScanner;
