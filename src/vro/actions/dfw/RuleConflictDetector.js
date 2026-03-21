/**
 * @file RuleConflictDetector.js
 * @description Detects shadowed, duplicate, and contradictory DFW rules.
 *   Provides pure-logic analysis of NSX DFW rule sets to identify potential
 *   conflicts before deployment. No external dependencies required — all
 *   methods operate on in-memory rule arrays.
 *
 * Rule format:
 *   {
 *     name: string,
 *     source_groups: string[],
 *     destination_groups: string[],
 *     services: string[],
 *     action: "ALLOW" | "DROP" | "REJECT",
 *     priority: number
 *   }
 *
 * @module dfw/RuleConflictDetector
 */

'use strict';

/**
 * RuleConflictDetector performs static analysis on DFW rule sets to find
 * shadowed, contradictory, and duplicate rules. All methods are pure functions
 * with no side effects — no REST calls, no constructor dependencies.
 *
 * @class RuleConflictDetector
 */
class RuleConflictDetector {
  /**
   * Runs all detection methods against the combined set of proposed and
   * existing rules. Returns a unified summary of every issue found.
   *
   * @param {Object[]} proposedRules - Rules that are about to be deployed.
   * @param {Object[]} existingRules - Rules currently active in NSX.
   * @returns {{
   *   conflicts: Object[],
   *   shadows: Object[],
   *   duplicates: Object[],
   *   hasIssues: boolean
   * }} A summary object. `hasIssues` is `true` when any category is non-empty.
   *
   * @example
   * const detector = new RuleConflictDetector();
   * const result = detector.analyze(newRules, currentRules);
   * if (result.hasIssues) {
   *   console.warn('Rule conflicts detected', result);
   * }
   */
  analyze(proposedRules, existingRules) {
    const proposed = Array.isArray(proposedRules) ? proposedRules : [];
    const existing = Array.isArray(existingRules) ? existingRules : [];

    const allRules = [...existing, ...proposed];

    const shadows = this.detectShadowed(allRules);
    const conflicts = this.detectContradictory(allRules);
    const duplicates = this.detectDuplicates(allRules);

    return {
      conflicts,
      shadows,
      duplicates,
      hasIssues: conflicts.length > 0 || shadows.length > 0 || duplicates.length > 0
    };
  }

  /**
   * Finds rules that are completely overshadowed by higher-priority rules.
   * A rule is shadowed when a rule with a **lower** priority number (i.e.
   * evaluated first) has an equal or broader match on source, destination,
   * and services. The shadowed rule will never be hit.
   *
   * @param {Object[]} rules - Full set of rules to analyse.
   * @returns {Object[]} Array of shadow descriptors:
   *   `{ shadowedRule, shadowedBy, reason }`.
   *
   * @example
   * const shadows = detector.detectShadowed(rules);
   * // [{ shadowedRule: 'deny-all', shadowedBy: 'allow-web', reason: '...' }]
   */
  detectShadowed(rules) {
    if (!Array.isArray(rules) || rules.length < 2) {
      return [];
    }

    const sorted = RuleConflictDetector._sortByPriority(rules);
    const shadows = [];

    for (let i = 1; i < sorted.length; i++) {
      const candidate = sorted[i];

      for (let j = 0; j < i; j++) {
        const higherPriority = sorted[j];

        if (RuleConflictDetector._isSubsumedBy(candidate, higherPriority)) {
          shadows.push({
            shadowedRule: candidate.name || `rule-index-${i}`,
            shadowedBy: higherPriority.name || `rule-index-${j}`,
            reason:
              `Rule "${candidate.name || i}" (priority ${candidate.priority}) is fully ` +
              `covered by "${higherPriority.name || j}" (priority ${higherPriority.priority}) ` +
              `which matches the same or broader source/destination/service scope.`
          });
          break; // one shadow relationship is enough per rule
        }
      }
    }

    return shadows;
  }

  /**
   * Finds rules that share the same source, destination, and service scope
   * but specify **different** actions. For example, one rule ALLOWs while
   * another DROPs traffic for the same tuple — this is a direct contradiction.
   *
   * @param {Object[]} rules - Full set of rules to analyse.
   * @returns {Object[]} Array of conflict descriptors:
   *   `{ ruleA, ruleB, reason }`.
   *
   * @example
   * const conflicts = detector.detectContradictory(rules);
   * // [{ ruleA: 'allow-web', ruleB: 'deny-web', reason: '...' }]
   */
  detectContradictory(rules) {
    if (!Array.isArray(rules) || rules.length < 2) {
      return [];
    }

    const conflicts = [];
    const seen = new Set();

    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const ruleA = rules[i];
        const ruleB = rules[j];

        // Only flag contradictions — same scope, different action
        if (
          RuleConflictDetector._scopeMatches(ruleA, ruleB) &&
          RuleConflictDetector._normalizeAction(ruleA.action) !==
            RuleConflictDetector._normalizeAction(ruleB.action)
        ) {
          const pairKey = RuleConflictDetector._pairKey(ruleA, ruleB);
          if (!seen.has(pairKey)) {
            seen.add(pairKey);
            conflicts.push({
              ruleA: ruleA.name || `rule-index-${i}`,
              ruleB: ruleB.name || `rule-index-${j}`,
              reason:
                `Rules "${ruleA.name || i}" (${ruleA.action}) and ` +
                `"${ruleB.name || j}" (${ruleB.action}) target the same ` +
                `source/destination/service scope but specify contradictory actions.`
            });
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * Finds rules with identical source_groups, destination_groups, services,
   * and action. These are exact duplicates that add no value and should be
   * consolidated.
   *
   * @param {Object[]} rules - Full set of rules to analyse.
   * @returns {Object[]} Array of duplicate descriptors:
   *   `{ ruleA, ruleB, reason }`.
   *
   * @example
   * const duplicates = detector.detectDuplicates(rules);
   * // [{ ruleA: 'allow-web-1', ruleB: 'allow-web-2', reason: '...' }]
   */
  detectDuplicates(rules) {
    if (!Array.isArray(rules) || rules.length < 2) {
      return [];
    }

    const duplicates = [];
    const seen = new Set();

    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const ruleA = rules[i];
        const ruleB = rules[j];

        if (
          RuleConflictDetector._scopeMatches(ruleA, ruleB) &&
          RuleConflictDetector._normalizeAction(ruleA.action) ===
            RuleConflictDetector._normalizeAction(ruleB.action)
        ) {
          const pairKey = RuleConflictDetector._pairKey(ruleA, ruleB);
          if (!seen.has(pairKey)) {
            seen.add(pairKey);
            duplicates.push({
              ruleA: ruleA.name || `rule-index-${i}`,
              ruleB: ruleB.name || `rule-index-${j}`,
              reason:
                `Rules "${ruleA.name || i}" and "${ruleB.name || j}" have identical ` +
                `source_groups, destination_groups, services, and action (${ruleA.action}). ` +
                `Consider removing the duplicate.`
            });
          }
        }
      }
    }

    return duplicates;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns a copy of the rules array sorted by priority (ascending — lower
   * number = higher priority = evaluated first).
   *
   * @private
   * @param {Object[]} rules
   * @returns {Object[]}
   */
  static _sortByPriority(rules) {
    return [...rules].sort((a, b) => {
      const pa = typeof a.priority === 'number' ? a.priority : Number.MAX_SAFE_INTEGER;
      const pb = typeof b.priority === 'number' ? b.priority : Number.MAX_SAFE_INTEGER;
      return pa - pb;
    });
  }

  /**
   * Normalises a string array for comparison — sorts, lowercases, and deduplicates.
   *
   * @private
   * @param {string[]} arr
   * @returns {string}
   */
  static _normalizeGroups(arr) {
    if (!Array.isArray(arr) || arr.length === 0) {
      return 'ANY';
    }
    return [...new Set(arr.map(s => String(s).trim().toLowerCase()))].sort().join(',');
  }

  /**
   * Normalises an action string for safe comparison.
   *
   * @private
   * @param {string} action
   * @returns {string}
   */
  static _normalizeAction(action) {
    return typeof action === 'string' ? action.trim().toUpperCase() : 'UNKNOWN';
  }

  /**
   * Checks if two rules have matching source, destination, and service scope.
   *
   * @private
   * @param {Object} ruleA
   * @param {Object} ruleB
   * @returns {boolean}
   */
  static _scopeMatches(ruleA, ruleB) {
    return (
      RuleConflictDetector._normalizeGroups(ruleA.source_groups) ===
        RuleConflictDetector._normalizeGroups(ruleB.source_groups) &&
      RuleConflictDetector._normalizeGroups(ruleA.destination_groups) ===
        RuleConflictDetector._normalizeGroups(ruleB.destination_groups) &&
      RuleConflictDetector._normalizeGroups(ruleA.services) ===
        RuleConflictDetector._normalizeGroups(ruleB.services)
    );
  }

  /**
   * Determines whether `candidate` is fully subsumed by `broader`.
   * A rule is subsumed when the broader rule's source, destination, and
   * service groups are a superset of (or equal to) the candidate's groups,
   * OR when the broader rule uses "ANY" (empty array) for that dimension.
   *
   * @private
   * @param {Object} candidate - The potentially shadowed rule.
   * @param {Object} broader   - The higher-priority rule.
   * @returns {boolean}
   */
  static _isSubsumedBy(candidate, broader) {
    return (
      RuleConflictDetector._groupCovers(broader.source_groups, candidate.source_groups) &&
      RuleConflictDetector._groupCovers(broader.destination_groups, candidate.destination_groups) &&
      RuleConflictDetector._groupCovers(broader.services, candidate.services)
    );
  }

  /**
   * Returns `true` if `supersetArr` covers (is a superset of or equal to)
   * `subsetArr`. An empty/missing array is treated as "ANY" and automatically
   * covers everything.
   *
   * @private
   * @param {string[]} supersetArr - The potentially broader group.
   * @param {string[]} subsetArr   - The potentially narrower group.
   * @returns {boolean}
   */
  static _groupCovers(supersetArr, subsetArr) {
    // "ANY" (empty array or missing) covers everything
    if (!Array.isArray(supersetArr) || supersetArr.length === 0) {
      return true;
    }
    // If subset is "ANY" but superset is specific, superset cannot cover it
    if (!Array.isArray(subsetArr) || subsetArr.length === 0) {
      return false;
    }

    const superNorm = new Set(supersetArr.map(s => String(s).trim().toLowerCase()));
    return subsetArr.every(item => superNorm.has(String(item).trim().toLowerCase()));
  }

  /**
   * Generates a deterministic key for a pair of rules (order-independent)
   * to avoid duplicate reporting.
   *
   * @private
   * @param {Object} ruleA
   * @param {Object} ruleB
   * @returns {string}
   */
  static _pairKey(ruleA, ruleB) {
    const names = [ruleA.name || 'unnamed-a', ruleB.name || 'unnamed-b'].sort();
    return names.join('::');
  }
}

module.exports = RuleConflictDetector;
