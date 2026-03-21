/**
 * @fileoverview ServiceNow Scripted REST API Resource - vRO Callback Handler
 * Processes POST callbacks from vRealize Orchestrator after DFW lifecycle
 * workflow execution completes. Handles both success and failure callbacks.
 *
 * On success (status=SUCCESS):
 *   - Updates RITM to "Closed Complete"
 *   - Adds work notes with VM details, tags, groups, and policies
 *   - Updates CMDB CI record with automation metadata
 *
 * On failure (status=FAILURE):
 *   - Updates RITM to "Failed"
 *   - Adds work notes with error details (errorCode, failedStep, compensatingAction)
 *   - Creates an incident if severity warrants escalation
 *
 * Validates correlationId matches RITM before processing.
 *
 * ServiceNow server-side globals used:
 *   - GlideRecord    : Database query/update API
 *   - gs             : GlideSystem utilities
 *   - GlideDateTime  : Date/time operations
 *   - sn_ws          : Scripted REST API namespace
 *
 * @module servicenow/integration/vroCallbackHandler
 */

/* global GlideRecord, gs, Class, GlideDateTime, CorrelationIdGenerator */

'use strict';

/**
 * @class VROCallbackHandler
 * @classdesc Scripted REST API resource handler that processes vRO callback
 *   notifications. Implements the ServiceNow Scripted REST Resource pattern
 *   for POST /api/now/v1/dfw/callback.
 */
const VROCallbackHandler = Class.create();

VROCallbackHandler.prototype = {

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /**
     * RITM state values for status updates.
     * @constant {Object.<string, string>}
     */
    RITM_STATES: {
        OPEN: '1',
        IN_PROGRESS: '2',
        CLOSED_COMPLETE: '3',
        CLOSED_INCOMPLETE: '4',
        PENDING: '-5'
    },

    /**
     * Incident priority mapping from vRO error severity.
     * @constant {Object.<string, string>}
     */
    INCIDENT_PRIORITY_MAP: {
        CRITICAL: '1',
        HIGH: '2',
        MEDIUM: '3',
        LOW: '4'
    },

    /**
     * Error codes that warrant automatic incident creation.
     * @constant {string[]}
     */
    INCIDENT_WORTHY_ERRORS: [
        'DFW-6001', 'DFW-6002', 'DFW-6003', 'DFW-6004', 'DFW-6005',
        'DFW-7001', 'DFW-7002', 'DFW-7003', 'DFW-7004', 'DFW-7005',
        'DFW-7006', 'DFW-7007'
    ],

    /**
     * Default assignment group for auto-created incidents.
     * @constant {string}
     */
    DEFAULT_INCIDENT_GROUP: 'DFW Automation Support',

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * Creates a new VROCallbackHandler instance.
     * @constructor
     */
    initialize: function () {
        // Stateless - no initialization required
    },

    // -----------------------------------------------------------------------
    // Public API - Main entry point
    // -----------------------------------------------------------------------

    /**
     * Processes an incoming vRO callback POST request.
     *
     * Steps:
     *   1. Parse and validate the request body
     *   2. Validate the correlationId matches an existing RITM
     *   3. Route to success or failure handler based on status field
     *   4. Return appropriate HTTP response
     *
     * @param {Object} request  - The Scripted REST request object.
     * @param {Object} response - The Scripted REST response object.
     * @returns {Object} JSON response body with processing result.
     */
    process: function (request, response) {
        let requestBody;

        try {
            // Parse request body from Scripted REST request
            requestBody = request.body ? request.body.data : null;

            if (!requestBody) {
                try {
                    requestBody = JSON.parse(request.body.dataString);
                } catch (parseErr) {
                    response.setStatus(400);
                    return {
                        status: 'error',
                        message: 'Invalid or empty request body',
                        errorCode: 'DFW-CB-4001'
                    };
                }
            }

            // Validate required fields in callback payload
            const validationResult = this._validateCallbackPayload(requestBody);
            if (!validationResult.valid) {
                response.setStatus(400);
                return {
                    status: 'error',
                    message: 'Validation failed: ' + validationResult.errors.join('; '),
                    errorCode: 'DFW-CB-4002'
                };
            }

            const correlationId = requestBody.correlationId;
            const callbackStatus = requestBody.status;

            // Locate the RITM record by correlationId
            const ritmGr = this._findRitmByCorrelationId(correlationId);
            if (!ritmGr) {
                gs.error('VROCallbackHandler: No RITM found for correlationId: ' + correlationId);
                response.setStatus(404);
                return {
                    status: 'error',
                    message: 'No RITM found matching correlationId: ' + correlationId,
                    errorCode: 'DFW-CB-4004'
                };
            }

            gs.info('VROCallbackHandler: Processing callback for correlationId=' +
                correlationId + ', status=' + callbackStatus +
                ', RITM=' + ritmGr.getValue('number'));

            // Route to appropriate handler based on status
            if (callbackStatus === 'SUCCESS' || callbackStatus === 'completed') {
                this._handleSuccess(ritmGr, requestBody);
                response.setStatus(200);
                return {
                    status: 'success',
                    message: 'RITM ' + ritmGr.getValue('number') + ' updated to Closed Complete',
                    correlationId: correlationId
                };
            } else if (callbackStatus === 'FAILURE' || callbackStatus === 'failed') {
                this._handleFailure(ritmGr, requestBody);
                response.setStatus(200);
                return {
                    status: 'success',
                    message: 'RITM ' + ritmGr.getValue('number') + ' updated to Failed',
                    correlationId: correlationId
                };
            } else if (callbackStatus === 'PARTIAL_SUCCESS') {
                this._handlePartialSuccess(ritmGr, requestBody);
                response.setStatus(200);
                return {
                    status: 'success',
                    message: 'RITM ' + ritmGr.getValue('number') + ' updated with partial success',
                    correlationId: correlationId
                };
            } else {
                response.setStatus(400);
                return {
                    status: 'error',
                    message: 'Unknown callback status: ' + callbackStatus,
                    errorCode: 'DFW-CB-4003'
                };
            }

        } catch (e) {
            gs.error('VROCallbackHandler: Unhandled exception processing callback: ' +
                (e.getMessage ? e.getMessage() : String(e)));
            response.setStatus(500);
            return {
                status: 'error',
                message: 'Internal error processing callback: ' +
                    (e.getMessage ? e.getMessage() : String(e)),
                errorCode: 'DFW-CB-5000'
            };
        }
    },

    // -----------------------------------------------------------------------
    // Private - Payload validation
    // -----------------------------------------------------------------------

    /**
     * Validates the callback payload contains all required fields.
     *
     * @private
     * @param {Object} payload - The callback request body.
     * @returns {{valid: boolean, errors: string[]}} Validation result.
     */
    _validateCallbackPayload: function (payload) {
        const errors = [];

        if (!payload || typeof payload !== 'object') {
            return { valid: false, errors: ['Payload must be a non-null object'] };
        }

        if (!payload.correlationId || typeof payload.correlationId !== 'string') {
            errors.push('correlationId is required and must be a string');
        }

        if (!payload.status || typeof payload.status !== 'string') {
            errors.push('status is required and must be a string');
        }

        const validStatuses = ['SUCCESS', 'FAILURE', 'PARTIAL_SUCCESS', 'completed', 'failed'];
        if (payload.status && validStatuses.indexOf(payload.status) === -1) {
            errors.push('status must be one of: ' + validStatuses.join(', '));
        }

        if (!payload.requestType) {
            errors.push('requestType is required');
        }

        // Validate correlationId format if CorrelationIdGenerator is available
        if (payload.correlationId && typeof CorrelationIdGenerator !== 'undefined') {
            try {
                const idGen = new CorrelationIdGenerator();
                const idValidation = idGen.validate(payload.correlationId);
                if (!idValidation.valid) {
                    errors.push('Invalid correlationId format: ' + idValidation.reason);
                }
            } catch (e) {
                // CorrelationIdGenerator not available; skip format validation
            }
        }

        return {
            valid: errors.length === 0,
            errors: errors
        };
    },

    // -----------------------------------------------------------------------
    // Private - RITM lookup
    // -----------------------------------------------------------------------

    /**
     * Finds the RITM record matching the given correlationId.
     * Searches the u_correlation_id field on sc_req_item.
     *
     * @private
     * @param {string} correlationId - The correlationId to search for.
     * @returns {GlideRecord|null} The matching RITM record, or null.
     */
    _findRitmByCorrelationId: function (correlationId) {
        // Primary lookup: u_correlation_id field
        const gr = new GlideRecord('sc_req_item');
        gr.addQuery('u_correlation_id', correlationId);
        gr.setLimit(1);
        gr.query();

        if (gr.next()) {
            return gr;
        }

        // Fallback: parse RITM number from correlationId and search by number
        if (typeof CorrelationIdGenerator !== 'undefined') {
            try {
                const idGen = new CorrelationIdGenerator();
                const parsed = idGen.parse(correlationId);
                if (parsed && parsed.ritmNumber) {
                    const grFallback = new GlideRecord('sc_req_item');
                    grFallback.addQuery('number', 'CONTAINS', parsed.ritmNumber);
                    grFallback.orderByDesc('sys_created_on');
                    grFallback.setLimit(1);
                    grFallback.query();

                    if (grFallback.next()) {
                        gs.warn('VROCallbackHandler: Found RITM via number fallback for ' +
                            correlationId);
                        return grFallback;
                    }
                }
            } catch (e) {
                // Fallback parse failed; continue to next fallback
            }
        }

        // Second fallback: search work_notes for correlationId
        const gr2 = new GlideRecord('sc_req_item');
        gr2.addQuery('work_notes', 'CONTAINS', correlationId);
        gr2.orderByDesc('sys_created_on');
        gr2.setLimit(1);
        gr2.query();

        if (gr2.next()) {
            return gr2;
        }

        return null;
    },

    // -----------------------------------------------------------------------
    // Private - Success handler
    // -----------------------------------------------------------------------

    /**
     * Processes a SUCCESS callback from vRO.
     * Updates the RITM to Closed Complete with full details in work notes
     * and updates the CMDB CI record.
     *
     * @private
     * @param {GlideRecord} ritmGr  - The RITM GlideRecord.
     * @param {Object}      payload - The callback payload.
     */
    _handleSuccess: function (ritmGr, payload) {
        const result = payload.result || {};
        const vmDetails = result.vmDetails || result.vm || {};
        const tagsApplied = result.appliedTags || result.tagsApplied || result.tags || {};
        const groupMemberships = result.groupMemberships || result.groups || [];
        const policiesApplied = result.activeDFWPolicies || result.policiesApplied || result.policies || [];
        const stepDurations = result.workflowStepDurations || {};

        // Build comprehensive work notes
        let workNotes = '[DFW Automation] Workflow completed successfully.\n' +
            'Correlation ID: ' + payload.correlationId + '\n' +
            'Request Type: ' + (payload.requestType || 'N/A') + '\n' +
            'Execution ID: ' + (payload.executionId || 'N/A') + '\n' +
            'Completed At: ' + (payload.timestamp || new GlideDateTime().getDisplayValue()) + '\n';

        // VM details section
        workNotes += '\n--- VM Details ---\n';
        if (vmDetails.name || vmDetails.vmName) {
            workNotes += 'VM Name: ' + (vmDetails.name || vmDetails.vmName) + '\n';
        }
        if (vmDetails.moRef || vmDetails.vmId) {
            workNotes += 'VM ID: ' + (vmDetails.moRef || vmDetails.vmId) + '\n';
        }
        if (vmDetails.ipAddress) {
            workNotes += 'IP Address: ' + vmDetails.ipAddress + '\n';
        }
        if (vmDetails.site) {
            workNotes += 'Site: ' + vmDetails.site + '\n';
        }
        if (vmDetails.powerState) {
            workNotes += 'Power State: ' + vmDetails.powerState + '\n';
        }

        // Tags applied section
        workNotes += '\n--- Tags Applied ---\n';
        if (Array.isArray(tagsApplied)) {
            for (let t = 0; t < tagsApplied.length; t++) {
                const tag = tagsApplied[t];
                workNotes += '  ' + (tag.scope || tag.category || 'unknown') + ': ' +
                    (tag.tag || tag.value || 'unknown') + '\n';
            }
        } else if (typeof tagsApplied === 'object' && tagsApplied !== null) {
            for (const tagKey in tagsApplied) {
                if (tagsApplied.hasOwnProperty(tagKey)) {
                    const tagVal = tagsApplied[tagKey];
                    if (Array.isArray(tagVal)) {
                        workNotes += '  ' + tagKey + ': ' + tagVal.join(', ') + '\n';
                    } else {
                        workNotes += '  ' + tagKey + ': ' + tagVal + '\n';
                    }
                }
            }
        }

        // Group memberships section
        workNotes += '\n--- Security Group Memberships ---\n';
        if (Array.isArray(groupMemberships) && groupMemberships.length > 0) {
            for (let g = 0; g < groupMemberships.length; g++) {
                const group = groupMemberships[g];
                workNotes += '  - ' + (typeof group === 'string' ? group : (group.name || group.path || JSON.stringify(group))) + '\n';
            }
        } else {
            workNotes += '  (No group membership data returned)\n';
        }

        // DFW policies section
        workNotes += '\n--- DFW Policies Applied ---\n';
        if (Array.isArray(policiesApplied) && policiesApplied.length > 0) {
            for (let p = 0; p < policiesApplied.length; p++) {
                const policy = policiesApplied[p];
                if (typeof policy === 'string') {
                    workNotes += '  - ' + policy + '\n';
                } else if (policy && (policy.policyName || policy.name)) {
                    workNotes += '  - ' + (policy.policyName || policy.name) +
                        (policy.ruleCount ? ' (' + policy.ruleCount + ' rules)' : '') +
                        (policy.category ? ' [' + policy.category + ']' : '') + '\n';
                }
            }
        } else {
            workNotes += '  (No policy data returned)\n';
        }

        // Step durations section
        if (stepDurations && typeof stepDurations === 'object') {
            let hasSteps = false;
            if (Array.isArray(stepDurations)) {
                hasSteps = stepDurations.length > 0;
            } else {
                hasSteps = Object.keys(stepDurations).length > 0;
            }

            if (hasSteps) {
                workNotes += '\n--- Workflow Step Durations ---\n';
                if (Array.isArray(stepDurations)) {
                    for (let s = 0; s < stepDurations.length; s++) {
                        const step = stepDurations[s];
                        workNotes += '  ' + (step.step || step.name || 'unknown') + ': ' +
                            (step.durationSeconds || step.durationMs || 0) +
                            (step.durationSeconds !== undefined ? 's' : 'ms') +
                            ' [' + (step.status || 'unknown') + ']\n';
                    }
                } else {
                    for (const stepName in stepDurations) {
                        if (stepDurations.hasOwnProperty(stepName)) {
                            workNotes += '  ' + stepName + ': ' + stepDurations[stepName] + 'ms\n';
                        }
                    }
                }
            }
        }

        // Update RITM to Closed Complete
        ritmGr.setValue('state', this.RITM_STATES.CLOSED_COMPLETE);
        ritmGr.work_notes = workNotes;
        ritmGr.setValue('close_notes', 'Completed by DFW Automation Pipeline. Correlation ID: ' +
            payload.correlationId);
        ritmGr.update();

        // Update CMDB CI if VM details are available
        if (vmDetails.name || vmDetails.vmName || vmDetails.vmId || vmDetails.moRef) {
            this._updateCmdbCi(ritmGr, vmDetails, tagsApplied, payload.correlationId);
        }

        // Log audit entry
        this._logAuditEntry(payload.correlationId, ritmGr.getValue('number'), 'success', workNotes);

        gs.info('VROCallbackHandler: RITM ' + ritmGr.getValue('number') +
            ' closed as complete. Correlation ID: ' + payload.correlationId);
    },

    // -----------------------------------------------------------------------
    // Private - Failure handler
    // -----------------------------------------------------------------------

    /**
     * Processes a FAILURE callback from vRO.
     * Updates the RITM to Failed with detailed error information
     * and creates an incident if the error severity warrants it.
     *
     * @private
     * @param {GlideRecord} ritmGr  - The RITM GlideRecord.
     * @param {Object}      payload - The callback payload.
     */
    _handleFailure: function (ritmGr, payload) {
        const errorInfo = payload.error || {};
        const errorCode = errorInfo.code || payload.errorCode || 'UNKNOWN';
        const errorMessage = errorInfo.message || payload.errorMessage || 'No error message provided';
        const failedStep = errorInfo.failedStep || errorInfo.step || payload.failedStep || 'unknown';
        const retryCount = errorInfo.retryCount || payload.retryCount || 0;
        const errorCategory = errorInfo.category || payload.errorCategory || '';
        const details = errorInfo.details || null;
        const compensatingAction = payload.compensatingAction || payload.compensatingActionTaken || '';
        const compensatingActionResult = payload.compensatingActionResult || '';
        const compensationResult = payload.compensationResult || null;
        const recommendedAction = payload.recommendedAction || '';

        // Build failure work notes
        let workNotes = '[DFW Automation] Workflow FAILED.\n' +
            'Correlation ID: ' + payload.correlationId + '\n' +
            'Request Type: ' + (payload.requestType || 'N/A') + '\n' +
            'Failed At: ' + (payload.timestamp || new GlideDateTime().getDisplayValue()) + '\n' +
            '\n--- Error Details ---\n' +
            'Error Code: ' + errorCode + '\n' +
            'Error Category: ' + (errorCategory || 'N/A') + '\n' +
            'Error Message: ' + errorMessage + '\n' +
            'Failed Step: ' + failedStep + '\n' +
            'Retry Count: ' + retryCount + '\n';

        if (details) {
            workNotes += 'Additional Details: ' + JSON.stringify(details) + '\n';
        }

        if (compensatingAction) {
            workNotes += '\n--- Compensating Action ---\n' +
                'Action Taken: ' + compensatingAction + '\n';
            if (compensatingActionResult) {
                workNotes += 'Action Result: ' + compensatingActionResult + '\n';
            }
        }

        if (compensationResult) {
            workNotes += '\n--- Saga Compensation Result ---\n' +
                'Steps Compensated: ' + (compensationResult.compensated || 0) + '\n' +
                'Steps Failed: ' + (compensationResult.failed || 0) + '\n';
            if (compensationResult.errors && compensationResult.errors.length > 0) {
                workNotes += 'Compensation Errors:\n';
                for (let i = 0; i < compensationResult.errors.length; i++) {
                    const compErr = compensationResult.errors[i];
                    workNotes += '  - ' + compErr.stepName + ': ' + compErr.error + '\n';
                }
            }
        }

        if (recommendedAction) {
            workNotes += '\n--- Recommended Action ---\n' + recommendedAction + '\n';
        }

        // Dead letter queue info
        if (payload.deadLetterQueueEntry) {
            const dlq = payload.deadLetterQueueEntry;
            workNotes += '\n--- Dead Letter Queue ---\n' +
                'Queue: ' + (dlq.queueName || 'N/A') + '\n' +
                'Message ID: ' + (dlq.messageId || 'N/A') + '\n' +
                'Retry Eligible: ' + (dlq.retryEligible ? 'Yes' : 'No') + '\n';
            if (dlq.nextRetryAt) {
                workNotes += 'Next Retry At: ' + dlq.nextRetryAt + '\n';
            }
        }

        workNotes += '\nAction Required: Review error details and take appropriate action.';

        // Update RITM to Failed (Closed Incomplete)
        ritmGr.setValue('state', this.RITM_STATES.CLOSED_INCOMPLETE);
        ritmGr.work_notes = workNotes;
        ritmGr.setValue('u_failure_reason', errorCode + ': ' + errorMessage);
        ritmGr.update();

        gs.error('VROCallbackHandler: RITM ' + ritmGr.getValue('number') +
            ' marked as failed. Error: ' + errorCode + ' - ' + errorMessage);

        // Create incident if error severity warrants it
        if (this._shouldCreateIncident(errorCode, errorInfo, payload)) {
            this._createIncident(ritmGr, payload, errorInfo);
        }

        // Log audit entry
        this._logAuditEntry(payload.correlationId, ritmGr.getValue('number'), 'failure', workNotes);
    },

    // -----------------------------------------------------------------------
    // Private - Partial success handler
    // -----------------------------------------------------------------------

    /**
     * Processes a PARTIAL_SUCCESS callback from vRO.
     * Updates the RITM with details of what succeeded and what failed.
     *
     * @private
     * @param {GlideRecord} ritmGr  - The RITM GlideRecord.
     * @param {Object}      payload - The callback payload.
     */
    _handlePartialSuccess: function (ritmGr, payload) {
        const result = payload.result || {};
        const errorInfo = payload.error || {};

        let workNotes = '[DFW Automation] Workflow completed with PARTIAL SUCCESS.\n' +
            'Correlation ID: ' + payload.correlationId + '\n' +
            'Request Type: ' + (payload.requestType || 'N/A') + '\n' +
            'Completed At: ' + (payload.timestamp || new GlideDateTime().getDisplayValue()) + '\n';

        if (result.completedSteps && Array.isArray(result.completedSteps)) {
            workNotes += '\n--- Completed Steps ---\n';
            for (let i = 0; i < result.completedSteps.length; i++) {
                workNotes += '  - ' + result.completedSteps[i] + '\n';
            }
        }

        if (result.failedSteps && Array.isArray(result.failedSteps)) {
            workNotes += '\n--- Failed Steps ---\n';
            for (let j = 0; j < result.failedSteps.length; j++) {
                workNotes += '  - ' + result.failedSteps[j] + '\n';
            }
        }

        if (errorInfo.message || errorInfo.code) {
            workNotes += '\nError: ' + (errorInfo.code || 'UNKNOWN') +
                ' - ' + (errorInfo.message || 'No details') + '\n';
        }

        workNotes += '\nAction Required: Review partial results and complete remaining steps manually.';

        ritmGr.setValue('state', this.RITM_STATES.IN_PROGRESS);
        ritmGr.work_notes = workNotes;
        ritmGr.update();

        // Create incident for manual follow-up on partial success
        this._createIncident(ritmGr, payload, errorInfo);

        // Log audit entry
        this._logAuditEntry(payload.correlationId, ritmGr.getValue('number'), 'partial_success', workNotes);

        gs.warn('VROCallbackHandler: RITM ' + ritmGr.getValue('number') +
            ' updated with partial success. Correlation ID: ' + payload.correlationId);
    },

    // -----------------------------------------------------------------------
    // Private - CMDB CI update
    // -----------------------------------------------------------------------

    /**
     * Updates the CMDB CI record with automation metadata from the vRO callback.
     *
     * @private
     * @param {GlideRecord} ritmGr        - The RITM GlideRecord.
     * @param {Object}      vmDetails     - VM details from the callback.
     * @param {Object}      tagsApplied   - Tags that were applied.
     * @param {string}      correlationId - The correlation ID.
     */
    _updateCmdbCi: function (ritmGr, vmDetails, tagsApplied, correlationId) {
        try {
            const vmName = vmDetails.name || vmDetails.vmName || '';
            let ciGr = new GlideRecord('cmdb_ci_vm_instance');
            let ciFound = false;

            // Try to find by VM name first
            if (vmName) {
                ciGr.addQuery('name', vmName);
                ciGr.setLimit(1);
                ciGr.query();
                ciFound = ciGr.next();
            }

            // Fallback: find by RITM's CI reference
            if (!ciFound) {
                const vmCiRef = ritmGr.getValue('cmdb_ci') || '';
                if (vmCiRef) {
                    ciGr = new GlideRecord('cmdb_ci_vm_instance');
                    if (ciGr.get(vmCiRef)) {
                        ciFound = true;
                    }
                }
            }

            // Fallback: find by moRef/object_id
            if (!ciFound && (vmDetails.moRef || vmDetails.vmId)) {
                ciGr = new GlideRecord('cmdb_ci_vm_instance');
                ciGr.addQuery('object_id', vmDetails.moRef || vmDetails.vmId);
                ciGr.setLimit(1);
                ciGr.query();
                ciFound = ciGr.next();
            }

            if (ciFound) {
                ciGr.setValue('u_dfw_correlation_id', correlationId);
                ciGr.setValue('u_dfw_last_automation_date', new GlideDateTime().getDisplayValue());
                ciGr.setValue('u_dfw_automation_status', 'Completed');

                if (tagsApplied && typeof tagsApplied === 'object') {
                    if (Array.isArray(tagsApplied)) {
                        // Convert array format to JSON string for storage
                        ciGr.setValue('u_nsx_tags', JSON.stringify(tagsApplied));
                    } else {
                        ciGr.setValue('u_nsx_tags', JSON.stringify(tagsApplied));
                    }
                }

                if (vmDetails.ipAddress) {
                    ciGr.setValue('ip_address', vmDetails.ipAddress);
                }
                if (vmDetails.moRef || vmDetails.vmId) {
                    ciGr.setValue('object_id', vmDetails.moRef || vmDetails.vmId);
                }
                if (vmDetails.powerState) {
                    ciGr.setValue('u_power_state', vmDetails.powerState);
                }

                ciGr.update();
                gs.info('VROCallbackHandler: CMDB CI updated for VM ' +
                    vmName + '. Correlation ID: ' + correlationId);
            } else {
                gs.warn('VROCallbackHandler: CMDB CI not found for VM ' +
                    (vmName || 'unknown') + '. Skipping CI update.');
            }
        } catch (e) {
            gs.error('VROCallbackHandler: Error updating CMDB CI: ' +
                (e.getMessage ? e.getMessage() : String(e)));
            // Do not throw - CI update failure should not fail the callback
        }
    },

    // -----------------------------------------------------------------------
    // Private - Incident creation
    // -----------------------------------------------------------------------

    /**
     * Determines whether an automatic incident should be created based on
     * the error code, severity, and category.
     *
     * @private
     * @param {string} errorCode - The DFW error code.
     * @param {Object} errorInfo - The full error info object.
     * @param {Object} payload   - The full callback payload.
     * @returns {boolean} True if an incident should be created.
     */
    _shouldCreateIncident: function (errorCode, errorInfo, payload) {
        // Always create incident for known infrastructure/connectivity errors
        if (this.INCIDENT_WORTHY_ERRORS.indexOf(errorCode) !== -1) {
            return true;
        }

        // Create incident if error category is CONNECTIVITY or INFRASTRUCTURE
        const category = errorInfo.category || payload.errorCategory || '';
        if (category === 'CONNECTIVITY' || category === 'INFRASTRUCTURE' ||
            category === 'CONNECTIVITY_ERROR' || category === 'NSX_API_ERROR' ||
            category === 'VCENTER_API_ERROR') {
            return true;
        }

        // Create incident if severity is CRITICAL or HIGH
        const severity = (errorInfo.severity || '').toUpperCase();
        if (severity === 'CRITICAL' || severity === 'HIGH') {
            return true;
        }

        return false;
    },

    /**
     * Creates a ServiceNow incident for DFW automation failures that
     * require manual intervention.
     *
     * @private
     * @param {GlideRecord} ritmGr    - The RITM GlideRecord.
     * @param {Object}      payload   - The callback payload.
     * @param {Object}      errorInfo - The error details.
     * @returns {string|null} The sys_id of the created incident, or null on failure.
     */
    _createIncident: function (ritmGr, payload, errorInfo) {
        try {
            const errorCode = errorInfo.code || payload.errorCode || 'UNKNOWN';
            const errorMessage = errorInfo.message || payload.errorMessage || 'Automation failure';
            const severity = (errorInfo.severity || 'MEDIUM').toUpperCase();
            const ritmNumber = ritmGr.getValue('number');

            const incGr = new GlideRecord('incident');
            incGr.initialize();
            incGr.setValue('short_description',
                '[DFW Automation] ' + errorCode + ' - ' + errorMessage.substring(0, 100) +
                ' (RITM: ' + ritmNumber + ')');
            incGr.setValue('description',
                'DFW Automation Pipeline failure requiring manual intervention.\n\n' +
                'RITM: ' + ritmNumber + '\n' +
                'Correlation ID: ' + payload.correlationId + '\n' +
                'Request Type: ' + (payload.requestType || 'N/A') + '\n' +
                'Error Code: ' + errorCode + '\n' +
                'Error Category: ' + (errorInfo.category || payload.errorCategory || 'N/A') + '\n' +
                'Error Message: ' + errorMessage + '\n' +
                'Failed Step: ' + (errorInfo.failedStep || errorInfo.step || payload.failedStep || 'N/A') + '\n' +
                'Retry Count: ' + (errorInfo.retryCount || payload.retryCount || 0) + '\n' +
                'Timestamp: ' + (payload.timestamp || new GlideDateTime().getDisplayValue()) + '\n\n' +
                'Compensating Action: ' + (payload.compensatingAction || payload.compensatingActionTaken || 'None specified') + '\n' +
                'Recommended Action: ' + (payload.recommendedAction || 'Review and resolve manually'));

            // Set priority based on error severity
            incGr.setValue('priority', this.INCIDENT_PRIORITY_MAP[severity] || '3');
            incGr.setValue('impact', severity === 'CRITICAL' ? '1' : '2');
            incGr.setValue('urgency', severity === 'CRITICAL' ? '1' : '2');

            // Set category and subcategory
            incGr.setValue('category', 'Network');
            incGr.setValue('subcategory', 'Firewall');

            // Set assignment group
            const assignmentGroup = gs.getProperty('dfw.incident.assignment_group', this.DEFAULT_INCIDENT_GROUP);
            const groupGr = new GlideRecord('sys_user_group');
            groupGr.addQuery('name', assignmentGroup);
            groupGr.setLimit(1);
            groupGr.query();
            if (groupGr.next()) {
                incGr.setValue('assignment_group', groupGr.getUniqueValue());
            }

            // Link to caller and RITM
            incGr.setValue('caller_id', ritmGr.getValue('opened_by'));
            incGr.setValue('parent', ritmGr.getValue('request'));
            incGr.setValue('u_correlation_id', payload.correlationId);

            const incidentSysId = incGr.insert();

            // Update RITM with incident reference
            ritmGr.work_notes = '[DFW Automation] Incident ' +
                incGr.getValue('number') + ' created for automation failure.\n' +
                'Error: ' + errorCode + ' - ' +
                errorMessage.substring(0, 200);
            ritmGr.update();

            gs.info('VROCallbackHandler: Incident ' + incGr.getValue('number') +
                ' created for RITM ' + ritmNumber +
                '. Correlation ID: ' + payload.correlationId);

            return incidentSysId;

        } catch (e) {
            gs.error('VROCallbackHandler: Failed to create incident: ' +
                (e.getMessage ? e.getMessage() : String(e)));
            return null;
        }
    },

    // -----------------------------------------------------------------------
    // Private - Audit logging
    // -----------------------------------------------------------------------

    /**
     * Logs an audit entry for the callback processing.
     *
     * @private
     * @param {string} correlationId - The correlation ID.
     * @param {string} ritmNumber    - The RITM number.
     * @param {string} status        - The callback status (success/failure/partial_success).
     * @param {string} details       - Detailed log text.
     */
    _logAuditEntry: function (correlationId, ritmNumber, status, details) {
        try {
            const audit = new GlideRecord('u_dfw_audit_log');
            audit.initialize();
            audit.setValue('u_correlation_id', correlationId);
            audit.setValue('u_ritm_number', ritmNumber);
            audit.setValue('u_event_type', 'vro_callback');
            audit.setValue('u_status', status);
            audit.setValue('u_details', details.substring(0, 4000));
            audit.setValue('u_timestamp', new GlideDateTime().getDisplayValue());
            audit.insert();
        } catch (e) {
            // Audit logging failure should not block callback processing
            gs.error('VROCallbackHandler: Failed to log audit entry: ' +
                (e.getMessage ? e.getMessage() : String(e)));
        }
    },

    /**
     * Type identifier for ServiceNow Script Include framework.
     * @type {string}
     */
    type: 'VROCallbackHandler'
};

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VROCallbackHandler;
}
