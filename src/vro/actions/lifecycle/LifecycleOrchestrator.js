/**
 * @file LifecycleOrchestrator.js
 * @description Template Method pattern base class for the DFW Automation Pipeline.
 *   Defines the invariant workflow skeleton (validate → resolveEndpoints → prepare →
 *   execute → verify → callback) while delegating the concrete implementation of
 *   prepare, execute, and verify to subclasses (Day0, Day2, DayN).
 *
 *   Every step is wrapped with timing instrumentation. On failure at any step,
 *   the orchestrator runs saga compensation, enqueues the failed payload to the
 *   Dead Letter Queue, and sends an error callback to ServiceNow.
 *
 *   The static factory method {@link LifecycleOrchestrator.create} returns the
 *   appropriate subclass instance based on the request type.
 *
 * @module lifecycle/LifecycleOrchestrator
 */

'use strict';

/**
 * @class LifecycleOrchestrator
 * @classdesc Abstract base class implementing the Template Method pattern for
 *   VM lifecycle workflows. Subclasses must implement {@link prepare},
 *   {@link execute}, and {@link verify}.
 *
 * @example
 * // Using the factory:
 * const orchestrator = LifecycleOrchestrator.create('Day0', dependencies);
 * const result = await orchestrator.run(payload);
 */
class LifecycleOrchestrator {
  /**
   * Creates a new LifecycleOrchestrator instance.
   *
   * @param {Object} dependencies - Injected dependencies for the orchestrator.
   * @param {import('../shared/ConfigLoader')} dependencies.configLoader - Configuration
   *   loader providing site endpoints and pipeline settings.
   * @param {Object} dependencies.restClient - HTTP client for REST API calls to
   *   vCenter, NSX, and ServiceNow.
   * @param {import('../shared/Logger')} dependencies.logger - Structured logger instance.
   * @param {Object} dependencies.payloadValidator - Validates incoming payloads against
   *   the expected schema.
   * @param {import('./SagaCoordinator')} dependencies.sagaCoordinator - Saga coordinator
   *   for compensating transaction management.
   * @param {import('./DeadLetterQueue')} dependencies.deadLetterQueue - Dead letter queue
   *   for failed operation storage and reprocessing.
   * @param {Object} dependencies.tagOperations - Tag management operations (apply, update,
   *   remove, read).
   * @param {Object} dependencies.groupVerifier - Verifies NSX group memberships for VMs.
   * @param {Object} dependencies.dfwValidator - Validates DFW policy state for VMs.
   * @param {Object} dependencies.snowAdapter - ServiceNow adapter for CMDB updates and
   *   callback notifications.
   */
  constructor(dependencies) {
    if (new.target === LifecycleOrchestrator) {
      throw new Error(
        '[DFW-6100] LifecycleOrchestrator is abstract and cannot be instantiated directly. ' +
        'Use LifecycleOrchestrator.create() or instantiate a subclass.'
      );
    }

    /** @protected @type {import('../shared/ConfigLoader')} */
    this.configLoader = dependencies.configLoader;

    /** @protected @type {Object} */
    this.restClient = dependencies.restClient;

    /** @protected @type {import('../shared/Logger')} */
    this.logger = dependencies.logger;

    /** @protected @type {Object} */
    this.payloadValidator = dependencies.payloadValidator;

    /** @protected @type {import('./SagaCoordinator')} */
    this.sagaCoordinator = dependencies.sagaCoordinator;

    /** @protected @type {import('./DeadLetterQueue')} */
    this.deadLetterQueue = dependencies.deadLetterQueue;

    /** @protected @type {Object} */
    this.tagOperations = dependencies.tagOperations;

    /** @protected @type {Object} */
    this.groupVerifier = dependencies.groupVerifier;

    /** @protected @type {Object} */
    this.dfwValidator = dependencies.dfwValidator;

    /** @protected @type {Object} */
    this.snowAdapter = dependencies.snowAdapter;

    /**
     * Collects step timing data for performance observability.
     * @protected
     * @type {Object.<string, number>}
     */
    this.stepDurations = {};
  }

  // ---------------------------------------------------------------------------
  // Template Method — invariant workflow skeleton
  // ---------------------------------------------------------------------------

  /**
   * Executes the complete lifecycle workflow using the Template Method pattern.
   *
   * The steps are executed in a fixed order:
   *   1. **validate** — Schema and business rule validation
   *   2. **resolveEndpoints** — Resolve site-specific API endpoints
   *   3. **prepare** — Subclass-specific preparation logic
   *   4. **execute** — Subclass-specific core operations
   *   5. **verify** — Subclass-specific verification checks
   *   6. **callback** — Send result/error back to ServiceNow
   *
   * If any step throws, the orchestrator catches the error, runs saga
   * compensation, enqueues the payload to the DLQ, and sends an error callback.
   *
   * @param {Object} payload - The incoming request payload from ServiceNow,
   *   containing at minimum `correlationId`, `requestType`, `site`, and
   *   request-specific fields.
   * @returns {Promise<Object>} The workflow result object, containing step
   *   outputs and timing data.
   * @throws {Error} Only if the error callback itself fails; all other errors
   *   are caught and handled internally.
   *
   * @example
   * const result = await orchestrator.run({
   *   correlationId: 'RITM-00001-1679000000000',
   *   requestType: 'Day0',
   *   site: 'NDCNG',
   *   vmName: 'srv-web-01',
   *   tags: { Application: 'APP001', Environment: 'Production' }
   * });
   */
  async run(payload) {
    const correlationId = payload && payload.correlationId
      ? payload.correlationId
      : `AUTO-${Date.now()}`;

    this.stepDurations = {};
    this.logger.info('Lifecycle workflow starting', {
      correlationId,
      requestType: payload && payload.requestType,
      component: this.constructor.name
    });

    try {
      // Step 1: Validate
      const validationResult = await this._timedStep('validate', () => {
        return this.validate(payload);
      });

      // Step 2: Resolve endpoints
      const endpoints = await this._timedStep('resolveEndpoints', () => {
        return this.resolveEndpoints(payload.site);
      });

      // Start saga tracking
      this.sagaCoordinator.begin(correlationId);

      // Step 3: Prepare (subclass)
      const prepareResult = await this._timedStep('prepare', () => {
        return this.prepare(payload, endpoints);
      });

      // Step 4: Execute (subclass)
      const executeResult = await this._timedStep('execute', () => {
        return this.execute(payload, endpoints);
      });

      // Step 5: Verify (subclass)
      const verifyResult = await this._timedStep('verify', () => {
        return this.verify(payload, endpoints);
      });

      // Build final result
      const result = {
        success: true,
        correlationId,
        requestType: payload.requestType,
        validation: validationResult,
        preparation: prepareResult,
        execution: executeResult,
        verification: verifyResult,
        workflowStepDurations: { ...this.stepDurations }
      };

      // Step 6: Callback to SNOW
      await this._timedStep('callback', () => {
        return this.callback(payload, result);
      });

      this.logger.info('Lifecycle workflow completed successfully', {
        correlationId,
        requestType: payload.requestType,
        totalDurationMs: Object.values(this.stepDurations).reduce((a, b) => a + b, 0),
        component: this.constructor.name
      });

      return result;
    } catch (err) {
      return this._handleFailure(payload, correlationId, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Concrete steps (shared across all subclasses)
  // ---------------------------------------------------------------------------

  /**
   * Validates the incoming payload using the injected PayloadValidator.
   *
   * @param {Object} payload - The request payload to validate.
   * @returns {Promise<{valid: boolean}>} Validation result.
   * @throws {Error} If validation fails with a `[DFW-6101]` error code.
   */
  async validate(payload) {
    this.logger.info('Validating payload', {
      correlationId: payload.correlationId,
      component: this.constructor.name
    });

    const result = await this.payloadValidator.validate(payload);

    if (!result.valid) {
      const errorMsg = Array.isArray(result.errors)
        ? result.errors.join('; ')
        : 'Payload validation failed';
      throw new Error(`[DFW-6101] Payload validation failed: ${errorMsg}`);
    }

    return result;
  }

  /**
   * Resolves the API endpoints (vCenter, NSX, NSX Global) for the given site
   * using the injected ConfigLoader.
   *
   * @param {string} site - Site code (e.g. `'NDCNG'`, `'TULNG'`).
   * @returns {Promise<{vcenterUrl: string, nsxUrl: string, nsxGlobalUrl: string}>}
   *   The resolved endpoint URLs.
   * @throws {Error} If the site code is not recognized.
   */
  async resolveEndpoints(site) {
    this.logger.info('Resolving endpoints for site', {
      site,
      component: this.constructor.name
    });

    const endpoints = this.configLoader.getEndpointsForSite(site);

    this.logger.debug('Endpoints resolved', {
      site,
      vcenterUrl: endpoints.vcenterUrl,
      nsxUrl: endpoints.nsxUrl,
      component: this.constructor.name
    });

    return endpoints;
  }

  /**
   * Sends the workflow result (success or error) back to ServiceNow via the
   * REST client. This method handles both success and failure callbacks.
   *
   * @param {Object} payload - The original request payload, containing the
   *   `callbackUrl` or `correlationId` for routing the response.
   * @param {Object} result - The workflow result to send back.
   * @returns {Promise<void>}
   */
  async callback(payload, result) {
    const callbackUrl = payload.callbackUrl || payload.callback_url;

    if (!callbackUrl) {
      this.logger.warn('No callback URL provided — skipping SNOW callback', {
        correlationId: payload.correlationId,
        component: this.constructor.name
      });
      return;
    }

    this.logger.info('Sending callback to ServiceNow', {
      correlationId: payload.correlationId,
      success: result.success,
      callbackUrl,
      component: this.constructor.name
    });

    const callbackPayload = {
      correlationId: payload.correlationId,
      requestType: payload.requestType,
      status: result.success ? 'completed' : 'failed',
      result,
      timestamp: new Date().toISOString()
    };

    await this.restClient.post(callbackUrl, callbackPayload);

    this.logger.info('Callback sent successfully', {
      correlationId: payload.correlationId,
      component: this.constructor.name
    });
  }

  // ---------------------------------------------------------------------------
  // Abstract methods — subclasses MUST implement
  // ---------------------------------------------------------------------------

  /**
   * Prepares the workflow execution. Subclasses implement this to perform
   * any pre-execution setup (e.g. looking up VM details, generating names).
   *
   * @abstract
   * @param {Object} payload - The validated request payload.
   * @param {Object} endpoints - The resolved site endpoints.
   * @returns {Promise<Object>} Preparation result.
   * @throws {Error} If not overridden by a subclass.
   */
  async prepare(_payload, _endpoints) {
    throw new Error(
      `[DFW-6102] ${this.constructor.name} must implement prepare()`
    );
  }

  /**
   * Executes the core workflow operations. Subclasses implement this to
   * perform the actual VM provisioning, tag changes, or decommissioning.
   *
   * @abstract
   * @param {Object} payload - The validated request payload.
   * @param {Object} endpoints - The resolved site endpoints.
   * @returns {Promise<Object>} Execution result.
   * @throws {Error} If not overridden by a subclass.
   */
  async execute(_payload, _endpoints) {
    throw new Error(
      `[DFW-6103] ${this.constructor.name} must implement execute()`
    );
  }

  /**
   * Verifies the workflow results. Subclasses implement this to validate
   * that the operations completed correctly (group membership, DFW policies).
   *
   * @abstract
   * @param {Object} payload - The validated request payload.
   * @param {Object} endpoints - The resolved site endpoints.
   * @returns {Promise<Object>} Verification result.
   * @throws {Error} If not overridden by a subclass.
   */
  async verify(_payload, _endpoints) {
    throw new Error(
      `[DFW-6104] ${this.constructor.name} must implement verify()`
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Wraps a step function with timing instrumentation, recording the elapsed
   * duration in {@link stepDurations}.
   *
   * @private
   * @param {string} stepName - Name of the step (used as the duration key).
   * @param {Function} stepFn - Async function to execute and time.
   * @returns {Promise<*>} The return value of `stepFn`.
   */
  async _timedStep(stepName, stepFn) {
    const startTime = Date.now();

    this.logger.debug(`Step "${stepName}" starting`, {
      step: stepName,
      component: this.constructor.name
    });

    try {
      const result = await stepFn();
      const durationMs = Date.now() - startTime;
      this.stepDurations[stepName] = durationMs;

      this.logger.debug(`Step "${stepName}" completed`, {
        step: stepName,
        durationMs,
        component: this.constructor.name
      });

      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      this.stepDurations[stepName] = durationMs;

      this.logger.error(`Step "${stepName}" failed`, {
        step: stepName,
        durationMs,
        errorMessage: err.message,
        component: this.constructor.name
      });

      throw err;
    }
  }

  /**
   * Handles a workflow failure by running saga compensation, enqueuing to the
   * DLQ, and sending an error callback to ServiceNow.
   *
   * @private
   * @param {Object} payload - The original request payload.
   * @param {string} correlationId - The workflow correlation ID.
   * @param {Error} err - The error that caused the failure.
   * @returns {Promise<Object>} An error result object.
   */
  async _handleFailure(payload, correlationId, err) {
    this.logger.error('Lifecycle workflow failed — initiating compensation', {
      correlationId,
      requestType: payload && payload.requestType,
      errorMessage: err.message,
      component: this.constructor.name
    });

    // Run saga compensation if a saga is active
    let compensationResult = null;
    if (this.sagaCoordinator.isActive()) {
      try {
        compensationResult = await this.sagaCoordinator.compensate();
      } catch (compErr) {
        this.logger.error('Saga compensation threw an unexpected error', {
          correlationId,
          errorMessage: compErr.message,
          component: this.constructor.name
        });
      }
    }

    // Enqueue to Dead Letter Queue
    let dlqId = null;
    try {
      dlqId = await this.deadLetterQueue.enqueue(payload, err, correlationId);
    } catch (dlqErr) {
      this.logger.error('Failed to enqueue to Dead Letter Queue', {
        correlationId,
        errorMessage: dlqErr.message,
        component: this.constructor.name
      });
    }

    // Build error result
    const errorResult = {
      success: false,
      correlationId,
      requestType: payload && payload.requestType,
      error: {
        message: err.message,
        code: err.code || null
      },
      compensationResult,
      dlqId,
      workflowStepDurations: { ...this.stepDurations }
    };

    // Send error callback to SNOW
    try {
      await this.callback(payload, errorResult);
    } catch (callbackErr) {
      this.logger.error('Error callback to ServiceNow failed', {
        correlationId,
        errorMessage: callbackErr.message,
        component: this.constructor.name
      });
    }

    return errorResult;
  }

  // ---------------------------------------------------------------------------
  // Factory Method
  // ---------------------------------------------------------------------------

  /**
   * Factory method that returns the appropriate orchestrator subclass based on
   * the request type.
   *
   * @static
   * @param {string} requestType - The lifecycle request type. One of
   *   `'Day0'`, `'Day2'`, or `'DayN'`.
   * @param {Object} dependencies - Dependency injection object passed to the
   *   subclass constructor. See {@link LifecycleOrchestrator} constructor for
   *   required properties.
   * @returns {LifecycleOrchestrator} An instance of the appropriate subclass.
   * @throws {Error} If the request type is not recognized.
   *
   * @example
   * const orchestrator = LifecycleOrchestrator.create('Day0', dependencies);
   * const result = await orchestrator.run(payload);
   */
  static create(requestType, dependencies) {
    const normalised = typeof requestType === 'string'
      ? requestType.trim()
      : '';

    /* eslint-disable global-require */
    switch (normalised) {
      case 'Day0': {
        const Day0Orchestrator = require('./Day0Orchestrator');
        return new Day0Orchestrator(dependencies);
      }
      case 'Day2': {
        const Day2Orchestrator = require('./Day2Orchestrator');
        return new Day2Orchestrator(dependencies);
      }
      case 'DayN': {
        const DayNOrchestrator = require('./DayNOrchestrator');
        return new DayNOrchestrator(dependencies);
      }
      default:
        throw new Error(
          `[DFW-6105] Unknown request type "${requestType}". ` +
          'Valid types: Day0, Day2, DayN'
        );
    }
    /* eslint-enable global-require */
  }
}

module.exports = LifecycleOrchestrator;
