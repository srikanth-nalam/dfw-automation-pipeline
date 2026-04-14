/**
 * @fileoverview TagOperations — CRUD operations for NSX tags via the NSX-T REST API.
 *
 * All mutating operations follow an **idempotent read-compare-write** pattern:
 *
 *  1. Read the VM's current tag set from NSX Manager.
 *  2. Compute the delta between current and desired state using
 *     {@link TagCardinalityEnforcer}.
 *  3. Apply only the changes (if any) via PATCH.
 *
 * This avoids unnecessary writes and prevents race conditions where two
 * concurrent callers might overwrite each other's changes.
 *
 * @module TagOperations
 */

'use strict';

const TagCardinalityEnforcer = require('./TagCardinalityEnforcer');

/**
 * @class TagOperations
 * @classdesc Provides CRUD methods for managing NSX tags on virtual machines
 * through the NSX-T Manager REST API.
 */
class TagOperations {
  /**
   * Creates a new TagOperations instance.
   *
   * @constructor
   * @param {Object} restClient - HTTP client pre-configured for the NSX-T API.
   *   Must expose `get(url, options)` and `patch(url, body, options)` methods
   *   that return Promises.
   * @param {Object} logger - Structured logger instance.  Must expose `info`,
   *   `warn`, `error`, and `debug` methods.
   */
  constructor(restClient, logger) {
    if (!restClient) {
      throw new Error('TagOperations requires a restClient instance');
    }
    if (!logger) {
      throw new Error('TagOperations requires a logger instance');
    }

    /** @type {Object} */
    this.restClient = restClient;
    /** @type {Object} */
    this.logger = logger;
    /** @type {TagCardinalityEnforcer} */
    this.cardinalityEnforcer = new TagCardinalityEnforcer();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Applies tags to a VM using an idempotent read-compare-write cycle.
   *
   * 1. Reads the VM's current tags from NSX Manager.
   * 2. Enforces cardinality rules by merging `tags` into the current set.
   * 3. Validates the resulting tag set for conflicting combinations.
   * 4. Computes a minimal delta and PATCHes only if changes are needed.
   *
   * @async
   * @param {string} vmId - The NSX external ID of the virtual machine.
   * @param {Object.<string, string|string[]>} tags - Desired tag map.
   *   Example: `{ AppCI: 'APP001', SystemRole: 'Web', Compliance: ['PCI'] }`
   * @param {string} site - Site identifier used to resolve the NSX Manager URL.
   * @returns {Promise<{applied: boolean, delta: {toAdd: Array, toRemove: Array}, currentTags: Object, finalTags: Object}>}
   *   Result describing what was (or was not) changed.
   * @throws {Error} If tag validation fails or the NSX API call errors.
   *
   * @example
   * const result = await tagOps.applyTags('vm-123', {
   *   Region: 'NDCNG',
   *   SecurityZone: 'Greenzone',
   *   Environment: 'Production',
   *   AppCI: 'APP001',
   *   SystemRole: 'Web'
   * }, 'site-east');
   */
  async applyTags(vmId, tags, site) {
    const correlationCtx = { vmId, site, operation: 'applyTags' };

    this.logger.info('Starting tag apply operation', correlationCtx);
    this.logger.debug('Desired tags', { ...correlationCtx, tags });

    // Step 1 — Read current state
    const currentTags = await this.getCurrentTags(vmId, site);
    this.logger.debug('Current tags retrieved', { ...correlationCtx, currentTags });

    // Step 2 — Enforce cardinality and merge
    const mergedTags = this.cardinalityEnforcer.enforceCardinality(currentTags, tags);

    // Step 3 — Validate the merged set
    const validation = this.cardinalityEnforcer.validateTagCombinations(mergedTags);
    if (!validation.valid) {
      const errMsg = `Tag validation failed: ${validation.errors.join('; ')}`;
      this.logger.error(errMsg, correlationCtx);
      throw new Error(errMsg);
    }

    // Step 4 — Compute delta
    const delta = this.cardinalityEnforcer.computeDelta(currentTags, tags);

    if (delta.toAdd.length === 0 && delta.toRemove.length === 0) {
      this.logger.info('No tag changes required — VM already in desired state', correlationCtx);
      return {
        applied: false,
        delta,
        currentTags,
        finalTags: mergedTags
      };
    }

    this.logger.info('Applying tag delta', {
      ...correlationCtx,
      toAdd: delta.toAdd.length,
      toRemove: delta.toRemove.length
    });

    // Step 5 — Build the full NSX tag array and PATCH
    const nsxTagArray = this._buildNsxTagArray(mergedTags);
    await this._patchTags(vmId, site, nsxTagArray);

    this.logger.info('Tags applied successfully', {
      ...correlationCtx,
      added: delta.toAdd.length,
      removed: delta.toRemove.length
    });

    return {
      applied: true,
      delta,
      currentTags,
      finalTags: mergedTags
    };
  }

  /**
   * Removes tags for the specified categories from a VM.
   *
   * @async
   * @param {string} vmId - The NSX external ID of the virtual machine.
   * @param {string[]} tagCategories - Array of category (scope) names to
   *   remove (e.g. `['AppCI', 'Compliance']`).
   * @param {string} site - Site identifier.
   * @returns {Promise<{removed: boolean, removedCategories: string[], currentTags: Object, finalTags: Object}>}
   *   Result describing what was removed.
   *
   * @example
   * await tagOps.removeTags('vm-123', ['Compliance', 'CostCenter'], 'site-east');
   */
  async removeTags(vmId, tagCategories, site) {
    const correlationCtx = { vmId, site, operation: 'removeTags', tagCategories };

    this.logger.info('Starting tag removal operation', correlationCtx);

    // Read current state
    const currentTags = await this.getCurrentTags(vmId, site);
    this.logger.debug('Current tags retrieved for removal', { ...correlationCtx, currentTags });

    // Build the filtered tag set
    const finalTags = { ...currentTags };
    const actuallyRemoved = [];

    for (const category of tagCategories) {
      if (finalTags[category] !== undefined) {
        delete finalTags[category];
        actuallyRemoved.push(category);
      }
    }

    if (actuallyRemoved.length === 0) {
      this.logger.info('No tags to remove — categories not present on VM', correlationCtx);
      return {
        removed: false,
        removedCategories: [],
        currentTags,
        finalTags
      };
    }

    // PATCH with the filtered tag set
    const nsxTagArray = this._buildNsxTagArray(finalTags);
    await this._patchTags(vmId, site, nsxTagArray);

    this.logger.info('Tags removed successfully', {
      ...correlationCtx,
      removedCategories: actuallyRemoved
    });

    return {
      removed: true,
      removedCategories: actuallyRemoved,
      currentTags,
      finalTags
    };
  }

  /**
   * Retrieves the current tags for a VM from the NSX Manager and normalizes
   * them into a category-keyed object.
   *
   * @async
   * @param {string} vmId - The NSX external ID of the virtual machine.
   * @param {string} site - Site identifier.
   * @returns {Promise<Object.<string, string|string[]>>} Normalized tag map.
   *   Single-value categories are strings; Compliance is an array.
   *
   * @example
   * const tags = await tagOps.getCurrentTags('vm-123', 'site-east');
   * // tags => { AppCI: 'APP001', Compliance: ['PCI', 'HIPAA'] }
   */
  async getCurrentTags(vmId, site) {
    const correlationCtx = { vmId, site, operation: 'getCurrentTags' };

    this.logger.debug('Fetching current tags from NSX Manager', correlationCtx);

    const nsxUrl = this._getNsxUrl(site);
    const endpoint = `${nsxUrl}/api/v1/fabric/virtual-machines/${encodeURIComponent(vmId)}/tags`;

    const response = await this.restClient.get(endpoint, {
      headers: { 'Content-Type': 'application/json' }
    });

    const nsxTags = this._extractTagsFromResponse(response);
    const normalized = this._normalizeNsxTags(nsxTags);

    this.logger.debug('Tags normalized', { ...correlationCtx, tagCount: nsxTags.length });
    return normalized;
  }

  /**
   * Updates tags on a VM using the full read-compare-write pattern.
   *
   * This method differs from {@link applyTags} in that it explicitly removes
   * old values for single-value categories before writing the new value, making
   * it suitable for complete tag replacement scenarios.
   *
   * @async
   * @param {string} vmId - The NSX external ID of the virtual machine.
   * @param {Object.<string, string|string[]>} newTags - The new desired tags.
   * @param {string} site - Site identifier.
   * @returns {Promise<{updated: boolean, delta: {toAdd: Array, toRemove: Array}, previousTags: Object, currentTags: Object}>}
   *   Result describing the update.
   *
   * @example
   * const result = await tagOps.updateTags('vm-123', {
   *   AppCI: 'APP002',
   *   Environment: 'Staging'
   * }, 'site-east');
   */
  async updateTags(vmId, newTags, site) {
    const correlationCtx = { vmId, site, operation: 'updateTags' };

    this.logger.info('Starting tag update (read-compare-write)', correlationCtx);

    // Step 1 — Read current state
    const previousTags = await this.getCurrentTags(vmId, site);
    this.logger.debug('Previous tags retrieved', { ...correlationCtx, previousTags });

    // Step 2 — For single-value categories present in newTags, remove old
    // values from previous set so the enforcer starts clean for those keys.
    const preparedBase = { ...previousTags };
    for (const category of Object.keys(newTags)) {
      const categoryType = this.cardinalityEnforcer.getCategoryType(category);
      if (categoryType === 'single') {
        delete preparedBase[category];
      }
    }

    // Step 3 — Merge using cardinality enforcer
    const mergedTags = this.cardinalityEnforcer.enforceCardinality(preparedBase, newTags);

    // Step 4 — Validate
    const validation = this.cardinalityEnforcer.validateTagCombinations(mergedTags);
    if (!validation.valid) {
      const errMsg = `Tag update validation failed: ${validation.errors.join('; ')}`;
      this.logger.error(errMsg, correlationCtx);
      throw new Error(errMsg);
    }

    // Step 5 — Compute delta from the *original* previousTags to the final state
    const delta = this._computeRawDelta(previousTags, mergedTags);

    if (delta.toAdd.length === 0 && delta.toRemove.length === 0) {
      this.logger.info('No tag updates required — VM already in desired state', correlationCtx);
      return {
        updated: false,
        delta,
        previousTags,
        currentTags: mergedTags
      };
    }

    // Step 6 — PATCH
    const nsxTagArray = this._buildNsxTagArray(mergedTags);
    await this._patchTags(vmId, site, nsxTagArray);

    this.logger.info('Tags updated successfully', {
      ...correlationCtx,
      added: delta.toAdd.length,
      removed: delta.toRemove.length
    });

    return {
      updated: true,
      delta,
      previousTags,
      currentTags: mergedTags
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolves the NSX Manager base URL for a given site.
   *
   * @private
   * @param {string} site - The site identifier.
   * @returns {string} The base URL (no trailing slash).
   */
  _getNsxUrl(site) {
    // In production this would look up the site-to-URL mapping from
    // configuration.  The restClient may also handle this internally.
    // We construct a deterministic URL so callers can configure per-site
    // endpoints on the restClient.
    return `https://nsx-manager-${site}`;
  }

  /**
   * Extracts the tags array from an NSX API response.
   *
   * @private
   * @param {Object} response - The HTTP response object.
   * @returns {Array<{tag: string, scope: string}>} The raw NSX tag array.
   */
  _extractTagsFromResponse(response) {
    // NSX API wraps tags inside the response body. Handle both direct
    // array and nested structures.
    if (!response) {
      return [];
    }

    const body = response.body || response.data || response;

    if (Array.isArray(body)) {
      return body;
    }

    if (body && Array.isArray(body.tags)) {
      return body.tags;
    }

    if (body && body.results && Array.isArray(body.results)) {
      return body.results;
    }

    return [];
  }

  /**
   * Normalizes an NSX tag array (`[{tag, scope}]`) into a category-keyed
   * object.  Single-value categories produce string values; multi-value
   * categories produce arrays.
   *
   * @private
   * @param {Array<{tag: string, scope: string}>} nsxTags - Raw NSX tags.
   * @returns {Object.<string, string|string[]>} Normalized tag map.
   */
  _normalizeNsxTags(nsxTags) {
    const normalized = {};

    for (const entry of nsxTags) {
      const { tag, scope } = entry;
      if (!scope) {
        continue;
      }

      const categoryType = this.cardinalityEnforcer.getCategoryType(scope);

      if (categoryType === 'multi') {
        if (!normalized[scope]) {
          normalized[scope] = [];
        }
        if (!normalized[scope].includes(tag)) {
          normalized[scope].push(tag);
        }
      } else {
        // single or unknown — last value wins
        normalized[scope] = tag;
      }
    }

    return normalized;
  }

  /**
   * Builds the full NSX tag array from a normalized tag map.
   *
   * @private
   * @param {Object.<string, string|string[]>} tagMap - Normalized tag map.
   * @returns {Array<{tag: string, scope: string}>} NSX tag array.
   */
  _buildNsxTagArray(tagMap) {
    const nsxTags = [];

    for (const [scope, value] of Object.entries(tagMap)) {
      const values = Array.isArray(value) ? value : [value];
      for (const tag of values) {
        nsxTags.push({ tag, scope });
      }
    }

    return nsxTags;
  }

  /**
   * Sends a PATCH request to update tags on a VM.
   *
   * @private
   * @async
   * @param {string} vmId - The VM external ID.
   * @param {string} site - Site identifier.
   * @param {Array<{tag: string, scope: string}>} nsxTagArray - Full NSX tag
   *   array to set.
   * @returns {Promise<Object>} The API response.
   */
  async _patchTags(vmId, site, nsxTagArray) {
    const nsxUrl = this._getNsxUrl(site);
    const endpoint = `${nsxUrl}/api/v1/fabric/virtual-machines/${encodeURIComponent(vmId)}/tags`;

    return this.restClient.patch(endpoint, {
      tags: nsxTagArray
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Computes a raw delta between two normalized tag maps without re-applying
   * cardinality enforcement.  Used by {@link updateTags} where cardinality has
   * already been enforced.
   *
   * @private
   * @param {Object.<string, string|string[]>} from - The original tag map.
   * @param {Object.<string, string|string[]>} to - The target tag map.
   * @returns {{toAdd: Array<{tag: string, scope: string}>, toRemove: Array<{tag: string, scope: string}>}}
   */
  _computeRawDelta(from, to) {
    const toAdd = [];
    const toRemove = [];

    const allCategories = new Set([
      ...Object.keys(from),
      ...Object.keys(to)
    ]);

    for (const category of allCategories) {
      const fromValues = this._toArray(from[category]);
      const toValues = this._toArray(to[category]);

      for (const value of toValues) {
        if (!fromValues.includes(value)) {
          toAdd.push({ tag: value, scope: category });
        }
      }
      for (const value of fromValues) {
        if (!toValues.includes(value)) {
          toRemove.push({ tag: value, scope: category });
        }
      }
    }

    return { toAdd, toRemove };
  }

  /**
   * Normalizes a value to an array.
   *
   * @private
   * @param {*} value - Value to normalize.
   * @returns {string[]}
   */
  _toArray(value) {
    if (value === undefined || value === null) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  }
}

module.exports = TagOperations;
