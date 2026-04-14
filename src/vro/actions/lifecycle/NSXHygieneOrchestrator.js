/**
 * @file NSXHygieneOrchestrator.js
 * @description Unified scheduled workflow that runs all cleanup/hygiene tasks in
 *   sequence and produces a consolidated report. Designed to be triggered by
 *   ServiceNow Scheduled Job via vRO REST endpoint.
 *
 * Error codes:
 *   - DFW-9300  NSXHygieneOrchestrator general error
 *   - DFW-9301  Individual task failure (non-blocking, continues to next task)
 *
 * @module lifecycle/NSXHygieneOrchestrator
 */

'use strict';

/**
 * Default task list for FULL scope.
 * @constant {string[]}
 * @private
 */
const FULL_TASKS = Object.freeze([
  'phantom',
  'orphanGroups',
  'staleRules',
  'emptySections',
  'staleTags',
  'unregistered'
]);

/**
 * Default task list for QUICK scope.
 * @constant {string[]}
 * @private
 */
const QUICK_TASKS = Object.freeze([
  'phantom',
  'orphanGroups',
  'staleRules'
]);

/**
 * @class NSXHygieneOrchestrator
 * @classdesc Orchestrates all NSX hygiene tasks in a coordinated sweep.
 *
 * @example
 * const orchestrator = new NSXHygieneOrchestrator(dependencies);
 * const report = await orchestrator.runHygieneSweep({
 *   correlationId: 'HYG-001',
 *   site: 'NDCNG',
 *   scope: 'FULL',
 *   dryRun: true
 * });
 */
class NSXHygieneOrchestrator {
  /**
   * Creates a new NSXHygieneOrchestrator.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.orphanGroupCleaner - OrphanGroupCleaner instance.
   * @param {Object} dependencies.staleRuleReaper - StaleRuleReaper instance.
   * @param {Object} dependencies.policyDeployer - PolicyDeployer instance.
   * @param {Object} dependencies.staleTagRemediator - StaleTagRemediator instance.
   * @param {Object} dependencies.phantomVMDetector - PhantomVMDetector instance.
   * @param {Object} dependencies.unregisteredVMOnboarder - UnregisteredVMOnboarder instance.
   * @param {Object} dependencies.logger - Structured logger.
   * @param {Object} dependencies.configLoader - Configuration loader.
   * @param {Object} dependencies.snowAdapter - ServiceNow adapter.
   *
   * @throws {Error} DFW-9300 when required dependencies are missing.
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-9300] NSXHygieneOrchestrator requires dependencies');
    }

    /** @private */
    this.orphanGroupCleaner = dependencies.orphanGroupCleaner;
    /** @private */
    this.staleRuleReaper = dependencies.staleRuleReaper;
    /** @private */
    this.policyDeployer = dependencies.policyDeployer;
    /** @private */
    this.staleTagRemediator = dependencies.staleTagRemediator;
    /** @private */
    this.phantomVMDetector = dependencies.phantomVMDetector;
    /** @private */
    this.unregisteredVMOnboarder = dependencies.unregisteredVMOnboarder;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this.configLoader = dependencies.configLoader;
    /** @private */
    this.snowAdapter = dependencies.snowAdapter;
  }

  /**
   * Runs a full hygiene sweep for a site.
   *
   * @async
   * @param {Object} payload - Sweep payload.
   * @param {string} payload.correlationId - Correlation ID for tracing.
   * @param {string} payload.site - Site code (NDCNG or TULNG).
   * @param {string} [payload.scope='FULL'] - Sweep scope: FULL or QUICK.
   * @param {boolean} [payload.dryRun=true] - If true, report only.
   * @param {string} [payload.callbackUrl] - ServiceNow callback URL.
   * @param {string[]} [payload.tasks] - Custom task list override.
   * @returns {Promise<Object>} Consolidated hygiene report.
   *
   * @throws {Error} DFW-9300 on general orchestration failure.
   */
  async runHygieneSweep(payload) {
    const correlationId = payload.correlationId || `HYG-${Date.now()}`;
    const site = payload.site;
    const scope = payload.scope || 'FULL';
    const dryRun = payload.dryRun !== false;
    const taskList = payload.tasks || (scope === 'QUICK' ? QUICK_TASKS : FULL_TASKS);

    const startTime = Date.now();

    this.logger.info('Starting NSX hygiene sweep', {
      correlationId,
      site,
      scope,
      dryRun,
      tasks: taskList,
      component: 'NSXHygieneOrchestrator'
    });

    const taskResults = {};
    let totalIssuesFound = 0;
    let autoRemediated = 0;
    let manualReviewRequired = 0;
    let incidentsCreated = 0;

    // Execute each task in sequence
    for (const task of taskList) {
      try {
        const taskResult = await this._executeTask(task, site, dryRun, correlationId);
        taskResults[task] = taskResult;

        // Aggregate metrics
        const metrics = this._extractMetrics(task, taskResult);
        totalIssuesFound += metrics.issues;
        autoRemediated += metrics.remediated;
        manualReviewRequired += metrics.manualReview;
      } catch (taskErr) {
        this.logger.error('Hygiene task failed — continuing to next task', {
          correlationId,
          task,
          site,
          errorMessage: taskErr.message,
          component: 'NSXHygieneOrchestrator'
        });
        taskResults[task] = {
          status: 'FAILED',
          error: taskErr.message
        };
      }
    }

    // Create ServiceNow incidents for manual-review items
    if (manualReviewRequired > 0) {
      try {
        const incidents = await this._createHygieneIncidents(taskResults, correlationId);
        incidentsCreated = incidents.length;
      } catch (incErr) {
        this.logger.error('Failed to create hygiene incidents', {
          correlationId,
          errorMessage: incErr.message,
          component: 'NSXHygieneOrchestrator'
        });
      }
    }

    // Determine overall status
    let overallStatus = 'CLEAN';
    if (totalIssuesFound > 0 && autoRemediated > 0) {
      overallStatus = 'ISSUES_REMEDIATED';
    } else if (totalIssuesFound > 0) {
      overallStatus = 'ISSUES_FOUND';
    }

    const duration = Date.now() - startTime;

    const result = {
      correlationId,
      site,
      scope,
      timestamp: new Date().toISOString(),
      duration,
      tasks: taskResults,
      summary: {
        totalIssuesFound,
        autoRemediated,
        manualReviewRequired,
        incidentsCreated
      },
      overallStatus
    };

    // Send callback to ServiceNow
    if (payload.callbackUrl) {
      try {
        await this._sendCallback(payload.callbackUrl, result, correlationId);
      } catch (cbErr) {
        this.logger.error('Failed to send hygiene callback', {
          correlationId,
          errorMessage: cbErr.message,
          component: 'NSXHygieneOrchestrator'
        });
      }
    }

    this.logger.info('NSX hygiene sweep completed', {
      correlationId,
      site,
      scope,
      duration,
      overallStatus,
      totalIssuesFound,
      autoRemediated,
      manualReviewRequired,
      incidentsCreated,
      component: 'NSXHygieneOrchestrator'
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Executes a single hygiene task.
   *
   * @private
   * @async
   * @param {string} task - Task name.
   * @param {string} site - Site code.
   * @param {boolean} dryRun - Dry run mode.
   * @param {string} correlationId - Correlation ID.
   * @returns {Promise<Object>} Task result.
   */
  async _executeTask(task, site, dryRun, correlationId) {
    this.logger.info('Executing hygiene task', {
      correlationId,
      task,
      site,
      component: 'NSXHygieneOrchestrator'
    });

    const options = { dryRun };

    switch (task) {
      case 'phantom':
        return this.phantomVMDetector.detect(site, options);
      case 'orphanGroups':
        return this.orphanGroupCleaner.sweep(site, options);
      case 'staleRules':
        return this.staleRuleReaper.reap(site, options);
      case 'emptySections':
        return this.policyDeployer.cleanupEmptySections(site, options);
      case 'staleTags':
        return this.staleTagRemediator.remediate(site, options);
      case 'unregistered':
        return this.unregisteredVMOnboarder.onboard(site, options);
      default:
        throw new Error(`[DFW-9301] Unknown hygiene task: ${task}`);
    }
  }

  /**
   * Extracts aggregated metrics from a task result.
   *
   * @private
   * @param {string} task - Task name.
   * @param {Object} result - Task result.
   * @returns {{issues: number, remediated: number, manualReview: number}} Metrics.
   */
  _extractMetrics(task, result) {
    const metrics = { issues: 0, remediated: 0, manualReview: 0 };

    switch (task) {
      case 'phantom':
        metrics.issues = result.phantomVMCount || 0;
        metrics.manualReview = result.phantomVMCount || 0;
        break;
      case 'orphanGroups':
        metrics.issues = result.orphanedGroups || 0;
        metrics.remediated = result.deletedGroups || 0;
        metrics.manualReview = result.skippedGroups || 0;
        break;
      case 'staleRules':
        metrics.issues = (result.staleRules || 0) + (result.expiredRules || 0) + (result.unmanagedRules || 0);
        metrics.remediated = result.disabledRules || 0;
        metrics.manualReview = result.skippedRules || 0;
        break;
      case 'emptySections':
        metrics.issues = result.emptySections || 0;
        metrics.remediated = result.deletedSections || 0;
        break;
      case 'staleTags':
        metrics.issues = result.totalStaleVMs || 0;
        metrics.remediated = result.remediatedVMs || 0;
        metrics.manualReview = result.manualReviewVMs || 0;
        break;
      case 'unregistered':
        metrics.issues = result.totalUnregistered || 0;
        metrics.remediated = result.onboarded || 0;
        metrics.manualReview = result.manualReview || 0;
        break;
      default:
        break;
    }

    return metrics;
  }

  /**
   * Creates ServiceNow incidents for items needing manual intervention.
   *
   * @private
   * @async
   * @param {Object} findings - Task results with findings.
   * @param {string} correlationId - Correlation ID.
   * @returns {Promise<Array>} Created incident references.
   */
  async _createHygieneIncidents(findings, correlationId) {
    const incidents = [];

    const result = await this.snowAdapter.toCallbackPayload({
      action: 'createHygieneIncidents',
      correlationId,
      findings
    });

    if (result && Array.isArray(result.incidents)) {
      incidents.push(...result.incidents);
    } else if (result) {
      incidents.push(result);
    }

    return incidents;
  }

  /**
   * Sends callback to ServiceNow with the full report.
   *
   * @private
   * @async
   * @param {string} url - Callback URL.
   * @param {Object} report - Full hygiene report.
   * @param {string} correlationId - Correlation ID.
   * @returns {Promise<void>}
   */
  async _sendCallback(url, report, correlationId) {
    this.logger.info('Sending hygiene report callback', {
      correlationId,
      callbackUrl: url,
      component: 'NSXHygieneOrchestrator'
    });

    await this.snowAdapter.toCallbackPayload({
      action: 'hygieneCallback',
      correlationId,
      callbackUrl: url,
      report
    });
  }
}

module.exports = NSXHygieneOrchestrator;
