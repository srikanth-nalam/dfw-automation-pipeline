/**
 * @file StaleRuleReaper.js
 * @description Identifies and removes stale DFW rules — rules referencing empty
 *   groups, unmanaged rules not in the RuleRegistry, and expired rules past their
 *   grace period. Stale rules are disabled (not deleted) for safety and auditability.
 *
 * Error codes:
 *   - DFW-8800  StaleRuleReaper general error
 *   - DFW-8801  Rule disable failed
 *
 * @module dfw/StaleRuleReaper
 */

'use strict';

/**
 * Rule classification constants.
 * @constant {Object}
 * @private
 */
const RULE_CLASSIFICATIONS = Object.freeze({
  STALE_EMPTY_SOURCE: 'STALE_EMPTY_SOURCE',
  STALE_EMPTY_DESTINATION: 'STALE_EMPTY_DESTINATION',
  EXPIRED: 'EXPIRED',
  UNMANAGED: 'UNMANAGED',
  ACTIVE: 'ACTIVE'
});

/**
 * @class StaleRuleReaper
 * @classdesc Scans DFW security policies for stale, expired, or unmanaged rules
 *   and disables them after archiving definitions.
 *
 * @example
 * const reaper = new StaleRuleReaper(dependencies);
 * const report = await reaper.reap('NDCNG', { dryRun: true });
 */
class StaleRuleReaper {
  /**
   * Creates a new StaleRuleReaper.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.restClient - HTTP client for NSX API calls.
   * @param {Object} dependencies.logger - Structured logger instance.
   * @param {Object} dependencies.configLoader - Configuration loader.
   * @param {Object} dependencies.ruleRegistry - Rule registry for managed rule lookup.
   * @param {Object} dependencies.dfwValidator - DFW policy validator.
   *
   * @throws {Error} DFW-8800 when required dependencies are missing.
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-8800] StaleRuleReaper requires dependencies');
    }

    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this.configLoader = dependencies.configLoader;
    /** @private */
    this.ruleRegistry = dependencies.ruleRegistry;
    /** @private */
    this.dfwValidator = dependencies.dfwValidator;
  }

  /**
   * Main entry point: scans and reaps stale rules at a site.
   *
   * @async
   * @param {string} site - Site code (NDCNG or TULNG).
   * @param {Object} [options={}] - Reap options.
   * @param {boolean} [options.dryRun=true] - If true, report only.
   * @param {number} [options.gracePeriodDays=30] - Days past review date before expiry.
   * @param {boolean} [options.includeUnmanaged=true] - Include unmanaged rule detection.
   * @returns {Promise<Object>} Reap report.
   *
   * @throws {Error} DFW-8800 on general failure.
   */
  async reap(site, options = {}) {
    const dryRun = options.dryRun !== false;
    const gracePeriodDays = options.gracePeriodDays || 30;
    const includeUnmanaged = options.includeUnmanaged !== false;

    this.logger.info('Starting stale rule reap', {
      site,
      dryRun,
      gracePeriodDays,
      includeUnmanaged,
      component: 'StaleRuleReaper'
    });

    try {
      const endpoints = this.configLoader.getEndpointsForSite(site);

      // Step 1: Fetch all security policies
      const policies = await this._fetchPolicies(site, endpoints);

      let totalRules = 0;
      let activeRules = 0;
      let staleRules = 0;
      let expiredRules = 0;
      let unmanagedRules = 0;
      let disabledRules = 0;
      let skippedRules = 0;
      const archivedDefinitions = [];

      // Step 2-5: Process each policy and its rules
      for (const policy of policies) {
        const policyId = policy.id || policy.display_name;
        const rules = policy.rules || [];

        for (const rule of rules) {
          totalRules += 1;

          // Step 3: Classify rule
          const classification = await this._classifyRule(
            rule, policyId, site, endpoints, gracePeriodDays, includeUnmanaged
          );

          if (classification === RULE_CLASSIFICATIONS.ACTIVE) {
            activeRules += 1;
            continue;
          }

          // Track classification counts
          if (classification === RULE_CLASSIFICATIONS.EXPIRED) {
            expiredRules += 1;
          } else if (classification === RULE_CLASSIFICATIONS.UNMANAGED) {
            unmanagedRules += 1;
          } else {
            staleRules += 1;
          }

          // Step 4: Archive
          archivedDefinitions.push(this._archiveRule(rule, policyId, classification));

          // Step 5: Disable if not dry run
          if (!dryRun) {
            const ruleId = rule.id || rule.display_name;
            try {
              await this._disableRule(policyId, ruleId, site, endpoints);
              disabledRules += 1;
            } catch (disableErr) {
              this.logger.error('Failed to disable stale rule', {
                ruleId,
                policyId,
                site,
                errorMessage: disableErr.message,
                component: 'StaleRuleReaper'
              });
              skippedRules += 1;
            }
          } else {
            skippedRules += 1;
          }
        }
      }

      const result = {
        site,
        timestamp: new Date().toISOString(),
        totalRules,
        activeRules,
        staleRules,
        expiredRules,
        unmanagedRules,
        disabledRules,
        skippedRules,
        archivedDefinitions
      };

      this.logger.info('Stale rule reap completed', {
        site,
        totalRules,
        activeRules,
        staleRules,
        expiredRules,
        unmanagedRules,
        disabledRules,
        component: 'StaleRuleReaper'
      });

      return result;
    } catch (err) {
      this.logger.error('Stale rule reap failed', {
        site,
        errorMessage: err.message,
        component: 'StaleRuleReaper'
      });
      throw new Error(`[DFW-8800] StaleRuleReaper reap failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetches all DFW security policies from NSX.
   *
   * @private
   * @async
   * @param {string} site - Site code.
   * @param {Object} endpoints - Resolved endpoints.
   * @returns {Promise<Array>} Array of policy objects.
   */
  async _fetchPolicies(site, endpoints) {
    const url = `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/security-policies`;
    const response = await this.restClient.get(url);
    const body = response.body || response;
    return body.results || body || [];
  }

  /**
   * Classifies a single rule based on group membership, registry status, and expiry.
   *
   * @private
   * @async
   * @param {Object} rule - Rule object from NSX.
   * @param {string} policyId - Parent policy identifier.
   * @param {string} site - Site code.
   * @param {Object} endpoints - Resolved endpoints.
   * @param {number} gracePeriodDays - Grace period for expiry calculation.
   * @param {boolean} includeUnmanaged - Whether to classify unmanaged rules.
   * @returns {Promise<string>} Rule classification.
   */
  async _classifyRule(rule, policyId, site, endpoints, gracePeriodDays, includeUnmanaged) {
    const ruleId = rule.id || rule.display_name;

    // Skip already disabled rules
    if (rule.disabled === true) {
      return RULE_CLASSIFICATIONS.ACTIVE;
    }

    // Check source groups for empty membership
    const sourceGroups = rule.source_groups || [];
    for (const groupPath of sourceGroups) {
      if (groupPath === 'ANY') { continue; }
      const memberCount = await this._checkGroupMembership(groupPath, site, endpoints);
      if (memberCount === 0) {
        return RULE_CLASSIFICATIONS.STALE_EMPTY_SOURCE;
      }
    }

    // Check destination groups for empty membership
    const destGroups = rule.destination_groups || [];
    for (const groupPath of destGroups) {
      if (groupPath === 'ANY') { continue; }
      const memberCount = await this._checkGroupMembership(groupPath, site, endpoints);
      if (memberCount === 0) {
        return RULE_CLASSIFICATIONS.STALE_EMPTY_DESTINATION;
      }
    }

    // Check expiry via RuleRegistry
    if (this._isRuleExpired(ruleId, gracePeriodDays)) {
      return RULE_CLASSIFICATIONS.EXPIRED;
    }

    // Check if managed
    if (includeUnmanaged && !this._isRuleManaged(ruleId)) {
      return RULE_CLASSIFICATIONS.UNMANAGED;
    }

    return RULE_CLASSIFICATIONS.ACTIVE;
  }

  /**
   * Returns the member count for a group referenced in a rule path.
   *
   * @private
   * @async
   * @param {string} groupPath - Group path or identifier.
   * @param {string} site - Site code.
   * @param {Object} endpoints - Resolved endpoints.
   * @returns {Promise<number>} Member count.
   */
  async _checkGroupMembership(groupPath, site, endpoints) {
    try {
      const groupId = groupPath.split('/').pop();
      const url = `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/groups/${encodeURIComponent(groupId)}/members/virtual-machines`;
      const response = await this.restClient.get(url);
      const body = response.body || response;
      const results = body.results || body || [];
      return Array.isArray(results) ? results.length : 0;
    } catch (err) {
      this.logger.warn('Group membership check failed', {
        groupPath,
        site,
        errorMessage: err.message,
        component: 'StaleRuleReaper'
      });
      return -1;
    }
  }

  /**
   * Checks if a rule is tracked in the RuleRegistry.
   *
   * @private
   * @param {string} ruleId - Rule identifier.
   * @returns {boolean} True if the rule is managed.
   */
  _isRuleManaged(ruleId) {
    if (!this.ruleRegistry || typeof this.ruleRegistry.getRule !== 'function') {
      return true;
    }
    const entry = this.ruleRegistry.getRule(ruleId);
    return !!entry;
  }

  /**
   * Checks if a rule is expired based on its review date and grace period.
   *
   * @private
   * @param {string} ruleId - Rule identifier.
   * @param {number} gracePeriodDays - Grace period in days.
   * @returns {boolean} True if the rule is expired.
   */
  _isRuleExpired(ruleId, gracePeriodDays) {
    if (!this.ruleRegistry || typeof this.ruleRegistry.getRule !== 'function') {
      return false;
    }
    const entry = this.ruleRegistry.getRule(ruleId);
    if (!entry || !entry.reviewDate) {
      return false;
    }

    const reviewDate = new Date(entry.reviewDate);
    const expiryDate = new Date(reviewDate.getTime() + (gracePeriodDays * 24 * 60 * 60 * 1000));
    return Date.now() > expiryDate.getTime();
  }

  /**
   * Disables a rule in NSX via PATCH.
   *
   * @private
   * @async
   * @param {string} policyId - Parent policy identifier.
   * @param {string} ruleId - Rule identifier.
   * @param {string} site - Site code.
   * @param {Object} endpoints - Resolved endpoints.
   * @returns {Promise<void>}
   *
   * @throws {Error} DFW-8801 when disable fails.
   */
  async _disableRule(policyId, ruleId, site, endpoints) {
    const url = `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/security-policies/${encodeURIComponent(policyId)}/rules/${encodeURIComponent(ruleId)}`;

    this.logger.info('Disabling stale rule', {
      ruleId,
      policyId,
      site,
      component: 'StaleRuleReaper'
    });

    try {
      await this.restClient.patch(url, { disabled: true });
    } catch (err) {
      throw new Error(`[DFW-8801] Failed to disable rule "${ruleId}": ${err.message}`);
    }
  }

  /**
   * Archives a rule definition for audit purposes.
   *
   * @private
   * @param {Object} rule - Rule object.
   * @param {string} policyId - Parent policy identifier.
   * @param {string} classification - Rule classification.
   * @returns {Object} Archived definition with metadata.
   */
  _archiveRule(rule, policyId, classification) {
    return {
      archivedAt: new Date().toISOString(),
      ruleId: rule.id || rule.display_name,
      policyId,
      classification,
      definition: JSON.parse(JSON.stringify(rule))
    };
  }
}

module.exports = StaleRuleReaper;
