/**
 * @file cmdbTagSyncRule.js
 * @description ServiceNow Business Rule that triggers Day-2 tag synchronization
 *   when approved CMDB CI changes occur. Monitors updates to the 5 security-relevant
 *   CMDB fields and triggers the vRO Day-2 workflow for real-time tag sync.
 *
 *   The 5 mandatory tag categories monitored:
 *     - Region       (u_region)
 *     - SecurityZone (u_security_zone)
 *     - Environment  (u_environment)
 *     - AppCI        (u_app_ci)
 *     - SystemRole   (u_system_role)
 *
 *   When any of these fields change on a cmdb_ci_vm_instance record, this rule:
 *     1. Detects which tag-relevant fields changed (current vs previous)
 *     2. Builds a changed-tags payload with old and new values
 *     3. Validates that the change was approved (approval state check)
 *     4. Triggers the vRO Day-2 tag sync workflow via REST
 *     5. Logs the sync trigger event to the DFW audit log
 *
 * Business Rule Configuration:
 *   Table: cmdb_ci_vm_instance
 *   When: After Update
 *   Order: 200
 *   Active: true
 *   Condition: Tag-relevant fields changed
 *
 * ServiceNow server-side globals used:
 *   - GlideRecord    : Database query/update API
 *   - gs             : GlideSystem utilities
 *   - current        : Current record being updated
 *   - previous       : Previous record values before update
 *
 * @module servicenow/business-rules/cmdbTagSyncRule
 */

/* global GlideRecord, gs, current, previous */

(function executeRule(current, previous) {
    'use strict';

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /**
     * CMDB fields mapped to their corresponding NSX tag categories.
     * These are the 5 mandatory security-relevant fields in the new tag model.
     * @type {Array.<{cmdbField: string, tagCategory: string}>}
     */
    const MONITORED_FIELDS = [
        { cmdbField: 'u_region', tagCategory: 'Region' },
        { cmdbField: 'u_security_zone', tagCategory: 'SecurityZone' },
        { cmdbField: 'u_environment', tagCategory: 'Environment' },
        { cmdbField: 'u_app_ci', tagCategory: 'AppCI' },
        { cmdbField: 'u_system_role', tagCategory: 'SystemRole' }
    ];

    /**
     * vRO endpoint property key for the Day-2 tag sync workflow.
     * @constant {string}
     */
    const VRO_ENDPOINT_PROPERTY = 'dfw.vro.endpoint.url';

    /**
     * vRO auth token property key.
     * @constant {string}
     */
    const VRO_AUTH_PROPERTY = 'dfw.vro.auth.token';

    /**
     * Day-2 workflow path appended to the vRO base URL.
     * @constant {string}
     */
    const DAY2_WORKFLOW_PATH = '/api/vro/v1/workflows/dfw-day2-tag-sync/trigger';

    /**
     * Maximum REST call timeout in milliseconds.
     * @constant {number}
     */
    const REST_TIMEOUT_MS = 30000;

    // -----------------------------------------------------------------------
    // Step 1: Detect which tag-relevant fields changed
    // -----------------------------------------------------------------------

    /**
     * Compares current and previous values for all monitored fields.
     * Returns an array of change objects for fields that differ.
     *
     * @returns {Array.<{cmdbField: string, tagCategory: string, oldValue: string, newValue: string}>}
     *   Array of detected changes; empty if no tag-relevant fields changed.
     */
    function detectChangedFields() {
        const changes = [];

        for (let i = 0; i < MONITORED_FIELDS.length; i++) {
            const field = MONITORED_FIELDS[i];
            const currentValue = current.getValue(field.cmdbField) || '';
            const previousValue = previous.getValue(field.cmdbField) || '';

            if (currentValue !== previousValue) {
                changes.push({
                    cmdbField: field.cmdbField,
                    tagCategory: field.tagCategory,
                    oldValue: previousValue,
                    newValue: currentValue
                });
            }
        }

        return changes;
    }

    // -----------------------------------------------------------------------
    // Step 2: Build the changed-tags payload
    // -----------------------------------------------------------------------

    /**
     * Constructs the REST payload for the vRO Day-2 tag sync workflow.
     *
     * @param {Array} changes - Array of field change objects from detectChangedFields.
     * @returns {Object} Structured payload for the vRO REST trigger.
     */
    function buildSyncPayload(changes) {
        const vmName = current.getValue('name') || '';
        const vmId = current.getValue('object_id') || current.getUniqueValue();
        const site = current.getValue('u_site') || '';

        const changedTags = {};
        const previousTags = {};

        for (let i = 0; i < changes.length; i++) {
            const change = changes[i];
            changedTags[change.tagCategory] = change.newValue;
            previousTags[change.tagCategory] = change.oldValue;
        }

        // Collect all current tag values (not just changed) for complete state
        const currentTags = {};
        for (let j = 0; j < MONITORED_FIELDS.length; j++) {
            const field = MONITORED_FIELDS[j];
            const value = current.getValue(field.cmdbField) || '';
            if (value !== '') {
                currentTags[field.tagCategory] = value;
            }
        }

        return {
            correlationId: 'CMDB-SYNC-' + vmId + '-' + Date.now(),
            requestType: 'day2_tag_update',
            schemaVersion: 'v1',
            source: 'cmdb_business_rule',
            vmName: vmName,
            vmId: vmId,
            site: site,
            changedTags: changedTags,
            previousTags: previousTags,
            currentTags: currentTags,
            changedBy: gs.getUserName(),
            changedAt: gs.nowDateTime(),
            ciSysId: current.getUniqueValue(),
            callbackUrl: gs.getProperty('dfw.snow.callback.url') + '/api/now/v1/dfw/callback'
        };
    }

    // -----------------------------------------------------------------------
    // Step 3: Validate the change was approved
    // -----------------------------------------------------------------------

    /**
     * Checks whether the CMDB change has been properly approved.
     * Validates the approval state on the current record or the related
     * change request record.
     *
     * @returns {boolean} True if the change is approved or no approval is required.
     */
    function isChangeApproved() {
        // Check if there is an associated change request
        const changeRequest = current.getValue('u_change_request') || '';

        if (!changeRequest || changeRequest === '') {
            // No change request linked -- check if direct edits are allowed
            const allowDirectEdits = gs.getProperty('dfw.cmdb.allow_direct_edits', 'false');
            if (allowDirectEdits === 'true') {
                return true;
            }

            gs.warn('[DFW-4200] CMDB tag field changed without associated change request. ' +
                'VM: ' + (current.getValue('name') || 'unknown') + ', ' +
                'Changed by: ' + gs.getUserName());
            return false;
        }

        // Verify the change request is in an approved state
        const crGr = new GlideRecord('change_request');
        if (crGr.get(changeRequest)) {
            const approvalState = crGr.getValue('approval') || '';
            if (approvalState === 'approved' || approvalState === 'requested') {
                return true;
            }

            gs.warn('[DFW-4201] CMDB tag field changed with unapproved change request. ' +
                'VM: ' + (current.getValue('name') || 'unknown') + ', ' +
                'Change: ' + crGr.getValue('number') + ', ' +
                'Approval State: ' + approvalState);
            return false;
        }

        gs.warn('[DFW-4202] Change request record not found: ' + changeRequest);
        return false;
    }

    // -----------------------------------------------------------------------
    // Step 4: Trigger the vRO Day-2 workflow
    // -----------------------------------------------------------------------

    /**
     * Sends the tag sync payload to the vRO Day-2 workflow via REST.
     *
     * @param {Object} payload - The sync payload from buildSyncPayload.
     * @returns {{success: boolean, executionId: string|null, error: string|null}}
     *   Result of the REST trigger attempt.
     */
    function triggerVROSync(payload) {
        const vroEndpoint = gs.getProperty(VRO_ENDPOINT_PROPERTY);
        const vroAuthToken = gs.getProperty(VRO_AUTH_PROPERTY);

        if (!vroEndpoint) {
            gs.error('[DFW-4210] vRO endpoint URL not configured. ' +
                'Property: ' + VRO_ENDPOINT_PROPERTY);
            return { success: false, executionId: null, error: 'vRO endpoint not configured' };
        }

        try {
            const restMessage = new sn_ws.RESTMessageV2();
            restMessage.setEndpoint(vroEndpoint + DAY2_WORKFLOW_PATH);
            restMessage.setHttpMethod('POST');
            restMessage.setRequestHeader('Content-Type', 'application/json');
            restMessage.setRequestHeader('X-Correlation-ID', payload.correlationId);
            restMessage.setRequestHeader('Authorization', 'Bearer ' + vroAuthToken);
            restMessage.setRequestBody(JSON.stringify(payload));
            restMessage.setHttpTimeout(REST_TIMEOUT_MS);

            const response = restMessage.execute();
            const statusCode = response.getStatusCode();

            if (statusCode === 202 || statusCode === 200) {
                let executionId = null;
                try {
                    const body = JSON.parse(response.getBody());
                    executionId = body.executionId || null;
                } catch (_parseErr) {
                    // Response body may not contain executionId -- non-fatal
                }

                return { success: true, executionId: executionId, error: null };
            }

            return {
                success: false,
                executionId: null,
                error: 'HTTP ' + statusCode + ': ' + response.getBody()
            };
        } catch (e) {
            const errMsg = e.getMessage ? e.getMessage() : String(e);
            gs.error('[DFW-4211] Failed to trigger vRO Day-2 tag sync: ' + errMsg);
            return { success: false, executionId: null, error: errMsg };
        }
    }

    // -----------------------------------------------------------------------
    // Step 5: Log the sync trigger event
    // -----------------------------------------------------------------------

    /**
     * Creates an audit log entry for the tag sync trigger event.
     *
     * @param {Object} payload - The sync payload.
     * @param {{success: boolean, executionId: string|null, error: string|null}} triggerResult -
     *   The result of the vRO trigger.
     * @param {Array} changes - The detected field changes.
     */
    function logSyncEvent(payload, triggerResult, changes) {
        try {
            const audit = new GlideRecord('u_dfw_audit_log');
            audit.initialize();
            audit.setValue('u_correlation_id', payload.correlationId);
            audit.setValue('u_event_type', 'cmdb_tag_sync');
            audit.setValue('u_status', triggerResult.success ? 'triggered' : 'trigger_failed');

            const changedFieldNames = changes.map(function (c) {
                return c.tagCategory + ': ' + c.oldValue + ' -> ' + c.newValue;
            }).join(', ');

            const details = 'CMDB tag sync triggered for VM: ' + payload.vmName + '\n' +
                'Site: ' + payload.site + '\n' +
                'Changed fields: ' + changedFieldNames + '\n' +
                'Changed by: ' + payload.changedBy + '\n' +
                'vRO Trigger: ' + (triggerResult.success ? 'SUCCESS' : 'FAILED') + '\n' +
                (triggerResult.executionId ? 'Execution ID: ' + triggerResult.executionId + '\n' : '') +
                (triggerResult.error ? 'Error: ' + triggerResult.error + '\n' : '');

            audit.setValue('u_details', details.substring(0, 4000));
            audit.setValue('u_timestamp', gs.nowDateTime());
            audit.insert();
        } catch (e) {
            gs.error('[DFW-4220] Failed to log CMDB tag sync audit entry: ' +
                (e.getMessage ? e.getMessage() : String(e)));
        }
    }

    /**
     * Updates the CMDB CI record with the sync trigger correlation ID.
     *
     * @param {string} correlationId - The correlation ID assigned to this sync event.
     */
    function updateCIWithCorrelation(correlationId) {
        try {
            const ciGr = new GlideRecord('cmdb_ci_vm_instance');
            if (ciGr.get(current.getUniqueValue())) {
                ciGr.setValue('u_dfw_correlation_id', correlationId);
                ciGr.setValue('u_dfw_last_automation_date', gs.nowDateTime());
                ciGr.setValue('u_dfw_automation_status', 'Day2-Sync-Triggered');
                ciGr.setWorkflow(false); // Prevent recursive trigger
                ciGr.update();
            }
        } catch (e) {
            gs.error('[DFW-4221] Failed to update CI with correlation ID: ' +
                (e.getMessage ? e.getMessage() : String(e)));
        }
    }

    // -----------------------------------------------------------------------
    // Execute the business rule logic
    // -----------------------------------------------------------------------

    // Step 1: Detect changed tag-relevant fields
    const changes = detectChangedFields();

    if (changes.length === 0) {
        // No tag-relevant fields changed -- exit silently
        return;
    }

    gs.info('[DFW] CMDB tag field change detected on VM: ' +
        (current.getValue('name') || 'unknown') + '. ' +
        'Changed categories: ' +
        changes.map(function (c) { return c.tagCategory; }).join(', '));

    // Step 3: Validate the change was approved
    if (!isChangeApproved()) {
        gs.warn('[DFW-4200] Skipping tag sync -- change not approved. VM: ' +
            (current.getValue('name') || 'unknown'));
        return;
    }

    // Step 2: Build the sync payload
    const payload = buildSyncPayload(changes);

    // Step 4: Trigger vRO Day-2 workflow
    const triggerResult = triggerVROSync(payload);

    // Step 5: Log the event
    logSyncEvent(payload, triggerResult, changes);

    // Update CI record with correlation
    if (triggerResult.success) {
        updateCIWithCorrelation(payload.correlationId);

        gs.info('[DFW] Day-2 tag sync triggered successfully for VM: ' +
            payload.vmName + '. Correlation ID: ' + payload.correlationId);
    } else {
        gs.error('[DFW-4211] Day-2 tag sync trigger FAILED for VM: ' +
            payload.vmName + '. Error: ' + triggerResult.error);

        // Queue event for retry via scheduled job
        gs.eventQueue('dfw.cmdb.tag_sync_failed', current,
            payload.correlationId, triggerResult.error);
    }

})(current, previous);

// ---------------------------------------------------------------------------
// Export for testing
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        /**
         * Monitored CMDB fields and their corresponding NSX tag categories.
         * @type {Array.<{cmdbField: string, tagCategory: string}>}
         */
        MONITORED_FIELDS: [
            { cmdbField: 'u_region', tagCategory: 'Region' },
            { cmdbField: 'u_security_zone', tagCategory: 'SecurityZone' },
            { cmdbField: 'u_environment', tagCategory: 'Environment' },
            { cmdbField: 'u_app_ci', tagCategory: 'AppCI' },
            { cmdbField: 'u_system_role', tagCategory: 'SystemRole' }
        ],

        /**
         * vRO Day-2 workflow path.
         * @type {string}
         */
        DAY2_WORKFLOW_PATH: '/api/vro/v1/workflows/dfw-day2-tag-sync/trigger',

        /**
         * REST call timeout in milliseconds.
         * @type {number}
         */
        REST_TIMEOUT_MS: 30000
    };
}
