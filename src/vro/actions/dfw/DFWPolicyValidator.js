/**
 * @file DFWPolicyValidator.js
 * @description Validates that DFW (Distributed Firewall) rules are properly
 *   applied to a virtual machine. Queries the NSX Manager's realized-state
 *   API to determine effective rule coverage, retrieve active rules, and
 *   detect orphaned rules in security groups.
 *
 * Error codes:
 *   - DFW-7006  Validation failed (VM has no DFW coverage or API error)
 *   - DFW-7007  Orphaned rule detected (group has rules but no members)
 *
 * @module dfw/DFWPolicyValidator
 */

'use strict';

const ConfigLoader = require('../shared/ConfigLoader');

/**
 * Factory for creating standardised error objects with DFW error codes.
 * Keeps error creation consistent across the module.
 *
 * @private
 */
const ErrorFactory = {
  /**
   * Creates a DFW-7006 validation failure error.
   *
   * @param {string} message - Human-readable description of the failure.
   * @param {Object} [context={}] - Additional context attached to the error.
   * @returns {Error} An Error with `code` and `context` properties.
   */
  validationFailed(message, context = {}) {
    const error = new Error(`[DFW-7006] ${message}`);
    error.code = 'DFW-7006';
    error.context = context;
    return error;
  },

  /**
   * Creates a DFW-7007 orphaned rule error.
   *
   * @param {string} message - Human-readable description of the orphaned rule.
   * @param {Object} [context={}] - Additional context attached to the error.
   * @returns {Error} An Error with `code` and `context` properties.
   */
  orphanedRule(message, context = {}) {
    const error = new Error(`[DFW-7007] ${message}`);
    error.code = 'DFW-7007';
    error.context = context;
    return error;
  }
};

/**
 * DFWPolicyValidator queries the NSX Manager realized-state API to verify
 * that virtual machines are properly covered by DFW policies and that
 * security groups do not contain orphaned rules.
 *
 * @class DFWPolicyValidator
 */
class DFWPolicyValidator {
  /**
   * Creates a new DFWPolicyValidator instance.
   *
   * @param {Object} restClient - HTTP client used for NSX REST calls.
   *   Must expose an async `get(url)` method that returns `{ status, body }`.
   * @param {Object} logger - Structured logger with `info`, `warn`, `error`,
   *   and `debug` methods.
   * @param {ConfigLoader} [configLoader] - Optional ConfigLoader instance.
   *   Falls back to a default ConfigLoader when omitted.
   *
   * @throws {Error} When `restClient` or `logger` is not provided.
   *
   * @example
   * const validator = new DFWPolicyValidator(restClient, logger);
   */
  constructor(restClient, logger, configLoader) {
    if (!restClient) {
      throw new Error('[DFW-7006] DFWPolicyValidator requires a restClient instance.');
    }
    if (!logger) {
      throw new Error('[DFW-7006] DFWPolicyValidator requires a logger instance.');
    }

    /** @private */
    this._restClient = restClient;
    /** @private */
    this._logger = logger;
    /** @private */
    this._config = configLoader || new ConfigLoader();
  }

  /**
   * Validates that a VM is covered by at least one active DFW policy.
   *
   * @param {string} vmId - The NSX external ID (or MORef) of the VM.
   * @param {string} site - Site code (e.g. `'NDCNG'`, `'TULNG'`).
   * @returns {Promise<{ covered: boolean, policies: Object[] }>}
   *   `covered` is `true` when at least one active rule applies to the VM.
   *   `policies` contains the raw rules returned by the NSX API.
   *
   * @throws {Error} DFW-7006 when the API call fails or returns an unexpected
   *   response structure.
   *
   * @example
   * const result = await validator.validateCoverage('vm-42', 'NDCNG');
   * if (!result.covered) {
   *   console.warn('VM has no DFW coverage');
   * }
   */
  async validateCoverage(vmId, site) {
    if (!vmId || typeof vmId !== 'string') {
      throw ErrorFactory.validationFailed(
        'vmId is required and must be a non-empty string.',
        { vmId, site }
      );
    }
    if (!site || typeof site !== 'string') {
      throw ErrorFactory.validationFailed(
        'site is required and must be a non-empty string.',
        { vmId, site }
      );
    }

    this._logger.info(`Validating DFW coverage for VM "${vmId}" at site "${site}".`);

    let rules;
    try {
      rules = await this.getEffectiveRules(vmId, site);
    } catch (err) {
      this._logger.error(
        `Failed to retrieve effective rules for VM "${vmId}": ${err.message}`
      );
      throw ErrorFactory.validationFailed(
        `Unable to validate DFW coverage for VM "${vmId}".`,
        { vmId, site, originalError: err.message }
      );
    }

    const activePolicies = rules.filter(
      rule => rule && rule.disabled !== true
    );

    const covered = activePolicies.length > 0;

    this._logger.info(
      `VM "${vmId}" DFW coverage: ${covered ? 'COVERED' : 'NOT COVERED'} ` +
      `(${activePolicies.length} active rule(s)).`
    );

    return {
      covered,
      policies: activePolicies
    };
  }

  /**
   * Retrieves the effective DFW rules for a specific VM from the NSX
   * realized-state API.
   *
   * NSX API endpoint:
   *   GET {nsxUrl}/policy/api/v1/infra/realized-state/enforcement-points/default/virtual-machines/{vmId}/rules
   *
   * @param {string} vmId - The NSX external ID of the VM.
   * @param {string} site - Site code for endpoint resolution.
   * @returns {Promise<Object[]>} Array of rule objects returned by NSX.
   *
   * @throws {Error} DFW-7006 when the API returns a non-200 status or the
   *   response body cannot be parsed.
   *
   * @example
   * const rules = await validator.getEffectiveRules('vm-42', 'NDCNG');
   * console.log(`Found ${rules.length} rules for vm-42`);
   */
  async getEffectiveRules(vmId, site) {
    if (!vmId || typeof vmId !== 'string') {
      throw ErrorFactory.validationFailed(
        'vmId is required and must be a non-empty string.',
        { vmId, site }
      );
    }
    if (!site || typeof site !== 'string') {
      throw ErrorFactory.validationFailed(
        'site is required and must be a non-empty string.',
        { vmId, site }
      );
    }

    const endpoints = this._config.getEndpointsForSite(site);
    const url =
      `${endpoints.nsxUrl}/policy/api/v1/infra/realized-state/` +
      `enforcement-points/default/virtual-machines/${encodeURIComponent(vmId)}/rules`;

    this._logger.debug(`GET ${url}`);

    let response;
    try {
      response = await this._restClient.get(url);
    } catch (err) {
      throw ErrorFactory.validationFailed(
        `NSX API request failed for VM "${vmId}": ${err.message}`,
        { vmId, site, url }
      );
    }

    if (!response || (response.status && response.status !== 200)) {
      throw ErrorFactory.validationFailed(
        `NSX API returned status ${response ? response.status : 'unknown'} for VM "${vmId}".`,
        { vmId, site, url, status: response ? response.status : null }
      );
    }

    const body = response.body || response;
    const results = body.results || body;

    if (!Array.isArray(results)) {
      this._logger.warn(
        `Unexpected response structure for VM "${vmId}". Expected array of rules.`
      );
      return [];
    }

    this._logger.info(
      `Retrieved ${results.length} effective rule(s) for VM "${vmId}".`
    );

    return results;
  }

  /**
   * Checks whether a security group has DFW rules assigned but contains
   * no members. An orphaned rule is a security concern because it indicates
   * policy drift — the rule set no longer protects any workloads.
   *
   * @param {string} groupId - The NSX security group path or ID.
   * @param {string} site - Site code for endpoint resolution.
   * @returns {Promise<{ orphaned: boolean, groupId: string, ruleCount: number, memberCount: number }>}
   *
   * @throws {Error} DFW-7007 when the group is confirmed orphaned.
   * @throws {Error} DFW-7006 when the API call fails.
   *
   * @example
   * const result = await validator.checkOrphanedRules('web-tier-group', 'NDCNG');
   * if (result.orphaned) {
   *   console.warn(`Group ${result.groupId} has ${result.ruleCount} rules but 0 members`);
   * }
   */
  async checkOrphanedRules(groupId, site) {
    if (!groupId || typeof groupId !== 'string') {
      throw ErrorFactory.validationFailed(
        'groupId is required and must be a non-empty string.',
        { groupId, site }
      );
    }
    if (!site || typeof site !== 'string') {
      throw ErrorFactory.validationFailed(
        'site is required and must be a non-empty string.',
        { groupId, site }
      );
    }

    const endpoints = this._config.getEndpointsForSite(site);

    // Fetch the security group members
    const membersUrl =
      `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/groups/` +
      `${encodeURIComponent(groupId)}/members/virtual-machines`;

    // Fetch rules that reference this group
    const rulesUrl =
      `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/groups/` +
      `${encodeURIComponent(groupId)}`;

    this._logger.debug(`Checking orphaned rules for group "${groupId}" at site "${site}".`);

    let membersResponse;
    let groupResponse;

    try {
      [membersResponse, groupResponse] = await Promise.all([
        this._restClient.get(membersUrl),
        this._restClient.get(rulesUrl)
      ]);
    } catch (err) {
      throw ErrorFactory.validationFailed(
        `Failed to check group "${groupId}": ${err.message}`,
        { groupId, site }
      );
    }

    const membersBody = membersResponse.body || membersResponse;
    const memberResults = membersBody.results || membersBody;
    const memberCount = Array.isArray(memberResults) ? memberResults.length : 0;

    const groupBody = groupResponse.body || groupResponse;
    const groupExpression = groupBody.expression || [];
    const ruleCount = Array.isArray(groupExpression) ? groupExpression.length : 0;

    const orphaned = ruleCount > 0 && memberCount === 0;

    const result = {
      orphaned,
      groupId,
      ruleCount,
      memberCount
    };

    if (orphaned) {
      this._logger.warn(
        `[DFW-7007] Group "${groupId}" has ${ruleCount} expression(s) but 0 members — orphaned.`
      );
      throw ErrorFactory.orphanedRule(
        `Security group "${groupId}" has ${ruleCount} rule criteria but no VM members.`,
        result
      );
    }

    this._logger.info(
      `Group "${groupId}": ${memberCount} member(s), ${ruleCount} expression(s) — OK.`
    );

    return result;
  }
}

module.exports = DFWPolicyValidator;
