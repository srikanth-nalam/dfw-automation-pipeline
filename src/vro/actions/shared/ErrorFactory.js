/**
 * @file ErrorFactory.js
 * @description Creates structured error objects matching the DFW Automation
 *   Pipeline BRD error taxonomy. Every error includes a unique DFW code,
 *   category, HTTP status, human-readable message, the failed pipeline step,
 *   and a retry count. Also provides a method to build SNOW callback payloads
 *   from errors.
 *
 *   Error code ranges:
 *   - **DFW-4xxx** — Input validation errors (HTTP 400)
 *   - **DFW-5xxx** — Authentication / authorisation errors (HTTP 401/403)
 *   - **DFW-6xxx** — Connectivity / availability errors (HTTP 503/504)
 *   - **DFW-7xxx** — Infrastructure / processing errors (HTTP 500)
 *   - **DFW-8xxx** — Partial success (HTTP 207)
 *   - **DFW-9xxx** — Unknown / unclassified errors (HTTP 500)
 *
 * @module shared/ErrorFactory
 */

'use strict';

/**
 * Complete error taxonomy as defined in the BRD.
 * Each entry maps a DFW error code to its category, HTTP status, and default message.
 *
 * @constant {Object.<string, { category: string, httpStatus: number, defaultMessage: string }>}
 */
const ERROR_TAXONOMY = {
  // --- Input Validation (4xx client errors) ---
  'DFW-4001': {
    category: 'INPUT_VALIDATION',
    httpStatus: 400,
    defaultMessage: 'Missing required field in request payload'
  },
  'DFW-4002': {
    category: 'INPUT_VALIDATION',
    httpStatus: 400,
    defaultMessage: 'Invalid tag value — not present in Enterprise Tag Dictionary'
  },
  'DFW-4003': {
    category: 'INPUT_VALIDATION',
    httpStatus: 400,
    defaultMessage: 'Conflicting tag combination'
  },
  'DFW-4004': {
    category: 'INPUT_VALIDATION',
    httpStatus: 400,
    defaultMessage: 'Invalid site value — must be NDCNG or TULNG'
  },
  'DFW-4005': {
    category: 'INPUT_VALIDATION',
    httpStatus: 400,
    defaultMessage: 'VM name format does not match naming convention'
  },
  'DFW-4006': {
    category: 'INPUT_VALIDATION',
    httpStatus: 400,
    defaultMessage: 'Duplicate single-value tag categories in input payload'
  },

  // --- Authentication / Authorisation ---
  'DFW-5001': {
    category: 'AUTHENTICATION',
    httpStatus: 401,
    defaultMessage: 'vRO service account authentication failed for vCenter API'
  },
  'DFW-5002': {
    category: 'AUTHENTICATION',
    httpStatus: 401,
    defaultMessage: 'vRO service account authentication failed for NSX Manager API'
  },
  'DFW-5003': {
    category: 'AUTHENTICATION',
    httpStatus: 403,
    defaultMessage: 'Insufficient permissions: vCenter VAPI tag operation denied'
  },
  'DFW-5004': {
    category: 'AUTHENTICATION',
    httpStatus: 403,
    defaultMessage: 'Insufficient permissions: NSX Manager tag operation denied'
  },

  // --- Connectivity / Availability ---
  'DFW-6001': {
    category: 'CONNECTIVITY',
    httpStatus: 503,
    defaultMessage: 'vCenter API endpoint unreachable'
  },
  'DFW-6002': {
    category: 'CONNECTIVITY',
    httpStatus: 503,
    defaultMessage: 'NSX Manager API endpoint unreachable'
  },
  'DFW-6003': {
    category: 'CONNECTIVITY',
    httpStatus: 503,
    defaultMessage: 'NSX Manager returned 503 after all retries'
  },
  'DFW-6004': {
    category: 'CONNECTIVITY',
    httpStatus: 503,
    defaultMessage: 'Circuit breaker open: calls to endpoint suspended'
  },
  'DFW-6005': {
    category: 'CONNECTIVITY',
    httpStatus: 504,
    defaultMessage: 'Gateway timeout on NSX Federation Global Manager API'
  },

  // --- Infrastructure / Processing ---
  'DFW-7001': {
    category: 'INFRASTRUCTURE',
    httpStatus: 500,
    defaultMessage: 'VM provisioning failed in vCenter'
  },
  'DFW-7002': {
    category: 'INFRASTRUCTURE',
    httpStatus: 500,
    defaultMessage: 'VMware Tools did not become ready within timeout period'
  },
  'DFW-7003': {
    category: 'INFRASTRUCTURE',
    httpStatus: 500,
    defaultMessage: 'Tag application failed in vCenter (VAPI error)'
  },
  'DFW-7004': {
    category: 'INFRASTRUCTURE',
    httpStatus: 500,
    defaultMessage: 'NSX tag propagation verification timeout'
  },
  'DFW-7005': {
    category: 'INFRASTRUCTURE',
    httpStatus: 500,
    defaultMessage: 'Dynamic Security Group membership not confirmed'
  },
  'DFW-7006': {
    category: 'INFRASTRUCTURE',
    httpStatus: 500,
    defaultMessage: 'DFW rule validation failed'
  },
  'DFW-7007': {
    category: 'INFRASTRUCTURE',
    httpStatus: 500,
    defaultMessage: 'Orphaned DFW rule detected during decommission'
  },

  // --- Partial Success ---
  'DFW-8001': {
    category: 'PARTIAL_SUCCESS',
    httpStatus: 207,
    defaultMessage: 'Tag applied in vCenter but propagation to NSX not confirmed'
  },
  'DFW-8002': {
    category: 'PARTIAL_SUCCESS',
    httpStatus: 207,
    defaultMessage: 'Some but not all VMs in bulk operation completed'
  },
  'DFW-8003': {
    category: 'PARTIAL_SUCCESS',
    httpStatus: 207,
    defaultMessage: 'VM decommissioned but orphaned rule cleanup incomplete'
  },

  // --- Unknown ---
  'DFW-9001': {
    category: 'UNKNOWN',
    httpStatus: 500,
    defaultMessage: 'Unclassified error'
  }
};

/**
 * DfwError extends the native Error with structured fields required by the
 * pipeline's error handling contract.
 *
 * @class DfwError
 * @extends Error
 */
class DfwError extends Error {
  /**
   * @param {Object} params                    - Error parameters.
   * @param {string} params.code               - DFW error code (e.g. `'DFW-4001'`).
   * @param {string} params.category           - Error category.
   * @param {number} params.httpStatus         - Corresponding HTTP status code.
   * @param {string} params.message            - Human-readable message.
   * @param {string} [params.failedStep='']    - Pipeline step where the error occurred.
   * @param {number} [params.retryCount=0]     - Number of retries attempted.
   * @param {*}      [params.details]          - Additional structured context.
   */
  constructor({ code, category, httpStatus, message, failedStep, retryCount, details }) {
    super(message);
    this.name = 'DfwError';
    /** @type {string} */
    this.code = code;
    /** @type {string} */
    this.category = category;
    /** @type {number} */
    this.httpStatus = httpStatus;
    /** @type {string} */
    this.failedStep = failedStep || '';
    /** @type {number} */
    this.retryCount = retryCount || 0;
    /** @type {*} */
    this.details = details || null;
    /** @type {string} */
    this.timestamp = new Date().toISOString();

    // Maintains proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DfwError);
    }
  }

  /**
   * Returns a plain-object representation suitable for JSON serialisation.
   *
   * @returns {Object}
   */
  toJSON() {
    return {
      code: this.code,
      category: this.category,
      httpStatus: this.httpStatus,
      message: this.message,
      failedStep: this.failedStep,
      retryCount: this.retryCount,
      details: this.details,
      timestamp: this.timestamp
    };
  }
}

/**
 * ErrorFactory is the single point of creation for structured DFW errors and
 * SNOW callback payloads. It ensures every error in the pipeline conforms to
 * the BRD error taxonomy.
 *
 * @class ErrorFactory
 *
 * @example
 * const error = ErrorFactory.createError('DFW-4001', 'Field "vmName" is missing', 'PayloadValidation', 0);
 * throw error;
 *
 * @example
 * const callbackPayload = ErrorFactory.createCallbackPayload(
 *   'RITM-12345-1679000000000',
 *   error,
 *   'Retry tag application manually via ServiceNow'
 * );
 */
class ErrorFactory {
  /**
   * Creates a structured DfwError.
   *
   * If the supplied `code` exists in the taxonomy, the category and HTTP status
   * are automatically populated. An unrecognised code falls back to DFW-9001
   * (UNKNOWN / 500).
   *
   * @param {string}  code                    - DFW error code (e.g. `'DFW-4001'`).
   * @param {string}  [message]               - Human-readable error message. If
   *                                            omitted, the taxonomy's default
   *                                            message is used.
   * @param {string}  [failedStep='']         - Pipeline step where the error
   *                                            occurred.
   * @param {number}  [retryCount=0]          - Number of retry attempts made
   *                                            before this error was raised.
   * @param {*}       [details]               - Optional additional context.
   * @returns {DfwError} A fully-populated DfwError instance.
   *
   * @example
   * const err = ErrorFactory.createError('DFW-6002', 'NSX at tulng unreachable', 'NSXConnect', 3);
   * // err.code       === 'DFW-6002'
   * // err.category   === 'CONNECTIVITY'
   * // err.httpStatus === 503
   */
  static createError(code, message, failedStep, retryCount, details) {
    const taxonomy = ERROR_TAXONOMY[code] || ERROR_TAXONOMY['DFW-9001'];
    const resolvedCode = ERROR_TAXONOMY[code] ? code : 'DFW-9001';

    return new DfwError({
      code: resolvedCode,
      category: taxonomy.category,
      httpStatus: taxonomy.httpStatus,
      message: message || taxonomy.defaultMessage,
      failedStep: failedStep || '',
      retryCount: retryCount || 0,
      details: details || null
    });
  }

  /**
   * Builds a callback payload to send back to ServiceNow when a pipeline
   * execution encounters an error. The payload includes the correlation ID,
   * structured error details, a compensating action recommendation, and a
   * timestamp.
   *
   * @param {string}    correlationId       - The pipeline correlation ID.
   * @param {DfwError|Error|Object} error   - The error to include. If a plain
   *                                          Error, it is wrapped with DFW-9001.
   * @param {string}    [compensatingAction=''] - A human-readable description of
   *                                          the recommended compensating action.
   * @returns {{ correlationId: string, status: string, error: Object,
   *   compensatingAction: string, timestamp: string }}
   *   A structured callback payload ready for HTTP POST to the SNOW callback URL.
   *
   * @example
   * const payload = ErrorFactory.createCallbackPayload(
   *   'RITM-12345-1679000000000',
   *   ErrorFactory.createError('DFW-7003', 'VAPI returned 500'),
   *   'Retry tag application via the vCenter UI'
   * );
   */
  static createCallbackPayload(correlationId, error, compensatingAction) {
    let structuredError;

    if (error instanceof DfwError) {
      structuredError = error.toJSON();
    } else if (error && typeof error === 'object' && error.code && ERROR_TAXONOMY[error.code]) {
      // Already structured but not a DfwError instance
      structuredError = {
        code: error.code,
        category: error.category || ERROR_TAXONOMY[error.code].category,
        httpStatus: error.httpStatus || ERROR_TAXONOMY[error.code].httpStatus,
        message: error.message || ERROR_TAXONOMY[error.code].defaultMessage,
        failedStep: error.failedStep || '',
        retryCount: error.retryCount || 0,
        details: error.details || null,
        timestamp: error.timestamp || new Date().toISOString()
      };
    } else {
      // Wrap unknown errors
      const wrapped = ErrorFactory.createError(
        'DFW-9001',
        error && error.message ? error.message : 'Unknown error',
        error && error.failedStep ? error.failedStep : '',
        error && error.retryCount ? error.retryCount : 0
      );
      structuredError = wrapped.toJSON();
    }

    // Determine overall status from category
    const status = ErrorFactory._resolveStatus(structuredError.category);

    return {
      correlationId: correlationId || '',
      status,
      error: structuredError,
      compensatingAction: compensatingAction || '',
      timestamp: new Date().toISOString()
    };
  }

  // ---------------------------------------------------------------------------
  // Lookup helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the taxonomy entry for a given DFW error code.
   *
   * @param {string} code - DFW error code.
   * @returns {{ category: string, httpStatus: number, defaultMessage: string }|null}
   *   The taxonomy entry, or `null` if the code is not recognised.
   */
  static getTaxonomy(code) {
    return ERROR_TAXONOMY[code] || null;
  }

  /**
   * Returns all registered error codes.
   *
   * @returns {string[]} Array of DFW error code strings.
   */
  static getAllCodes() {
    return Object.keys(ERROR_TAXONOMY);
  }

  /**
   * Returns all error codes within a given category.
   *
   * @param {string} category - Category name (e.g. `'CONNECTIVITY'`).
   * @returns {string[]} Array of matching DFW error codes.
   */
  static getCodesByCategory(category) {
    return Object.entries(ERROR_TAXONOMY)
      .filter(([, entry]) => entry.category === category)
      .map(([code]) => code);
  }

  /**
   * Checks whether a given code represents a retryable error.
   * Connectivity and infrastructure errors are generally retryable;
   * input validation and authentication errors are not.
   *
   * @param {string} code - DFW error code.
   * @returns {boolean} `true` if the error is retryable.
   */
  static isRetryable(code) {
    const taxonomy = ERROR_TAXONOMY[code];
    if (!taxonomy) {
      return false;
    }
    return ['CONNECTIVITY', 'INFRASTRUCTURE'].includes(taxonomy.category);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Maps an error category to a callback status string.
   *
   * @private
   * @static
   * @param {string} category - Error category.
   * @returns {string} Status string for the callback payload.
   */
  static _resolveStatus(category) {
    switch (category) {
      case 'PARTIAL_SUCCESS':
        return 'PARTIAL_SUCCESS';
      case 'INPUT_VALIDATION':
        return 'FAILED_VALIDATION';
      case 'AUTHENTICATION':
        return 'FAILED_AUTH';
      case 'CONNECTIVITY':
        return 'FAILED_CONNECTIVITY';
      case 'INFRASTRUCTURE':
        return 'FAILED_INFRASTRUCTURE';
      default:
        return 'FAILED';
    }
  }
}

/** Expose the taxonomy for external introspection. */
ErrorFactory.ERROR_TAXONOMY = ERROR_TAXONOMY;

/** Expose the DfwError class for instanceof checks. */
ErrorFactory.DfwError = DfwError;

module.exports = ErrorFactory;
