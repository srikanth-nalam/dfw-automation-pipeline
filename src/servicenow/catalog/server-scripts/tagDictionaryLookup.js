/**
 * @file tagDictionaryLookup.js
 * @description Script Include for querying the u_enterprise_tag_dictionary table.
 *   Provides methods to look up valid tag values, validate entries against the
 *   dictionary, retrieve full metadata for tag values, and fetch conflict rules.
 *
 *   The u_enterprise_tag_dictionary table schema:
 *     - u_category       (string)  : Tag category/scope (e.g., "Tier", "Environment")
 *     - u_value          (string)  : Tag value (e.g., "Production", "PCI")
 *     - u_display_name   (string)  : Human-readable display label
 *     - u_description    (string)  : Detailed description of the tag value
 *     - u_active         (boolean) : Whether the value is currently active
 *     - u_applicable_environments (string) : Comma-separated list of environments
 *     - u_applicable_tiers        (string) : Comma-separated list of tiers
 *     - u_requires_approval       (boolean): Whether selecting this value triggers approval
 *     - u_approval_group          (reference): Approval group sys_id
 *     - u_sort_order     (integer) : Display sort order
 *     - u_deprecated     (boolean) : Whether the value is deprecated (still valid but discouraged)
 *     - u_replacement    (string)  : Suggested replacement if deprecated
 *
 *   ServiceNow server-side globals used:
 *     - GlideRecord : Database query API
 *     - gs          : GlideSystem utilities
 *
 * @module servicenow/catalog/server-scripts/tagDictionaryLookup
 */

/* global GlideRecord, gs, Class, AbstractAjaxProcessor */

'use strict';

/**
 * @class TagDictionaryLookup
 * @extends AbstractAjaxProcessor
 * @classdesc Provides read-only access to the enterprise tag dictionary for
 *   tag value validation, metadata retrieval, and conflict rule lookups.
 *   Extends AbstractAjaxProcessor to support both server-side and
 *   GlideAjax client-side invocations.
 */
const TagDictionaryLookup = Class.create();

TagDictionaryLookup.prototype = Object.extendsObject(AbstractAjaxProcessor, {

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /**
     * Name of the enterprise tag dictionary table.
     * @constant {string}
     */
    TABLE_TAG_DICTIONARY: 'u_enterprise_tag_dictionary',

    /**
     * Name of the conflict rules table.
     * @constant {string}
     */
    TABLE_CONFLICT_RULES: 'u_tag_conflict_rules',

    // -----------------------------------------------------------------------
    // Public API — getTagValues
    // -----------------------------------------------------------------------

    /**
     * Returns all active tag values for a given category, ordered by sort order.
     *
     * @param {string} category - The tag category to query (e.g., "Tier",
     *   "Environment", "DataClassification", "Compliance").
     * @returns {Array.<{value: string, displayName: string, description: string, deprecated: boolean, replacement: string}>}
     *   Array of tag value objects. Empty array if category is invalid or has no values.
     *
     * @example
     * var lookup = new TagDictionaryLookup();
     * var tiers = lookup.getTagValues('Tier');
     * // => [
     * //   { value: 'Web', displayName: 'Web Tier', description: '...', deprecated: false, replacement: '' },
     * //   { value: 'App', displayName: 'Application Tier', description: '...', deprecated: false, replacement: '' },
     * //   ...
     * // ]
     */
    getTagValues: function (category) {
        if (!category || category.toString().trim() === '') {
            gs.warn('TagDictionaryLookup.getTagValues: category parameter is required');
            return [];
        }

        const results = [];
        const gr = new GlideRecord(this.TABLE_TAG_DICTIONARY);
        gr.addQuery('u_category', category.toString().trim());
        gr.addQuery('u_active', true);
        gr.orderBy('u_sort_order');
        gr.query();

        while (gr.next()) {
            results.push({
                value: gr.getValue('u_value') || '',
                displayName: gr.getValue('u_display_name') || gr.getValue('u_value') || '',
                description: gr.getValue('u_description') || '',
                deprecated: gr.getValue('u_deprecated') === 'true' || gr.getValue('u_deprecated') === '1',
                replacement: gr.getValue('u_replacement') || ''
            });
        }

        return results;
    },

    /**
     * AJAX-accessible wrapper for getTagValues.
     * Called via GlideAjax with sysparm_name = "getTagValuesAjax".
     *
     * @returns {string} JSON string of the tag values array.
     */
    getTagValuesAjax: function () {
        const category = this.getParameter('sysparm_category');
        const values = this.getTagValues(category);
        return JSON.stringify(values);
    },

    // -----------------------------------------------------------------------
    // Public API — validateTagValue
    // -----------------------------------------------------------------------

    /**
     * Checks if a specific value is valid (active and present) in the
     * enterprise tag dictionary for the given category.
     *
     * @param {string} category - The tag category to check.
     * @param {string} value    - The tag value to validate.
     * @returns {boolean} True if the value exists and is active in the dictionary.
     *
     * @example
     * var lookup = new TagDictionaryLookup();
     * var isValid = lookup.validateTagValue('Environment', 'Production');
     * // => true
     *
     * var isInvalid = lookup.validateTagValue('Environment', 'Staging-Old');
     * // => false
     */
    validateTagValue: function (category, value) {
        if (!category || !value) {
            return false;
        }

        const catStr = category.toString().trim();
        const valStr = value.toString().trim();

        if (catStr === '' || valStr === '') {
            return false;
        }

        const gr = new GlideRecord(this.TABLE_TAG_DICTIONARY);
        gr.addQuery('u_category', catStr);
        gr.addQuery('u_value', valStr);
        gr.addQuery('u_active', true);
        gr.setLimit(1);
        gr.query();

        return gr.hasNext();
    },

    /**
     * AJAX-accessible wrapper for validateTagValue.
     * Called via GlideAjax with sysparm_name = "validateTagValueAjax".
     *
     * @returns {string} "true" or "false".
     */
    validateTagValueAjax: function () {
        const category = this.getParameter('sysparm_category');
        const value = this.getParameter('sysparm_value');
        return this.validateTagValue(category, value).toString();
    },

    // -----------------------------------------------------------------------
    // Public API — getTagMetadata
    // -----------------------------------------------------------------------

    /**
     * Returns the full metadata record for a specific tag value in a category.
     * Includes applicable environments, tiers, approval requirements, and
     * deprecation status.
     *
     * @param {string} category - The tag category.
     * @param {string} value    - The tag value.
     * @returns {Object|null} Full metadata object, or null if not found.
     * @returns {string}   return.value                  - The tag value.
     * @returns {string}   return.displayName             - Human-readable display label.
     * @returns {string}   return.description             - Detailed description.
     * @returns {string}   return.category                - The tag category.
     * @returns {boolean}  return.active                  - Whether the value is active.
     * @returns {string[]} return.applicableEnvironments  - Environments where this value can be used.
     * @returns {string[]} return.applicableTiers          - Tiers where this value can be used.
     * @returns {boolean}  return.requiresApproval         - Whether this value triggers an approval workflow.
     * @returns {string}   return.approvalGroup            - Sys_id of the approval group (empty if no approval).
     * @returns {number}   return.sortOrder                - Display sort order.
     * @returns {boolean}  return.deprecated               - Whether the value is deprecated.
     * @returns {string}   return.replacement              - Suggested replacement value if deprecated.
     *
     * @example
     * var lookup = new TagDictionaryLookup();
     * var meta = lookup.getTagMetadata('Compliance', 'PCI');
     * // => {
     * //   value: 'PCI',
     * //   displayName: 'PCI DSS',
     * //   description: 'Payment Card Industry Data Security Standard',
     * //   category: 'Compliance',
     * //   active: true,
     * //   applicableEnvironments: ['Development', 'Staging', 'Production'],
     * //   applicableTiers: ['Web', 'App', 'Database'],
     * //   requiresApproval: true,
     * //   approvalGroup: 'a1b2c3d4...',
     * //   sortOrder: 10,
     * //   deprecated: false,
     * //   replacement: ''
     * // }
     */
    getTagMetadata: function (category, value) {
        if (!category || !value) {
            return null;
        }

        const catStr = category.toString().trim();
        const valStr = value.toString().trim();

        if (catStr === '' || valStr === '') {
            return null;
        }

        const gr = new GlideRecord(this.TABLE_TAG_DICTIONARY);
        gr.addQuery('u_category', catStr);
        gr.addQuery('u_value', valStr);
        gr.setLimit(1);
        gr.query();

        if (!gr.next()) {
            return null;
        }

        return {
            value: gr.getValue('u_value') || '',
            displayName: gr.getValue('u_display_name') || gr.getValue('u_value') || '',
            description: gr.getValue('u_description') || '',
            category: gr.getValue('u_category') || '',
            active: gr.getValue('u_active') === 'true' || gr.getValue('u_active') === '1',
            applicableEnvironments: this._parseCommaSeparated(
                gr.getValue('u_applicable_environments')
            ),
            applicableTiers: this._parseCommaSeparated(
                gr.getValue('u_applicable_tiers')
            ),
            requiresApproval: gr.getValue('u_requires_approval') === 'true' ||
                gr.getValue('u_requires_approval') === '1',
            approvalGroup: gr.getValue('u_approval_group') || '',
            sortOrder: parseInt(gr.getValue('u_sort_order') || '0', 10),
            deprecated: gr.getValue('u_deprecated') === 'true' ||
                gr.getValue('u_deprecated') === '1',
            replacement: gr.getValue('u_replacement') || ''
        };
    },

    /**
     * AJAX-accessible wrapper for getTagMetadata.
     * Called via GlideAjax with sysparm_name = "getTagMetadataAjax".
     *
     * @returns {string} JSON string of the metadata object, or "null".
     */
    getTagMetadataAjax: function () {
        const category = this.getParameter('sysparm_category');
        const value = this.getParameter('sysparm_value');
        const meta = this.getTagMetadata(category, value);
        return JSON.stringify(meta);
    },

    // -----------------------------------------------------------------------
    // Public API — getConflictRules
    // -----------------------------------------------------------------------

    /**
     * Returns all active conflict rules from the u_tag_conflict_rules table.
     * Each rule defines a pair of tag category/value combinations that are
     * mutually exclusive.
     *
     * @returns {Array.<{
     *   sysId: string,
     *   category1: string,
     *   value1: string,
     *   category2: string,
     *   value2: string,
     *   errorMessage: string,
     *   errorCode: string,
     *   active: boolean
     * }>} Array of conflict rule objects.
     *
     * @example
     * var lookup = new TagDictionaryLookup();
     * var rules = lookup.getConflictRules();
     * // => [
     * //   {
     * //     sysId: 'abc123...',
     * //     category1: 'Compliance',
     * //     value1: 'PCI',
     * //     category2: 'Environment',
     * //     value2: 'Sandbox',
     * //     errorMessage: 'PCI workloads cannot be in Sandbox',
     * //     errorCode: 'DFW-4003',
     * //     active: true
     * //   },
     * //   ...
     * // ]
     */
    getConflictRules: function () {
        const rules = [];

        const gr = new GlideRecord(this.TABLE_CONFLICT_RULES);
        gr.addQuery('u_active', true);
        gr.orderBy('u_error_code');
        gr.query();

        while (gr.next()) {
            rules.push({
                sysId: gr.getUniqueValue(),
                category1: gr.getValue('u_category_1') || '',
                value1: gr.getValue('u_value_1') || '',
                category2: gr.getValue('u_category_2') || '',
                value2: gr.getValue('u_value_2') || '',
                errorMessage: gr.getValue('u_error_message') || '',
                errorCode: gr.getValue('u_error_code') || '',
                active: true
            });
        }

        return rules;
    },

    /**
     * AJAX-accessible wrapper for getConflictRules.
     * Called via GlideAjax with sysparm_name = "getConflictRulesAjax".
     *
     * @returns {string} JSON string of the conflict rules array.
     */
    getConflictRulesAjax: function () {
        const rules = this.getConflictRules();
        return JSON.stringify(rules);
    },

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Parses a comma-separated string into a trimmed array of non-empty strings.
     *
     * @private
     * @param {string|null} str - The comma-separated string to parse.
     * @returns {string[]} Array of trimmed, non-empty values.
     */
    _parseCommaSeparated: function (str) {
        if (!str || str.toString().trim() === '') {
            return [];
        }

        const parts = str.toString().split(',');
        const result = [];

        for (let i = 0; i < parts.length; i++) {
            const trimmed = parts[i].trim();
            if (trimmed !== '') {
                result.push(trimmed);
            }
        }

        return result;
    },

    /**
     * Type identifier for ServiceNow Script Include framework.
     * @type {string}
     */
    type: 'TagDictionaryLookup'
});
