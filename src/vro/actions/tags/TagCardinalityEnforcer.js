/**
 * @fileoverview TagCardinalityEnforcer — Enforces cardinality rules for NSX tags.
 *
 * NSX tags are organized by category (scope). Each category has a cardinality
 * constraint that determines how many values can coexist:
 *
 *  - **Single-value** categories (Region, SecurityZone, Environment, AppCI,
 *    SystemRole, DataClassification, CostCenter): only one tag value is
 *    permitted at a time. Assigning a new value automatically replaces any
 *    previous value.
 *
 *  - **Multi-value** categories (Compliance): multiple values may coexist
 *    (e.g. PCI + HIPAA). The special value "None" is mutually exclusive: if
 *    "None" is present, no other compliance values are allowed, and adding a
 *    real compliance value removes "None".
 *
 * The enforcer also validates tag combinations to catch conflicting
 * configurations (e.g. PCI compliance in a Sandbox environment).
 *
 * @module TagCardinalityEnforcer
 */

'use strict';

/**
 * Category cardinality configuration.
 * Maps each category name to its cardinality type.
 *
 * @constant {Object.<string, {type: string}>}
 */
const CATEGORY_CONFIG = Object.freeze({
  Region: { type: 'single' },
  SecurityZone: { type: 'single' },
  Environment: { type: 'single' },
  AppCI: { type: 'single' },
  SystemRole: { type: 'single' },
  DataClassification: { type: 'single' },
  CostCenter: { type: 'single' },
  Compliance: { type: 'multi' }
});

/**
 * Rules that define conflicting tag combinations.
 * Each rule has a human-readable description and a `check` function that
 * receives the merged tag map and returns `true` when the conflict is present.
 *
 * @constant {Array<{description: string, check: function(Object): boolean}>}
 */
const CONFLICT_RULES = Object.freeze([
  {
    description: 'PCI compliance is not permitted in a Sandbox environment',
    check: (tags) => {
      const compliance = tags.Compliance;
      const env = tags.Environment;
      if (!compliance || !env) {
        return false;
      }
      const complianceValues = Array.isArray(compliance) ? compliance : [compliance];
      return complianceValues.includes('PCI') && env === 'Sandbox';
    }
  },
  {
    description: 'HIPAA compliance is not permitted in a Sandbox environment',
    check: (tags) => {
      const compliance = tags.Compliance;
      const env = tags.Environment;
      if (!compliance || !env) {
        return false;
      }
      const complianceValues = Array.isArray(compliance) ? compliance : [compliance];
      return complianceValues.includes('HIPAA') && env === 'Sandbox';
    }
  },
  {
    description: 'Confidential data classification requires a compliance tag other than None',
    check: (tags) => {
      const classification = tags.DataClassification;
      const compliance = tags.Compliance;
      if (classification !== 'Confidential') {
        return false;
      }
      if (!compliance) {
        return true;
      }
      const complianceValues = Array.isArray(compliance) ? compliance : [compliance];
      return complianceValues.length === 0 ||
        (complianceValues.length === 1 && complianceValues[0] === 'None');
    }
  }
]);

/**
 * @class TagCardinalityEnforcer
 * @classdesc Enforces cardinality constraints and validates tag combinations
 * for NSX tag operations.
 */
class TagCardinalityEnforcer {
  /**
   * Creates a new TagCardinalityEnforcer.
   *
   * @constructor
   */
  constructor() {
    /** @type {Object.<string, {type: string}>} */
    this.categoryConfig = CATEGORY_CONFIG;
    /** @type {Array<{description: string, check: function}>} */
    this.conflictRules = CONFLICT_RULES;
  }

  /**
   * Enforces cardinality rules by merging desired tags into the current tag
   * set. Single-value categories have their previous value replaced; the
   * Compliance multi-value category follows "None"-exclusivity logic.
   *
   * @param {Object.<string, string|string[]>} currentTags - The VM's current
   *   tag map keyed by category (scope).  Single-value categories are strings;
   *   Compliance is an array of strings.
   * @param {Object.<string, string|string[]>} desiredTags - The desired tag
   *   values to merge in.  Same shape as `currentTags`.
   * @returns {Object.<string, string|string[]>} The merged tag set with all
   *   cardinality rules applied.
   *
   * @example
   * const enforcer = new TagCardinalityEnforcer();
   * const merged = enforcer.enforceCardinality(
   *   { AppCI: 'APP001', Compliance: ['PCI'] },
   *   { AppCI: 'APP002', Compliance: ['HIPAA'] }
   * );
   * // merged => { AppCI: 'APP002', Compliance: ['PCI', 'HIPAA'] }
   */
  enforceCardinality(currentTags, desiredTags) {
    const merged = { ...currentTags };

    for (const [category, desiredValue] of Object.entries(desiredTags)) {
      const config = this.categoryConfig[category];

      if (!config) {
        // Unknown category — pass through as single-value
        merged[category] = desiredValue;
        continue;
      }

      if (config.type === 'single') {
        // Single-value: replace unconditionally
        const value = Array.isArray(desiredValue) ? desiredValue[0] : desiredValue;
        merged[category] = value;
      } else if (config.type === 'multi') {
        // Multi-value (Compliance): merge with None-exclusivity
        merged[category] = this._mergeMultiValue(
          merged[category],
          desiredValue
        );
      }
    }

    return merged;
  }

  /**
   * Computes the delta (tags to add and tags to remove) required to move from
   * the `current` tag state to the `desired` tag state while respecting
   * cardinality rules.  The returned arrays use NSX tag format:
   * `{ tag: <value>, scope: <category> }`.
   *
   * @param {Object.<string, string|string[]>} current - Current tags on the VM.
   * @param {Object.<string, string|string[]>} desired - Desired tag state.
   * @returns {{toAdd: Array<{tag: string, scope: string}>, toRemove: Array<{tag: string, scope: string}>}}
   *   The computed delta.
   *
   * @example
   * const delta = enforcer.computeDelta(
   *   { AppCI: 'APP001', Compliance: ['PCI'] },
   *   { AppCI: 'APP002', Compliance: ['PCI', 'HIPAA'] }
   * );
   * // delta.toAdd => [
   * //   { tag: 'APP002', scope: 'AppCI' },
   * //   { tag: 'HIPAA', scope: 'Compliance' }
   * // ]
   * // delta.toRemove => [
   * //   { tag: 'APP001', scope: 'AppCI' }
   * // ]
   */
  computeDelta(current, desired) {
    const merged = this.enforceCardinality(current, desired);
    const toAdd = [];
    const toRemove = [];

    // Collect all categories from both current and merged
    const allCategories = new Set([
      ...Object.keys(current),
      ...Object.keys(merged)
    ]);

    for (const category of allCategories) {
      const currentValues = this._normalizeToArray(current[category]);
      const mergedValues = this._normalizeToArray(merged[category]);

      // Tags that exist in merged but not in current → add
      for (const value of mergedValues) {
        if (!currentValues.includes(value)) {
          toAdd.push({ tag: value, scope: category });
        }
      }

      // Tags that exist in current but not in merged → remove
      for (const value of currentValues) {
        if (!mergedValues.includes(value)) {
          toRemove.push({ tag: value, scope: category });
        }
      }
    }

    return { toAdd, toRemove };
  }

  /**
   * Validates the given tag set against all conflict rules.
   *
   * @param {Object.<string, string|string[]>} tags - The tag map to validate.
   * @returns {{valid: boolean, errors: string[]}} Validation result.  `valid`
   *   is `true` when no conflicts are detected; `errors` contains the
   *   descriptions of any violated rules.
   *
   * @example
   * const result = enforcer.validateTagCombinations({
   *   Compliance: ['PCI'],
   *   Environment: 'Sandbox'
   * });
   * // result => { valid: false, errors: ['PCI compliance is not permitted in a Sandbox environment'] }
   */
  validateTagCombinations(tags) {
    const errors = [];

    for (const rule of this.conflictRules) {
      if (rule.check(tags)) {
        errors.push(rule.description);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Returns the cardinality type for a given category.
   *
   * @param {string} category - The tag category (scope) name.
   * @returns {string} Either `'single'`, `'multi'`, or `'unknown'`.
   */
  getCategoryType(category) {
    const config = this.categoryConfig[category];
    return config ? config.type : 'unknown';
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Merges a desired multi-value set into the current set, enforcing
   * None-exclusivity for the Compliance category.
   *
   * Rules:
   *  - If desired contains "None", the result is `['None']` regardless of
   *    current values.
   *  - If desired contains any non-"None" value and current contains "None",
   *    "None" is removed before merging.
   *  - Otherwise the two sets are unioned (duplicates removed).
   *
   * @private
   * @param {string|string[]|undefined} currentValue - Current tag values.
   * @param {string|string[]|undefined} desiredValue - Desired tag values.
   * @returns {string[]} The merged multi-value array.
   */
  _mergeMultiValue(currentValue, desiredValue) {
    const current = this._normalizeToArray(currentValue);
    const desired = this._normalizeToArray(desiredValue);

    // "None" in desired means clear everything and set only "None"
    if (desired.includes('None')) {
      return ['None'];
    }

    // Remove "None" from current if we are adding real values
    const base = current.filter((v) => v !== 'None');

    // Union of base + desired, deduplicated
    const union = [...new Set([...base, ...desired])];
    return union;
  }

  /**
   * Normalizes a tag value (string, array, or undefined) into an array.
   *
   * @private
   * @param {string|string[]|undefined} value - The value to normalize.
   * @returns {string[]} An array of tag values.
   */
  _normalizeToArray(value) {
    if (value === undefined || value === null) {
      return [];
    }
    if (Array.isArray(value)) {
      return value;
    }
    return [value];
  }
}

module.exports = TagCardinalityEnforcer;
