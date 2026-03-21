/**
 * @fileoverview Before-Insert Business Rule - Tag Field Server Validation
 * @description Validates all mandatory tag fields before RITM creation.
 * Runs server-side as defense-in-depth against client-side bypass.
 *
 * Validation steps:
 *   1. Validates all mandatory tag fields are present and non-empty
 *   2. Validates tag values against Enterprise Tag Dictionary (u_enterprise_tag_dictionary)
 *   3. Validates conflicting tag combinations (PCI+Sandbox, HIPAA+Sandbox, etc.)
 *   4. On failure: current.setAbortAction(true) with detailed error message
 *
 * Business Rule Configuration:
 *   Table: sc_req_item
 *   When: Before Insert
 *   Order: 100
 *   Active: true
 *   Condition: current.cat_item references a DFW-enabled catalog item
 *
 * ServiceNow server-side globals used:
 *   - GlideRecord   : Database query/update API
 *   - gs            : GlideSystem utilities
 *   - current       : Current record being inserted
 *   - previous      : Previous record (null for inserts)
 *
 * @module servicenow/business-rules/tagFieldServerValidation
 */

/* global GlideRecord, gs, current, previous */

(function executeRule(current, previous) {
    'use strict';

    // -----------------------------------------------------------------------
    // Constants - Valid value enumerations
    // -----------------------------------------------------------------------

    const VALID_ENVIRONMENTS = ['Production', 'Pre-Production', 'UAT', 'Staging', 'Development', 'Sandbox', 'DR'];
    const VALID_TIERS = ['Web', 'Application', 'Database', 'Middleware', 'Utility', 'Shared-Services'];
    const VALID_COMPLIANCE = ['PCI', 'HIPAA', 'SOX', 'None'];
    const VALID_DATA_CLASSIFICATIONS = ['Public', 'Internal', 'Confidential', 'Restricted'];
    const VALID_SITES = ['NDCNG', 'TULNG'];

    /**
     * Mandatory tag fields with their display labels.
     * @type {Array.<{field: string, label: string}>}
     */
    const MANDATORY_FIELDS = [
        { field: 'application',         label: 'Application' },
        { field: 'tier',                label: 'Tier' },
        { field: 'environment',         label: 'Environment' },
        { field: 'compliance',          label: 'Compliance' },
        { field: 'data_classification', label: 'Data Classification' },
        { field: 'site',               label: 'Site' }
    ];

    const errors = [];

    // -----------------------------------------------------------------------
    // Helper functions
    // -----------------------------------------------------------------------

    /**
     * Safely extracts a variable value from the current record.
     * @param {string} fieldName - The variable field name.
     * @returns {string} The trimmed value, or empty string if not present.
     */
    function getVariable(fieldName) {
        if (current.variables[fieldName]) {
            return current.variables[fieldName].toString().trim();
        }
        return '';
    }

    /**
     * Validates that a tag value exists and is active in the Enterprise
     * Tag Dictionary (u_enterprise_tag_dictionary).
     *
     * @param {string} category - Tag category name (e.g., 'Tier', 'Environment')
     * @param {string} value    - Tag value to validate
     * @returns {boolean} True if the value exists and is active in the dictionary
     */
    function validateAgainstDictionary(category, value) {
        const gr = new GlideRecord('u_enterprise_tag_dictionary');
        gr.addQuery('u_category', category);
        gr.addQuery('u_value', value);
        gr.addQuery('u_active', true);
        gr.setLimit(1);
        gr.query();
        return gr.hasNext();
    }

    // -----------------------------------------------------------------------
    // Step 1: Validate mandatory fields are present and non-empty
    // -----------------------------------------------------------------------

    function validateMandatoryFields() {
        for (let i = 0; i < MANDATORY_FIELDS.length; i++) {
            const fieldDef = MANDATORY_FIELDS[i];
            const value = getVariable(fieldDef.field);

            if (!value || value === '') {
                errors.push({
                    field: fieldDef.field,
                    message: fieldDef.label + ' is a required field and cannot be empty.',
                    code: 'DFW-4001'
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Step 2: Validate tag values against Enterprise Tag Dictionary
    // -----------------------------------------------------------------------

    function validateTagDictionaryValues() {
        const application = getVariable('application');
        const tier = getVariable('tier');
        const environment = getVariable('environment');
        const compliance = getVariable('compliance');
        const dataClassification = getVariable('data_classification');
        const site = getVariable('site');

        // Validate Site against allowed values
        if (site && VALID_SITES.indexOf(site) === -1) {
            errors.push({
                field: 'site',
                message: 'Invalid site value: "' + site + '". Must be one of: ' + VALID_SITES.join(', '),
                code: 'DFW-4004'
            });
        }

        // Validate Environment against enum and dictionary
        if (environment) {
            if (VALID_ENVIRONMENTS.indexOf(environment) === -1) {
                errors.push({
                    field: 'environment',
                    message: '"' + environment + '" is not a valid Environment value. Check the enterprise tag dictionary.',
                    code: 'DFW-4002'
                });
            } else if (!validateAgainstDictionary('Environment', environment)) {
                errors.push({
                    field: 'environment',
                    message: 'Environment "' + environment + '" not found or inactive in Enterprise Tag Dictionary.',
                    code: 'DFW-4002'
                });
            }
        }

        // Validate Tier against enum and dictionary
        if (tier) {
            if (VALID_TIERS.indexOf(tier) === -1) {
                errors.push({
                    field: 'tier',
                    message: '"' + tier + '" is not a valid Tier value. Check the enterprise tag dictionary.',
                    code: 'DFW-4002'
                });
            } else if (!validateAgainstDictionary('Tier', tier)) {
                errors.push({
                    field: 'tier',
                    message: 'Tier "' + tier + '" not found or inactive in Enterprise Tag Dictionary.',
                    code: 'DFW-4002'
                });
            }
        }

        // Validate Data Classification against enum and dictionary
        if (dataClassification) {
            if (VALID_DATA_CLASSIFICATIONS.indexOf(dataClassification) === -1) {
                errors.push({
                    field: 'data_classification',
                    message: '"' + dataClassification + '" is not a valid Data Classification value.',
                    code: 'DFW-4002'
                });
            } else if (!validateAgainstDictionary('DataClassification', dataClassification)) {
                errors.push({
                    field: 'data_classification',
                    message: 'Data Classification "' + dataClassification + '" not found or inactive in Enterprise Tag Dictionary.',
                    code: 'DFW-4002'
                });
            }
        }

        // Validate Compliance values (comma-separated, multi-value)
        if (compliance) {
            const complianceValues = compliance.split(',');
            for (let i = 0; i < complianceValues.length; i++) {
                const cv = complianceValues[i].trim();
                if (cv === '') { continue; }

                if (VALID_COMPLIANCE.indexOf(cv) === -1) {
                    errors.push({
                        field: 'compliance',
                        message: '"' + cv + '" is not a valid Compliance value. Must be one of: ' + VALID_COMPLIANCE.join(', '),
                        code: 'DFW-4002'
                    });
                } else if (!validateAgainstDictionary('Compliance', cv)) {
                    errors.push({
                        field: 'compliance',
                        message: 'Compliance "' + cv + '" not found or inactive in Enterprise Tag Dictionary.',
                        code: 'DFW-4002'
                    });
                }
            }
        }

        // Validate Application against dictionary (no fixed enum - dynamic values)
        if (application && !validateAgainstDictionary('Application', application)) {
            errors.push({
                field: 'application',
                message: 'Application "' + application + '" not found in Enterprise Tag Dictionary. Register the application code before submitting.',
                code: 'DFW-4002'
            });
        }
    }

    // -----------------------------------------------------------------------
    // Step 3: Validate conflicting tag combinations
    // -----------------------------------------------------------------------

    function validateConflictingCombinations() {
        const environment = getVariable('environment');
        const compliance = getVariable('compliance');
        const dataClassification = getVariable('data_classification');
        const tier = getVariable('tier');

        const complianceValues = compliance ? compliance.split(',').map(function (v) { return v.trim(); }) : [];

        // Rule 1: PCI compliance cannot be in Sandbox
        if (complianceValues.indexOf('PCI') > -1 && environment === 'Sandbox') {
            errors.push({
                field: 'compliance',
                message: 'PCI workloads cannot be placed in Sandbox environment. PCI DSS requires environments that meet control requirements.',
                code: 'DFW-4003'
            });
        }

        // Rule 2: HIPAA compliance cannot be in Sandbox
        if (complianceValues.indexOf('HIPAA') > -1 && environment === 'Sandbox') {
            errors.push({
                field: 'compliance',
                message: 'HIPAA workloads cannot be placed in Sandbox environment. HIPAA requires environments with appropriate safeguards.',
                code: 'DFW-4003'
            });
        }

        // Rule 3: SOX compliance cannot be in Sandbox or Development
        if (complianceValues.indexOf('SOX') > -1 &&
            (environment === 'Sandbox' || environment === 'Development')) {
            errors.push({
                field: 'compliance',
                message: 'SOX workloads cannot be placed in ' + environment + ' environment.',
                code: 'DFW-4003'
            });
        }

        // Rule 4: "None" compliance is mutually exclusive with other compliance values
        if (complianceValues.indexOf('None') > -1 && complianceValues.length > 1) {
            errors.push({
                field: 'compliance',
                message: 'Compliance value "None" cannot be combined with other compliance frameworks. Select either "None" or specific compliance standards.',
                code: 'DFW-4003'
            });
        }

        // Rule 5: Duplicate compliance values
        const seenCompliance = {};
        for (let i = 0; i < complianceValues.length; i++) {
            if (complianceValues[i] && seenCompliance[complianceValues[i]]) {
                errors.push({
                    field: 'compliance',
                    message: 'Duplicate compliance value: "' + complianceValues[i] + '".',
                    code: 'DFW-4003'
                });
            }
            seenCompliance[complianceValues[i]] = true;
        }

        // Rule 6: Confidential data classification requires compliance other than None
        if (dataClassification === 'Confidential') {
            let hasRealCompliance = false;
            for (let j = 0; j < complianceValues.length; j++) {
                if (complianceValues[j] !== '' && complianceValues[j] !== 'None') {
                    hasRealCompliance = true;
                    break;
                }
            }
            if (!hasRealCompliance) {
                errors.push({
                    field: 'data_classification',
                    message: 'Confidential data classification requires a compliance framework other than "None".',
                    code: 'DFW-4003'
                });
            }
        }

        // Rule 7: Restricted data classification requires Production environment
        if (dataClassification === 'Restricted' && environment !== 'Production') {
            errors.push({
                field: 'data_classification',
                message: 'Restricted data classification is only permitted in Production environments.',
                code: 'DFW-4003'
            });
        }

        // Rule 8: Database tier in Sandbox requires explicit approval
        if (tier === 'Database' && environment === 'Sandbox') {
            errors.push({
                field: 'tier',
                message: 'Database tier workloads in Sandbox require explicit approval. Consider using Development or Staging instead.',
                code: 'DFW-4003'
            });
        }

        // Rule 9: Database tier requires explicit compliance selection (not None)
        if (tier === 'Database' && (!compliance || compliance === '' || compliance === 'None')) {
            errors.push({
                field: 'compliance',
                message: 'Database tier workloads require an explicit compliance framework. "None" is not permitted for Database tier.',
                code: 'DFW-4003'
            });
        }

        // Rule 10: Regulated compliance frameworks require DataClassification >= Internal
        let hasRegulatedCompliance = false;
        for (let k = 0; k < complianceValues.length; k++) {
            if (complianceValues[k] !== '' && complianceValues[k] !== 'None') {
                hasRegulatedCompliance = true;
                break;
            }
        }
        if (hasRegulatedCompliance && dataClassification === 'Public') {
            errors.push({
                field: 'data_classification',
                message: 'Regulated compliance frameworks require Data Classification of "Internal" or higher. "Public" is not permitted.',
                code: 'DFW-4003'
            });
        }

        // Check dynamic conflict rules from u_tag_conflict_rules table
        validateDynamicConflictRules();
    }

    /**
     * Checks dynamic conflict rules loaded from the u_tag_conflict_rules table.
     * Allows administrators to define new conflict rules without code changes.
     */
    function validateDynamicConflictRules() {
        const fieldMap = {
            'Tier': 'tier',
            'Environment': 'environment',
            'DataClassification': 'data_classification',
            'Compliance': 'compliance',
            'CostCenter': 'cost_center',
            'Application': 'application'
        };

        const gr = new GlideRecord('u_tag_conflict_rules');
        gr.addQuery('u_active', true);
        gr.query();

        while (gr.next()) {
            const ruleCategory1 = gr.getValue('u_category_1');
            const ruleValue1 = gr.getValue('u_value_1');
            const ruleCategory2 = gr.getValue('u_category_2');
            const ruleValue2 = gr.getValue('u_value_2');
            const ruleMessage = gr.getValue('u_error_message');
            const ruleCode = gr.getValue('u_error_code') || 'DFW-4100';

            const var1 = getVariable(fieldMap[ruleCategory1] || '');
            const var2 = getVariable(fieldMap[ruleCategory2] || '');

            if (!var1 || !var2) { continue; }

            const values1 = var1.split(',').map(function (v) { return v.trim(); });
            const values2 = var2.split(',').map(function (v) { return v.trim(); });

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
    }

    // -----------------------------------------------------------------------
    // Execute all validation steps
    // -----------------------------------------------------------------------

    validateMandatoryFields();

    // Only proceed to value/conflict validation if all mandatory fields are present
    if (errors.length === 0) {
        validateTagDictionaryValues();
        validateConflictingCombinations();
    }

    // -----------------------------------------------------------------------
    // Abort action if any errors found
    // -----------------------------------------------------------------------

    if (errors.length > 0) {
        const errorMessages = errors.map(function (e) {
            return '[' + e.code + '] ' + e.field + ': ' + e.message;
        }).join('\n');

        current.setAbortAction(true);
        gs.addErrorMessage('DFW Tag Validation Failed:\n' + errorMessages);
        gs.log('DFW Tag Validation Failed for RITM ' +
            (current.getValue('number') || 'NEW') + ':\n' + errorMessages,
            'DFW.TagValidation');
    }

})(current, previous);

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VALID_ENVIRONMENTS: ['Production', 'Pre-Production', 'UAT', 'Staging', 'Development', 'Sandbox', 'DR'],
        VALID_TIERS: ['Web', 'Application', 'Database', 'Middleware', 'Utility', 'Shared-Services'],
        VALID_COMPLIANCE: ['PCI', 'HIPAA', 'SOX', 'None'],
        VALID_DATA_CLASSIFICATIONS: ['Public', 'Internal', 'Confidential', 'Restricted'],
        VALID_SITES: ['NDCNG', 'TULNG']
    };
}
