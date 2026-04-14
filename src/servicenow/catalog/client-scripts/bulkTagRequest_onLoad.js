/**
 * @file bulkTagRequest_onLoad.js
 * @description Client Script (onLoad) for the Bulk Tag Remediation Request
 *   catalog item. Executes when the form loads to configure the CSV upload
 *   interface, set up operation type and batch size controls, display
 *   dual-approval notifications, and enforce role-based restrictions.
 *
 *   ServiceNow client-side globals used:
 *     - g_form    : GlideForm API for field manipulation
 *     - g_user    : GlideUser API for current user context and role checks
 *     - GlideAjax : Asynchronous server-side script include invocation
 *     - gel       : DOM element lookup
 *
 * @module servicenow/catalog/client-scripts/bulkTagRequest_onLoad
 */

/* global g_form, g_user, GlideAjax, gel */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Roles that can submit bulk tag requests.
 * @constant {Object.<string, string>}
 */
const BULK_TAG_ROLES = {
    /** Tag Admin — full bulk tag authority */
    TAG_ADMIN: 'x_dfw_tag_admin',
    /** Tag Manager — can submit for review */
    TAG_MANAGER: 'x_dfw_tag_manager'
};

/**
 * Valid operation types for bulk tag operations.
 * @constant {Array<{label: string, value: string}>}
 */
const OPERATION_TYPES = [
    { label: 'Apply Tags (add new, preserve existing)', value: 'apply' },
    { label: 'Update Tags (overwrite existing values)', value: 'update' },
    { label: 'Remove Tags (remove specified categories)', value: 'remove' }
];

/**
 * Default and range constraints for batch size.
 * @constant {Object}
 */
const BATCH_SIZE_CONFIG = {
    defaultValue: 10,
    min: 1,
    max: 50
};

/**
 * CSV format template displayed as help text.
 * @constant {string}
 */
const CSV_FORMAT_HELP = [
    'CSV Format Requirements:',
    '  Column headers (first row): vmName, Region, SecurityZone, Environment, AppCI, SystemRole, Compliance, DataClassification, CostCenter',
    '  - vmName (required): The VM name as it appears in vCenter',
    '  - Region (required): NDCNG or TULNG',
    '  - SecurityZone (required): Greenzone, DMZ, Restricted, Management, or External',
    '  - Environment (required): Production, Staging, Development, Sandbox, UAT',
    '  - AppCI (required): Application CI identifier (e.g., APP001)',
    '  - SystemRole (required): Web, Application, Database, Middleware, Utility, or SharedServices',
    '  - Compliance (optional): Comma-separated within quotes (e.g., "PCI,SOX")',
    '  - DataClassification (optional): Public, Internal, Confidential, Restricted',
    '  - CostCenter (optional): Cost center code',
    '',
    'Example:',
    '  vmName,Region,SecurityZone,Environment,AppCI,SystemRole,Compliance,DataClassification,CostCenter',
    '  SRV-WEB-001,NDCNG,Greenzone,Production,APP001,Web,"PCI",Confidential,CC-IT-001',
    '  SRV-APP-002,TULNG,DMZ,Production,APP001,Application,"PCI,SOX",Confidential,CC-IT-001'
].join('\n');

// ---------------------------------------------------------------------------
// Main onLoad handler
// ---------------------------------------------------------------------------

/**
 * Catalog Client Script — onLoad handler for the Bulk Tag Remediation
 * Request form.
 *
 * Responsibilities:
 *   1. Verify the current user has bulk tag submission authority.
 *   2. Configure the operation type dropdown.
 *   3. Configure the batch size field with constraints.
 *   4. Display CSV format help text.
 *   5. Configure the dry-run checkbox with explanation.
 *   6. Show dual-approval notification.
 *   7. Configure the target site selector.
 *
 * @function onLoad
 * @returns {void}
 */
function onLoad() {
    // Step 1: Role check
    if (!_hasBulkTagAuthority()) {
        _showUnauthorizedMessage();
        _disableFormFields();
        return;
    }

    // Step 2: Configure operation type
    _configureOperationType();

    // Step 3: Configure batch size
    _configureBatchSize();

    // Step 4: Display CSV format help
    _displayCSVHelp();

    // Step 5: Configure dry-run checkbox
    _configureDryRun();

    // Step 6: Show approval notification
    _showApprovalNotification();

    // Step 7: Configure site selector
    _configureSiteSelector();
}

// ---------------------------------------------------------------------------
// Role-based access control
// ---------------------------------------------------------------------------

/**
 * Checks whether the current user has an authorized role for bulk tag
 * request submission.
 *
 * @private
 * @returns {boolean} True if the user has at least one authorized role.
 */
function _hasBulkTagAuthority() {
    return (
        g_user.hasRole(BULK_TAG_ROLES.TAG_ADMIN) ||
        g_user.hasRole(BULK_TAG_ROLES.TAG_MANAGER)
    );
}

/**
 * Displays an error message informing the user that they lack bulk tag
 * submission authority.
 *
 * @private
 * @returns {void}
 */
function _showUnauthorizedMessage() {
    g_form.addErrorMessage(
        'ACCESS DENIED: Bulk Tag Remediation requests require the ' +
        'Tag Admin (x_dfw_tag_admin) or Tag Manager (x_dfw_tag_manager) role. ' +
        'Please contact your infrastructure team for access.'
    );
}

/**
 * Disables all form fields to prevent unauthorized submissions.
 *
 * @private
 * @returns {void}
 */
function _disableFormFields() {
    const fields = [
        'csv_attachment', 'operation_type', 'target_site',
        'batch_size', 'dry_run', 'justification'
    ];

    for (let i = 0; i < fields.length; i++) {
        g_form.setReadOnly(fields[i], true);
    }
}

// ---------------------------------------------------------------------------
// Field configuration
// ---------------------------------------------------------------------------

/**
 * Configures the operation type dropdown with the predefined options.
 * Defaults to 'apply' (safest operation).
 *
 * @private
 * @returns {void}
 */
function _configureOperationType() {
    g_form.setValue('operation_type', 'apply');
    g_form.setMandatory('operation_type', true);
}

/**
 * Configures the batch size field with default value and constraints.
 *
 * @private
 * @returns {void}
 */
function _configureBatchSize() {
    g_form.setValue('batch_size', BATCH_SIZE_CONFIG.defaultValue.toString());
    g_form.setMandatory('batch_size', true);

    g_form.addDecoration(
        'batch_size',
        'icon-info',
        'Number of VMs processed per batch (range: ' +
        BATCH_SIZE_CONFIG.min + '-' + BATCH_SIZE_CONFIG.max + '). ' +
        'Larger batches are faster but increase blast radius on failure.'
    );
}

/**
 * Displays the CSV format help text in an info message so the user knows
 * the expected file format.
 *
 * @private
 * @returns {void}
 */
function _displayCSVHelp() {
    const helpContainer = gel('csv_format_help');
    if (helpContainer) {
        helpContainer.innerHTML = '<pre>' + CSV_FORMAT_HELP + '</pre>';
        helpContainer.style.display = 'block';
    }

    g_form.addDecoration(
        'csv_attachment',
        'icon-info',
        'Upload a CSV file with VM names and tag values. ' +
        'See format requirements below the field.'
    );
}

/**
 * Configures the dry-run checkbox with an explanatory decoration.
 * Defaults to enabled (checked) for safety.
 *
 * @private
 * @returns {void}
 */
function _configureDryRun() {
    g_form.setValue('dry_run', 'true');

    g_form.addDecoration(
        'dry_run',
        'icon-info',
        'When enabled, the operation simulates tag changes without applying them. ' +
        'A detailed report of proposed changes is generated for review. ' +
        'Recommended: run a dry-run first, then submit again with dry-run disabled.'
    );
}

/**
 * Displays a notification informing the submitter that bulk tag operations
 * require dual approval from both a Program Sponsor and a Security Architect.
 *
 * @private
 * @returns {void}
 */
function _showApprovalNotification() {
    g_form.addInfoMessage(
        'APPROVAL REQUIRED: Bulk tag operations require dual approval from ' +
        'a Program Sponsor and a Security Architect before execution. ' +
        'The request will be routed automatically after submission. ' +
        'Dry-run requests are exempt from approval.'
    );
}

/**
 * Configures the target site selector and makes it mandatory.
 *
 * @private
 * @returns {void}
 */
function _configureSiteSelector() {
    g_form.setMandatory('target_site', true);
}
