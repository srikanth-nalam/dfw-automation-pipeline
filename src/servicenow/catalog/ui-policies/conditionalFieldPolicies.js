/**
 * @file conditionalFieldPolicies.js
 * @description UI Policy configurations as code for the DFW Automation Pipeline
 *   catalog items. Defines conditional field visibility, mandatory status,
 *   read-only flags, and default values based on form state.
 *
 *   These policy definitions are exportable and can be imported into ServiceNow
 *   via Update Sets, the CI/CD pipeline, or the ServiceNow REST API. Each policy
 *   follows the structure required by the sys_ui_policy table.
 *
 *   Policy execution order is determined by the `order` field (lower = earlier).
 *
 * @module servicenow/catalog/ui-policies/conditionalFieldPolicies
 */

'use strict';

/**
 * Collection of UI Policy definitions for the VM Build Request and Tag Update
 * Request catalog items.
 *
 * Each policy object contains:
 *   - name         : Human-readable policy name.
 *   - shortDescription : Brief description for the admin UI.
 *   - table        : Target table (sc_req_item for catalog item variables).
 *   - catalogItem  : Name of the catalog item this policy applies to.
 *   - condition     : ServiceNow condition string (field^operator^value format).
 *   - reverseCondition : Whether to reverse actions when condition becomes false.
 *   - onLoad       : Whether to execute on form load.
 *   - order        : Execution priority (lower = earlier).
 *   - active       : Whether the policy is enabled.
 *   - actions      : Array of field-level actions applied when condition is true.
 *
 * @type {Array.<{
 *   name: string,
 *   shortDescription: string,
 *   table: string,
 *   catalogItem: string,
 *   condition: string,
 *   reverseCondition: boolean,
 *   onLoad: boolean,
 *   order: number,
 *   active: boolean,
 *   actions: Array.<{
 *     field: string,
 *     mandatory: (boolean|null),
 *     visible: (boolean|null),
 *     readOnly: (boolean|null),
 *     value: (string|null)
 *   }>
 * }>}
 */
const UI_POLICIES = [

    // -----------------------------------------------------------------------
    // Policy 1: Compliance visibility based on Tier
    // -----------------------------------------------------------------------
    {
        name: 'DFW - Compliance Required for Database Tier',
        shortDescription: 'When Tier is "Database", make the Compliance field ' +
            'mandatory and visible. Database workloads must declare a compliance ' +
            'framework per enterprise security policy.',
        table: 'sc_req_item',
        catalogItem: 'VM Build Request',
        condition: 'variables.tier=Database',
        reverseCondition: true,
        onLoad: true,
        order: 100,
        active: true,
        actions: [
            {
                field: 'variables.compliance',
                mandatory: true,
                visible: true,
                readOnly: null,
                value: null
            },
            {
                field: 'variables.compliance_info',
                mandatory: null,
                visible: true,
                readOnly: null,
                value: null
            }
        ]
    },

    // -----------------------------------------------------------------------
    // Policy 2: Compliance optional for non-Database tiers (reverse of Policy 1)
    // -----------------------------------------------------------------------
    {
        name: 'DFW - Compliance Optional for Non-Database Tiers',
        shortDescription: 'When Tier is not "Database", the Compliance field is ' +
            'visible but not mandatory. Users may still select a compliance ' +
            'framework if applicable.',
        table: 'sc_req_item',
        catalogItem: 'VM Build Request',
        condition: 'variables.tier!=Database',
        reverseCondition: false,
        onLoad: true,
        order: 110,
        active: true,
        actions: [
            {
                field: 'variables.compliance',
                mandatory: false,
                visible: true,
                readOnly: null,
                value: null
            }
        ]
    },

    // -----------------------------------------------------------------------
    // Policy 3: DataClassification required for Production environment
    // -----------------------------------------------------------------------
    {
        name: 'DFW - DataClassification Required for Production',
        shortDescription: 'When Environment is "Production", make Data ' +
            'Classification mandatory. Production VMs must have an explicit ' +
            'data classification for governance and access control purposes.',
        table: 'sc_req_item',
        catalogItem: 'VM Build Request',
        condition: 'variables.environment=Production',
        reverseCondition: true,
        onLoad: true,
        order: 200,
        active: true,
        actions: [
            {
                field: 'variables.data_classification',
                mandatory: true,
                visible: true,
                readOnly: null,
                value: null
            }
        ]
    },

    // -----------------------------------------------------------------------
    // Policy 4: Production warning banner
    // -----------------------------------------------------------------------
    {
        name: 'DFW - Production Environment Warning Banner',
        shortDescription: 'When Environment is "Production", show the ' +
            'production warning banner and an advisory message. This alerts ' +
            'requesters that production deployments require CAB approval and ' +
            'have extended lead times.',
        table: 'sc_req_item',
        catalogItem: 'VM Build Request',
        condition: 'variables.environment=Production',
        reverseCondition: true,
        onLoad: true,
        order: 210,
        active: true,
        actions: [
            {
                field: 'variables.production_warning_banner',
                mandatory: null,
                visible: true,
                readOnly: null,
                value: null
            },
            {
                field: 'variables.production_lead_time_notice',
                mandatory: null,
                visible: true,
                readOnly: null,
                value: 'Production deployments require CAB approval and a minimum ' +
                    '5-business-day lead time.'
            }
        ]
    },

    // -----------------------------------------------------------------------
    // Policy 5: Sandbox environment restrictions
    // -----------------------------------------------------------------------
    {
        name: 'DFW - Sandbox Compliance Restriction',
        shortDescription: 'When Environment is "Sandbox", restrict the ' +
            'Compliance field to "None" only. Regulatory workloads (PCI, HIPAA, ' +
            'SOX, FedRAMP) are not permitted in Sandbox environments.',
        table: 'sc_req_item',
        catalogItem: 'VM Build Request',
        condition: 'variables.environment=Sandbox',
        reverseCondition: true,
        onLoad: true,
        order: 220,
        active: true,
        actions: [
            {
                field: 'variables.compliance',
                mandatory: null,
                visible: true,
                readOnly: null,
                value: 'None'
            },
            {
                field: 'variables.sandbox_compliance_notice',
                mandatory: null,
                visible: true,
                readOnly: null,
                value: null
            }
        ]
    },

    // -----------------------------------------------------------------------
    // Policy 6: Sandbox hides advanced data classification options
    // -----------------------------------------------------------------------
    {
        name: 'DFW - Sandbox DataClassification Restriction',
        shortDescription: 'When Environment is "Sandbox", restrict Data ' +
            'Classification to "Public" or "Internal" only. Confidential and ' +
            'Restricted data is not permitted in Sandbox environments.',
        table: 'sc_req_item',
        catalogItem: 'VM Build Request',
        condition: 'variables.environment=Sandbox',
        reverseCondition: true,
        onLoad: true,
        order: 230,
        active: true,
        actions: [
            {
                field: 'variables.data_classification',
                mandatory: null,
                visible: true,
                readOnly: null,
                value: 'Internal'
            }
        ]
    },

    // -----------------------------------------------------------------------
    // Policy 7: Tag Update — Production VM warning
    // -----------------------------------------------------------------------
    {
        name: 'DFW - Tag Update Production VM Warning',
        shortDescription: 'For Tag Update Requests, when the selected VM is ' +
            'in a Production environment, show a warning banner and make the ' +
            'change justification field mandatory.',
        table: 'sc_req_item',
        catalogItem: 'Tag Update Request',
        condition: 'variables.current_environment=Production',
        reverseCondition: true,
        onLoad: true,
        order: 300,
        active: true,
        actions: [
            {
                field: 'variables.change_justification',
                mandatory: true,
                visible: true,
                readOnly: null,
                value: null
            },
            {
                field: 'variables.production_warning_banner',
                mandatory: null,
                visible: true,
                readOnly: null,
                value: null
            }
        ]
    },

    // -----------------------------------------------------------------------
    // Policy 8: Cost Center is always read-only
    // -----------------------------------------------------------------------
    {
        name: 'DFW - Cost Center Read Only',
        shortDescription: 'The Cost Center field is always read-only on the ' +
            'form. It is auto-populated from the user\'s department record ' +
            'and can only be changed by finance administrators.',
        table: 'sc_req_item',
        catalogItem: 'VM Build Request',
        condition: '',
        reverseCondition: false,
        onLoad: true,
        order: 50,
        active: true,
        actions: [
            {
                field: 'variables.cost_center',
                mandatory: null,
                visible: true,
                readOnly: true,
                value: null
            }
        ]
    }
];

// ---------------------------------------------------------------------------
// Export helper functions
// ---------------------------------------------------------------------------

/**
 * Returns all active UI policy definitions.
 *
 * @returns {Array} Array of UI policy configuration objects.
 */
function getActivePolicies() {
    const active = [];
    for (let i = 0; i < UI_POLICIES.length; i++) {
        if (UI_POLICIES[i].active) {
            active.push(UI_POLICIES[i]);
        }
    }
    return active;
}

/**
 * Returns UI policies filtered by catalog item name.
 *
 * @param {string} catalogItemName - The catalog item name to filter by.
 * @returns {Array} Filtered array of UI policy configuration objects.
 */
function getPoliciesForCatalogItem(catalogItemName) {
    const filtered = [];
    for (let i = 0; i < UI_POLICIES.length; i++) {
        if (UI_POLICIES[i].catalogItem === catalogItemName && UI_POLICIES[i].active) {
            filtered.push(UI_POLICIES[i]);
        }
    }
    return filtered;
}

/**
 * Returns a specific UI policy by name.
 *
 * @param {string} policyName - The policy name to search for.
 * @returns {Object|null} The matching policy object, or null if not found.
 */
function getPolicyByName(policyName) {
    for (let i = 0; i < UI_POLICIES.length; i++) {
        if (UI_POLICIES[i].name === policyName) {
            return UI_POLICIES[i];
        }
    }
    return null;
}

/**
 * Validates that all policy definitions have the required structure.
 * Useful for CI/CD pipeline validation before deployment.
 *
 * @returns {{valid: boolean, errors: string[]}} Validation result.
 */
function validatePolicyDefinitions() {
    const errors = [];
    const requiredFields = ['name', 'table', 'catalogItem', 'order', 'actions'];

    for (let i = 0; i < UI_POLICIES.length; i++) {
        const policy = UI_POLICIES[i];

        for (let j = 0; j < requiredFields.length; j++) {
            const field = requiredFields[j];
            if (policy[field] === undefined || policy[field] === null) {
                errors.push('Policy at index ' + i + ' (' + (policy.name || 'unnamed') +
                    ') is missing required field: ' + field);
            }
        }

        if (policy.actions && Array.isArray(policy.actions)) {
            for (let k = 0; k < policy.actions.length; k++) {
                const action = policy.actions[k];
                if (!action.field) {
                    errors.push('Policy "' + policy.name + '" action at index ' + k +
                        ' is missing required "field" property.');
                }
            }
        } else if (policy.actions !== undefined) {
            errors.push('Policy "' + policy.name + '" has "actions" but it is not an array.');
        }
    }

    return {
        valid: errors.length === 0,
        errors: errors
    };
}

// Module exports for testing and CI/CD integration
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        UI_POLICIES: UI_POLICIES,
        getActivePolicies: getActivePolicies,
        getPoliciesForCatalogItem: getPoliciesForCatalogItem,
        getPolicyByName: getPolicyByName,
        validatePolicyDefinitions: validatePolicyDefinitions
    };
}
