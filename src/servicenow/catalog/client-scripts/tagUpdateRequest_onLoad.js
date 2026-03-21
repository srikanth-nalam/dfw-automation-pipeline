/**
 * @file tagUpdateRequest_onLoad.js
 * @description Client Script (onLoad) for the Tag Update Request catalog item.
 *   Executes when the form loads to populate current tag values from the
 *   selected VM's CMDB Configuration Item (CI) record, enforce role-based
 *   field restrictions, and display warnings for production VMs.
 *
 *   ServiceNow client-side globals used:
 *     - g_form    : GlideForm API for field manipulation
 *     - g_user    : GlideUser API for current user context and role checks
 *     - GlideAjax : Asynchronous server-side script include invocation
 *
 * @module servicenow/catalog/client-scripts/tagUpdateRequest_onLoad
 */

/* global g_form, g_user, GlideAjax, gel */

'use strict';

// ---------------------------------------------------------------------------
// Role constants
// ---------------------------------------------------------------------------

/**
 * Roles that grant elevated privileges on tag update forms.
 * @constant {Object.<string, string>}
 */
const ROLES = {
    /** Full admin — can edit all fields */
    TAG_ADMIN: 'x_dfw_tag_admin',
    /** Tag manager — can edit most fields but not Cost Center */
    TAG_MANAGER: 'x_dfw_tag_manager',
    /** Standard user — limited editing capabilities */
    ITIL: 'itil'
};

/**
 * Fields that are always read-only for non-admin users.
 * These are finance-controlled or system-managed fields.
 * @constant {string[]}
 */
const ADMIN_ONLY_FIELDS = [
    'cost_center',
    'application'
];

/**
 * Fields that require at least TAG_MANAGER role to edit.
 * @constant {string[]}
 */
const MANAGER_EDITABLE_FIELDS = [
    'tier',
    'environment',
    'data_classification',
    'compliance'
];

// ---------------------------------------------------------------------------
// Main onLoad handler
// ---------------------------------------------------------------------------

/**
 * Catalog Client Script — onLoad handler for the Tag Update Request form.
 *
 * Responsibilities:
 *   1. Populate current tag values from the selected VM's CMDB CI record.
 *   2. Apply role-based field restrictions (read-only enforcement).
 *   3. Show warnings for production environment VMs.
 *
 * @function onLoad
 * @returns {void}
 */
function onLoad() {
    const vmCiSysId = g_form.getValue('vm_ci');

    if (vmCiSysId && vmCiSysId !== '') {
        _populateCurrentTags(vmCiSysId);
    } else {
        _showNoVmMessage();
    }

    _applyRoleBasedRestrictions();
}

// ---------------------------------------------------------------------------
// Current tag population from CMDB
// ---------------------------------------------------------------------------

/**
 * Fetches the current tag values for the selected VM from its CMDB CI record
 * via a GlideAjax call to the DFWTagLookup Script Include.
 *
 * The server-side method getTagsForCI accepts the CI sys_id and returns a
 * JSON string containing the current tag values keyed by category:
 * ```json
 * {
 *   "application": "APP001",
 *   "tier": "Web",
 *   "environment": "Production",
 *   "data_classification": "Internal",
 *   "compliance": "PCI",
 *   "cost_center": "CC-1234"
 * }
 * ```
 *
 * @private
 * @param {string} ciSysId - The sys_id of the VM's CMDB CI record.
 * @returns {void}
 */
function _populateCurrentTags(ciSysId) {
    const ga = new GlideAjax('DFWTagLookup');
    ga.addParam('sysparm_name', 'getTagsForCI');
    ga.addParam('sysparm_ci_sys_id', ciSysId);

    ga.getXMLAnswer(function (answer) {
        if (!answer || answer === '' || answer === 'null') {
            g_form.addInfoMessage(
                'No existing tags found for the selected VM. All tag fields are blank.'
            );
            return;
        }

        let tags;
        try {
            tags = JSON.parse(answer);
        } catch (e) {
            g_form.addErrorMessage(
                'Failed to parse tag data from CMDB. Please contact your ServiceNow administrator.'
            );
            return;
        }

        _setTagFieldValues(tags);
        _checkProductionWarning(tags);
    });
}

/**
 * Sets form field values from the parsed tag data object.
 * Each tag category is mapped to its corresponding catalog variable.
 *
 * @private
 * @param {Object} tags - Tag data keyed by category.
 * @param {string} [tags.application]          - Application tag value.
 * @param {string} [tags.tier]                 - Tier tag value.
 * @param {string} [tags.environment]          - Environment tag value.
 * @param {string} [tags.data_classification]  - DataClassification tag value.
 * @param {string} [tags.compliance]           - Compliance tag value(s).
 * @param {string} [tags.cost_center]          - CostCenter tag value.
 * @returns {void}
 */
function _setTagFieldValues(tags) {
    /** @type {Array.<{field: string, key: string}>} */
    const fieldMappings = [
        { field: 'current_application',          key: 'application' },
        { field: 'current_tier',                 key: 'tier' },
        { field: 'current_environment',          key: 'environment' },
        { field: 'current_data_classification',  key: 'data_classification' },
        { field: 'current_compliance',           key: 'compliance' },
        { field: 'current_cost_center',          key: 'cost_center' }
    ];

    for (let i = 0; i < fieldMappings.length; i++) {
        const mapping = fieldMappings[i];
        const value = tags[mapping.key];

        if (value !== undefined && value !== null) {
            g_form.setValue(mapping.field, value.toString());
            // Current value fields are always read-only (display-only)
            g_form.setReadOnly(mapping.field, true);
        }
    }

    // Also pre-populate the "new" fields with current values as starting point
    const editableFieldMappings = [
        { field: 'application',          key: 'application' },
        { field: 'tier',                 key: 'tier' },
        { field: 'environment',          key: 'environment' },
        { field: 'data_classification',  key: 'data_classification' },
        { field: 'compliance',           key: 'compliance' },
        { field: 'cost_center',          key: 'cost_center' }
    ];

    for (let j = 0; j < editableFieldMappings.length; j++) {
        const editMapping = editableFieldMappings[j];
        const editValue = tags[editMapping.key];

        if (editValue !== undefined && editValue !== null) {
            g_form.setValue(editMapping.field, editValue.toString());
        }
    }
}

/**
 * Checks whether the VM is in a production environment and displays a
 * prominent warning if so. Production tag changes require additional
 * approvals and may impact running workloads.
 *
 * @private
 * @param {Object} tags - Tag data keyed by category.
 * @returns {void}
 */
function _checkProductionWarning(tags) {
    if (tags.environment && tags.environment === 'Production') {
        g_form.addWarningMessage(
            'WARNING: This VM is in a PRODUCTION environment. ' +
            'Tag changes to production workloads require Change Advisory Board (CAB) approval ' +
            'and will trigger an automated compliance re-evaluation. ' +
            'Please ensure all changes are documented in an approved change request.'
        );

        // Show the production banner if available
        const banner = gel('production_warning_banner');
        if (banner) {
            banner.style.display = 'block';
        }
    }
}

/**
 * Displays a message when no VM CI is selected on form load.
 * This can happen if the form is accessed directly without a pre-selected VM.
 *
 * @private
 * @returns {void}
 */
function _showNoVmMessage() {
    g_form.addInfoMessage(
        'Please select a VM to update tags. Current tag values will be populated ' +
        'automatically from the CMDB after selection.'
    );
}

// ---------------------------------------------------------------------------
// Role-based field restrictions
// ---------------------------------------------------------------------------

/**
 * Applies field-level read-only restrictions based on the current user's roles.
 *
 * Access model:
 *   - **x_dfw_tag_admin**: Full access to all fields.
 *   - **x_dfw_tag_manager**: Can edit tier, environment, data classification,
 *     and compliance. Cannot edit cost center or application.
 *   - **itil** (standard user): Can only view current values and submit the
 *     request. All tag fields are read-only; changes require manager approval.
 *
 * @private
 * @returns {void}
 */
function _applyRoleBasedRestrictions() {
    const isAdmin = g_user.hasRole(ROLES.TAG_ADMIN);
    const isManager = g_user.hasRole(ROLES.TAG_MANAGER);

    if (isAdmin) {
        // Admins can edit everything — no restrictions
        return;
    }

    // Admin-only fields are read-only for everyone except admins
    _setFieldsReadOnly(ADMIN_ONLY_FIELDS, true);

    if (isManager) {
        // Managers can edit the manager-editable fields
        _setFieldsReadOnly(MANAGER_EDITABLE_FIELDS, false);
    } else {
        // Standard users: all tag fields are read-only
        _setFieldsReadOnly(MANAGER_EDITABLE_FIELDS, true);
        g_form.addInfoMessage(
            'Your role does not permit direct tag editing. You may submit this ' +
            'request and it will be routed to a Tag Manager for review and approval.'
        );
    }
}

/**
 * Sets a list of fields to read-only or editable.
 *
 * @private
 * @param {string[]} fields   - Array of field names.
 * @param {boolean}  readOnly - True to make read-only, false to make editable.
 * @returns {void}
 */
function _setFieldsReadOnly(fields, readOnly) {
    for (let i = 0; i < fields.length; i++) {
        g_form.setReadOnly(fields[i], readOnly);
    }
}
