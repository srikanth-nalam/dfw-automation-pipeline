/**
 * @file quarantineRequest_onLoad.js
 * @description Client Script (onLoad) for the Emergency VM Quarantine Request
 *   catalog item. Executes when the form loads to populate current VM context,
 *   enforce role-based access restrictions (Security Architects and Tag Admins
 *   only), display production warnings, and configure the quarantine duration
 *   dropdown.
 *
 *   ServiceNow client-side globals used:
 *     - g_form    : GlideForm API for field manipulation
 *     - g_user    : GlideUser API for current user context and role checks
 *     - GlideAjax : Asynchronous server-side script include invocation
 *     - gel       : DOM element lookup
 *
 * @module servicenow/catalog/client-scripts/quarantineRequest_onLoad
 */

/* global g_form, g_user, GlideAjax, gel */

'use strict';

// ---------------------------------------------------------------------------
// Role constants
// ---------------------------------------------------------------------------

/**
 * Roles that are authorized to submit quarantine requests.
 * @constant {Object.<string, string>}
 */
const QUARANTINE_ROLES = {
    /** Security Architect — primary quarantine authority */
    SECURITY_ARCHITECT: 'x_dfw_security_architect',
    /** Tag Admin — secondary quarantine authority */
    TAG_ADMIN: 'x_dfw_tag_admin'
};

/**
 * Minimum character length for the justification field.
 * @constant {number}
 */
const MIN_JUSTIFICATION_LENGTH = 50;

/**
 * Valid quarantine duration options in minutes.
 * @constant {Array<{label: string, value: number}>}
 */
const DURATION_OPTIONS = [
    { label: '15 minutes', value: 15 },
    { label: '30 minutes', value: 30 },
    { label: '1 hour', value: 60 },
    { label: '2 hours', value: 120 },
    { label: '4 hours', value: 240 },
    { label: '8 hours', value: 480 },
    { label: '24 hours', value: 1440 }
];

// ---------------------------------------------------------------------------
// Main onLoad handler
// ---------------------------------------------------------------------------

/**
 * Catalog Client Script — onLoad handler for the Emergency VM Quarantine
 * Request form.
 *
 * Responsibilities:
 *   1. Verify the current user has quarantine submission authority.
 *   2. Populate current VM context from the selected CMDB CI.
 *   3. Configure the quarantine duration dropdown.
 *   4. Show warnings for production environment VMs.
 *   5. Set up justification field validation hints.
 *
 * @function onLoad
 * @returns {void}
 */
function onLoad() {
    // Step 1: Role check — only authorized roles can submit
    if (!_hasQuarantineAuthority()) {
        _showUnauthorizedMessage();
        _disableFormSubmission();
        return;
    }

    // Step 2: Populate VM context
    const vmCiSysId = g_form.getValue('vm_ci');
    if (vmCiSysId && vmCiSysId !== '') {
        _populateVMContext(vmCiSysId);
    } else {
        g_form.addInfoMessage(
            'Please select a VM to quarantine. Current tags and environment ' +
            'details will be populated automatically after selection.'
        );
    }

    // Step 3: Configure duration dropdown
    _configureDurationDropdown();

    // Step 4: Set justification field hints
    _configureJustificationField();

    // Step 5: Auto-populate initiatedBy
    g_form.setValue('initiated_by', g_user.getFullName());
    g_form.setReadOnly('initiated_by', true);
}

// ---------------------------------------------------------------------------
// Role-based access control
// ---------------------------------------------------------------------------

/**
 * Checks whether the current user has an authorized role for quarantine
 * request submission.
 *
 * @private
 * @returns {boolean} True if the user has at least one quarantine role.
 */
function _hasQuarantineAuthority() {
    return (
        g_user.hasRole(QUARANTINE_ROLES.SECURITY_ARCHITECT) ||
        g_user.hasRole(QUARANTINE_ROLES.TAG_ADMIN)
    );
}

/**
 * Displays an error message informing the user that they lack quarantine
 * submission authority.
 *
 * @private
 * @returns {void}
 */
function _showUnauthorizedMessage() {
    g_form.addErrorMessage(
        'ACCESS DENIED: Emergency VM Quarantine requests require the ' +
        'Security Architect (x_dfw_security_architect) or Tag Admin ' +
        '(x_dfw_tag_admin) role. Please contact your security team ' +
        'if you need to quarantine a VM urgently.'
    );
}

/**
 * Disables all form fields and the submit button to prevent unauthorized
 * submissions.
 *
 * @private
 * @returns {void}
 */
function _disableFormSubmission() {
    const fields = [
        'vm_ci', 'justification', 'duration_minutes',
        'severity_level', 'initiated_by'
    ];

    for (let i = 0; i < fields.length; i++) {
        g_form.setReadOnly(fields[i], true);
    }
}

// ---------------------------------------------------------------------------
// VM context population from CMDB
// ---------------------------------------------------------------------------

/**
 * Fetches the current VM context (tags, environment, application) from the
 * CMDB CI record and populates display fields on the form.
 *
 * @private
 * @param {string} ciSysId - The sys_id of the VM's CMDB CI record.
 * @returns {void}
 */
function _populateVMContext(ciSysId) {
    const ga = new GlideAjax('DFWTagLookup');
    ga.addParam('sysparm_name', 'getTagsForCI');
    ga.addParam('sysparm_ci_sys_id', ciSysId);

    ga.getXMLAnswer(function (answer) {
        if (!answer || answer === '' || answer === 'null') {
            g_form.addInfoMessage(
                'No existing tags found for the selected VM. ' +
                'Quarantine will still proceed but environment context is unknown.'
            );
            return;
        }

        let tags;
        try {
            tags = JSON.parse(answer);
        } catch (e) {
            g_form.addErrorMessage(
                'Failed to parse tag data from CMDB. ' +
                'Please contact your ServiceNow administrator.'
            );
            return;
        }

        _setVMContextFields(tags);
        _checkProductionWarning(tags);
    });
}

/**
 * Sets the read-only context fields that show the VM's current tag state.
 *
 * @private
 * @param {Object} tags - Tag data keyed by category.
 * @returns {void}
 */
function _setVMContextFields(tags) {
    const contextMappings = [
        { field: 'current_app_ci', key: 'app_ci' },
        { field: 'current_environment', key: 'environment' },
        { field: 'current_system_role', key: 'system_role' },
        { field: 'current_region', key: 'region' },
        { field: 'current_security_zone', key: 'security_zone' },
        { field: 'current_compliance', key: 'compliance' }
    ];

    for (let i = 0; i < contextMappings.length; i++) {
        const mapping = contextMappings[i];
        const value = tags[mapping.key];

        if (value !== undefined && value !== null) {
            g_form.setValue(mapping.field, value.toString());
            g_form.setReadOnly(mapping.field, true);
        }
    }
}

/**
 * Displays a prominent warning if the target VM is in a production
 * environment. Production quarantines have higher impact and require
 * additional documentation.
 *
 * @private
 * @param {Object} tags - Tag data keyed by category.
 * @returns {void}
 */
function _checkProductionWarning(tags) {
    if (tags.environment && tags.environment === 'Production') {
        g_form.addWarningMessage(
            'CRITICAL: This VM is in a PRODUCTION environment. ' +
            'Quarantining this VM will immediately block all non-management traffic. ' +
            'Ensure you have documented the security incident and notified the ' +
            'application owner before proceeding.'
        );

        const banner = gel('production_quarantine_banner');
        if (banner) {
            banner.style.display = 'block';
        }

        // Auto-set severity to Critical for production VMs
        g_form.setValue('severity_level', 'critical');
    }
}

// ---------------------------------------------------------------------------
// Quarantine duration configuration
// ---------------------------------------------------------------------------

/**
 * Configures the quarantine duration dropdown with the predefined duration
 * options. Sets a default value of 1 hour (60 minutes).
 *
 * @private
 * @returns {void}
 */
function _configureDurationDropdown() {
    // Set the default duration to 1 hour
    g_form.setValue('duration_minutes', '60');
}

// ---------------------------------------------------------------------------
// Justification field configuration
// ---------------------------------------------------------------------------

/**
 * Configures the justification field with validation hints and character
 * count guidance.
 *
 * @private
 * @returns {void}
 */
function _configureJustificationField() {
    g_form.setMandatory('justification', true);

    // Add help text for minimum length requirement
    g_form.addDecoration(
        'justification',
        'icon-info',
        'Minimum ' + MIN_JUSTIFICATION_LENGTH + ' characters required. ' +
        'Include: security incident reference, threat description, and expected impact.'
    );
}
