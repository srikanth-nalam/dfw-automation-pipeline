/**
 * @file OrphanGroupCleaner.js
 * @description Scheduled sweep to identify and clean up empty NSX security groups
 *   that have zero members. Groups are classified based on DFW rule references and
 *   minimum age thresholds. Definitions are archived before deletion.
 *
 * Error codes:
 *   - DFW-8700  OrphanGroupCleaner general error
 *   - DFW-8701  Group deletion blocked (referenced by active rules with other non-empty groups)
 *
 * @module groups/OrphanGroupCleaner
 */

'use strict';

/**
 * @class OrphanGroupCleaner
 * @classdesc Sweeps NSX security groups to find empty/orphan groups, archives
 *   definitions, and optionally deletes safe-to-remove groups.
 *
 * @example
 * const cleaner = new OrphanGroupCleaner(dependencies);
 * const report = await cleaner.sweep('NDCNG', { dryRun: true });
 */
class OrphanGroupCleaner {
  /**
   * Creates a new OrphanGroupCleaner.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.restClient - HTTP client for NSX API calls.
   * @param {Object} dependencies.logger - Structured logger instance.
   * @param {Object} dependencies.configLoader - Configuration loader for site endpoints.
   * @param {Object} dependencies.dfwValidator - DFW policy validator instance.
   * @param {Object} dependencies.ruleRegistry - Rule registry instance.
   *
   * @throws {Error} DFW-8700 when required dependencies are missing.
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-8700] OrphanGroupCleaner requires dependencies');
    }

    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this.configLoader = dependencies.configLoader;
    /** @private */
    this.dfwValidator = dependencies.dfwValidator;
    /** @private */
    this.ruleRegistry = dependencies.ruleRegistry;
  }

  /**
   * Main entry point: sweeps a site for orphan security groups.
   *
   * @async
   * @param {string} site - Site code (NDCNG or TULNG).
   * @param {Object} [options={}] - Sweep options.
   * @param {boolean} [options.dryRun=true] - If true, report only without making changes.
   * @param {boolean} [options.archiveBeforeDelete=true] - Archive group definitions before deletion.
   * @param {number} [options.minAgeHours=24] - Minimum hours a group must be empty.
   * @returns {Promise<Object>} Sweep report.
   *
   * @throws {Error} DFW-8700 on general sweep failure.
   */
  async sweep(site, options = {}) {
    const dryRun = options.dryRun !== false;
    const archiveBeforeDelete = options.archiveBeforeDelete !== false;
    const minAgeHours = options.minAgeHours || 24;

    this.logger.info('Starting orphan group sweep', {
      site,
      dryRun,
      minAgeHours,
      component: 'OrphanGroupCleaner'
    });

    try {
      const endpoints = this.configLoader.getEndpointsForSite(site);

      // Step 1: List all security groups
      const allGroups = await this._listAllGroups(site, endpoints);

      const report = [];
      const archivedDefinitions = [];
      let emptyGroups = 0;
      let orphanedGroups = 0;
      let deletedGroups = 0;
      let skippedGroups = 0;

      // Step 2-8: Evaluate each group
      for (const group of allGroups) {
        const groupId = group.id || group.display_name;

        // Step 2: Get member count
        const memberCount = await this._getGroupMemberCount(groupId, site, endpoints);

        if (memberCount > 0) {
          continue;
        }

        emptyGroups += 1;

        // Step 3: Check group age
        const lastModified = group._last_modified_time || group.last_modified_time || 0;
        const ageHours = (Date.now() - lastModified) / (1000 * 60 * 60);

        if (ageHours < minAgeHours) {
          skippedGroups += 1;
          report.push({
            groupId,
            status: 'SKIPPED_TOO_RECENT',
            ageHours: Math.round(ageHours),
            minAgeHours
          });
          continue;
        }

        // Step 4-5: Check DFW rule references
        const referencingRules = await this._getReferencingRules(groupId, site, endpoints);
        let classification;

        if (referencingRules.length > 0) {
          classification = 'ORPHAN_WITH_RULES';
          orphanedGroups += 1;
        } else {
          classification = 'ORPHAN_SAFE_TO_DELETE';
          orphanedGroups += 1;
        }

        // Step 7: Archive
        if (archiveBeforeDelete) {
          const archived = this._archiveGroupDefinition(group);
          archivedDefinitions.push(archived);
        }

        // Step 8: Delete if safe and not dry run
        if (!dryRun && classification === 'ORPHAN_SAFE_TO_DELETE') {
          try {
            await this._deleteGroup(groupId, site, endpoints);
            deletedGroups += 1;
            report.push({
              groupId,
              status: 'DELETED',
              classification,
              referencingRules: referencingRules.length
            });
          } catch (deleteErr) {
            this.logger.error('Failed to delete orphan group', {
              groupId,
              site,
              errorMessage: deleteErr.message,
              component: 'OrphanGroupCleaner'
            });
            skippedGroups += 1;
            report.push({
              groupId,
              status: 'DELETE_FAILED',
              classification,
              error: deleteErr.message
            });
          }
        } else if (!dryRun && classification === 'ORPHAN_WITH_RULES') {
          skippedGroups += 1;
          this.logger.warn('Group deletion blocked — referenced by active rules', {
            groupId,
            site,
            ruleCount: referencingRules.length,
            component: 'OrphanGroupCleaner'
          });
          report.push({
            groupId,
            status: 'BLOCKED',
            classification,
            referencingRules: referencingRules.length
          });
        } else {
          report.push({
            groupId,
            status: 'DRY_RUN',
            classification,
            referencingRules: referencingRules.length
          });
        }
      }

      const result = {
        site,
        timestamp: new Date().toISOString(),
        totalGroups: allGroups.length,
        emptyGroups,
        orphanedGroups,
        deletedGroups,
        skippedGroups,
        archivedDefinitions,
        report
      };

      this.logger.info('Orphan group sweep completed', {
        site,
        totalGroups: allGroups.length,
        emptyGroups,
        orphanedGroups,
        deletedGroups,
        skippedGroups,
        component: 'OrphanGroupCleaner'
      });

      return result;
    } catch (err) {
      this.logger.error('Orphan group sweep failed', {
        site,
        errorMessage: err.message,
        component: 'OrphanGroupCleaner'
      });
      throw new Error(`[DFW-8700] OrphanGroupCleaner sweep failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Lists all security groups from NSX.
   *
   * @private
   * @async
   * @param {string} site - Site code.
   * @param {Object} endpoints - Resolved endpoints.
   * @returns {Promise<Array>} Array of group objects.
   */
  async _listAllGroups(site, endpoints) {
    const url = `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/groups`;
    const response = await this.restClient.get(url);
    const body = response.body || response;
    return body.results || body || [];
  }

  /**
   * Returns the VM member count for a security group.
   *
   * @private
   * @async
   * @param {string} groupId - Group identifier.
   * @param {string} site - Site code.
   * @param {Object} endpoints - Resolved endpoints.
   * @returns {Promise<number>} Member count.
   */
  async _getGroupMemberCount(groupId, site, endpoints) {
    try {
      const url = `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/groups/${encodeURIComponent(groupId)}/members/virtual-machines`;
      const response = await this.restClient.get(url);
      const body = response.body || response;
      const results = body.results || body || [];
      return Array.isArray(results) ? results.length : 0;
    } catch (err) {
      this.logger.warn('Failed to get group member count', {
        groupId,
        site,
        errorMessage: err.message,
        component: 'OrphanGroupCleaner'
      });
      return 0;
    }
  }

  /**
   * Returns DFW rules that reference the given group in source or destination.
   *
   * @private
   * @async
   * @param {string} groupId - Group identifier.
   * @param {string} site - Site code.
   * @param {Object} endpoints - Resolved endpoints.
   * @returns {Promise<Array>} Array of referencing rules.
   */
  async _getReferencingRules(groupId, site, endpoints) {
    try {
      const url = `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/security-policies`;
      const response = await this.restClient.get(url);
      const body = response.body || response;
      const policies = body.results || body || [];

      const referencingRules = [];
      for (const policy of policies) {
        const rules = policy.rules || [];
        for (const rule of rules) {
          const sources = rule.source_groups || [];
          const destinations = rule.destination_groups || [];
          const allGroups = [...sources, ...destinations];

          if (allGroups.some(g => g.includes(groupId))) {
            referencingRules.push({
              ruleId: rule.id || rule.display_name,
              policyId: policy.id || policy.display_name,
              ruleName: rule.display_name
            });
          }
        }
      }

      return referencingRules;
    } catch (err) {
      this.logger.warn('Failed to check referencing rules', {
        groupId,
        site,
        errorMessage: err.message,
        component: 'OrphanGroupCleaner'
      });
      return [];
    }
  }

  /**
   * Archives a group definition for audit purposes.
   *
   * @private
   * @param {Object} group - Full group definition object.
   * @returns {Object} Archived definition with timestamp.
   */
  _archiveGroupDefinition(group) {
    return {
      archivedAt: new Date().toISOString(),
      groupId: group.id || group.display_name,
      displayName: group.display_name,
      definition: JSON.parse(JSON.stringify(group))
    };
  }

  /**
   * Deletes a security group from NSX.
   *
   * @private
   * @async
   * @param {string} groupId - Group identifier.
   * @param {string} site - Site code.
   * @param {Object} endpoints - Resolved endpoints.
   * @returns {Promise<void>}
   */
  async _deleteGroup(groupId, site, endpoints) {
    const url = `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/groups/${encodeURIComponent(groupId)}`;

    this.logger.info('Deleting orphan group', {
      groupId,
      site,
      component: 'OrphanGroupCleaner'
    });

    await this.restClient.delete(url);

    this.logger.info('Orphan group deleted', {
      groupId,
      site,
      component: 'OrphanGroupCleaner'
    });
  }
}

module.exports = OrphanGroupCleaner;
