/**
 * @file vmBuildRequest_onLoad.js
 * @description Client Script (onLoad) for the VM Build Request catalog item.
 *   Executes when the form loads to auto-populate fields with sensible defaults
 *   and retrieve user-specific data such as Cost Center from the user's
 *   department record.
 *
 *   ServiceNow client-side globals used:
 *     - g_form    : GlideForm API for field manipulation
 *     - g_user    : GlideUser API for current user context
 *     - GlideAjax : Asynchronous server-side script include invocation
 *
 * @module servicenow/catalog/client-scripts/vmBuildRequest_onLoad
 */

/* global g_form, g_user, GlideAjax, gel */

'use strict';

/**
 * Catalog Client Script — onLoad handler for the VM Build Request form.
 *
 * Responsibilities:
 *   1. Auto-populate the Cost Center field from the user's department record.
 *   2. Set default values for DataClassification ("Internal") and Compliance ("None").
 *   3. Initialize form state (field visibility, mandatory flags, info messages).
 *
 * @function onLoad
 * @returns {void}
 */
function onLoad() {
    _setDefaultFieldValues();
    _populateCostCenter();
    _initializeFormState();
}

// ---------------------------------------------------------------------------
// Default field values
// ---------------------------------------------------------------------------

/**
 * Sets default values for tag-related catalog variables when the form first
 * loads. These defaults align with the enterprise tagging policy:
 *   - DataClassification defaults to "Internal" (lowest sensitivity).
 *   - Compliance defaults to "None" (no regulatory framework).
 *
 * @private
 * @returns {void}
 */
function _setDefaultFieldValues() {
    const currentDataClassification = g_form.getValue('data_classification');
    if (!currentDataClassification || currentDataClassification === '') {
        g_form.setValue('data_classification', 'Internal');
    }

    const currentCompliance = g_form.getValue('compliance');
    if (!currentCompliance || currentCompliance === '') {
        g_form.setValue('compliance', 'None');
    }
}

// ---------------------------------------------------------------------------
// Cost Center auto-population
// ---------------------------------------------------------------------------

/**
 * Attempts to auto-populate the Cost Center field using two strategies:
 *   1. First, check the user's stored preference via g_user.getPreference().
 *   2. If no preference exists, fall back to a GlideAjax call that resolves
 *      the cost center from the user's department record on the server side.
 *
 * The Cost Center field is made read-only after population to prevent
 * accidental edits (finance-controlled field).
 *
 * @private
 * @returns {void}
 */
function _populateCostCenter() {
    const costCenterPref = g_user.getPreference('cost_center');

    if (costCenterPref && costCenterPref !== '' && costCenterPref !== 'undefined') {
        g_form.setValue('cost_center', costCenterPref);
        g_form.setReadOnly('cost_center', true);
        return;
    }

    // Fall back to server-side lookup via GlideAjax
    _fetchCostCenterFromDepartment();
}

/**
 * Performs an asynchronous GlideAjax call to the DFWCatalogUtils Script Include
 * to resolve the cost center from the current user's department record.
 *
 * The server-side method getCostCenterForUser accepts the user sys_id and
 * returns the cost center value (or empty string if not found).
 *
 * @private
 * @returns {void}
 */
function _fetchCostCenterFromDepartment() {
    const ga = new GlideAjax('DFWCatalogUtils');
    ga.addParam('sysparm_name', 'getCostCenterForUser');
    ga.addParam('sysparm_user_id', g_user.userID);

    ga.getXMLAnswer(function (answer) {
        if (answer && answer !== '' && answer !== 'null') {
            g_form.setValue('cost_center', answer);
            g_form.setReadOnly('cost_center', true);
        } else {
            // Could not resolve — leave editable and show advisory
            g_form.setReadOnly('cost_center', false);
            g_form.showFieldMsg(
                'cost_center',
                'Cost Center could not be determined from your department. Please enter it manually.',
                'info'
            );
        }
    });
}

// ---------------------------------------------------------------------------
// Form state initialization
// ---------------------------------------------------------------------------

/**
 * Initializes the form to a known-good state on load:
 *   - Hides the production warning banner (shown conditionally later by onChange).
 *   - Ensures the Compliance field starts as not mandatory (only required for
 *     certain tier selections).
 *   - Sets the Environment field as mandatory (always required).
 *   - Sets the Tier field as mandatory (always required).
 *   - Sets the Application field as mandatory (always required).
 *
 * @private
 * @returns {void}
 */
function _initializeFormState() {
    // Core required fields — always mandatory
    g_form.setMandatory('application', true);
    g_form.setMandatory('tier', true);
    g_form.setMandatory('environment', true);
    g_form.setMandatory('data_classification', true);

    // Compliance starts as optional; onChange for Tier may make it mandatory
    g_form.setMandatory('compliance', false);

    // Hide the production warning banner element (if it exists)
    _hideProductionBanner();

    // Clear any stale field messages from previous form interactions
    g_form.hideAllFieldMsgs();
}

/**
 * Hides the production environment warning banner element on the form.
 * The banner is a UI Macro element with id "production_warning_banner".
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
