/**
 * @file RuleRegistry.js
 * @description External rule tracking registry for the DFW Automation Pipeline.
 *   Interfaces with the ServiceNow custom table x_dfw_rule_registry to persist
 *   rule state, change history, ownership, and certification dates.
 *
 * Error codes: DFW-11001 through DFW-11006
 *
 * @module dfw/RuleRegistry
 */

'use strict';

/**
 * ServiceNow custom table path for the DFW rule registry.
 * @constant {string}
 * @private
 */
const REGISTRY_TABLE = '/api/now/table/x_dfw_rule_registry';

/**
 * @class RuleRegistry
 * @classdesc Manages DFW rule persistence in ServiceNow. Supports CRUD
 *   operations, state tracking, change history, and search queries against
 *   the x_dfw_rule_registry table.
 *
 * @example
 * const registry = new RuleRegistry({ restClient, logger });
 * const ruleId = registry.generateRuleId();
 * await registry.register({ ruleId, name: 'allow-web', state: 'REQUESTED' });
 */
class RuleRegistry {
  /**
   * Creates a new RuleRegistry instance.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.restClient - HTTP client with `get`, `post`, `patch` methods.
   * @param {Object} dependencies.logger - Structured logger with `info`, `warn`, `error`, `debug`.
   *
   * @throws {Error} [DFW-11001] When required dependencies are missing.
   *
   * @example
   * const registry = new RuleRegistry({ restClient, logger });
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-11001] RuleRegistry requires dependencies');
    }
    if (!dependencies.restClient) {
      throw new Error('[DFW-11001] RuleRegistry requires a restClient instance');
    }
    if (!dependencies.logger) {
      throw new Error('[DFW-11001] RuleRegistry requires a logger instance');
    }

    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this._nextId = 1;
  }

  /**
   * Generates a sequential rule identifier in the format DFW-R-XXXX.
   *
   * The counter is local to this instance and increments monotonically.
   * In production, the authoritative ID would come from the ServiceNow
   * auto-number field on the registry table.
   *
   * @returns {string} A unique rule ID (e.g. 'DFW-R-0001').
   *
   * @example
   * const ruleId = registry.generateRuleId(); // 'DFW-R-0001'
   * const nextId = registry.generateRuleId(); // 'DFW-R-0002'
   */
  generateRuleId() {
    const id = `DFW-R-${String(this._nextId).padStart(4, '0')}`;
    this._nextId += 1;
    return id;
  }

  /**
   * Registers a new rule in the ServiceNow registry table.
   *
   * Creates a record with the initial state, owner, and timestamps.
   * An initial change history entry is appended automatically.
   *
   * @async
   * @param {Object} rule - Rule definition to register.
   * @param {string} rule.ruleId - Unique rule identifier.
   * @param {string} rule.name - Human-readable rule name.
   * @param {string} rule.state - Initial rule state.
   * @param {string} [rule.owner] - Rule owner identifier.
   * @returns {Promise<Object>} The registered rule record from ServiceNow.
   *
   * @throws {Error} [DFW-11002] When the rule is missing required fields.
   * @throws {Error} [DFW-11003] When the REST call fails.
   *
   * @example
   * const record = await registry.register({
   *   ruleId: 'DFW-R-0001',
   *   name: 'allow-web-to-db',
   *   state: 'REQUESTED',
   *   owner: 'john.doe'
   * });
   */
  async register(rule) {
    if (!rule || !rule.ruleId || !rule.name || !rule.state) {
      throw new Error('[DFW-11002] Rule must include ruleId, name, and state');
    }

    this.logger.info('Registering rule in ServiceNow', {
      ruleId: rule.ruleId,
      name: rule.name,
      state: rule.state,
      component: 'RuleRegistry'
    });

    const record = {
      ...rule,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      change_history: [
        {
          timestamp: new Date().toISOString(),
          fromState: null,
          toState: rule.state,
          changedBy: rule.owner || 'system',
          reason: 'Initial registration'
        }
      ]
    };

    let response;
    try {
      response = await this.restClient.post(REGISTRY_TABLE, record);
    } catch (err) {
      this.logger.error('Failed to register rule', {
        ruleId: rule.ruleId,
        errorMessage: err.message,
        component: 'RuleRegistry'
      });
      throw new Error(`[DFW-11003] Failed to register rule "${rule.ruleId}": ${err.message}`);
    }

    this.logger.info('Rule registered successfully', {
      ruleId: rule.ruleId,
      component: 'RuleRegistry'
    });

    const body = response && response.result ? response.result : response;
    return body || record;
  }

  /**
   * Updates the state of an existing rule and appends to its change history.
   *
   * @async
   * @param {string} ruleId - The rule identifier to update.
   * @param {string} newState - The target state.
   * @param {Object} [metadata={}] - Additional metadata for the history entry.
   * @param {string} [metadata.changedBy] - Who triggered the change.
   * @param {string} [metadata.reason] - Reason for the state change.
   * @returns {Promise<Object>} Updated rule record.
   *
   * @throws {Error} [DFW-11004] When the rule is not found.
   * @throws {Error} [DFW-11003] When the REST call fails.
   *
   * @example
   * await registry.updateState('DFW-R-0001', 'APPROVED', {
   *   changedBy: 'security-architect',
   *   reason: 'Impact analysis passed'
   * });
   */
  async updateState(ruleId, newState, metadata = {}) {
    if (!ruleId || !newState) {
      throw new Error('[DFW-11004] ruleId and newState are required');
    }

    this.logger.info('Updating rule state', {
      ruleId,
      newState,
      component: 'RuleRegistry'
    });

    const existing = await this.getRule(ruleId);

    const historyEntry = {
      timestamp: new Date().toISOString(),
      fromState: existing.state,
      toState: newState,
      changedBy: metadata.changedBy || 'system',
      reason: metadata.reason || `State transition to ${newState}`
    };

    const changeHistory = Array.isArray(existing.change_history)
      ? [...existing.change_history, historyEntry]
      : [historyEntry];

    const updatePayload = {
      state: newState,
      updated_at: new Date().toISOString(),
      change_history: changeHistory,
      ...metadata
    };

    let response;
    try {
      response = await this.restClient.patch(
        `${REGISTRY_TABLE}/${ruleId}`,
        updatePayload
      );
    } catch (err) {
      this.logger.error('Failed to update rule state', {
        ruleId,
        newState,
        errorMessage: err.message,
        component: 'RuleRegistry'
      });
      throw new Error(`[DFW-11003] Failed to update rule "${ruleId}": ${err.message}`);
    }

    this.logger.info('Rule state updated', {
      ruleId,
      newState,
      component: 'RuleRegistry'
    });

    const body = response && response.result ? response.result : response;
    return body || { ...existing, ...updatePayload };
  }

  /**
   * Retrieves the full change history for a rule.
   *
   * @async
   * @param {string} ruleId - The rule identifier.
   * @returns {Promise<Object[]>} Array of change history entries.
   *
   * @throws {Error} [DFW-11004] When the rule is not found.
   *
   * @example
   * const history = await registry.getHistory('DFW-R-0001');
   * console.log(`${history.length} state changes recorded`);
   */
  async getHistory(ruleId) {
    if (!ruleId) {
      throw new Error('[DFW-11004] ruleId is required');
    }

    const rule = await this.getRule(ruleId);
    return Array.isArray(rule.change_history) ? rule.change_history : [];
  }

  /**
   * Finds all rules owned by a specific user.
   *
   * @async
   * @param {string} ownerId - The owner identifier to search for.
   * @returns {Promise<Object[]>} Array of matching rule records.
   *
   * @throws {Error} [DFW-11005] When the search fails.
   *
   * @example
   * const rules = await registry.findByOwner('john.doe');
   */
  async findByOwner(ownerId) {
    if (!ownerId) {
      throw new Error('[DFW-11005] ownerId is required');
    }

    this.logger.debug('Finding rules by owner', {
      ownerId,
      component: 'RuleRegistry'
    });

    return this.search({ owner: ownerId });
  }

  /**
   * Finds rules with a review_date within the specified number of days.
   *
   * @async
   * @param {number} [withinDays=30] - Number of days from today to search.
   * @returns {Promise<Object[]>} Array of rules with upcoming review dates.
   *
   * @throws {Error} [DFW-11005] When the search fails.
   *
   * @example
   * const expiring = await registry.findExpiring(14);
   * console.log(`${expiring.length} rules due for review within 14 days`);
   */
  async findExpiring(withinDays = 30) {
    this.logger.debug('Finding expiring rules', {
      withinDays,
      component: 'RuleRegistry'
    });

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() + withinDays);
    const cutoffISO = cutoffDate.toISOString();

    let response;
    try {
      response = await this.restClient.get(
        `${REGISTRY_TABLE}?sysparm_query=review_date<=${cutoffISO}^state!=EXPIRED`
      );
    } catch (err) {
      this.logger.error('Failed to find expiring rules', {
        withinDays,
        errorMessage: err.message,
        component: 'RuleRegistry'
      });
      throw new Error(`[DFW-11005] Failed to find expiring rules: ${err.message}`);
    }

    return this._extractResults(response);
  }

  /**
   * Searches the registry with arbitrary criteria.
   *
   * @async
   * @param {Object} criteria - Search criteria as key-value pairs.
   * @returns {Promise<Object[]>} Array of matching rule records.
   *
   * @throws {Error} [DFW-11005] When the search fails.
   *
   * @example
   * const rules = await registry.search({ state: 'ENFORCED', owner: 'john.doe' });
   */
  async search(criteria) {
    if (!criteria || typeof criteria !== 'object') {
      throw new Error('[DFW-11005] Search criteria must be a non-null object');
    }

    const queryParts = Object.entries(criteria).map(
      ([key, value]) => `${key}=${value}`
    );
    const query = queryParts.join('^');
    const url = `${REGISTRY_TABLE}?sysparm_query=${query}`;

    this.logger.debug('Searching rule registry', {
      criteria,
      component: 'RuleRegistry'
    });

    let response;
    try {
      response = await this.restClient.get(url);
    } catch (err) {
      this.logger.error('Rule registry search failed', {
        criteria,
        errorMessage: err.message,
        component: 'RuleRegistry'
      });
      throw new Error(`[DFW-11005] Rule registry search failed: ${err.message}`);
    }

    return this._extractResults(response);
  }

  /**
   * Retrieves a single rule record by its identifier.
   *
   * @async
   * @param {string} ruleId - The rule identifier.
   * @returns {Promise<Object>} The rule record.
   *
   * @throws {Error} [DFW-11004] When the rule is not found.
   * @throws {Error} [DFW-11003] When the REST call fails.
   *
   * @example
   * const rule = await registry.getRule('DFW-R-0001');
   * console.log(`Rule state: ${rule.state}`);
   */
  async getRule(ruleId) {
    if (!ruleId) {
      throw new Error('[DFW-11004] ruleId is required');
    }

    this.logger.debug('Fetching rule', {
      ruleId,
      component: 'RuleRegistry'
    });

    let response;
    try {
      response = await this.restClient.get(`${REGISTRY_TABLE}/${ruleId}`);
    } catch (err) {
      this.logger.error('Failed to fetch rule', {
        ruleId,
        errorMessage: err.message,
        component: 'RuleRegistry'
      });
      throw new Error(`[DFW-11004] Rule "${ruleId}" not found: ${err.message}`);
    }

    const result = response && response.result !== undefined
      ? response.result
      : response;
    if (!result) {
      throw new Error(`[DFW-11004] Rule "${ruleId}" not found`);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extracts a results array from various REST response shapes.
   *
   * @private
   * @param {Object|Array} response - REST response.
   * @returns {Object[]} Array of result records.
   */
  _extractResults(response) {
    if (Array.isArray(response)) {
      return response;
    }
    if (response && Array.isArray(response.result)) {
      return response.result;
    }
    if (response && response.body && Array.isArray(response.body.result)) {
      return response.body.result;
    }
    return [];
  }
}

module.exports = RuleRegistry;
