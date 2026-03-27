/**
 * @fileoverview GroupMembershipVerifier — Verifies that a virtual machine
 * belongs to the expected NSX Dynamic Security Groups.
 *
 * NSX Dynamic Security Groups use tag-based membership criteria.  After tags
 * are applied to a VM, NSX re-evaluates group membership asynchronously.
 * This module queries the NSX Manager to confirm the VM has landed in the
 * correct groups, and can also predict group changes based on tag deltas.
 *
 * @module GroupMembershipVerifier
 */

'use strict';

/**
 * Default tag-to-group mapping rules.
 *
 * Each rule maps a set of tag criteria to an NSX security group.  A VM is
 * predicted to be a member of a group when ALL criteria in the rule match
 * the VM's tags.
 *
 * Criteria values may be:
 *  - A string  — exact match for single-value categories.
 *  - An array  — the VM's multi-value category must include ALL listed values.
 *  - `'*'`     — any non-empty value satisfies the criterion.
 *
 * @constant {Array<{groupName: string, criteria: Object.<string, string|string[]>}>}
 */
const DEFAULT_GROUP_RULES = Object.freeze([
  {
    groupName: 'SG-Web-Production',
    criteria: { Tier: 'Web', Environment: 'Production' }
  },
  {
    groupName: 'SG-App-Production',
    criteria: { Tier: 'App', Environment: 'Production' }
  },
  {
    groupName: 'SG-DB-Production',
    criteria: { Tier: 'DB', Environment: 'Production' }
  },
  {
    groupName: 'SG-Web-Staging',
    criteria: { Tier: 'Web', Environment: 'Staging' }
  },
  {
    groupName: 'SG-App-Staging',
    criteria: { Tier: 'App', Environment: 'Staging' }
  },
  {
    groupName: 'SG-DB-Staging',
    criteria: { Tier: 'DB', Environment: 'Staging' }
  },
  {
    groupName: 'SG-PCI-Compliance',
    criteria: { Compliance: ['PCI'] }
  },
  {
    groupName: 'SG-HIPAA-Compliance',
    criteria: { Compliance: ['HIPAA'] }
  },
  {
    groupName: 'SG-SOX-Compliance',
    criteria: { Compliance: ['SOX'] }
  },
  {
    groupName: 'SG-Confidential-Data',
    criteria: { DataClassification: 'Confidential' }
  },
  {
    groupName: 'SG-Quarantine',
    criteria: { Quarantine: 'ACTIVE' }
  }
]);

/**
 * @class GroupMembershipVerifier
 * @classdesc Queries NSX Manager to verify a VM's Dynamic Security Group
 * membership and predicts group changes based on tag modifications.
 */
class GroupMembershipVerifier {
  /**
   * Creates a new GroupMembershipVerifier.
   *
   * @constructor
   * @param {Object} restClient - HTTP client pre-configured for the NSX-T API.
   *   Must expose a `get(url, options)` method returning a Promise.
   * @param {Object} logger - Structured logger instance.  Must expose `info`,
   *   `warn`, `error`, and `debug` methods.
   * @param {Object} [options={}] - Optional configuration.
   * @param {Array} [options.groupRules] - Custom tag-to-group mapping rules.
   *   Defaults to {@link DEFAULT_GROUP_RULES}.
   */
  constructor(restClient, logger, options = {}) {
    if (!restClient) {
      throw new Error('GroupMembershipVerifier requires a restClient instance');
    }
    if (!logger) {
      throw new Error('GroupMembershipVerifier requires a logger instance');
    }

    /** @type {Object} */
    this.restClient = restClient;
    /** @type {Object} */
    this.logger = logger;
    /** @type {Array<{groupName: string, criteria: Object}>} */
    this.groupRules = options.groupRules || DEFAULT_GROUP_RULES;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Verifies that a VM is a member of the expected NSX Dynamic Security
   * Groups.
   *
   * Fetches the VM's actual group membership from NSX Manager and compares
   * it against the supplied expected list.
   *
   * @async
   * @param {string} vmId - The NSX external ID of the virtual machine.
   * @param {string[]} expectedGroups - Array of group names (display names)
   *   the VM is expected to belong to.
   * @param {string} site - Site identifier used to resolve the NSX Manager URL.
   * @returns {Promise<{verified: boolean, expectedGroups: string[], actualGroups: string[], missing: string[], unexpected: string[]}>}
   *   Verification result.
   *
   * @example
   * const result = await verifier.verifyMembership('vm-123',
   *   ['SG-Web-Production', 'SG-PCI-Compliance'],
   *   'site-east'
   * );
   * if (!result.verified) {
   *   console.log('Missing groups:', result.missing);
   * }
   */
  async verifyMembership(vmId, expectedGroups, site) {
    const correlationCtx = { vmId, site, operation: 'verifyMembership' };

    this.logger.info('Verifying group membership', {
      ...correlationCtx,
      expectedCount: expectedGroups.length
    });

    const actualGroups = await this.getEffectiveGroups(vmId, site);

    const actualSet = new Set(actualGroups);
    const expectedSet = new Set(expectedGroups);

    // Groups that are expected but not present
    const missing = expectedGroups.filter((g) => !actualSet.has(g));

    // Groups that are present but not expected
    const unexpected = actualGroups.filter((g) => !expectedSet.has(g));

    const verified = missing.length === 0;

    this.logger.info('Group membership verification complete', {
      ...correlationCtx,
      verified,
      actualCount: actualGroups.length,
      missingCount: missing.length,
      unexpectedCount: unexpected.length
    });

    if (!verified) {
      this.logger.warn('Group membership mismatch detected', {
        ...correlationCtx,
        missing,
        unexpected
      });
    }

    return {
      verified,
      expectedGroups,
      actualGroups,
      missing,
      unexpected
    };
  }

  /**
   * Retrieves the list of NSX Dynamic Security Groups that a VM currently
   * belongs to.
   *
   * @async
   * @param {string} vmId - The NSX external ID of the virtual machine.
   * @param {string} site - Site identifier.
   * @returns {Promise<string[]>} Array of group display names.
   *
   * @example
   * const groups = await verifier.getEffectiveGroups('vm-123', 'site-east');
   * // groups => ['SG-Web-Production', 'SG-PCI-Compliance']
   */
  async getEffectiveGroups(vmId, site) {
    const correlationCtx = { vmId, site, operation: 'getEffectiveGroups' };

    this.logger.debug('Fetching effective groups from NSX Manager', correlationCtx);

    const nsxUrl = this._getNsxUrl(site);
    const endpoint = `${nsxUrl}/api/v1/fabric/virtual-machines/${encodeURIComponent(vmId)}/groups`;

    const response = await this.restClient.get(endpoint, {
      headers: { 'Content-Type': 'application/json' }
    });

    const groups = this._extractGroupsFromResponse(response);

    this.logger.debug('Effective groups retrieved', {
      ...correlationCtx,
      groupCount: groups.length,
      groups
    });

    return groups;
  }

  /**
   * Predicts which NSX Dynamic Security Groups a VM will join or leave when
   * its tags change from `currentTags` to `newTags`.
   *
   * Uses the tag-to-group mapping rules to evaluate membership before and
   * after the tag change, then computes the diff.
   *
   * @param {string} vmId - The NSX external ID of the virtual machine
   *   (included in the result for correlation).
   * @param {Object.<string, string|string[]>} currentTags - The VM's current
   *   tag map.
   * @param {Object.<string, string|string[]>} newTags - The VM's tag map
   *   after the proposed change.
   * @returns {{vmId: string, groupsToJoin: string[], groupsToLeave: string[], unchangedGroups: string[]}}
   *   Predicted group membership changes.
   *
   * @example
   * const prediction = verifier.predictGroupChanges('vm-123',
   *   { Tier: 'Web', Environment: 'Staging' },
   *   { Tier: 'Web', Environment: 'Production' }
   * );
   * // prediction.groupsToJoin => ['SG-Web-Production']
   * // prediction.groupsToLeave => ['SG-Web-Staging']
   */
  predictGroupChanges(vmId, currentTags, newTags) {
    const correlationCtx = { vmId, operation: 'predictGroupChanges' };

    this.logger.debug('Predicting group membership changes', correlationCtx);

    const currentGroups = this._evaluateGroupRules(currentTags);
    const newGroups = this._evaluateGroupRules(newTags);

    const currentSet = new Set(currentGroups);
    const newSet = new Set(newGroups);

    const groupsToJoin = newGroups.filter((g) => !currentSet.has(g));
    const groupsToLeave = currentGroups.filter((g) => !newSet.has(g));
    const unchangedGroups = currentGroups.filter((g) => newSet.has(g));

    this.logger.info('Group change prediction complete', {
      ...correlationCtx,
      joining: groupsToJoin.length,
      leaving: groupsToLeave.length,
      unchanged: unchangedGroups.length
    });

    return {
      vmId,
      groupsToJoin,
      groupsToLeave,
      unchangedGroups
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolves the NSX Manager base URL for a given site.
   *
   * @private
   * @param {string} site - The site identifier.
   * @returns {string} The base URL (no trailing slash).
   */
  _getNsxUrl(site) {
    return `https://nsx-manager-${site}`;
  }

  /**
   * Extracts group display names from an NSX API response.
   *
   * Handles multiple response shapes returned by NSX Manager versions.
   *
   * @private
   * @param {Object} response - The HTTP response object.
   * @returns {string[]} Array of group display names.
   */
  _extractGroupsFromResponse(response) {
    if (!response) {
      return [];
    }

    const body = response.body || response.data || response;

    let rawGroups = [];

    if (Array.isArray(body)) {
      rawGroups = body;
    } else if (body && Array.isArray(body.results)) {
      rawGroups = body.results;
    } else if (body && Array.isArray(body.groups)) {
      rawGroups = body.groups;
    }

    // Extract display_name from each group object, or use the value directly
    // if it is already a string
    return rawGroups.map((g) => {
      if (typeof g === 'string') {
        return g;
      }
      return g.display_name || g.name || g.id || String(g);
    });
  }

  /**
   * Evaluates the tag-to-group mapping rules against a tag set and returns
   * the list of groups whose criteria are satisfied.
   *
   * @private
   * @param {Object.<string, string|string[]>} tags - The tag map to evaluate.
   * @returns {string[]} Array of matching group names.
   */
  _evaluateGroupRules(tags) {
    const matchedGroups = [];

    for (const rule of this.groupRules) {
      if (this._criteriaMatch(rule.criteria, tags)) {
        matchedGroups.push(rule.groupName);
      }
    }

    return matchedGroups;
  }

  /**
   * Checks whether a set of criteria is satisfied by the given tags.
   *
   * @private
   * @param {Object.<string, string|string[]>} criteria - The criteria to check.
   * @param {Object.<string, string|string[]>} tags - The tag map.
   * @returns {boolean} `true` if all criteria are met.
   */
  _criteriaMatch(criteria, tags) {
    for (const [category, required] of Object.entries(criteria)) {
      const actual = tags[category];

      if (actual === undefined || actual === null) {
        return false;
      }

      // Wildcard: any non-empty value matches
      if (required === '*') {
        continue;
      }

      if (Array.isArray(required)) {
        // All required values must be present in the actual array
        const actualArray = Array.isArray(actual) ? actual : [actual];
        for (const requiredVal of required) {
          if (!actualArray.includes(requiredVal)) {
            return false;
          }
        }
      } else {
        // Exact match for single-value categories
        const actualVal = Array.isArray(actual) ? actual[0] : actual;
        if (actualVal !== required) {
          return false;
        }
      }
    }

    return true;
  }
}

module.exports = GroupMembershipVerifier;
