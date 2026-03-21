/**
 * @file RetryHandler.js
 * @description Exponential backoff retry handler for the DFW Automation
 *   Pipeline. Wraps async operations with configurable retry logic, custom
 *   retry strategies, and structured logging of each attempt.
 *
 *   Default intervals: [5000, 15000, 45000] (5s, 15s, 45s).
 *   Default max retries: 3.
 *
 * @module shared/RetryHandler
 */

'use strict';

const Logger = require('./Logger');

/**
 * Default retry intervals in milliseconds.
 * Each index corresponds to the wait time before the Nth retry attempt.
 *
 * @constant {number[]}
 */
const DEFAULT_RETRY_INTERVALS = [5000, 15000, 45000];

/**
 * Default maximum number of retry attempts.
 *
 * @constant {number}
 */
const DEFAULT_MAX_RETRIES = 3;

/**
 * Default predicate that determines whether a failed attempt should be retried.
 * By default, all errors are retryable except those explicitly marked otherwise.
 *
 * @param {Error} error - The error thrown by the wrapped function.
 * @returns {boolean} `true` if the operation should be retried.
 */
const defaultShouldRetry = (error) => {
  // Do not retry client-side validation errors (4xx)
  if (error && typeof error.statusCode === 'number') {
    return error.statusCode >= 500 || error.statusCode === 429;
  }
  // Do not retry if explicitly marked non-retryable
  if (error && error.retryable === false) {
    return false;
  }
  return true;
};

/**
 * Sleep utility that returns a Promise resolved after `ms` milliseconds.
 *
 * @private
 * @param {number} ms - Duration in milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * RetryHandler implements the Strategy pattern for retry logic. Callers can
 * supply a custom retry strategy (an object with a `getDelay(attempt)` method)
 * or rely on the default interval-based backoff.
 *
 * @class RetryHandler
 *
 * @example
 * // Using the static convenience method
 * const result = await RetryHandler.execute(
 *   () => fetch('https://api.example.com/resource'),
 *   { retryIntervals: [1000, 3000, 9000], shouldRetry: (err) => err.statusCode >= 500 }
 * );
 *
 * @example
 * // Using a custom retry strategy
 * const strategy = {
 *   getDelay(attempt) { return Math.pow(2, attempt) * 1000; }
 * };
 * const result = await RetryHandler.execute(fetchData, { retryStrategy: strategy });
 */
class RetryHandler {
  /**
   * Creates a new RetryHandler instance.
   *
   * @param {Object}   [options={}]                  - Configuration options.
   * @param {number[]} [options.retryIntervals]       - Array of wait times in ms for
   *                                                    each retry attempt. Length implicitly
   *                                                    sets maxRetries if `maxRetries` is
   *                                                    not provided.
   * @param {number}   [options.maxRetries]           - Maximum number of retry attempts.
   *                                                    Defaults to `retryIntervals.length`
   *                                                    or `DEFAULT_MAX_RETRIES`.
   * @param {Function} [options.shouldRetry]          - Predicate `(error) => boolean`.
   *                                                    Return `true` to retry, `false` to
   *                                                    fail immediately.
   * @param {Object}   [options.retryStrategy]        - Strategy object with a
   *                                                    `getDelay(attempt)` method returning
   *                                                    the delay in ms for that attempt.
   *                                                    When provided, `retryIntervals` is
   *                                                    ignored.
   * @param {Logger}   [options.logger]               - Logger instance. If omitted, a
   *                                                    default logger is created.
   * @param {string}   [options.operationName='operation'] - Human-readable name for the
   *                                                    operation, used in log messages.
   */
  constructor(options = {}) {
    /** @private */
    this._retryIntervals = Array.isArray(options.retryIntervals)
      ? options.retryIntervals
      : DEFAULT_RETRY_INTERVALS;

    /** @private */
    this._maxRetries = typeof options.maxRetries === 'number'
      ? options.maxRetries
      : this._retryIntervals.length;

    /** @private */
    this._shouldRetry = typeof options.shouldRetry === 'function'
      ? options.shouldRetry
      : defaultShouldRetry;

    /** @private */
    this._retryStrategy = options.retryStrategy || null;

    /** @private */
    this._logger = options.logger || new Logger({ step: 'RetryHandler', minLevel: 'DEBUG' });

    /** @private */
    this._operationName = options.operationName || 'operation';
  }

  /**
   * Executes the supplied async function with retry logic.
   *
   * @param {Function} fn - An async (or Promise-returning) function to execute.
   *   Receives the current attempt number (0-based) as its sole argument.
   * @returns {Promise<*>} The resolved value of `fn` on success.
   * @throws {Error} The last error encountered after all retries are exhausted,
   *   enriched with `retryCount` and `operationName` properties.
   *
   * @example
   * const handler = new RetryHandler({ operationName: 'fetchTags' });
   * const tags = await handler.run(async (attempt) => {
   *   return await nsxClient.getTags(vmId);
   * });
   */
  async run(fn) {
    let lastError = null;

    for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
      try {
        this._logger.debug(`Attempt ${attempt + 1}/${this._maxRetries + 1} for ${this._operationName}`, {
          attempt: attempt + 1,
          maxAttempts: this._maxRetries + 1,
          operationName: this._operationName
        });

        const result = await fn(attempt);

        if (attempt > 0) {
          this._logger.info(`${this._operationName} succeeded after ${attempt + 1} attempts`, {
            attempt: attempt + 1,
            operationName: this._operationName
          });
        }

        return result;
      } catch (error) {
        lastError = error;

        this._logger.warn(`${this._operationName} failed on attempt ${attempt + 1}/${this._maxRetries + 1}`, {
          attempt: attempt + 1,
          maxAttempts: this._maxRetries + 1,
          operationName: this._operationName,
          errorMessage: error.message,
          errorCode: error.code || undefined
        });

        // Check if we should retry
        if (attempt >= this._maxRetries) {
          break;
        }

        if (!this._shouldRetry(error)) {
          this._logger.info(`${this._operationName} error is non-retryable, aborting`, {
            operationName: this._operationName,
            errorMessage: error.message
          });
          break;
        }

        // Calculate delay
        const delay = this._getDelay(attempt);

        this._logger.info(`Waiting ${delay}ms before retry ${attempt + 2} for ${this._operationName}`, {
          delayMs: delay,
          nextAttempt: attempt + 2,
          operationName: this._operationName
        });

        await sleep(delay);
      }
    }

    // All retries exhausted — enrich and rethrow
    lastError.retryCount = this._maxRetries;
    lastError.operationName = this._operationName;

    this._logger.error(`${this._operationName} failed after ${this._maxRetries + 1} attempts`, {
      totalAttempts: this._maxRetries + 1,
      operationName: this._operationName,
      errorMessage: lastError.message
    });

    throw lastError;
  }

  /**
   * Computes the delay for the given attempt index.
   *
   * @private
   * @param {number} attempt - Zero-based attempt index.
   * @returns {number} Delay in milliseconds.
   */
  _getDelay(attempt) {
    // Custom strategy takes precedence
    if (this._retryStrategy && typeof this._retryStrategy.getDelay === 'function') {
      return this._retryStrategy.getDelay(attempt);
    }

    // Interval-based: use last interval if attempt exceeds array bounds
    if (attempt < this._retryIntervals.length) {
      return this._retryIntervals[attempt];
    }
    return this._retryIntervals[this._retryIntervals.length - 1] || 5000;
  }

  // ---------------------------------------------------------------------------
  // Static convenience method
  // ---------------------------------------------------------------------------

  /**
   * Static factory method that creates a RetryHandler and immediately executes
   * the supplied function with retry logic.
   *
   * @static
   * @param {Function} fn      - Async function to execute.
   * @param {Object}   [options={}] - Same options accepted by the constructor.
   * @returns {Promise<*>} The resolved value of `fn` on success.
   * @throws {Error} After all retries are exhausted.
   *
   * @example
   * const data = await RetryHandler.execute(
   *   () => apiClient.get('/tags'),
   *   { maxRetries: 2, retryIntervals: [1000, 3000] }
   * );
   */
  static async execute(fn, options = {}) {
    const handler = new RetryHandler(options);
    return handler.run(fn);
  }
}

/** Expose default constants for consumer reference. */
RetryHandler.DEFAULT_RETRY_INTERVALS = DEFAULT_RETRY_INTERVALS;
RetryHandler.DEFAULT_MAX_RETRIES = DEFAULT_MAX_RETRIES;

module.exports = RetryHandler;
