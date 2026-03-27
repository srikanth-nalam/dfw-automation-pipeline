/**
 * @file ImpactAnalysisAction.js
 * @description Pre-approval read-only impact analysis for proposed tag changes.
 *   This action can be invoked from ServiceNow BEFORE approval is granted to
 *   show the impact of proposed changes in the approval form.
 *
 *   The action performs NO mutations — it reads current state and predicts
 *   what would change if the proposed tags were applied.
 *
 * @module lifecycle/ImpactAnalysisAction
 */

'use strict';

/**
 * Risk level thresholds.
 * @constant {Object}
 * @private
 */
const RISK_LEVELS = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
});

/**
 * @class ImpactAnalysisAction
 * @classdesc Performs read-only impact analysis on proposed tag changes,
 *   predicting group membership changes, affected DFW rules, and overall
 *   risk level.
 *
 * @example
 * const action = new ImpactAnalysisAction({ tagOperations, groupVerifier, dfwValidator, logger });
 * const impact = await action.analyze({ vmId: 'vm-123', site: 'NDCNG', proposedTags: { ... } });
 */
class ImpactAnalysisAction {
  /**
   * Creates a new ImpactAnalysisAction.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.tagOperations - Tag management operations.
   * @param {Object} dependencies.groupVerifier - Group membership verifier.
   * @param {Object} dependencies.dfwValidator - DFW policy validator.
   * @param {Object} dependencies.logger - Structured logger instance.
   */
  constructor(dependencies) {
    if (!dependencies || !dependencies.tagOperations) {
      throw new Error('[DFW-8001] ImpactAnalysisAction requires tagOperations dependency');
    }
    if (!dependencies.groupVerifier) {
      throw new Error('[DFW-8002] ImpactAnalysisAction requires groupVerifier dependency');
    }
    if (!dependencies.dfwValidator) {
      throw new Error('[DFW-8003] ImpactAnalysisAction requires dfwValidator dependency');
    }
    if (!dependencies.logger) {
      throw new Error('[DFW-8004] ImpactAnalysisAction requires logger dependency');
    }

    /** @private */
    this.tagOperations = dependencies.tagOperations;
    /** @private */
    this.groupVerifier = dependencies.groupVerifier;
    /** @private */
    this.dfwValidator = dependencies.dfwValidator;
    /** @private */
    this.logger = dependencies.logger;
  }

  /**
   * Performs impact analysis for a proposed tag change.
   *
   * @async
   * @param {Object} params - Analysis parameters.
   * @param {string} params.vmId - VM identifier.
   * @param {string} params.site - Site code (NDCNG or TULNG).
   * @param {Object} params.proposedTags - Proposed tag values.
   * @returns {Promise<Object>} Impact analysis result.
   */
  async analyze(params) {
    const { vmId, site, proposedTags } = params;

    this.logger.info('Starting impact analysis', {
      vmId,
      site,
      proposedCategories: Object.keys(proposedTags),
      component: 'ImpactAnalysisAction'
    });

    try {
      // Step 1: Read current tags from NSX
      const currentTags = await this.tagOperations.getTags(vmId, site);

      this.logger.debug('Current tags retrieved', {
        vmId,
        currentTags,
        component: 'ImpactAnalysisAction'
      });

      // Step 2: Compute tag delta
      const tagDelta = this._computeTagDelta(currentTags, proposedTags);

      // Step 3: Predict group membership changes
      const mergedTags = { ...currentTags, ...proposedTags };
      const groupChanges = this.groupVerifier.predictGroupChanges(
        vmId, currentTags, mergedTags
      );

      // Step 4: Query DFW rules that reference affected groups
      const affectedGroups = [
        ...groupChanges.groupsToJoin,
        ...groupChanges.groupsToLeave
      ];
      const affectedDFWRules = await this._getAffectedDFWRules(
        affectedGroups, vmId, site
      );

      // Step 5: Assess risk level
      const { riskLevel, riskReasons } = this._assessRisk(
        currentTags, proposedTags, groupChanges, affectedDFWRules
      );

      const requiresSecurityArchitectApproval = riskLevel === RISK_LEVELS.HIGH;

      const result = {
        vmId,
        site,
        currentTags,
        proposedTags,
        tagDelta,
        groupChanges: {
          joining: groupChanges.groupsToJoin,
          leaving: groupChanges.groupsToLeave,
          unchanged: groupChanges.unchangedGroups
        },
        affectedDFWRules,
        riskLevel,
        riskReasons,
        requiresSecurityArchitectApproval,
        analysisTimestamp: new Date().toISOString()
      };

      this.logger.info('Impact analysis completed', {
        vmId,
        riskLevel,
        groupsJoining: groupChanges.groupsToJoin.length,
        groupsLeaving: groupChanges.groupsToLeave.length,
        affectedRuleCount: affectedDFWRules.length,
        requiresSecurityArchitectApproval,
        component: 'ImpactAnalysisAction'
      });

      return result;
    } catch (err) {
      this.logger.error('Impact analysis failed', {
        vmId,
        site,
        errorMessage: err.message,
        component: 'ImpactAnalysisAction'
      });
      throw err;
    }
  }

  /**
   * Computes the delta between current and proposed tags.
   *
   * @private
   * @param {Object} currentTags - Current tag values.
   * @param {Object} proposedTags - Proposed tag values.
   * @returns {Object} Tag delta with added, changed, and removed categories.
   */
  _computeTagDelta(currentTags, proposedTags) {
    const added = {};
    const changed = {};
    const unchanged = {};

    for (const [category, value] of Object.entries(proposedTags)) {
      if (currentTags[category] === undefined) {
        added[category] = { newValue: value };
      } else if (JSON.stringify(currentTags[category]) !== JSON.stringify(value)) {
        changed[category] = {
          oldValue: currentTags[category],
          newValue: value
        };
      } else {
        unchanged[category] = value;
      }
    }

    return { added, changed, unchanged };
  }

  /**
   * Gets DFW rules that reference the affected groups.
   *
   * @private
   * @async
   * @param {string[]} groups - Affected group names.
   * @param {string} vmId - VM identifier.
   * @param {string} site - Site code.
   * @returns {Promise<Array>} Affected DFW rules.
   */
  async _getAffectedDFWRules(groups, vmId, site) {
    if (groups.length === 0) {
      return [];
    }

    try {
      const result = await this.dfwValidator.validatePolicies(vmId, site);
      return result && result.policies ? result.policies : [];
    } catch (err) {
      this.logger.warn('Failed to retrieve affected DFW rules', {
        vmId,
        site,
        errorMessage: err.message,
        component: 'ImpactAnalysisAction'
      });
      return [];
    }
  }

  /**
   * Assesses the risk level of the proposed change.
   *
   * @private
   * @param {Object} currentTags - Current tags.
   * @param {Object} proposedTags - Proposed tags.
   * @param {Object} groupChanges - Predicted group changes.
   * @param {Array} affectedDFWRules - Affected DFW rules.
   * @returns {{ riskLevel: string, riskReasons: string[] }}
   */
  _assessRisk(currentTags, proposedTags, groupChanges, affectedDFWRules) {
    const riskReasons = [];
    let riskLevel = RISK_LEVELS.LOW;

    // HIGH: Production environment changes
    if (currentTags.Environment === 'Production' || proposedTags.Environment === 'Production') {
      if (proposedTags.Environment && proposedTags.Environment !== currentTags.Environment) {
        riskReasons.push('Environment change involving Production tier');
        riskLevel = RISK_LEVELS.HIGH;
      }
    }

    // HIGH: Leaving production groups
    const leavingProductionGroups = groupChanges.groupsToLeave.filter(
      (g) => g.includes('Production')
    );
    if (leavingProductionGroups.length > 0) {
      riskReasons.push(
        `VM will leave production security groups: ${leavingProductionGroups.join(', ')}`
      );
      riskLevel = RISK_LEVELS.HIGH;
    }

    // MEDIUM: Compliance changes
    if (proposedTags.Compliance) {
      const currentCompliance = Array.isArray(currentTags.Compliance)
        ? currentTags.Compliance
        : [];
      const proposedCompliance = Array.isArray(proposedTags.Compliance)
        ? proposedTags.Compliance
        : [];
      if (JSON.stringify(currentCompliance) !== JSON.stringify(proposedCompliance)) {
        riskReasons.push('Compliance framework change detected');
        if (riskLevel !== RISK_LEVELS.HIGH) {
          riskLevel = RISK_LEVELS.MEDIUM;
        }
      }
    }

    // MEDIUM: DataClassification changes
    if (
      proposedTags.DataClassification &&
      proposedTags.DataClassification !== currentTags.DataClassification
    ) {
      riskReasons.push(
        `Data classification change from "${currentTags.DataClassification}" to "${proposedTags.DataClassification}"`
      );
      if (riskLevel !== RISK_LEVELS.HIGH) {
        riskLevel = RISK_LEVELS.MEDIUM;
      }
    }

    // MEDIUM: Multiple group changes
    if (groupChanges.groupsToJoin.length + groupChanges.groupsToLeave.length > 3) {
      riskReasons.push('Large number of security group changes predicted');
      if (riskLevel !== RISK_LEVELS.HIGH) {
        riskLevel = RISK_LEVELS.MEDIUM;
      }
    }

    if (riskReasons.length === 0) {
      riskReasons.push('No elevated risk factors detected');
    }

    return { riskLevel, riskReasons };
  }
}

module.exports = ImpactAnalysisAction;
