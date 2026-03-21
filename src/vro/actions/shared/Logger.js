/**
 * @file Logger.js
 * @description Structured JSON logger for the DFW Automation Pipeline.
 *   Every log line is emitted as a single-line JSON object containing a
 *   timestamp, severity level, correlation ID, pipeline step, message, and
 *   optional metadata. This format enables downstream consumption by
 *   Splunk, ELK, or any JSON-capable log aggregator.
 *
 * @module shared/Logger
 */

'use strict';

/**
 * Ordered severity levels. The numeric value is used for threshold comparison;
 * only messages at or above the configured minimum level are emitted.
 *
 * @enum {number}
 * @readonly
 */
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

/**
 * Maps a severity name string to a console method.
 *
 * @constant {Object.<string, Function>}
 * @private
 */
const CONSOLE_METHODS = {
  DEBUG: console.debug,
  INFO: console.info,
  WARN: console.warn,
  ERROR: console.error
};

/**
 * Structured JSON logger.
 *
 * Usage:
 * ```js
 * const Logger = require('./Logger');
 * const log = new Logger({ step: 'TagValidation', minLevel: 'DEBUG' });
 * log.info('Validation started', { vmName: 'srv-web-01' });
 * ```
 *
 * Each call emits a JSON string to the appropriate `console.*` method:
 * ```json
 * {"timestamp":"2026-03-21T12:00:00.000Z","level":"INFO","correlationId":"","step":"TagValidation","message":"Validation started","metadata":{"vmName":"srv-web-01"}}
 * ```
 *
 * @class Logger
 */
class Logger {
  /**
   * Creates a new Logger instance.
   *
   * @param {Object}  [options={}]               - Logger configuration.
   * @param {string}  [options.correlationId='']  - Correlation ID to attach to every log entry.
   * @param {string}  [options.step='']           - Pipeline step label (e.g. `'TagValidation'`).
   * @param {string}  [options.minLevel='INFO']   - Minimum severity level to emit. One of
   *                                                `'DEBUG'`, `'INFO'`, `'WARN'`, `'ERROR'`.
   * @param {Object}  [options.defaultMetadata={}] - Key-value pairs merged into every log entry's
   *                                                 metadata field.
   */
  constructor(options = {}) {
    /** @private */
    this._correlationId = options.correlationId || '';
    /** @private */
    this._step = options.step || '';
    /** @private */
    this._minLevel = Logger._resolveLevel(options.minLevel);
    /** @private */
    this._defaultMetadata = options.defaultMetadata || {};
  }

  // ---------------------------------------------------------------------------
  // Public API — log methods
  // ---------------------------------------------------------------------------

  /**
   * Logs a message at DEBUG level.
   *
   * @param {string} message - Human-readable log message.
   * @param {Object} [metadata={}] - Arbitrary key-value metadata to include.
   * @returns {void}
   */
  debug(message, metadata = {}) {
    this._emit('DEBUG', message, metadata);
  }

  /**
   * Logs a message at INFO level.
   *
   * @param {string} message - Human-readable log message.
   * @param {Object} [metadata={}] - Arbitrary key-value metadata to include.
   * @returns {void}
   */
  info(message, metadata = {}) {
    this._emit('INFO', message, metadata);
  }

  /**
   * Logs a message at WARN level.
   *
   * @param {string} message - Human-readable log message.
   * @param {Object} [metadata={}] - Arbitrary key-value metadata to include.
   * @returns {void}
   */
  warn(message, metadata = {}) {
    this._emit('WARN', message, metadata);
  }

  /**
   * Logs a message at ERROR level.
   *
   * @param {string} message - Human-readable log message.
   * @param {Object} [metadata={}] - Arbitrary key-value metadata to include.
   *   If an `Error` instance is supplied, its `message`, `stack`, and `code`
   *   properties are automatically extracted into the metadata.
   * @returns {void}
   */
  error(message, metadata = {}) {
    const enriched = Logger._enrichErrorMetadata(metadata);
    this._emit('ERROR', message, enriched);
  }

  // ---------------------------------------------------------------------------
  // Public API — context propagation
  // ---------------------------------------------------------------------------

  /**
   * Returns a new Logger instance bound to the specified correlation ID.
   * All other settings (step, minLevel, defaultMetadata) are carried over.
   *
   * @param {string} correlationId - The correlation ID to bind.
   * @returns {Logger} A new Logger instance with the given correlation ID.
   *
   * @example
   * const child = logger.withCorrelation('RITM-12345-1679000000000');
   * child.info('Processing started');
   */
  withCorrelation(correlationId) {
    return new Logger({
      correlationId,
      step: this._step,
      minLevel: this._getLevelName(),
      defaultMetadata: { ...this._defaultMetadata }
    });
  }

  /**
   * Returns a new Logger instance bound to the specified pipeline step.
   *
   * @param {string} step - Pipeline step name.
   * @returns {Logger} A new Logger instance with the given step.
   */
  withStep(step) {
    return new Logger({
      correlationId: this._correlationId,
      step,
      minLevel: this._getLevelName(),
      defaultMetadata: { ...this._defaultMetadata }
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Builds the JSON log entry and writes it to the console.
   *
   * @private
   * @param {string} level    - Severity level name.
   * @param {string} message  - Log message.
   * @param {Object} metadata - Metadata object.
   * @returns {void}
   */
  _emit(level, message, metadata) {
    if (LOG_LEVELS[level] < this._minLevel) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      correlationId: this._correlationId,
      step: this._step,
      message: String(message),
      metadata: { ...this._defaultMetadata, ...metadata }
    };

    const json = Logger._safeStringify(entry);
    const consoleFn = CONSOLE_METHODS[level] || console.log;
    consoleFn.call(console, json);
  }

  /**
   * Returns the string name for the current minimum level.
   *
   * @private
   * @returns {string}
   */
  _getLevelName() {
    for (const [name, value] of Object.entries(LOG_LEVELS)) {
      if (value === this._minLevel) {
        return name;
      }
    }
    return 'INFO';
  }

  /**
   * Resolves a level name string to its numeric value.
   *
   * @private
   * @static
   * @param {string} [levelName='INFO'] - Level name.
   * @returns {number} Numeric severity value.
   */
  static _resolveLevel(levelName) {
    if (typeof levelName === 'string') {
      const upper = levelName.toUpperCase().trim();
      if (LOG_LEVELS[upper] !== undefined) {
        return LOG_LEVELS[upper];
      }
    }
    return LOG_LEVELS.INFO;
  }

  /**
   * If the metadata is (or contains) an Error instance, extract useful
   * properties into a plain object.
   *
   * @private
   * @static
   * @param {Object|Error} metadata - Raw metadata.
   * @returns {Object} Enriched metadata object.
   */
  static _enrichErrorMetadata(metadata) {
    if (metadata instanceof Error) {
      return {
        errorMessage: metadata.message,
        errorCode: metadata.code || undefined,
        stack: metadata.stack
      };
    }
    if (metadata && metadata.error instanceof Error) {
      return {
        ...metadata,
        error: {
          errorMessage: metadata.error.message,
          errorCode: metadata.error.code || undefined,
          stack: metadata.error.stack
        }
      };
    }
    return metadata;
  }

  /**
   * Safely converts an object to a JSON string, handling circular references.
   *
   * @private
   * @static
   * @param {*} obj - Value to serialise.
   * @returns {string} JSON string.
   */
  static _safeStringify(obj) {
    try {
      return JSON.stringify(obj);
    } catch (_err) {
      // Fallback for circular structures
      const seen = new WeakSet();
      return JSON.stringify(obj, (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular]';
          }
          seen.add(value);
        }
        return value;
      });
    }
  }
}

/** Expose level constants for external use. */
Logger.LOG_LEVELS = LOG_LEVELS;

module.exports = Logger;
