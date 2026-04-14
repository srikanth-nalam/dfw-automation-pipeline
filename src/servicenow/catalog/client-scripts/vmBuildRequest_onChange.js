/**
 * @file vmBuildRequest_onChange.js
 * @description Client Script (onChange) for the VM Build Request catalog item.
 *   Handles dynamic form behavior when the user changes Tier, Environment, or
 *   Compliance fields. Enforces business rules client-side including:
 *     - Making Compliance required when Tier is "Database"
 *     - Showing production warnings when Environment is "Production"
 *     - Blocking PCI workloads in Sandbox (DFW-4003)
 *     - Filtering field options based on selections
 *
 *   ServiceNow client-side globals used:
 *     - g_form    : GlideForm API for field manipulation
 *     - gel       : DOM element accessor
 *
 * @module servicenow/catalog/client-scripts/vmBuildRequest_onChange
 */

/* global g_form, gel */

'use strict';

// ---------------------------------------------------------------------------
// Error code constants
// ---------------------------------------------------------------------------

/**
 * Error code for PCI-in-Sandbox conflict.
 * @constant {string}
 */
const DFW_4003 = 'DFW-4003';

// ---------------------------------------------------------------------------
// DataClassification options by Tier
// ---------------------------------------------------------------------------

/**
 * Mapping of Tier values to allowed DataClassification options.
 * Used to filter the DataClassification dropdown when the Tier changes.
 *
 * @constant {Object.<string, string[]>}
 */
const DATA_CLASSIFICATION_BY_ROLE = {
    'Web':            ['Public', 'Internal'],
    'Application':    ['Internal', 'Confidential'],
    'Database':       ['Confidential', 'Restricted'],
    'Middleware':     ['Internal', 'Confidential'],
    'Utility':        ['Public', 'Internal'],
    'SharedServices': ['Internal', 'Confidential']
};

/**
 * Full list of all DataClassification values for reset scenarios.
 * @constant {string[]}
 */
const ALL_DATA_CLASSIFICATIONS = ['Public', 'Internal', 'Confidential', 'Restricted'];

/**
 * Full list of all Compliance values.
 * @constant {string[]}
 */
const ALL_COMPLIANCE_VALUES = ['None', 'PCI', 'HIPAA', 'SOX', 'FedRAMP'];

// ---------------------------------------------------------------------------
// Main onChange dispatcher
// ---------------------------------------------------------------------------

/**
 * Catalog Client Script — onChange handler for the VM Build Request form.
 *
 * ServiceNow invokes this function each time a monitored variable changes.
 * The function dispatches to the appropriate handler based on which field
 * was modified.
 *
 * @function onChange
 * @param {string} control   - The widget that triggered the change.
 * @param {string} oldValue  - The previous field value.
 * @param {string} newValue  - The new field value.
 * @param {boolean} isLoading - True if the form is still loading.
 * @returns {void}
 */
function onChange(control, oldValue, newValue, isLoading) {
    // Do not run during initial form load (onLoad handles that)
    if (isLoading) {
        return;
    }

    const fieldName = control.toString();

    switch (fieldName) {
        case 'system_role':
            _handleSystemRoleChange(newValue, oldValue);
            break;
        case 'region':
        case 'security_zone':
        case 'app_ci':
            // No special onChange logic needed for these fields
            break;
        case 'environment':
            _handleEnvironmentChange(newValue, oldValue);
            break;
        case 'compliance':
            _handleComplianceChange(newValue, oldValue);
            break;
        default:
            break;
    }
}

// ---------------------------------------------------------------------------
// Tier change handler
// ---------------------------------------------------------------------------

/**
 * Handles changes to the SystemRole field.
 *
 * When SystemRole is set to "Database":
 *   - Makes the Compliance field mandatory (databases require explicit
 *     compliance classification per security policy).
 *   - Displays an info message explaining why Compliance is now required.
 *
 * For all SystemRole values:
 *   - Filters DataClassification options to only those valid for the role.
 *   - Resets the DataClassification value if it is no longer in the allowed set.
 *
 * @private
 * @param {string} newRole - The newly selected SystemRole value.
 * @param {string} oldRole - The previous SystemRole value.
 * @returns {void}
 */
function _handleSystemRoleChange(newRole, oldRole) {
    // --- Compliance mandatory logic for Database system role ---
    if (newRole === 'Database') {
        g_form.setMandatory('compliance', true);
        g_form.showFieldMsg(
            'compliance',
            'Compliance framework is required for Database system role workloads. ' +
            'Please select the applicable compliance standard(s).',
            'info'
        );
    } else {
        g_form.setMandatory('compliance', false);
        g_form.hideFieldMsg('compliance');
    }

    // --- Filter DataClassification based on SystemRole ---
    _filterDataClassificationByRole(newRole);
}

/**
 * Filters the DataClassification dropdown to show only the options that are
 * valid for the selected SystemRole. If the currently selected DataClassification
 * is not in the allowed list, it is cleared.
 *
 * @private
 * @param {string} role - The currently selected SystemRole value.
 * @returns {void}
 */
function _filterDataClassificationByRole(role) {
    const allowedValues = DATA_CLASSIFICATION_BY_ROLE[role] || ALL_DATA_CLASSIFICATIONS;
    const currentValue = g_form.getValue('data_classification');

    // Remove all options first, then add back only the allowed ones
    g_form.clearOptions('data_classification');

    // Add blank/placeholder option
    g_form.addOption('data_classification', '', '-- Select --');

    for (let i = 0; i < allowedValues.length; i++) {
        g_form.addOption('data_classification', allowedValues[i], allowedValues[i]);
    }

    // Restore previous selection if still valid
    if (allowedValues.indexOf(currentValue) !== -1) {
        g_form.setValue('data_classification', currentValue);
    } else if (currentValue && currentValue !== '') {
        // Previous value no longer valid — clear and notify
        g_form.setValue('data_classification', '');
        g_form.showFieldMsg(
            'data_classification',
            'Your previous Data Classification selection is not valid for the "' +
            role + '" system role. Please select a new value.',
            'warning'
        );
    }
}

// ---------------------------------------------------------------------------
// Environment change handler
// ---------------------------------------------------------------------------

/**
 * Handles changes to the Environment field.
 *
 * When Environment is "Production":
 *   - Shows a prominent warning banner advising the requester that production
 *     deployments require additional approvals and lead time.
 *   - Makes DataClassification mandatory (production VMs must have an explicit
 *     data classification).
 *
 * When Environment is "Sandbox":
 *   - Filters the Compliance field to only allow "None" (regulatory workloads
 *     are not permitted in Sandbox).
 *   - Validates that no conflicting Compliance value is already selected.
 *
 * For other environments:
 *   - Hides the production banner.
 *   - Restores full Compliance option list.
 *
 * @private
 * @param {string} newEnv - The newly selected Environment value.
 * @param {string} oldEnv - The previous Environment value.
 * @returns {void}
 */
function _handleEnvironmentChange(newEnv, oldEnv) {
    // --- Production environment ---
    if (newEnv === 'Production') {
        _showProductionBanner();
        g_form.setMandatory('data_classification', true);
        g_form.showFieldMsg(
            'environment',
            'Production deployments require Change Advisory Board (CAB) approval ' +
            'and a minimum 5-business-day lead time.',
            'info'
        );
    } else {
        _hideProductionBanner();
        // DataClassification is always mandatory per onLoad, but clear the env msg
        g_form.hideFieldMsg('environment');
    }

    // --- Sandbox environment ---
    if (newEnv === 'Sandbox') {
        _filterComplianceForSandbox();
        // Check existing Compliance value for conflicts
        _validateComplianceEnvironment(g_form.getValue('compliance'), newEnv);
    } else {
        // Restore full Compliance options
        _restoreAllComplianceOptions();
    }
}

/**
 * Filters the Compliance field to only show "None" when Environment is Sandbox.
 * Regulatory compliance frameworks (PCI, HIPAA, SOX, FedRAMP) are not
 * permitted in Sandbox environments.
 *
 * @private
 * @returns {void}
 */
function _filterComplianceForSandbox() {
    g_form.clearOptions('compliance');
    g_form.addOption('compliance', '', '-- Select --');
    g_form.addOption('compliance', 'None', 'None');
    g_form.setValue('compliance', 'None');
    g_form.showFieldMsg(
        'compliance',
        'Sandbox environments only support Compliance = "None". ' +
        'Regulated workloads must use Development, Staging, or Production.',
        'info'
    );
}

/**
 * Restores all Compliance options to the dropdown.
 *
 * @private
 * @returns {void}
 */
function _restoreAllComplianceOptions() {
    const currentValue = g_form.getValue('compliance');

    g_form.clearOptions('compliance');
    g_form.addOption('compliance', '', '-- Select --');

    for (let i = 0; i < ALL_COMPLIANCE_VALUES.length; i++) {
        g_form.addOption('compliance', ALL_COMPLIANCE_VALUES[i], ALL_COMPLIANCE_VALUES[i]);
    }

    // Restore previously selected value if still valid
    if (currentValue && ALL_COMPLIANCE_VALUES.indexOf(currentValue) !== -1) {
        g_form.setValue('compliance', currentValue);
    }
    g_form.hideFieldMsg('compliance');
}

/**
 * Shows the production environment warning banner.
 * The banner is a UI Macro with id "production_warning_banner".
 *
 * @private
 * @returns {void}
 */
function _showProductionBanner() {
    const banner = gel('production_warning_banner');
    if (banner) {
        banner.style.display = 'block';
    }
}

/**
 * Hides the production environment warning banner.
 *
 * @private
 * @returns {void}
 */
function _hideProductionBanner() {
    const banner = gel('production_warning_banner');
    if (banner) {
        banner.style.display = 'none';
    }
}

// ---------------------------------------------------------------------------
// Compliance change handler
// ---------------------------------------------------------------------------

/**
 * Handles changes to the Compliance field.
 *
 * Primary validation: If Compliance includes "PCI" and Environment is
 * "Sandbox", display error DFW-4003 and revert the Compliance value.
 *
 * @private
 * @param {string} newCompliance - The newly selected Compliance value.
 * @param {string} oldCompliance - The previous Compliance value.
 * @returns {void}
 */
function _handleComplianceChange(newCompliance, oldCompliance) {
    const environment = g_form.getValue('environment');
    _validateComplianceEnvironment(newCompliance, environment);
}

/**
 * Validates that the Compliance and Environment combination is allowed.
 *
 * Business rule: PCI workloads cannot be deployed in Sandbox environments.
 * Violation produces error DFW-4003.
 *
 * If a conflict is detected:
 *   1. An error message is displayed on the Compliance field.
 *   2. The Compliance value is reverted to "None".
 *
 * @private
 * @param {string} complianceValue - Current or proposed Compliance value.
 * @param {string} environmentValue - Current Environment value.
 * @returns {void}
 */
function _validateComplianceEnvironment(complianceValue, environmentValue) {
    if (!complianceValue || !environmentValue) {
        return;
    }

    // Compliance may be a comma-separated multi-value in some configurations
    const complianceValues = complianceValue.split(',');
    let hasPCI = false;

    for (let i = 0; i < complianceValues.length; i++) {
        if (complianceValues[i].trim() === 'PCI') {
            hasPCI = true;
            break;
        }
    }

    if (hasPCI && environmentValue === 'Sandbox') {
        g_form.showFieldMsg(
            'compliance',
            '[' + DFW_4003 + '] PCI workloads cannot be in Sandbox. ' +
            'PCI-regulated workloads must be deployed to an environment that ' +
            'meets PCI DSS control requirements (Development, Staging, or Production).',
            'error'
        );

        // Revert to safe default
        g_form.setValue('compliance', 'None');
    }
}
