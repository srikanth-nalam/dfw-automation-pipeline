/**
 * @fileoverview GroupReconciler — Reconciles expected versus actual NSX Dynamic
 * Security Group membership for a virtual machine.
 *
 * After tags are applied and propagated, the reconciler verifies that the VM
 * has landed in all expected groups and generates a structured reconciliation
 * report.  Discrepancies are reported with recommended actions so that
 * upstream systems (vRO workflows, ServiceNow) can decide whether to retry,
 * escalate, or accept the deviation.
 *
 * @module GroupReconciler
 */

'use strict';

/**
 * Possible reconciliation statuses.
 *
 * @constant {Object.<string, string>}
 */
const RECONCILIATION_STATUS = Object.freeze({
  /** All expected groups match — no discrepancies. */
  RECONCILED: 'RECONCILED',
  /** One or more expected groups are missing or unexpected groups are present. */
  DISCREPANCIES_FOUND: 'DISCREPANCIES_FOUND',
  /** The reconciliation process itself failed (e.g. API error). */
  ERROR: 'ERROR'
});

/**
 * Recommended actions for discrepancy types.
 *
 * @constant {Object.<string, string>}
 */
const DISCREPANCY_ACTIONS = Object.freeze({
  MISSING: 'Verify tag propagation completed and group criteria match. ' +
    'Consider re-applying tags or escalating if the group uses static membership.',
  UNEXPECTED: 'Review group membership criteria. The VM may have residual ' +
    'tags from a previous configuration or the group criteria may be overly broad.'
});

/**
 * @class GroupReconciler
 * @classdesc Orchestrates group membership verification and produces
 * structured reconciliation reports.
 */
class GroupReconciler {
  /**
   * Creates a new GroupReconciler.
   *
   * @constructor
   * @param {Object} groupVerifier - A {@link GroupMembershipVerifier} instance
   *   used to check actual group membership.
   * @param {Object} restClient - HTTP client pre-configured for the NSX-T API.
   *   Passed through for potential direct queries.
   * @param {Object} logger - Structured logger instance.  Must expose `info`,
   *   `warn`, `error`, and `debug` methods.
   */
  constructor(groupVerifier, restClient, logger) {
    if (!groupVerifier) {
      throw new Error('GroupReconciler requires a groupVerifier instance');
    }
    if (!restClient) {
      throw new Error('GroupReconciler requires a restClient instance');
    }
    if (!logger) {
      throw new Error('GroupReconciler requires a logger instance');
    }

    /** @type {Object} */
    this.groupVerifier = groupVerifier;
    /** @type {Object} */
    this.restClient = restClient;
    /** @type {Object} */
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Runs a full reconciliation cycle for a VM.
   *
   * 1. Fetches the VM's current tags from NSX (via the verifier).
   * 2. Predicts expected groups based on tag-to-group rules.
   * 3. Fetches actual group membership from NSX.
   * 4. Compares expected vs actual and produces a reconciliation report.
   *
   * @async
   * @param {string} vmId - The NSX external ID of the virtual machine.
   * @param {string} site - Site identifier used to resolve the NSX Manager URL.
   * @param {Object} [options={}] - Optional reconciliation parameters.
   * @param {string[]} [options.expectedGroups] - Explicit list of expected
   *   group names.  If omitted, groups are predicted from the VM's current
   *   tags using the verifier's tag-to-group rules.
   * @returns {Promise<{vmId: string, timestamp: string, status: string, discrepancies: Array<{groupName: string, expected: boolean, actual: boolean, action: string}>, expectedGroups: string[], actualGroups: string[]}>}
   *   The reconciliation report.
   *
   * @example
   * const report = await reconciler.reconcile('vm-123', 'site-east');
   * if (report.status === 'DISCREPANCIES_FOUND') {
   *   console.log(report.discrepancies);
   * }
   */
  async reconcile(vmId, site, options = {}) {
    const correlationCtx = { vmId, site, operation: 'reconcile' };
    const timestamp = new Date().toISOString();

    this.logger.info('Starting group reconciliation', correlationCtx);

    try {
      // Determine expected groups
      let expectedGroups;

      if (options.expectedGroups && options.expectedGroups.length > 0) {
        expectedGroups = options.expectedGroups;
        this.logger.debug('Using explicitly provided expected groups', {
          ...correlationCtx,
          expectedGroups
        });
      } else {
        // Predict from current tags
        expectedGroups = await this._predictExpectedGroups(vmId, site);
        this.logger.debug('Predicted expected groups from tags', {
          ...correlationCtx,
          expectedGroups
        });
      }

      // Fetch actual group membership
      const actualGroups = await this.groupVerifier.getEffectiveGroups(vmId, site);

      // Build discrepancies
      const discrepancies = this._findDiscrepancies(expectedGroups, actualGroups);

      const status = discrepancies.length === 0
        ? RECONCILIATION_STATUS.RECONCILED
        : RECONCILIATION_STATUS.DISCREPANCIES_FOUND;

      const report = {
        vmId,
        timestamp,
        status,
        discrepancies,
        expectedGroups,
        actualGroups
      };

      if (status === RECONCILIATION_STATUS.RECONCILED) {
        this.logger.info('Reconciliation complete — no discrepancies', {
          ...correlationCtx,
          groupCount: actualGroups.length
        });
      } else {
        this.logger.warn('Reconciliation complete — discrepancies found', {
          ...correlationCtx,
          discrepancyCount: discrepancies.length
        });
      }

      return report;
    } catch (error) {
      this.logger.error('Reconciliation failed with error', {
        ...correlationCtx,
        error: error.message,
        code: error.code
      });

      return {
        vmId,
        timestamp,
        status: RECONCILIATION_STATUS.ERROR,
        discrepancies: [],
        expectedGroups: [],
        actualGroups: [],
        error: {
          message: error.message,
          code: error.code || 'UNKNOWN'
        }
      };
    }
  }

  /**
   * Generates a structured report of group membership discrepancies for a VM.
   *
   * This is a convenience method that calls {@link reconcile} and returns only
   * the discrepancy-related fields, enriched with human-readable descriptions.
   *
   * @async
   * @param {string} vmId - The NSX external ID of the virtual machine.
   * @param {string} site - Site identifier.
   * @param {Object} [options={}] - Optional parameters forwarded to
   *   {@link reconcile}.
   * @returns {Promise<{vmId: string, timestamp: string, status: string, discrepancies: Array<{groupName: string, expected: boolean, actual: boolean, action: string, type: string}>, summary: string}>}
   *   Discrepancy report with a human-readable summary.
   *
   * @example
   * const report = await reconciler.reportDiscrepancies('vm-123', 'site-east');
   * console.log(report.summary);
   * // "2 discrepancies found: 1 missing group(s), 1 unexpected group(s)"
   */
  async reportDiscrepancies(vmId, site, options = {}) {
    const correlationCtx = { vmId, site, operation: 'reportDiscrepancies' };

    this.logger.info('Generating discrepancy report', correlationCtx);

    const reconciliation = await this.reconcile(vmId, site, options);

    // Enrich discrepancies with a type label
    const enrichedDiscrepancies = reconciliation.discrepancies.map((d) => ({
      ...d,
      type: d.expected && !d.actual ? 'MISSING' : 'UNEXPECTED'
    }));

    // Build human-readable summary
    const missingCount = enrichedDiscrepancies.filter((d) => d.type === 'MISSING').length;
    const unexpectedCount = enrichedDiscrepancies.filter((d) => d.type === 'UNEXPECTED').length;

    let summary;
    if (reconciliation.status === RECONCILIATION_STATUS.RECONCILED) {
      summary = 'All expected groups verified — no discrepancies.';
    } else if (reconciliation.status === RECONCILIATION_STATUS.ERROR) {
      summary = `Reconciliation failed: ${reconciliation.error ? reconciliation.error.message : 'Unknown error'}`;
    } else {
      const parts = [];
      if (missingCount > 0) {
        parts.push(`${missingCount} missing group(s)`);
      }
      if (unexpectedCount > 0) {
        parts.push(`${unexpectedCount} unexpected group(s)`);
      }
      summary = `${enrichedDiscrepancies.length} discrepancies found: ${parts.join(', ')}`;
    }

    this.logger.info('Discrepancy report generated', {
      ...correlationCtx,
      status: reconciliation.status,
      summary
    });

    return {
      vmId,
      timestamp: reconciliation.timestamp,
      status: reconciliation.status,
      discrepancies: enrichedDiscrepancies,
      summary
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Predicts the expected groups for a VM by reading its current tags from
   * NSX and evaluating them against the verifier's group rules.
   *
   * @private
   * @async
   * @param {string} vmId - The VM external ID.
   * @param {string} site - Site identifier.
   * @returns {Promise<string[]>} Predicted group names.
   */
  async _predictExpectedGroups(vmId, site) {
    const nsxUrl = `https://nsx-manager-${site}`;
    const endpoint = `${nsxUrl}/api/v1/fabric/virtual-machines/${encodeURIComponent(vmId)}/tags`;

    const response = await this.restClient.get(endpoint, {
      headers: { 'Content-Type': 'application/json' }
    });

    const currentTags = this._normalizeTagResponse(response);

    // Use the verifier's predictGroupChanges with identical current/new tags
    // to determine which groups the current tags satisfy
    const prediction = this.groupVerifier.predictGroupChanges(vmId, {}, currentTags);

    return prediction.groupsToJoin;
  }

  /**
   * Normalizes an NSX tag API response into a category-keyed tag map.
   *
   * @private
   * @param {Object} response - The HTTP response.
   * @returns {Object.<string, string|string[]>} Normalized tag map.
   */
  _normalizeTagResponse(response) {
    const body = response.body || response.data || response;
    const tags = Array.isArray(body)
      ? body
      : (body && Array.isArray(body.tags))
        ? body.tags
        : (body && Array.isArray(body.results))
          ? body.results
          : [];

    const normalized = {};
    const multiValueCategories = new Set(['Compliance']);

    for (const { tag, scope } of tags) {
      if (!scope) {
        continue;
      }

      if (multiValueCategories.has(scope)) {
        if (!normalized[scope]) {
          normalized[scope] = [];
        }
        if (!normalized[scope].includes(tag)) {
          normalized[scope].push(tag);
        }
      } else {
        normalized[scope] = tag;
      }
    }

    return normalized;
  }

  /**
   * Compares expected and actual group lists and returns a structured array
   * of discrepancies.
   *
   * @private
   * @param {string[]} expectedGroups - Groups the VM should belong to.
   * @param {string[]} actualGroups - Groups the VM actually belongs to.
   * @returns {Array<{groupName: string, expected: boolean, actual: boolean, action: string}>}
   *   Array of discrepancies (empty if fully reconciled).
   */
  _findDiscrepancies(expectedGroups, actualGroups) {
    const discrepancies = [];
    const actualSet = new Set(actualGroups);
    const expectedSet = new Set(expectedGroups);

    // Missing: expected but not in actual
    for (const groupName of expectedGroups) {
      if (!actualSet.has(groupName)) {
        discrepancies.push({
          groupName,
          expected: true,
          actual: false,
          action: DISCREPANCY_ACTIONS.MISSING
        });
      }
    }

    // Unexpected: in actual but not expected
    for (const groupName of actualGroups) {
      if (!expectedSet.has(groupName)) {
        discrepancies.push({
          groupName,
          expected: false,
          actual: true,
          action: DISCREPANCY_ACTIONS.UNEXPECTED
        });
      }
    }

    return discrepancies;
  }
}

module.exports = GroupReconciler;
