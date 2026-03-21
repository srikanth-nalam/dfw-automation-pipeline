/**
 * @file CircuitBreaker.js
 * @description Circuit breaker pattern implementation for the DFW Automation
 *   Pipeline. Protects downstream services (vCenter, NSX Manager) from
 *   cascading failures by tracking per-endpoint error rates and temporarily
 *   suspending calls when a failure threshold is breached.
 *
 *   States:
 *   - **CLOSED** — Normal operation. Failures are counted; once the threshold
 *     is reached, transitions to OPEN.
 *   - **OPEN** — All calls are immediately rejected with a DFW-6004 error.
 *     After `resetTimeout` elapses, transitions to HALF_OPEN.
 *   - **HALF_OPEN** — A single probe call is permitted. If it succeeds, the
 *     breaker returns to CLOSED. If it fails, it re-enters OPEN.
 *
 * @module shared/CircuitBreaker
 */

'use strict';

const Logger = require('./Logger');

/**
 * Circuit breaker states.
 *
 * @enum {string}
 * @readonly
 */
const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

/**
 * Default configuration constants.
 *
 * @constant {Object}
 */
const DEFAULTS = {
  failureThreshold: 5,
  resetTimeout: 60000,
  windowSize: 300000
};

/**
 * In-memory store for per-endpoint circuit breaker state.
 * In a vRO deployment this could be backed by a shared Configuration Element.
 *
 * @type {Map<string, Object>}
 * @private
 */
const _endpointStates = new Map();

/**
 * CircuitBreaker wraps an async function call and applies the circuit breaker
 * pattern, tracking failures per named endpoint.
 *
 * @class CircuitBreaker
 *
 * @example
 * const breaker = new CircuitBreaker('nsx-manager-ndcng', {
 *   failureThreshold: 3,
 *   resetTimeout: 30000
 * });
 *
 * const result = await breaker.execute(async () => {
 *   return await nsxClient.get('/api/v1/fabric/virtual-machines');
 * });
 */
class CircuitBreaker {
  /**
   * Creates a new CircuitBreaker for the given endpoint name.
   *
   * @param {string} name - Logical endpoint identifier (e.g.
   *   `'nsx-manager-ndcng'`). State is tracked per-name so that different
   *   endpoints have independent breakers.
   * @param {Object}  [options={}]                      - Configuration.
   * @param {number}  [options.failureThreshold=5]      - Number of failures
   *                                                      within the window that
   *                                                      trips the breaker.
   * @param {number}  [options.resetTimeout=60000]      - Milliseconds to wait
   *                                                      in OPEN state before
   *                                                      transitioning to
   *                                                      HALF_OPEN.
   * @param {number}  [options.windowSize=300000]       - Sliding window in ms
   *                                                      for counting failures.
   * @param {Logger}  [options.logger]                  - Logger instance.
   */
  constructor(name, options = {}) {
    if (!name || typeof name !== 'string') {
      throw new Error('CircuitBreaker requires a non-empty endpoint name');
    }

    /** @private */
    this._name = name;
    /** @private */
    this._failureThreshold = options.failureThreshold || DEFAULTS.failureThreshold;
    /** @private */
    this._resetTimeout = options.resetTimeout || DEFAULTS.resetTimeout;
    /** @private */
    this._windowSize = options.windowSize || DEFAULTS.windowSize;
    /** @private */
    this._logger = options.logger || new Logger({ step: 'CircuitBreaker', minLevel: 'DEBUG' });

    // Initialise state if this is the first time we see this endpoint
    if (!_endpointStates.has(this._name)) {
      this._initState();
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Executes the supplied async function through the circuit breaker.
   *
   * - **CLOSED**: Calls `fn`. On success, records success. On failure, records
   *   failure and may transition to OPEN.
   * - **OPEN**: Immediately rejects with a DFW-6004 error. If `resetTimeout`
   *   has elapsed, transitions to HALF_OPEN first.
   * - **HALF_OPEN**: Allows exactly one probe call. Success returns to CLOSED;
   *   failure returns to OPEN.
   *
   * @param {Function} fn - Async (or Promise-returning) function to execute.
   * @returns {Promise<*>} The resolved value of `fn`.
   * @throws {Error} DFW-6004 error when the breaker is OPEN, or the original
   *   error from `fn` if not retryable.
   */
  async execute(fn) {
    const state = this._getState();

    // Check if OPEN state should transition to HALF_OPEN
    if (state.status === STATE.OPEN) {
      if (Date.now() - state.lastFailureTime >= this._resetTimeout) {
        this._transition(STATE.HALF_OPEN);
      } else {
        this._logger.warn(`Circuit breaker OPEN for endpoint "${this._name}", rejecting call`, {
          endpoint: this._name,
          state: STATE.OPEN,
          lastFailureTime: new Date(state.lastFailureTime).toISOString()
        });

        const error = new Error(
          `[DFW-6004] Circuit breaker open: calls to endpoint "${this._name}" suspended`
        );
        error.code = 'DFW-6004';
        error.statusCode = 503;
        error.retryable = false;
        error.endpoint = this._name;
        throw error;
      }
    }

    // HALF_OPEN: allow one probe call
    if (this._getState().status === STATE.HALF_OPEN) {
      return this._executeProbe(fn);
    }

    // CLOSED: normal execution
    return this._executeNormal(fn);
  }

  /**
   * Returns the current state of the circuit breaker.
   *
   * @returns {string} One of `'CLOSED'`, `'OPEN'`, or `'HALF_OPEN'`.
   */
  getState() {
    const state = this._getState();

    // Auto-transition from OPEN to HALF_OPEN if timeout has elapsed
    if (state.status === STATE.OPEN && Date.now() - state.lastFailureTime >= this._resetTimeout) {
      this._transition(STATE.HALF_OPEN);
      return STATE.HALF_OPEN;
    }

    return state.status;
  }

  /**
   * Manually resets the breaker to CLOSED, clearing all counters.
   *
   * @returns {void}
   */
  reset() {
    this._logger.info(`Circuit breaker for "${this._name}" manually reset`, {
      endpoint: this._name,
      previousState: this._getState().status
    });
    this._initState();
  }

  /**
   * Returns operational statistics for monitoring and dashboards.
   *
   * @returns {{ name: string, state: string, totalSuccesses: number,
   *   totalFailures: number, consecutiveFailures: number,
   *   failureThreshold: number, recentFailures: number,
   *   lastFailureTime: string|null, lastSuccessTime: string|null }}
   */
  getStats() {
    const state = this._getState();
    return {
      name: this._name,
      state: this.getState(),
      totalSuccesses: state.totalSuccesses,
      totalFailures: state.totalFailures,
      consecutiveFailures: state.consecutiveFailures,
      failureThreshold: this._failureThreshold,
      recentFailures: this._countRecentFailures(),
      lastFailureTime: state.lastFailureTime
        ? new Date(state.lastFailureTime).toISOString()
        : null,
      lastSuccessTime: state.lastSuccessTime
        ? new Date(state.lastSuccessTime).toISOString()
        : null
    };
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  /**
   * Resets all endpoint states. Primarily for testing.
   *
   * @static
   * @returns {void}
   */
  static resetAll() {
    _endpointStates.clear();
  }

  /**
   * Returns the state map size (number of tracked endpoints).
   *
   * @static
   * @returns {number}
   */
  static getTrackedEndpointCount() {
    return _endpointStates.size;
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Initialises or resets the internal state for this endpoint.
   *
   * @private
   * @returns {void}
   */
  _initState() {
    _endpointStates.set(this._name, {
      status: STATE.CLOSED,
      failureTimestamps: [],
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      lastFailureTime: null,
      lastSuccessTime: null
    });
  }

  /**
   * Returns the mutable state object for this endpoint.
   *
   * @private
   * @returns {Object}
   */
  _getState() {
    return _endpointStates.get(this._name);
  }

  /**
   * Transitions the breaker to a new state with logging.
   *
   * @private
   * @param {string} newStatus - Target state.
   * @returns {void}
   */
  _transition(newStatus) {
    const state = this._getState();
    const previousStatus = state.status;
    state.status = newStatus;

    this._logger.info(`Circuit breaker "${this._name}" transitioned: ${previousStatus} -> ${newStatus}`, {
      endpoint: this._name,
      previousState: previousStatus,
      newState: newStatus
    });
  }

  /**
   * Executes `fn` in CLOSED state, recording successes and failures.
   *
   * @private
   * @param {Function} fn - Async function.
   * @returns {Promise<*>}
   */
  async _executeNormal(fn) {
    try {
      const result = await fn();
      this._recordSuccess();
      return result;
    } catch (error) {
      this._recordFailure();
      throw error;
    }
  }

  /**
   * Executes `fn` as a HALF_OPEN probe. Success transitions to CLOSED;
   * failure transitions back to OPEN.
   *
   * @private
   * @param {Function} fn - Async function.
   * @returns {Promise<*>}
   */
  async _executeProbe(fn) {
    this._logger.info(`Circuit breaker "${this._name}" executing probe call in HALF_OPEN state`, {
      endpoint: this._name
    });

    try {
      const result = await fn();
      this._recordSuccess();
      this._transition(STATE.CLOSED);
      // Reset failure counters on successful probe
      const state = this._getState();
      state.consecutiveFailures = 0;
      state.failureTimestamps = [];
      return result;
    } catch (error) {
      this._recordFailure();
      this._transition(STATE.OPEN);
      throw error;
    }
  }

  /**
   * Records a successful call.
   *
   * @private
   * @returns {void}
   */
  _recordSuccess() {
    const state = this._getState();
    state.totalSuccesses += 1;
    state.consecutiveFailures = 0;
    state.lastSuccessTime = Date.now();
  }

  /**
   * Records a failed call. If the failure threshold is reached within the
   * sliding window, transitions to OPEN.
   *
   * @private
   * @returns {void}
   */
  _recordFailure() {
    const state = this._getState();
    const now = Date.now();

    state.totalFailures += 1;
    state.consecutiveFailures += 1;
    state.lastFailureTime = now;
    state.failureTimestamps.push(now);

    // Prune timestamps outside the sliding window
    const windowStart = now - this._windowSize;
    state.failureTimestamps = state.failureTimestamps.filter(ts => ts >= windowStart);

    // Check threshold
    if (state.failureTimestamps.length >= this._failureThreshold) {
      this._transition(STATE.OPEN);
    }
  }

  /**
   * Counts recent failures within the current sliding window.
   *
   * @private
   * @returns {number}
   */
  _countRecentFailures() {
    const state = this._getState();
    const windowStart = Date.now() - this._windowSize;
    return state.failureTimestamps.filter(ts => ts >= windowStart).length;
  }
}

/** Expose state constants. */
CircuitBreaker.STATE = STATE;
CircuitBreaker.DEFAULTS = DEFAULTS;

module.exports = CircuitBreaker;
