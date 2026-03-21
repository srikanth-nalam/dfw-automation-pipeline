/**
 * @fileoverview TagPropagationVerifier — Polls NSX Manager to verify that
 * vCenter tag changes have propagated to NSX.
 *
 * After tags are applied in vCenter, NSX Manager must sync the change before
 * Dynamic Security Groups re-evaluate membership.  This module polls the
 * NSX tag endpoint until the expected tags appear on the VM or a configurable
 * timeout is reached.
 *
 * Default polling parameters:
 *  - Polling interval: 10 000 ms (10 s)
 *  - Maximum wait: 60 000 ms (60 s)
 *
 * On timeout, an error with code **DFW-7004** is thrown via
 * {@link ErrorFactory}.
 *
 * @module TagPropagationVerifier
 */

'use strict';

const ErrorFactory = require('../shared/ErrorFactory');

/**
 * Default configuration for polling behaviour.
 *
 * @constant {Object}
 * @property {number} pollingInterval - Milliseconds between poll attempts.
 * @property {number} maxWait - Maximum milliseconds to wait before timeout.
 */
const DEFAULT_CONFIG = Object.freeze({
  pollingInterval: 10000,
  maxWait: 60000
});

/**
 * @class TagPropagationVerifier
 * @classdesc Verifies that NSX Manager has received and applied tag changes
 * originating from vCenter.
 */
class TagPropagationVerifier {
  /**
   * Creates a new TagPropagationVerifier.
   *
   * @constructor
   * @param {Object} restClient - HTTP client pre-configured for the NSX-T API.
   *   Must expose a `get(url, options)` method returning a Promise.
   * @param {Object} logger - Structured logger instance.  Must expose `info`,
   *   `warn`, `error`, and `debug` methods.
   * @param {Object} [config={}] - Optional overrides for polling behaviour.
   * @param {number} [config.pollingInterval=10000] - Milliseconds between
   *   poll attempts.
   * @param {number} [config.maxWait=60000] - Maximum milliseconds to wait.
   */
  constructor(restClient, logger, config = {}) {
    if (!restClient) {
      throw new Error('TagPropagationVerifier requires a restClient instance');
    }
    if (!logger) {
      throw new Error('TagPropagationVerifier requires a logger instance');
    }

    /** @type {Object} */
    this.restClient = restClient;
    /** @type {Object} */
    this.logger = logger;
    /** @type {number} */
    this.pollingInterval = config.pollingInterval || DEFAULT_CONFIG.pollingInterval;
    /** @type {number} */
    this.maxWait = config.maxWait || DEFAULT_CONFIG.maxWait;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Verifies that the expected tags are present on the VM in NSX Manager.
   *
   * Polls at `pollingInterval` until the expected tags are detected or
   * `maxWait` is exceeded, at which point a DFW-7004 error is thrown.
   *
   * @async
   * @param {string} vmId - The NSX external ID of the virtual machine.
   * @param {Object.<string, string|string[]>} expectedTags - The tag map that
   *   should be present on the VM after propagation.  Only the categories
   *   specified here are checked; extra categories on the VM are ignored.
   * @param {string} site - Site identifier used to resolve the NSX Manager URL.
   * @returns {Promise<{synced: boolean, actualTags: Object, duration: number}>}
   *   On success, `synced` is `true`, `actualTags` is the full tag map
   *   retrieved from NSX, and `duration` is the elapsed time in milliseconds.
   * @throws {Error} DFW-7004 if the tags do not appear within `maxWait`.
   *
   * @example
   * const result = await verifier.verifyPropagation('vm-123', {
   *   Application: 'APP001',
   *   Compliance: ['PCI']
   * }, 'site-east');
   * console.log(result.duration); // e.g. 20500
   */
  async verifyPropagation(vmId, expectedTags, site) {
    const correlationCtx = { vmId, site, operation: 'verifyPropagation' };

    this.logger.info('Starting tag propagation verification', {
      ...correlationCtx,
      expectedCategories: Object.keys(expectedTags)
    });

    const startTime = Date.now();

    const result = await this.waitForSync(
      vmId,
      site,
      this.pollingInterval,
      this.maxWait,
      (actualTags) => this._tagsMatch(expectedTags, actualTags)
    );

    const duration = Date.now() - startTime;

    this.logger.info('Tag propagation verified', {
      ...correlationCtx,
      duration,
      attempts: result.attempts
    });

    return {
      synced: true,
      actualTags: result.actualTags,
      duration
    };
  }

  /**
   * Generic polling method that repeatedly fetches the VM's current tags from
   * NSX Manager until a condition is met or a timeout is reached.
   *
   * @async
   * @param {string} vmId - The NSX external ID of the virtual machine.
   * @param {string} site - Site identifier.
   * @param {number} [pollingInterval] - Milliseconds between polls.  Defaults
   *   to the instance-level `pollingInterval`.
   * @param {number} [maxWait] - Maximum milliseconds before timeout.  Defaults
   *   to the instance-level `maxWait`.
   * @param {function(Object): boolean} [matchFn] - Optional predicate that
   *   receives the current tag map and returns `true` when sync is complete.
   *   If omitted, the method returns after the first successful fetch.
   * @returns {Promise<{actualTags: Object, attempts: number, elapsed: number}>}
   *   The tags at the time the condition was met.
   * @throws {Error} DFW-7004 if `maxWait` is exceeded.
   *
   * @example
   * const result = await verifier.waitForSync('vm-123', 'site-east', 5000, 30000);
   */
  async waitForSync(vmId, site, pollingInterval, maxWait, matchFn) {
    const interval = pollingInterval || this.pollingInterval;
    const timeout = maxWait || this.maxWait;
    const correlationCtx = { vmId, site, operation: 'waitForSync' };

    const startTime = Date.now();
    let attempts = 0;

    while (true) {
      attempts++;
      const elapsed = Date.now() - startTime;

      if (elapsed > timeout) {
        const errMsg = `Tag propagation sync timed out after ${timeout}ms (${attempts} attempts)`;
        this.logger.error(errMsg, { ...correlationCtx, elapsed, attempts });

        throw ErrorFactory.createError('DFW-7004', errMsg, 'TagPropagationVerification', attempts, {
          vmId,
          site,
          elapsed,
          timeout
        });
      }

      this.logger.debug(`Polling attempt ${attempts}`, {
        ...correlationCtx,
        elapsed,
        attempts
      });

      try {
        const actualTags = await this._fetchCurrentTags(vmId, site);

        // If no match function provided, any successful fetch is sufficient
        if (!matchFn || matchFn(actualTags)) {
          return {
            actualTags,
            attempts,
            elapsed: Date.now() - startTime
          };
        }

        this.logger.debug('Tags not yet in expected state, will retry', {
          ...correlationCtx,
          attempts,
          actualTags
        });
      } catch (fetchError) {
        this.logger.warn('Failed to fetch tags during polling, will retry', {
          ...correlationCtx,
          attempts,
          error: fetchError.message
        });
      }

      // Wait before next poll
      await this._sleep(interval);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetches the current tags for a VM from the NSX Manager.
   *
   * @private
   * @async
   * @param {string} vmId - The VM external ID.
   * @param {string} site - Site identifier.
   * @returns {Promise<Object.<string, string|string[]>>} Normalized tag map.
   */
  async _fetchCurrentTags(vmId, site) {
    const nsxUrl = this._getNsxUrl(site);
    const endpoint = `${nsxUrl}/api/v1/fabric/virtual-machines/${encodeURIComponent(vmId)}/tags`;

    const response = await this.restClient.get(endpoint, {
      headers: { 'Content-Type': 'application/json' }
    });

    return this._normalizeResponse(response);
  }

  /**
   * Resolves the NSX Manager base URL for a given site.
   *
   * @private
   * @param {string} site - The site identifier.
   * @returns {string} The base URL (no trailing slash).
   */
  _getNsxUrl(site) {
    return `https://nsx-manager-${site}`;
  }

  /**
   * Normalizes an NSX API response into a category-keyed tag map.
   *
   * @private
   * @param {Object} response - The HTTP response.
   * @returns {Object.<string, string|string[]>} Normalized tag map.
   */
  _normalizeResponse(response) {
    const body = response.body || response.data || response;
    const tags = Array.isArray(body)
      ? body
      : (body && Array.isArray(body.tags))
        ? body.tags
        : (body && Array.isArray(body.results))
          ? body.results
          : [];

    const normalized = {};

    // Known multi-value categories
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
   * Checks whether the expected tags are present in the actual tag set.
   * Only categories present in `expected` are checked; extra categories in
   * `actual` are ignored.
   *
   * @private
   * @param {Object.<string, string|string[]>} expected - Expected tag values.
   * @param {Object.<string, string|string[]>} actual - Actual tag values from NSX.
   * @returns {boolean} `true` if all expected categories match.
   */
  _tagsMatch(expected, actual) {
    for (const [category, expectedValue] of Object.entries(expected)) {
      const actualValue = actual[category];

      if (actualValue === undefined) {
        return false;
      }

      if (Array.isArray(expectedValue)) {
        if (!Array.isArray(actualValue)) {
          return false;
        }
        // All expected values must be present (order-independent)
        const actualSet = new Set(actualValue);
        for (const val of expectedValue) {
          if (!actualSet.has(val)) {
            return false;
          }
        }
      } else {
        if (actualValue !== expectedValue) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Sleeps for the specified duration.
   *
   * @private
   * @param {number} ms - Milliseconds to sleep.
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = TagPropagationVerifier;
