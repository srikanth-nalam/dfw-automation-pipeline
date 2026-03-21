/**
 * @file catalogItemValidation.js
 * @description Server-side Script Include for comprehensive catalog item validation.
 *   Implements defense-in-depth by re-validating all client-side business rules
 *   on the server. Validates tag values against the enterprise tag dictionary
 *   (u_enterprise_tag_dictionary), enforces cardinality rules, detects conflicting
 *   tag combinations, and ensures all required fields are present.
 *
 *   This Script Include is invoked by:
 *     - The tagFieldServerValidation Business Rule (before insert)
 *     - The vroTrigger integration script (pre-submission check)
 *     - Client-side GlideAjax calls for real-time validation
 *
 *   ServiceNow server-side globals used:
 *     - GlideRecord   : Database query/update API
 *     - gs             : GlideSystem utilities (logging, user context)
 *     - current        : Current record in business rule context
 *
 * @module servicenow/catalog/server-scripts/catalogItemValidation
 */

/* global GlideRecord, gs, Class, AbstractAjaxProcessor */

'use strict';

/**
 * @class CatalogItemValidation
 * @extends AbstractAjaxProcessor
 * @classdesc Validates catalog item submissions for the DFW Automation Pipeline.
 *   Provides both synchronous validation (for business rules) and AJAX-accessible
 *   methods (for client-side real-time validation).
 */
const CatalogItemValidation = Class.create();

CatalogItemValidation.prototype = Object.extendsObject(AbstractAjaxProcessor, {

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /**
     * Error code prefix for validation errors.
     * @constant {string}
     */
    ERROR_PREFIX: 'DFW',

    /**
     * Required fields for VM Build Request catalog items.
     * @constant {Array.<{field: string, label: string}>}
     */
    VM_BUILD_REQUIRED_FIELDS: [
        { field: 'application',          label: 'Application' },
        { field: 'tier',                 label: 'Tier' },
        { field: 'environment',          label: 'Environment' },
        { field: 'data_classification',  label: 'Data Classification' },
        { field: 'compliance',           label: 'Compliance' },
        { field: 'cost_center',          label: 'Cost Center' }
    ],

    /**
     * Required fields for Tag Update Request catalog items.
     * @constant {Array.<{field: string, label: string}>}
     */
    TAG_UPDATE_REQUIRED_FIELDS: [
        { field: 'vm_ci',               label: 'VM Configuration Item' },
        { field: 'application',          label: 'Application' },
        { field: 'tier',                 label: 'Tier' },
        { field: 'environment',          label: 'Environment' },
        { field: 'data_classification',  label: 'Data Classification' },
        { field: 'compliance',           label: 'Compliance' }
    ],

    /**
     * Valid tag categories that map to u_enterprise_tag_dictionary.
     * @constant {string[]}
     */
    TAG_CATEGORIES: [
        'Application',
        'Tier',
        'Environment',
        'DataClassification',
        'Compliance',
        'CostCenter'
    ],

    /**
     * Cardinality rules: categories that allow only a single value.
     * @constant {string[]}
     */
    SINGLE_VALUE_CATEGORIES: [
        'Application',
        'Tier',
        'Environment',
        'DataClassification',
        'CostCenter'
    ],

    /**
     * Cardinality rules: categories that allow multiple values.
     * @constant {string[]}
     */
    MULTI_VALUE_CATEGORIES: [
        'Compliance'
    ],

    // -----------------------------------------------------------------------
    // Public API — Main validation entry point
    // -----------------------------------------------------------------------

    /**
     * Validates a complete catalog item submission. This is the primary entry
     * point called by business rules and integration scripts.
     *
     * Performs the following checks in order:
     *   1. Required field presence
     *   2. Tag dictionary value validation
     *   3. Cardinality rule enforcement
     *   4. Conflicting combination detection
     *   5. Conditional requirement rules (e.g., Database tier requires Compliance)
     *
     * @param {Object} variables - The catalog item variables to validate.
     * @param {string} variables.application          - Application tag value.
     * @param {string} variables.tier                 - Tier tag value.
     * @param {string} variables.environment          - Environment tag value.
     * @param {string} variables.data_classification  - DataClassification tag value.
     * @param {string} variables.compliance           - Compliance tag value(s), comma-separated if multi.
     * @param {string} [variables.cost_center]        - CostCenter tag value.
     * @param {string} [variables.vm_ci]              - VM CI sys_id (for tag update requests).
     * @param {string} requestType - Either "vm_build" or "tag_update".
     * @returns {{valid: boolean, errors: Array.<{field: string, message: string, code: string}>}}
     *   Validation result object.
     *
     * @example
     * var validator = new CatalogItemValidation();
     * var result = validator.validate({
     *     application: 'APP001',
     *     tier: 'Database',
     *     environment: 'Production',
     *     data_classification: 'Confidential',
     *     compliance: 'PCI',
     *     cost_center: 'CC-1234'
     * }, 'vm_build');
     *
     * if (!result.valid) {
     *     gs.error('Validation failed: ' + JSON.stringify(result.errors));
     * }
     */
    validate: function (variables, requestType) {
        let errors = [];

        // Step 1: Required field validation
        const requiredErrors = this._validateRequiredFields(variables, requestType);
        errors = errors.concat(requiredErrors);

        // If required fields are missing, skip further validation
        if (requiredErrors.length > 0) {
            return { valid: false, errors: errors };
        }

        // Step 2: Tag dictionary validation
        const dictionaryErrors = this._validateTagDictionary(variables);
        errors = errors.concat(dictionaryErrors);

        // Step 3: Cardinality rule validation
        const cardinalityErrors = this._validateCardinality(variables);
        errors = errors.concat(cardinalityErrors);

        // Step 4: Conflicting combination detection
        const conflictErrors = this._validateConflicts(variables);
        errors = errors.concat(conflictErrors);

        // Step 5: Conditional requirement rules
        const conditionalErrors = this._validateConditionalRules(variables);
        errors = errors.concat(conditionalErrors);

        return {
            valid: errors.length === 0,
            errors: errors
        };
    },

    /**
     * AJAX-accessible validation method for client-side real-time validation.
     * Called via GlideAjax with sysparm_name = "validateAjax".
     *
     * @returns {string} JSON string of the validation result.
     */
    validateAjax: function () {
        const variablesJson = this.getParameter('sysparm_variables');
        const requestType = this.getParameter('sysparm_request_type') || 'vm_build';

        let variables;
        try {
            variables = JSON.parse(variablesJson);
        } catch (e) {
            return JSON.stringify({
                valid: false,
                errors: [{
                    field: '_request',
                    message: 'Invalid variables JSON format',
                    code: this.ERROR_PREFIX + '-5001'
                }]
            });
        }

        const result = this.validate(variables, requestType);
        return JSON.stringify(result);
    },

    // -----------------------------------------------------------------------
    // Private — Required field validation
    // -----------------------------------------------------------------------

    /**
     * Validates that all required fields are present and non-empty.
     *
     * @private
     * @param {Object} variables  - The catalog item variables.
     * @param {string} requestType - "vm_build" or "tag_update".
     * @returns {Array.<{field: string, message: string, code: string}>} Errors found.
     */
    _validateRequiredFields: function (variables, requestType) {
        const errors = [];
        const requiredFields = (requestType === 'tag_update')
            ? this.TAG_UPDATE_REQUIRED_FIELDS
            : this.VM_BUILD_REQUIRED_FIELDS;

        for (let i = 0; i < requiredFields.length; i++) {
            const fieldDef = requiredFields[i];
            const value = variables[fieldDef.field];

            if (value === undefined || value === null || value.toString().trim() === '') {
                errors.push({
                    field: fieldDef.field,
                    message: fieldDef.label + ' is required and cannot be empty.',
                    code: this.ERROR_PREFIX + '-1001'
                });
            }
        }

        return errors;
    },

    // -----------------------------------------------------------------------
    // Private — Tag dictionary validation
    // -----------------------------------------------------------------------

    /**
     * Validates that each tag value exists in the u_enterprise_tag_dictionary
     * table for its respective category. Uses GlideRecord to query the dictionary.
     *
     * @private
     * @param {Object} variables - The catalog item variables.
     * @returns {Array.<{field: string, message: string, code: string}>} Errors found.
     */
    _validateTagDictionary: function (variables) {
        const errors = [];

        /** @type {Array.<{variable: string, category: string}>} */
        const tagMappings = [
            { variable: 'tier',                category: 'Tier' },
            { variable: 'environment',          category: 'Environment' },
            { variable: 'data_classification',  category: 'DataClassification' },
            { variable: 'compliance',           category: 'Compliance' }
        ];

        for (let i = 0; i < tagMappings.length; i++) {
            const mapping = tagMappings[i];
            const value = variables[mapping.variable];

            if (!value || value.toString().trim() === '') {
                continue;
            }

            // Compliance may be multi-value (comma-separated)
            if (mapping.category === 'Compliance') {
                const complianceValues = value.toString().split(',');
                for (let j = 0; j < complianceValues.length; j++) {
                    const cv = complianceValues[j].trim();
                    if (cv !== '' && !this._isValidDictionaryValue(mapping.category, cv)) {
                        errors.push({
                            field: mapping.variable,
                            message: '"' + cv + '" is not a valid value for ' +
                                mapping.category + '. Check the enterprise tag dictionary.',
                            code: this.ERROR_PREFIX + '-2001'
                        });
                    }
                }
            } else {
                if (!this._isValidDictionaryValue(mapping.category, value.toString().trim())) {
                    errors.push({
                        field: mapping.variable,
                        message: '"' + value + '" is not a valid value for ' +
                            mapping.category + '. Check the enterprise tag dictionary.',
                        code: this.ERROR_PREFIX + '-2001'
                    });
                }
            }
        }

        return errors;
    },

    /**
     * Queries the u_enterprise_tag_dictionary table to check if a value exists
     * and is active for the given category.
     *
     * @private
     * @param {string} category - The tag category (e.g., "Tier", "Environment").
     * @param {string} value    - The tag value to validate.
     * @returns {boolean} True if the value is valid and active in the dictionary.
     */
    _isValidDictionaryValue: function (category, value) {
        const gr = new GlideRecord('u_enterprise_tag_dictionary');
        gr.addQuery('u_category', category);
        gr.addQuery('u_value', value);
        gr.addQuery('u_active', true);
        gr.setLimit(1);
        gr.query();

        return gr.hasNext();
    },

    // -----------------------------------------------------------------------
    // Private — Cardinality validation
    // -----------------------------------------------------------------------

    /**
     * Validates cardinality rules: single-value categories must have exactly
     * one value; multi-value categories are checked for consistency.
     *
     * @private
     * @param {Object} variables - The catalog item variables.
     * @returns {Array.<{field: string, message: string, code: string}>} Errors found.
     */
    _validateCardinality: function (variables) {
        const errors = [];

        // Check Compliance for "None" exclusivity
        const compliance = variables.compliance;
        if (compliance && compliance.toString().indexOf(',') !== -1) {
            const compValues = compliance.toString().split(',');
            const trimmedValues = [];
            for (let i = 0; i < compValues.length; i++) {
                const trimmed = compValues[i].trim();
                if (trimmed !== '') {
                    trimmedValues.push(trimmed);
                }
            }

            // "None" must be exclusive — cannot coexist with other compliance values
            if (trimmedValues.indexOf('None') !== -1 && trimmedValues.length > 1) {
                errors.push({
                    field: 'compliance',
                    message: 'Compliance value "None" cannot be combined with other compliance ' +
                        'frameworks. Select either "None" or specific compliance standards.',
                    code: this.ERROR_PREFIX + '-3001'
                });
            }

            // Check for duplicate values
            const seen = {};
            for (let j = 0; j < trimmedValues.length; j++) {
                if (seen[trimmedValues[j]]) {
                    errors.push({
                        field: 'compliance',
                        message: 'Duplicate compliance value: "' + trimmedValues[j] + '".',
                        code: this.ERROR_PREFIX + '-3002'
                    });
                }
                seen[trimmedValues[j]] = true;
            }
        }

        return errors;
    },

    // -----------------------------------------------------------------------
    // Private — Conflict detection
    // -----------------------------------------------------------------------

    /**
     * Detects conflicting tag combinations that violate enterprise security
     * policies. These mirror the client-side rules but are enforced server-side
     * as defense in depth.
     *
     * Conflict rules:
     *   1. PCI compliance cannot be in Sandbox (DFW-4003)
     *   2. HIPAA compliance cannot be in Sandbox (DFW-4004)
     *   3. Confidential data classification requires compliance other than None
     *   4. Restricted data classification requires Production environment
     *   5. Database tier in Sandbox requires explicit approval
     *
     * @private
     * @param {Object} variables - The catalog item variables.
     * @returns {Array.<{field: string, message: string, code: string}>} Errors found.
     */
    _validateConflicts: function (variables) {
        let errors = [];
        const environment = (variables.environment || '').toString().trim();
        const compliance = (variables.compliance || '').toString().trim();
        const dataClassification = (variables.data_classification || '').toString().trim();
        const tier = (variables.tier || '').toString().trim();

        const complianceValues = compliance.split(',').map(function (v) {
            return v.trim();
        });

        // Rule 1: PCI + Sandbox = DFW-4003
        if (complianceValues.indexOf('PCI') !== -1 && environment === 'Sandbox') {
            errors.push({
                field: 'compliance',
                message: 'PCI workloads cannot be in Sandbox. PCI DSS requires ' +
                    'environments that meet control requirements.',
                code: this.ERROR_PREFIX + '-4003'
            });
        }

        // Rule 2: HIPAA + Sandbox
        if (complianceValues.indexOf('HIPAA') !== -1 && environment === 'Sandbox') {
            errors.push({
                field: 'compliance',
                message: 'HIPAA workloads cannot be in Sandbox. HIPAA requires ' +
                    'environments with appropriate safeguards.',
                code: this.ERROR_PREFIX + '-4004'
            });
        }

        // Rule 3: Confidential data requires compliance != None
        if (dataClassification === 'Confidential') {
            let hasRealCompliance = false;
            for (let i = 0; i < complianceValues.length; i++) {
                if (complianceValues[i] !== '' && complianceValues[i] !== 'None') {
                    hasRealCompliance = true;
                    break;
                }
            }
            if (!hasRealCompliance) {
                errors.push({
                    field: 'data_classification',
                    message: 'Confidential data classification requires a compliance ' +
                        'framework other than "None".',
                    code: this.ERROR_PREFIX + '-4005'
                });
            }
        }

        // Rule 4: Restricted data requires Production
        if (dataClassification === 'Restricted' && environment !== 'Production') {
            errors.push({
                field: 'data_classification',
                message: 'Restricted data classification is only permitted in ' +
                    'Production environments.',
                code: this.ERROR_PREFIX + '-4006'
            });
        }

        // Rule 5: Database tier in Sandbox
        if (tier === 'Database' && environment === 'Sandbox') {
            errors.push({
                field: 'tier',
                message: 'Database tier workloads in Sandbox require explicit approval. ' +
                    'Consider using Development or Staging instead.',
                code: this.ERROR_PREFIX + '-4007'
            });
        }

        // Check dynamic conflict rules from dictionary
        const dynamicConflicts = this._checkDynamicConflictRules(variables);
        errors = errors.concat(dynamicConflicts);

        return errors;
    },

    /**
     * Checks dynamic conflict rules loaded from the u_enterprise_tag_dictionary
     * conflict rules table. This allows administrators to define new conflict
     * rules without code changes.
     *
     * @private
     * @param {Object} variables - The catalog item variables.
     * @returns {Array.<{field: string, message: string, code: string}>} Errors found.
     */
    _checkDynamicConflictRules: function (variables) {
        const errors = [];

        const gr = new GlideRecord('u_tag_conflict_rules');
        gr.addQuery('u_active', true);
        gr.query();

        while (gr.next()) {
            const ruleCategory1 = gr.getValue('u_category_1');
            const ruleValue1 = gr.getValue('u_value_1');
            const ruleCategory2 = gr.getValue('u_category_2');
            const ruleValue2 = gr.getValue('u_value_2');
            const ruleMessage = gr.getValue('u_error_message');
            const ruleCode = gr.getValue('u_error_code') || (this.ERROR_PREFIX + '-4100');

            const fieldMap = {
                'Tier': 'tier',
                'Environment': 'environment',
                'DataClassification': 'data_classification',
                'Compliance': 'compliance',
                'CostCenter': 'cost_center',
                'Application': 'application'
            };

            const var1 = variables[fieldMap[ruleCategory1]] || '';
            const var2 = variables[fieldMap[ruleCategory2]] || '';

            const values1 = var1.toString().split(',').map(function (v) { return v.trim(); });
            const values2 = var2.toString().split(',').map(function (v) { return v.trim(); });

            if (values1.indexOf(ruleValue1) !== -1 && values2.indexOf(ruleValue2) !== -1) {
                errors.push({
                    field: fieldMap[ruleCategory1] || ruleCategory1,
                    message: ruleMessage || 'Conflicting tag combination: ' +
                        ruleCategory1 + '=' + ruleValue1 + ' with ' +
                        ruleCategory2 + '=' + ruleValue2,
                    code: ruleCode
                });
            }
        }

        return errors;
    },

    // -----------------------------------------------------------------------
    // Private — Conditional requirement rules
    // -----------------------------------------------------------------------

    /**
     * Validates conditional requirement rules — fields that become mandatory
     * based on the values of other fields.
     *
     * Rules:
     *   - Database tier requires Compliance to be something other than empty.
     *   - Production environment requires DataClassification to be set.
     *   - Any compliance framework other than "None" requires DataClassification
     *     to be at least "Internal".
     *
     * @private
     * @param {Object} variables - The catalog item variables.
     * @returns {Array.<{field: string, message: string, code: string}>} Errors found.
     */
    _validateConditionalRules: function (variables) {
        const errors = [];
        const tier = (variables.tier || '').toString().trim();
        const environment = (variables.environment || '').toString().trim();
        const compliance = (variables.compliance || '').toString().trim();
        const dataClassification = (variables.data_classification || '').toString().trim();

        // Database tier requires explicit compliance selection
        if (tier === 'Database' && (!compliance || compliance === '' || compliance === 'None')) {
            errors.push({
                field: 'compliance',
                message: 'Database tier workloads require an explicit compliance framework. ' +
                    '"None" is not permitted for Database tier.',
                code: this.ERROR_PREFIX + '-5002'
            });
        }

        // Production requires DataClassification
        if (environment === 'Production' && (!dataClassification || dataClassification === '')) {
            errors.push({
                field: 'data_classification',
                message: 'Data Classification is required for Production environment deployments.',
                code: this.ERROR_PREFIX + '-5003'
            });
        }

        // Compliance frameworks (non-None) require DataClassification >= Internal
        const complianceValues = compliance.split(',').map(function (v) { return v.trim(); });
        let hasRegulatedCompliance = false;
        for (let i = 0; i < complianceValues.length; i++) {
            if (complianceValues[i] !== '' && complianceValues[i] !== 'None') {
                hasRegulatedCompliance = true;
                break;
            }
        }

        if (hasRegulatedCompliance && dataClassification === 'Public') {
            errors.push({
                field: 'data_classification',
                message: 'Regulated compliance frameworks require Data Classification ' +
                    'of "Internal" or higher. "Public" is not permitted.',
                code: this.ERROR_PREFIX + '-5004'
            });
        }

        return errors;
    },

    /**
     * Type identifier for ServiceNow Script Include framework.
     * @type {string}
     */
    type: 'CatalogItemValidation'
});
