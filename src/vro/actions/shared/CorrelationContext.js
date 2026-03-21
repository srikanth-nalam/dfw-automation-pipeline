/**
 * @file CorrelationContext.js
 * @description Generates and propagates correlation IDs for the DFW
 *   Automation Pipeline. Each pipeline run is assigned a unique correlation ID
 *   with the format `RITM-{number}-{epochTimestamp}` that is threaded through
 *   every log entry, HTTP header, and callback payload.
 *
 *   Because Node.js (and the vRO Rhino runtime) is single-threaded, a
 *   module-level variable provides thread-local-like semantics without the
 *   complexity of `AsyncLocalStorage`.
 *
 * @module shared/CorrelationContext
 */

'use strict';

/**
 * Module-level variable holding the current correlation ID.
 * Serves as a thread-local equivalent in a single-threaded runtime.
 *
 * @type {string|null}
 * @private
 */
let _currentCorrelationId = null;

/**
 * Module-level variable holding the RITM number component for reference.
 *
 * @type {string|null}
 * @private
 */
let _currentRitmNumber = null;

/**
 * Module-level variable holding the creation timestamp.
 *
 * @type {number|null}
 * @private
 */
let _createdAt = null;

/**
 * The HTTP header name used to propagate the correlation ID between services.
 *
 * @constant {string}
 */
const CORRELATION_HEADER = 'X-Correlation-ID';

/**
 * Regular expression for validating the correlation ID format.
 *
 * @constant {RegExp}
 */
const CORRELATION_ID_PATTERN = /^RITM-\d+-\d+$/;

/**
 * CorrelationContext provides static methods for creating, retrieving, and
 * clearing correlation IDs within a single pipeline execution.
 *
 * Typical lifecycle:
 * ```js
 * CorrelationContext.create('12345');           // => 'RITM-12345-1679000000000'
 * CorrelationContext.get();                      // => 'RITM-12345-1679000000000'
 * CorrelationContext.getHeaders();               // => { 'X-Correlation-ID': '...' }
 * CorrelationContext.clear();                    // resets to null
 * ```
 *
 * @class CorrelationContext
 */
class CorrelationContext {
  /**
   * Creates and stores a new correlation ID.
   *
   * @param {string|number} ritmNumber - The ServiceNow RITM number (numeric
   *   portion only, e.g. `'12345'` or `12345`).
   * @returns {string} The generated correlation ID in the format
   *   `RITM-{ritmNumber}-{epochTimestamp}`.
   * @throws {Error} If `ritmNumber` is not a valid positive integer or
   *   numeric string.
   *
   * @example
   * const id = CorrelationContext.create('100234');
   * // => 'RITM-100234-1679000000000'
   */
  static create(ritmNumber) {
    const normalised = CorrelationContext._normaliseRitmNumber(ritmNumber);
    const timestamp = Date.now();
    const correlationId = `RITM-${normalised}-${timestamp}`;

    _currentCorrelationId = correlationId;
    _currentRitmNumber = normalised;
    _createdAt = timestamp;

    return correlationId;
  }

  /**
   * Retrieves the current correlation ID.
   *
   * @returns {string|null} The active correlation ID, or `null` if none has
   *   been created or the context has been cleared.
   *
   * @example
   * const id = CorrelationContext.get();
   * if (id) {
   *   logger.info('Processing', { correlationId: id });
   * }
   */
  static get() {
    return _currentCorrelationId;
  }

  /**
   * Returns an HTTP headers object suitable for passing the correlation ID
   * to downstream services.
   *
   * @returns {Object.<string, string>} An object with the
   *   `X-Correlation-ID` header set to the current correlation ID. If no
   *   correlation ID exists, the header value is an empty string.
   *
   * @example
   * const headers = {
   *   'Content-Type': 'application/json',
   *   ...CorrelationContext.getHeaders()
   * };
   */
  static getHeaders() {
    return {
      [CORRELATION_HEADER]: _currentCorrelationId || ''
    };
  }

  /**
   * Clears the current correlation context. Should be called at the end of
   * each pipeline execution to avoid leaking state between runs.
   *
   * @returns {void}
   *
   * @example
   * try {
   *   await pipeline.execute();
   * } finally {
   *   CorrelationContext.clear();
   * }
   */
  static clear() {
    _currentCorrelationId = null;
    _currentRitmNumber = null;
    _createdAt = null;
  }

  /**
   * Sets the correlation ID directly. Useful when the ID is received from an
   * incoming request header rather than generated locally.
   *
   * @param {string} correlationId - A pre-existing correlation ID to adopt.
   * @returns {string} The adopted correlation ID.
   * @throws {Error} If the supplied string does not match the expected
   *   `RITM-{number}-{timestamp}` format.
   *
   * @example
   * CorrelationContext.set(req.headers['x-correlation-id']);
   */
  static set(correlationId) {
    if (typeof correlationId !== 'string' || !CORRELATION_ID_PATTERN.test(correlationId)) {
      throw new Error(
        `Invalid correlation ID format: "${correlationId}". ` +
        'Expected format: RITM-{number}-{epochTimestamp}'
      );
    }

    _currentCorrelationId = correlationId;

    // Extract components
    const parts = correlationId.split('-');
    _currentRitmNumber = parts[1];
    _createdAt = parseInt(parts[2], 10);

    return correlationId;
  }

  /**
   * Returns the RITM number component of the current correlation ID.
   *
   * @returns {string|null} The RITM number, or `null` if no context exists.
   */
  static getRitmNumber() {
    return _currentRitmNumber;
  }

  /**
   * Returns the creation timestamp of the current correlation ID.
   *
   * @returns {number|null} Epoch milliseconds, or `null` if no context exists.
   */
  static getCreatedAt() {
    return _createdAt;
  }

  /**
   * Validates whether a string matches the correlation ID format.
   *
   * @param {string} value - The value to validate.
   * @returns {boolean} `true` if the value matches `RITM-{number}-{timestamp}`.
   */
  static isValid(value) {
    return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Normalises and validates a RITM number input.
   *
   * @private
   * @static
   * @param {string|number} ritmNumber - Raw RITM number input.
   * @returns {string} The validated numeric string.
   * @throws {Error} If the input is not a valid positive integer.
   */
  static _normaliseRitmNumber(ritmNumber) {
    const str = String(ritmNumber).trim();

    if (!/^\d+$/.test(str)) {
      throw new Error(
        `Invalid RITM number: "${ritmNumber}". Must be a positive integer or numeric string.`
      );
    }

    return str;
  }
}

/** Expose the header name constant. */
CorrelationContext.CORRELATION_HEADER = CORRELATION_HEADER;

/** Expose the pattern constant for external validation. */
CorrelationContext.CORRELATION_ID_PATTERN = CORRELATION_ID_PATTERN;

module.exports = CorrelationContext;
