/**
 * @file SagaCoordinator.js
 * @description Implements the Saga pattern for distributed transaction management
 *   in the DFW Automation Pipeline. Tracks completed workflow steps as a journal
 *   and, on failure, executes compensating transactions in reverse order to
 *   maintain system consistency.
 *
 *   Each recorded step includes a compensating action (an async function) that
 *   undoes the step's side effects. When {@link SagaCoordinator#compensate} is
 *   invoked, these compensating actions are executed in LIFO order — ensuring
 *   that the most recent changes are rolled back first.
 *
 *   If an individual compensation fails, the error is logged but the coordinator
 *   continues with the remaining compensations, guaranteeing a best-effort
 *   rollback even under partial failure conditions.
 *
 * @module lifecycle/SagaCoordinator
 */

'use strict';

/**
 * @class SagaCoordinator
 * @classdesc Tracks workflow steps and orchestrates compensating transactions
 *   on failure, implementing the Saga pattern for distributed operations.
 *
 * @example
 * const Logger = require('../shared/Logger');
 * const saga = new SagaCoordinator(new Logger({ step: 'Day0' }));
 *
 * saga.begin('RITM-00001-1679000000000');
 * await saga.recordStep('provisionVM', async () => { await deleteVM(vmId); });
 * await saga.recordStep('applyTags', async () => { await removeTags(vmId); });
 *
 * // On failure:
 * await saga.compensate();
 * // → removes tags first, then deletes the VM (reverse order)
 */
class SagaCoordinator {
  /**
   * Creates a new SagaCoordinator instance.
   *
   * @param {import('../shared/Logger')} logger - Logger instance used for
   *   structured logging of saga lifecycle events and compensation outcomes.
   */
  constructor(logger) {
    /**
     * Logger instance for saga operations.
     * @private
     * @type {import('../shared/Logger')}
     */
    this._logger = logger;

    /**
     * Correlation ID for the active saga. Empty string when no saga is active.
     * @private
     * @type {string}
     */
    this._correlationId = '';

    /**
     * Journal of recorded steps with their compensating actions.
     * @private
     * @type {Array<{stepName: string, timestamp: string, compensatingAction: Function, compensated: boolean}>}
     */
    this._journal = [];

    /**
     * Whether a saga is currently in progress.
     * @private
     * @type {boolean}
     */
    this._active = false;
  }

  /**
   * Starts a new saga, initializing the journal and marking the saga as active.
   * Any previously recorded journal entries are cleared.
   *
   * @param {string} correlationId - Unique identifier for the saga instance,
   *   typically derived from the ServiceNow RITM number and timestamp.
   * @returns {void}
   * @throws {Error} If a saga is already in progress. The active saga must be
   *   completed or compensated before starting a new one.
   *
   * @example
   * saga.begin('RITM-00001-1679000000000');
   */
  begin(correlationId) {
    if (this._active) {
      throw new Error(
        `[DFW-6001] Cannot begin a new saga — saga "${this._correlationId}" is already active. ` +
        'Complete or compensate the current saga before starting a new one.'
      );
    }

    this._correlationId = correlationId;
    this._journal = [];
    this._active = true;

    this._logger.info('Saga started', {
      correlationId: this._correlationId,
      component: 'SagaCoordinator'
    });
  }

  /**
   * Records a completed workflow step along with its compensating action.
   * The compensating action is an async function that will undo the step's
   * side effects if the saga needs to be rolled back.
   *
   * Steps are appended to the journal in the order they are recorded. During
   * compensation, they will be executed in reverse order.
   *
   * @param {string} stepName - Human-readable name of the completed step
   *   (e.g. `'provisionVM'`, `'applyTags'`).
   * @param {Function} compensatingAction - Async function that undoes this step.
   *   Must return a Promise. Receives no arguments.
   * @returns {Promise<void>}
   * @throws {Error} If no saga is currently active.
   *
   * @example
   * await saga.recordStep('provisionVM', async () => {
   *   await restClient.delete(`${endpoints.vcenterUrl}/api/vcenter/vm/${vmId}`);
   * });
   */
  async recordStep(stepName, compensatingAction) {
    if (!this._active) {
      throw new Error(
        '[DFW-6002] Cannot record step — no saga is currently active. ' +
        'Call begin() before recording steps.'
      );
    }

    if (typeof compensatingAction !== 'function') {
      throw new Error(
        `[DFW-6003] Compensating action for step "${stepName}" must be a function.`
      );
    }

    const entry = {
      stepName,
      timestamp: new Date().toISOString(),
      compensatingAction,
      compensated: false
    };

    this._journal.push(entry);

    this._logger.debug('Saga step recorded', {
      correlationId: this._correlationId,
      stepName,
      journalLength: this._journal.length,
      component: 'SagaCoordinator'
    });
  }

  /**
   * Executes all compensating transactions in REVERSE order (LIFO).
   *
   * Each compensating action is awaited individually. If a compensation fails,
   * the error is logged and the journal entry is marked with the failure, but
   * execution continues with the remaining compensations.
   *
   * After all compensations have been attempted, the saga is marked as inactive.
   *
   * @returns {Promise<{compensated: number, failed: number, errors: Array<{stepName: string, error: string}>}>}
   *   A summary object containing:
   *   - `compensated` — number of steps successfully compensated
   *   - `failed` — number of steps where compensation failed
   *   - `errors` — details of any compensation failures
   * @throws {Error} If no saga is currently active.
   *
   * @example
   * const result = await saga.compensate();
   * // result => { compensated: 2, failed: 0, errors: [] }
   */
  async compensate() {
    if (!this._active) {
      throw new Error(
        '[DFW-6004] Cannot compensate — no saga is currently active.'
      );
    }

    this._logger.warn('Saga compensation initiated', {
      correlationId: this._correlationId,
      stepsToCompensate: this._journal.length,
      component: 'SagaCoordinator'
    });

    const result = {
      compensated: 0,
      failed: 0,
      errors: []
    };

    // Execute compensating actions in REVERSE order
    const reversedJournal = [...this._journal].reverse();

    for (const entry of reversedJournal) {
      const stepStartTime = Date.now();

      try {
        this._logger.info(`Compensating step: ${entry.stepName}`, {
          correlationId: this._correlationId,
          stepName: entry.stepName,
          originalTimestamp: entry.timestamp,
          component: 'SagaCoordinator'
        });

        await entry.compensatingAction();

        entry.compensated = true;
        result.compensated += 1;

        this._logger.info(`Compensation succeeded: ${entry.stepName}`, {
          correlationId: this._correlationId,
          stepName: entry.stepName,
          durationMs: Date.now() - stepStartTime,
          component: 'SagaCoordinator'
        });
      } catch (err) {
        result.failed += 1;
        const errorDetail = {
          stepName: entry.stepName,
          error: err.message || String(err)
        };
        result.errors.push(errorDetail);

        this._logger.error(`Compensation failed: ${entry.stepName}`, {
          correlationId: this._correlationId,
          stepName: entry.stepName,
          errorMessage: err.message,
          stack: err.stack,
          durationMs: Date.now() - stepStartTime,
          component: 'SagaCoordinator'
        });

        // Continue with remaining compensations — do NOT throw
      }
    }

    this._logger.info('Saga compensation complete', {
      correlationId: this._correlationId,
      compensated: result.compensated,
      failed: result.failed,
      totalSteps: this._journal.length,
      component: 'SagaCoordinator'
    });

    // Mark saga as inactive
    this._active = false;

    return result;
  }

  /**
   * Returns the current journal as an array of step records.
   * The returned array is a shallow copy; mutating it does not affect the
   * internal journal.
   *
   * Each journal entry contains:
   * - `stepName` — name of the recorded step
   * - `timestamp` — ISO 8601 timestamp of when the step was recorded
   * - `compensatingAction` — the compensating function
   * - `compensated` — whether the step has been compensated
   *
   * @returns {Array<{stepName: string, timestamp: string, compensatingAction: Function, compensated: boolean}>}
   *   A shallow copy of the journal entries.
   *
   * @example
   * const journal = saga.getJournal();
   * console.log(journal.length); // => 2
   * console.log(journal[0].stepName); // => 'provisionVM'
   */
  getJournal() {
    return [...this._journal];
  }

  /**
   * Returns whether a saga is currently in progress.
   *
   * @returns {boolean} `true` if a saga has been started with {@link begin}
   *   and has not yet been compensated or completed; `false` otherwise.
   *
   * @example
   * saga.begin('RITM-00001');
   * saga.isActive(); // => true
   * await saga.compensate();
   * saga.isActive(); // => false
   */
  isActive() {
    return this._active;
  }
}

module.exports = SagaCoordinator;
