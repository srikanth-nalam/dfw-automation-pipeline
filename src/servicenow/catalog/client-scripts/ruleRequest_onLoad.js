/**
 * @file ruleRequest_onLoad.js
 * @description Client Script (onLoad) for the DFW Rule Request catalog item.
 *   Initializes the rule request form, validates user permissions, populates
 *   source/destination group dropdowns, and provides rule template guidance.
 *
 *   Responsibilities:
 *     1. Check that the current user has permission to submit rule requests
 *     2. Initialize form field states (mandatory flags, visibility, defaults)
 *     3. Load available rule templates from the server
 *     4. Configure source and destination security group dropdowns
 *     5. Set up action type dropdown and protocol/port validation hints
 *
 *   ServiceNow client-side globals used:
 *     - g_form    : GlideForm API for field manipulation
 *     - g_user    : GlideUser API for current user context
 *     - GlideAjax : Asynchronous server-side script include invocation
 *     - gel       : DOM element retrieval helper
 *
 * @module servicenow/catalog/client-scripts/ruleRequest_onLoad
 */

/* global g_form, g_user, GlideAjax, gel */

'use strict';

/**
 * Valid rule action types presented to the user.
 * @constant {Array.<{value: string, label: string}>}
 */
const RULE_ACTIONS = [
    { value: '', label: '-- Select Action --' },
    { value: 'allow', label: 'Allow' },
    { value: 'deny', label: 'Deny' },
    { value: 'drop', label: 'Drop (Silent)' },
    { value: 'reject', label: 'Reject (with RST)' }
];

/**
 * Valid protocols for rule requests.
 * @constant {Array.<{value: string, label: string}>}
 */
const PROTOCOLS = [
    { value: '', label: '-- Select Protocol --' },
    { value: 'TCP', label: 'TCP' },
    { value: 'UDP', label: 'UDP' },
    { value: 'ICMP', label: 'ICMP' },
    { value: 'ANY', label: 'Any' }
];

/**
 * User roles authorized to submit DFW rule requests.
 * @constant {string[]}
 */
const AUTHORIZED_ROLES = [
    'dfw_rule_requestor',
    'dfw_admin',
    'security_admin',
    'network_admin',
    'itil'
];

/**
 * Catalog Client Script -- onLoad handler for the DFW Rule Request form.
 *
 * Orchestrates form initialization in the correct sequence:
 *   1. Permission check (may abort loading)
 *   2. Form state initialization (mandatory, visibility)
 *   3. Rule template loading (async)
 *   4. Source/destination group configuration (async)
 *
 * @function onLoad
 * @returns {void}
 */
function onLoad() {
    _checkUserPermissions();
    _initializeFormState();
    _loadRuleTemplates();
    _configureSourceDestination();
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

/**
 * Validates that the current user holds at least one of the authorized roles
 * for DFW rule request submission.
 *
 * If the user is not authorized:
 *   - Displays an error message on the form
 *   - Disables the submit button
 *   - Sets all fields to read-only
 *
 * @private
 * @returns {void}
 */
function _checkUserPermissions() {
    let hasPermission = false;

    for (let i = 0; i < AUTHORIZED_ROLES.length; i++) {
        if (g_user.hasRole(AUTHORIZED_ROLES[i])) {
            hasPermission = true;
            break;
        }
    }

    if (!hasPermission) {
        g_form.addErrorMessage(
            'You do not have permission to submit DFW rule requests. ' +
            'Required role: one of ' + AUTHORIZED_ROLES.join(', ') + '. ' +
            'Contact your ServiceNow administrator for access.'
        );

        // Disable form fields to prevent unauthorized submission
        g_form.setReadOnly('source_group', true);
        g_form.setReadOnly('destination_group', true);
        g_form.setReadOnly('action', true);
        g_form.setReadOnly('protocol', true);
        g_form.setReadOnly('port', true);
        g_form.setReadOnly('justification', true);
        g_form.setReadOnly('rule_template', true);
        g_form.setReadOnly('expiration_date', true);

        // Disable the submit button element if present
        const submitBtn = gel('dfw_rule_submit_btn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.5';
        }
    }
}

// ---------------------------------------------------------------------------
// Form state initialization
// ---------------------------------------------------------------------------

/**
 * Initializes the form to a known-good state on load.
 *
 * Sets up:
 *   - Mandatory fields (source group, destination group, action, protocol, justification)
 *   - Optional fields (port, expiration date, rule template)
 *   - Default values for action and protocol dropdowns
 *   - Port field visibility (shown by default, hidden for ICMP)
 *   - Advisory messages for form guidance
 *
 * @private
 * @returns {void}
 */
function _initializeFormState() {
    // Core required fields -- always mandatory
    g_form.setMandatory('source_group', true);
    g_form.setMandatory('destination_group', true);
    g_form.setMandatory('action', true);
    g_form.setMandatory('protocol', true);
    g_form.setMandatory('justification', true);

    // Optional fields
    g_form.setMandatory('port', false);
    g_form.setMandatory('expiration_date', false);
    g_form.setMandatory('rule_template', false);

    // Set default values if fields are empty
    const currentAction = g_form.getValue('action');
    if (!currentAction || currentAction === '') {
        g_form.setValue('action', '');
    }

    const currentProtocol = g_form.getValue('protocol');
    if (!currentProtocol || currentProtocol === '') {
        g_form.setValue('protocol', '');
    }

    // Port field starts visible
    g_form.setDisplay('port', true);

    // Show port format advisory
    g_form.showFieldMsg(
        'port',
        'Enter a single port (e.g., 443), a range (e.g., 8080-8090), or leave blank for all ports.',
        'info'
    );

    // Show justification guidance
    g_form.showFieldMsg(
        'justification',
        'Provide a business reason for this rule request. Include the application name, ' +
        'communication flow, and any relevant change request numbers.',
        'info'
    );

    // Hide stale messages from prior interactions
    _hideExpirationWarning();

    // Set the expiration date field label with guidance
    _configureExpirationField();
}

// ---------------------------------------------------------------------------
// Rule template loading
// ---------------------------------------------------------------------------

/**
 * Loads available rule templates from the server via GlideAjax.
 *
 * Rule templates are pre-defined rule configurations stored in the
 * u_dfw_rule_templates table. They provide quick-fill functionality
 * for common rule patterns (e.g., "Web-to-App HTTPS", "App-to-DB PostgreSQL").
 *
 * On successful load:
 *   - Populates the rule_template dropdown
 *   - Displays an info message with the number of available templates
 *
 * On failure:
 *   - Hides the rule_template field (graceful degradation)
 *
 * @private
 * @returns {void}
 */
function _loadRuleTemplates() {
    const ga = new GlideAjax('DFWCatalogUtils');
    ga.addParam('sysparm_name', 'getRuleTemplates');
    ga.addParam('sysparm_user_id', g_user.userID);

    ga.getXMLAnswer(function (answer) {
        if (!answer || answer === '' || answer === 'null' || answer === '[]') {
            // No templates available -- hide the template field
            g_form.setDisplay('rule_template', false);
            return;
        }

        try {
            const templates = JSON.parse(answer);

            if (!Array.isArray(templates) || templates.length === 0) {
                g_form.setDisplay('rule_template', false);
                return;
            }

            // Populate the rule_template dropdown
            g_form.clearValue('rule_template');

            for (let i = 0; i < templates.length; i++) {
                const template = templates[i];
                g_form.addOption(
                    'rule_template',
                    template.sys_id || template.id,
                    template.name || template.label
                );
            }

            g_form.showFieldMsg(
                'rule_template',
                templates.length + ' rule template(s) available. Select a template to auto-fill common rule patterns.',
                'info'
            );

        } catch (_parseErr) {
            // Template loading failed -- hide the field gracefully
            g_form.setDisplay('rule_template', false);
        }
    });
}

// ---------------------------------------------------------------------------
// Source/destination group configuration
// ---------------------------------------------------------------------------

/**
 * Configures the source and destination security group dropdowns.
 *
 * Fetches the list of security groups available to the current user's
 * scope (based on their application CI assignments) from the server.
 * Populates both source_group and destination_group fields with the
 * returned group list.
 *
 * Groups are loaded from the u_dfw_security_groups table via GlideAjax.
 *
 * @private
 * @returns {void}
 */
function _configureSourceDestination() {
    const ga = new GlideAjax('DFWCatalogUtils');
    ga.addParam('sysparm_name', 'getSecurityGroupsForUser');
    ga.addParam('sysparm_user_id', g_user.userID);

    ga.getXMLAnswer(function (answer) {
        if (!answer || answer === '' || answer === 'null' || answer === '[]') {
            g_form.showFieldMsg(
                'source_group',
                'No security groups available for your user scope. Contact the DFW team.',
                'error'
            );
            return;
        }

        try {
            const groups = JSON.parse(answer);

            if (!Array.isArray(groups) || groups.length === 0) {
                g_form.showFieldMsg(
                    'source_group',
                    'No security groups found. Verify your application CI assignments.',
                    'error'
                );
                return;
            }

            // Populate source group dropdown
            _populateGroupDropdown('source_group', groups);

            // Populate destination group dropdown
            _populateGroupDropdown('destination_group', groups);

        } catch (_parseErr) {
            g_form.showFieldMsg(
                'source_group',
                'Failed to load security groups. Please reload the form.',
                'error'
            );
        }
    });
}

/**
 * Populates a dropdown field with security group options.
 *
 * @private
 * @param {string} fieldName - The form field name to populate.
 * @param {Array.<{sys_id: string, name: string, description: string}>} groups -
 *   Array of security group objects.
 * @returns {void}
 */
function _populateGroupDropdown(fieldName, groups) {
    g_form.clearValue(fieldName);

    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const label = group.name + (group.description ? ' (' + group.description + ')' : '');
        g_form.addOption(fieldName, group.sys_id || group.name, label);
    }
}

// ---------------------------------------------------------------------------
// Expiration date configuration
// ---------------------------------------------------------------------------

/**
 * Configures the expiration date field with guidance for temporary rules.
 *
 * Displays an advisory message explaining when an expiration date should
 * be set (temporary access, incident-driven rules, etc.).
 *
 * @private
 * @returns {void}
 */
function _configureExpirationField() {
    g_form.showFieldMsg(
        'expiration_date',
        'Set an expiration date for temporary rules. Permanent rules may leave this field blank. ' +
        'Emergency rules typically expire within 72 hours.',
        'info'
    );
}

/**
 * Hides the expiration warning banner element if present on the form.
 *
 * @private
 * @returns {void}
 */
function _hideExpirationWarning() {
    const warningBanner = gel('rule_expiration_warning');
    if (warningBanner) {
        warningBanner.style.display = 'none';
    }
}
