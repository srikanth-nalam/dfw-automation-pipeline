/**
 * @file SnowPayloadAdapter.js
 * @description Transforms ServiceNow (SNOW) catalog request payloads to the
 *   internal domain model and vice-versa. Handles both the inbound
 *   transformation (SNOW -> internal) and outbound callbacks (internal ->
 *   SNOW success/error payloads).
 *
 * Internal model shape:
 *   {
 *     correlationId, requestType,
 *     vm: { name, template, cluster, datastore, network, cpu, memory, disk },
 *     site, tags: {}, requestedBy, approvedBy,
 *     callbackUrl, callbackToken, priority
 *   }
 *
 * @module adapters/SnowPayloadAdapter
 */

'use strict';

/**
 * Required fields in the incoming SNOW payload.
 *
 * @constant {string[]}
 * @private
 */
const REQUIRED_SNOW_FIELDS = [
  'correlation_id',
  'request_type',
  'vm_name',
  'site',
  'callback_url'
];

/**
 * SnowPayloadAdapter provides bidirectional transformation between
 * ServiceNow REST payloads and the pipeline's internal domain model.
 *
 * All methods are designed to be used statically but the class is also
 * instantiable for potential future state (e.g. schema version tracking).
 *
 * @class SnowPayloadAdapter
 */
class SnowPayloadAdapter {
  /**
   * Transforms a raw ServiceNow catalog request payload into the
   * normalised internal domain model used throughout the pipeline.
   *
   * @param {Object} snowPayload - The inbound SNOW REST payload.
   * @returns {{
   *   correlationId: string,
   *   requestType: string,
   *   vm: {
   *     name: string,
   *     template: string,
   *     cluster: string,
   *     datastore: string,
   *     network: string,
   *     cpu: number,
   *     memory: number,
   *     disk: number
   *   },
   *   site: string,
   *   tags: Object,
   *   requestedBy: string,
   *   approvedBy: string,
   *   callbackUrl: string,
   *   callbackToken: string,
   *   priority: string
   * }}
   *
   * @throws {Error} When the payload is null or missing required fields.
   *
   * @example
   * const adapter = new SnowPayloadAdapter();
   * const internal = adapter.toInternalModel(snowPayload);
   */
  toInternalModel(snowPayload) {
    if (!snowPayload || typeof snowPayload !== 'object') {
      throw new Error(
        '[DFW-3001] SNOW payload must be a non-null object.'
      );
    }

    // Validate required fields
    const missing = REQUIRED_SNOW_FIELDS.filter(
      field => snowPayload[field] === undefined ||
               snowPayload[field] === null ||
               snowPayload[field] === ''
    );

    if (missing.length > 0) {
      throw new Error(
        `[DFW-3001] SNOW payload missing required field(s): ${missing.join(', ')}.`
      );
    }

    // Extract and normalise VM specification
    const vm = {
      name: SnowPayloadAdapter._trimString(snowPayload.vm_name),
      template: SnowPayloadAdapter._trimString(snowPayload.vm_template || ''),
      cluster: SnowPayloadAdapter._trimString(snowPayload.vm_cluster || snowPayload.cluster || ''),
      datastore: SnowPayloadAdapter._trimString(snowPayload.vm_datastore || snowPayload.datastore || ''),
      network: SnowPayloadAdapter._trimString(snowPayload.vm_network || snowPayload.network || ''),
      cpu: SnowPayloadAdapter._parsePositiveInt(snowPayload.vm_cpu || snowPayload.cpu, 0),
      memory: SnowPayloadAdapter._parsePositiveInt(snowPayload.vm_memory || snowPayload.memory, 0),
      disk: SnowPayloadAdapter._parsePositiveInt(snowPayload.vm_disk || snowPayload.disk, 0)
    };

    // Extract tags — SNOW may send them as a flat object or nested under a key
    const rawTags = snowPayload.tags || snowPayload.vm_tags || {};
    const tags = typeof rawTags === 'object' && !Array.isArray(rawTags)
      ? { ...rawTags }
      : {};

    return {
      correlationId: SnowPayloadAdapter._trimString(snowPayload.correlation_id),
      requestType: SnowPayloadAdapter._trimString(snowPayload.request_type),
      vm,
      site: SnowPayloadAdapter._trimString(snowPayload.site).toUpperCase(),
      tags,
      requestedBy: SnowPayloadAdapter._trimString(snowPayload.requested_by || snowPayload.requestedBy || ''),
      approvedBy: SnowPayloadAdapter._trimString(snowPayload.approved_by || snowPayload.approvedBy || ''),
      callbackUrl: SnowPayloadAdapter._trimString(snowPayload.callback_url),
      callbackToken: SnowPayloadAdapter._trimString(snowPayload.callback_token || snowPayload.callbackToken || ''),
      priority: SnowPayloadAdapter._trimString(snowPayload.priority || 'normal').toLowerCase()
    };
  }

  /**
   * Transforms an internal pipeline result into the SNOW success callback
   * payload format.
   *
   * @param {Object} internalResult - The pipeline execution result.
   * @param {string} internalResult.correlationId - Request correlation ID.
   * @param {string} [internalResult.status='completed'] - Final status.
   * @param {Object} [internalResult.vm] - VM details.
   * @param {Object} [internalResult.tags] - Applied tags.
   * @param {string[]} [internalResult.completedSteps] - Ordered list of steps.
   * @returns {{
   *   correlation_id: string,
   *   status: string,
   *   result: string,
   *   vm_name: string,
   *   completion_time: string,
   *   details: Object
   * }}
   *
   * @throws {Error} When internalResult is null or missing correlationId.
   *
   * @example
   * const callback = adapter.toCallbackPayload(result);
   * // POST to SNOW callback URL
   */
  toCallbackPayload(internalResult) {
    if (!internalResult || typeof internalResult !== 'object') {
      throw new Error(
        '[DFW-3002] Internal result must be a non-null object.'
      );
    }

    if (!internalResult.correlationId) {
      throw new Error(
        '[DFW-3002] Internal result must include a correlationId.'
      );
    }

    return {
      correlation_id: internalResult.correlationId,
      status: internalResult.status || 'completed',
      result: 'success',
      vm_name: internalResult.vm ? internalResult.vm.name || '' : '',
      completion_time: new Date().toISOString(),
      details: {
        tags_applied: internalResult.tags || {},
        completed_steps: Array.isArray(internalResult.completedSteps)
          ? internalResult.completedSteps
          : [],
        site: internalResult.site || '',
        request_type: internalResult.requestType || '',
        additional_info: internalResult.additionalInfo || {}
      }
    };
  }

  /**
   * Transforms an error into the SNOW failure callback payload format.
   * Provides structured error information including error code, category,
   * failed step, retry count, and suggested compensating action.
   *
   * @param {Error|Object} error - The error that occurred. May be a standard
   *   Error with `code` and `context` properties, or a plain object.
   * @returns {{
   *   correlation_id: string,
   *   status: string,
   *   result: string,
   *   errorCode: string,
   *   errorCategory: string,
   *   errorMessage: string,
   *   failedStep: string,
   *   retryCount: number,
   *   compensatingAction: string,
   *   completion_time: string
   * }}
   *
   * @example
   * try {
   *   await pipeline.execute(request);
   * } catch (err) {
   *   const callback = adapter.toErrorCallback(err);
   *   await snowClient.post(callbackUrl, callback);
   * }
   */
  toErrorCallback(error) {
    if (!error) {
      return {
        correlation_id: '',
        status: 'failed',
        result: 'failure',
        errorCode: 'DFW-9999',
        errorCategory: 'UNKNOWN',
        errorMessage: 'An unknown error occurred.',
        failedStep: 'unknown',
        retryCount: 0,
        compensatingAction: 'Manual investigation required.',
        completion_time: new Date().toISOString()
      };
    }

    const isErrorInstance = error instanceof Error;
    const message = isErrorInstance ? error.message : String(error.message || error);
    const code = error.code || SnowPayloadAdapter._extractErrorCode(message);
    const context = error.context || {};

    return {
      correlation_id: context.correlationId || error.correlationId || '',
      status: 'failed',
      result: 'failure',
      errorCode: code || 'DFW-9999',
      errorCategory: SnowPayloadAdapter._categorizeError(code),
      errorMessage: message,
      failedStep: context.step || error.step || SnowPayloadAdapter._inferFailedStep(code),
      retryCount: typeof context.retryCount === 'number'
        ? context.retryCount
        : (typeof error.retryCount === 'number' ? error.retryCount : 0),
      compensatingAction: SnowPayloadAdapter._suggestCompensation(code),
      completion_time: new Date().toISOString()
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Safely trims a string value.
   *
   * @private
   * @param {*} value
   * @returns {string}
   */
  static _trimString(value) {
    return typeof value === 'string' ? value.trim() : String(value || '').trim();
  }

  /**
   * Parses a value as a positive integer, returning a default on failure.
   *
   * @private
   * @param {*} value
   * @param {number} defaultValue
   * @returns {number}
   */
  static _parsePositiveInt(value, defaultValue) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
  }

  /**
   * Extracts a DFW error code from an error message string.
   *
   * @private
   * @param {string} message
   * @returns {string}
   */
  static _extractErrorCode(message) {
    if (typeof message !== 'string') {
      return 'DFW-9999';
    }
    const match = message.match(/DFW-\d{4}/);
    return match ? match[0] : 'DFW-9999';
  }

  /**
   * Maps a DFW error code to a human-readable error category.
   *
   * @private
   * @param {string} code
   * @returns {string}
   */
  static _categorizeError(code) {
    if (!code || typeof code !== 'string') {
      return 'UNKNOWN';
    }

    const codeNum = parseInt(code.replace('DFW-', ''), 10);

    if (codeNum >= 1000 && codeNum < 2000) {
      return 'VALIDATION';
    }
    if (codeNum >= 2000 && codeNum < 3000) {
      return 'TAGGING';
    }
    if (codeNum >= 3000 && codeNum < 4000) {
      return 'INTEGRATION';
    }
    if (codeNum >= 4000 && codeNum < 5000) {
      return 'CONFIGURATION';
    }
    if (codeNum >= 5000 && codeNum < 6000) {
      return 'CONNECTIVITY';
    }
    if (codeNum >= 6000 && codeNum < 7000) {
      return 'SECURITY_GROUP';
    }
    if (codeNum >= 7000 && codeNum < 8000) {
      return 'DFW_POLICY';
    }
    if (codeNum >= 8000 && codeNum < 9000) {
      return 'DEPLOYMENT';
    }
    if (codeNum >= 9000) {
      return 'SYSTEM';
    }

    return 'UNKNOWN';
  }

  /**
   * Infers the pipeline step that failed based on error code.
   *
   * @private
   * @param {string} code
   * @returns {string}
   */
  static _inferFailedStep(code) {
    if (!code || typeof code !== 'string') {
      return 'unknown';
    }

    const codeNum = parseInt(code.replace('DFW-', ''), 10);

    if (codeNum >= 1000 && codeNum < 2000) {
      return 'input-validation';
    }
    if (codeNum >= 2000 && codeNum < 3000) {
      return 'tag-assignment';
    }
    if (codeNum >= 3000 && codeNum < 4000) {
      return 'snow-integration';
    }
    if (codeNum >= 4000 && codeNum < 5000) {
      return 'configuration-load';
    }
    if (codeNum >= 5000 && codeNum < 6000) {
      return 'api-connectivity';
    }
    if (codeNum >= 6000 && codeNum < 7000) {
      return 'security-group-assignment';
    }
    if (codeNum >= 7000 && codeNum < 8000) {
      return 'dfw-policy-validation';
    }
    if (codeNum >= 8000 && codeNum < 9000) {
      return 'policy-deployment';
    }

    return 'unknown';
  }

  /**
   * Suggests a compensating action based on the error code.
   *
   * @private
   * @param {string} code
   * @returns {string}
   */
  static _suggestCompensation(code) {
    if (!code || typeof code !== 'string') {
      return 'Manual investigation required.';
    }

    const codeNum = parseInt(code.replace('DFW-', ''), 10);

    if (codeNum >= 1000 && codeNum < 2000) {
      return 'Correct the input payload and resubmit the request.';
    }
    if (codeNum >= 2000 && codeNum < 3000) {
      return 'Verify tag categories exist in vCenter and retry tag assignment.';
    }
    if (codeNum >= 3000 && codeNum < 4000) {
      return 'Check ServiceNow connectivity and callback URL validity.';
    }
    if (codeNum >= 4000 && codeNum < 5000) {
      return 'Verify site configuration and endpoint URLs.';
    }
    if (codeNum >= 5000 && codeNum < 6000) {
      return 'Check network connectivity to NSX/vCenter endpoints and retry.';
    }
    if (codeNum >= 6000 && codeNum < 7000) {
      return 'Verify security group exists and has correct membership criteria.';
    }
    if (codeNum >= 7000 && codeNum < 8000) {
      return 'Review DFW policy rules and re-run validation.';
    }
    if (codeNum >= 8000 && codeNum < 9000) {
      return 'Check policy definition for conflicts, then redeploy or rollback.';
    }

    return 'Manual investigation required.';
  }
}

module.exports = SnowPayloadAdapter;
