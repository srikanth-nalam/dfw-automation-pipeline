/**
 * @file NsxApiAdapter.js
 * @description Transforms the pipeline's internal tag model to and from the
 *   NSX Manager REST API tag/group format. Handles both single-value (string)
 *   and multi-value (array) tag categories.
 *
 * NSX tag format:
 *   { tags: [{ tag: "value", scope: "category" }, ...] }
 *
 * Internal model format:
 *   { Application: "APP001", Tier: "Web", Compliance: ["PCI", "HIPAA"] }
 *
 * @module adapters/NsxApiAdapter
 */

'use strict';

/**
 * NsxApiAdapter converts between the pipeline's internal tag model and the
 * NSX Manager REST API representation. Also generates NSX group membership
 * criteria expressions from tags.
 *
 * All methods are stateless and can be used either statically or on an
 * instance.
 *
 * @class NsxApiAdapter
 */
class NsxApiAdapter {
  /**
   * Converts an internal tag map to the NSX REST API tag payload format.
   *
   * Handles two value types per category:
   *   - **String** — produces a single `{ tag, scope }` entry.
   *   - **Array** — produces one `{ tag, scope }` entry per element.
   *
   * @param {Object} tags - Internal tag map. Keys are category names, values
   *   are strings or arrays of strings.
   * @returns {{ tags: Array<{ tag: string, scope: string }> }}
   *   NSX-formatted tag payload ready for PATCH/PUT.
   *
   * @throws {Error} When `tags` is not a non-null object.
   *
   * @example
   * const adapter = new NsxApiAdapter();
   * const payload = adapter.toNsxTagPayload({
   *   Application: 'APP001',
   *   Tier: 'Web',
   *   Compliance: ['PCI', 'HIPAA']
   * });
   * // {
   * //   tags: [
   * //     { tag: 'APP001', scope: 'Application' },
   * //     { tag: 'Web', scope: 'Tier' },
   * //     { tag: 'PCI', scope: 'Compliance' },
   * //     { tag: 'HIPAA', scope: 'Compliance' }
   * //   ]
   * // }
   */
  toNsxTagPayload(tags) {
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
      throw new Error(
        '[DFW-2001] tags must be a non-null object mapping category names to values.'
      );
    }

    const nsxTags = [];

    for (const [scope, value] of Object.entries(tags)) {
      if (scope === '' || scope === undefined) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== null && item !== undefined && String(item).trim() !== '') {
            nsxTags.push({
              tag: String(item).trim(),
              scope: scope.trim()
            });
          }
        }
      } else if (value !== null && value !== undefined && String(value).trim() !== '') {
        nsxTags.push({
          tag: String(value).trim(),
          scope: scope.trim()
        });
      }
    }

    return { tags: nsxTags };
  }

  /**
   * Converts an NSX tag response back to the internal tag model.
   * When multiple tags share the same scope (category), the values are
   * collected into an array.
   *
   * @param {Object|Array} nsxTags - NSX tag response. Accepts either
   *   `{ tags: [...] }` or a bare array of `{ tag, scope }` objects.
   * @returns {Object} Internal tag map. Keys are category (scope) names,
   *   values are strings (single) or arrays (multiple).
   *
   * @example
   * const internal = adapter.fromNsxTagResponse({
   *   tags: [
   *     { tag: 'APP001', scope: 'Application' },
   *     { tag: 'PCI', scope: 'Compliance' },
   *     { tag: 'HIPAA', scope: 'Compliance' }
   *   ]
   * });
   * // { Application: 'APP001', Compliance: ['PCI', 'HIPAA'] }
   */
  fromNsxTagResponse(nsxTags) {
    const tagArray = NsxApiAdapter._extractTagArray(nsxTags);
    const result = {};

    for (const entry of tagArray) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const scope = typeof entry.scope === 'string' ? entry.scope.trim() : '';
      const tag = typeof entry.tag === 'string' ? entry.tag.trim() : '';

      if (!scope || !tag) {
        continue;
      }

      if (result[scope] === undefined) {
        // First value — store as string
        result[scope] = tag;
      } else if (Array.isArray(result[scope])) {
        // Already an array — append
        if (!result[scope].includes(tag)) {
          result[scope].push(tag);
        }
      } else {
        // Second value — promote to array
        if (result[scope] !== tag) {
          result[scope] = [result[scope], tag];
        }
      }
    }

    return result;
  }

  /**
   * Generates NSX group membership criteria expressions from the internal
   * tag model. Each tag category/value produces a `Condition` block using
   * the `VirtualMachine` resource type and `Tag` member type.
   *
   * When multiple tags are provided, they are combined with a
   * `ConjunctionOperator` (AND by default between categories, OR within
   * a multi-value category).
   *
   * @param {Object} tags - Internal tag map.
   * @returns {Array<Object>} Array of NSX expression objects suitable for
   *   inclusion in a group definition's `expression` field.
   *
   * @throws {Error} When `tags` is not a non-null object.
   *
   * @example
   * const criteria = adapter.toGroupCriteria({
   *   Application: 'APP001',
   *   Tier: 'Web'
   * });
   * // Returns array of NSX Condition and ConjunctionOperator objects
   */
  toGroupCriteria(tags) {
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
      throw new Error(
        '[DFW-2002] tags must be a non-null object for group criteria generation.'
      );
    }

    const entries = Object.entries(tags).filter(
      ([scope, value]) => scope && value !== null && value !== undefined
    );

    if (entries.length === 0) {
      return [];
    }

    const expressions = [];

    for (let i = 0; i < entries.length; i++) {
      const [scope, value] = entries[i];

      // Insert AND conjunction between categories (not before the first)
      if (i > 0) {
        expressions.push({
          resource_type: 'ConjunctionOperator',
          conjunction_operator: 'AND'
        });
      }

      if (Array.isArray(value)) {
        // Multi-value: OR within the same category
        const conditions = value
          .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
          .map(v => NsxApiAdapter._buildCondition(scope, String(v).trim()));

        if (conditions.length === 1) {
          expressions.push(conditions[0]);
        } else if (conditions.length > 1) {
          // Wrap multi-value in a NestedExpression with OR
          expressions.push({
            resource_type: 'NestedExpression',
            expressions: NsxApiAdapter._interleaveWithOr(conditions)
          });
        }
      } else {
        // Single value
        const trimmed = String(value).trim();
        if (trimmed !== '') {
          expressions.push(NsxApiAdapter._buildCondition(scope, trimmed));
        }
      }
    }

    return expressions;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extracts the tag array from various NSX response shapes.
   *
   * @private
   * @param {Object|Array} nsxTags
   * @returns {Array}
   */
  static _extractTagArray(nsxTags) {
    if (Array.isArray(nsxTags)) {
      return nsxTags;
    }
    if (nsxTags && typeof nsxTags === 'object' && Array.isArray(nsxTags.tags)) {
      return nsxTags.tags;
    }
    return [];
  }

  /**
   * Builds a single NSX Condition expression for a tag scope/value pair.
   *
   * @private
   * @param {string} scope - Tag category (NSX scope).
   * @param {string} value - Tag value.
   * @returns {Object} NSX Condition resource.
   */
  static _buildCondition(scope, value) {
    return {
      resource_type: 'Condition',
      key: 'Tag',
      member_type: 'VirtualMachine',
      value: `${scope}|${value}`,
      operator: 'EQUALS',
      scope_operator: 'EQUALS'
    };
  }

  /**
   * Interleaves an array of conditions with OR conjunction operators.
   *
   * @private
   * @param {Object[]} conditions
   * @returns {Object[]} Array with conditions separated by OR operators.
   */
  static _interleaveWithOr(conditions) {
    const result = [];
    for (let i = 0; i < conditions.length; i++) {
      result.push(conditions[i]);
      if (i < conditions.length - 1) {
        result.push({
          resource_type: 'ConjunctionOperator',
          conjunction_operator: 'OR'
        });
      }
    }
    return result;
  }
}

module.exports = NsxApiAdapter;
