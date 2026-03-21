/**
 * @file PolicyDeployer.js
 * @description Deploys policy-as-code definitions to the NSX DFW via REST.
 *   Supports deploy, rollback, dry-run validation, and structural validation
 *   of policy definitions. Policies are provided as JSON objects (simulating
 *   parsed YAML since there is no YAML library in the dependency set).
 *
 * NSX API endpoint:
 *   PATCH {nsxUrl}/policy/api/v1/infra/domains/default/security-policies/{policyName}
 *
 * @module dfw/PolicyDeployer
 */

'use strict';

const ConfigLoader = require('../shared/ConfigLoader');
const RuleConflictDetector = require('./RuleConflictDetector');

/**
 * Required top-level fields in a policy definition.
 *
 * @constant {string[]}
 * @private
 */
const REQUIRED_POLICY_FIELDS = ['name', 'category', 'rules'];

/**
 * Required fields in each rule within a policy.
 *
 * @constant {string[]}
 * @private
 */
const REQUIRED_RULE_FIELDS = [
  'name',
  'source_groups',
  'destination_groups',
  'services',
  'action'
];

/**
 * Valid DFW rule actions.
 *
 * @constant {Set<string>}
 * @private
 */
const VALID_ACTIONS = new Set(['ALLOW', 'DROP', 'REJECT']);

/**
 * Valid deployment scopes.
 *
 * @constant {RegExp}
 * @private
 */
const SCOPE_PATTERN = /^(GLOBAL|LOCAL:.+)$/;

/**
 * PolicyDeployer deploys, validates, and manages lifecycle operations for
 * NSX DFW security policies expressed as code (JSON / YAML-like objects).
 *
 * @class PolicyDeployer
 */
class PolicyDeployer {
  /**
   * Creates a new PolicyDeployer instance.
   *
   * @param {Object} restClient - HTTP client with async `patch(url, body)`,
   *   `get(url)`, and optionally `put(url, body)` methods.
   * @param {Object} logger - Structured logger with `info`, `warn`, `error`,
   *   and `debug` methods.
   * @param {ConfigLoader} [configLoader] - Optional ConfigLoader instance.
   *
   * @throws {Error} When `restClient` or `logger` is missing.
   *
   * @example
   * const deployer = new PolicyDeployer(restClient, logger);
   */
  constructor(restClient, logger, configLoader) {
    if (!restClient) {
      throw new Error('[DFW-8001] PolicyDeployer requires a restClient instance.');
    }
    if (!logger) {
      throw new Error('[DFW-8001] PolicyDeployer requires a logger instance.');
    }

    /** @private */
    this._restClient = restClient;
    /** @private */
    this._logger = logger;
    /** @private */
    this._config = configLoader || new ConfigLoader();
    /** @private */
    this._conflictDetector = new RuleConflictDetector();
  }

  /**
   * Deploys a policy definition to the NSX DFW.
   *
   * Steps performed:
   *   1. Parse the policy (JSON string or object).
   *   2. Validate structural correctness.
   *   3. Convert to NSX API format.
   *   4. PATCH to the NSX security-policies endpoint.
   *
   * @param {string|Object} policyYaml - Policy definition as a JSON string
   *   or pre-parsed object. Called "policyYaml" to reflect that in production
   *   this would originate from a YAML file.
   * @param {string} site - Site code (e.g. `'NDCNG'`).
   * @param {string} [scope='GLOBAL'] - Deployment scope: `'GLOBAL'` or
   *   `'LOCAL:{site}'`.
   * @returns {Promise<{ success: boolean, policyName: string, rulesDeployed: number, scope: string, site: string }>}
   *
   * @throws {Error} When the policy is structurally invalid or the PATCH fails.
   *
   * @example
   * const result = await deployer.deploy(policy, 'NDCNG', 'GLOBAL');
   * console.log(`Deployed ${result.rulesDeployed} rules as "${result.policyName}"`);
   */
  async deploy(policyYaml, site, scope = 'GLOBAL') {
    const policy = PolicyDeployer._parsePolicy(policyYaml);

    // Validate
    const validation = this.validatePolicyStructure(policy);
    if (!validation.valid) {
      throw new Error(
        `[DFW-8002] Policy structure validation failed: ${validation.errors.join('; ')}`
      );
    }

    // Validate scope
    if (!SCOPE_PATTERN.test(scope)) {
      throw new Error(
        `[DFW-8003] Invalid scope "${scope}". Must be "GLOBAL" or "LOCAL:{site}".`
      );
    }

    if (!site || typeof site !== 'string') {
      throw new Error('[DFW-8003] site is required and must be a non-empty string.');
    }

    const endpoints = this._config.getEndpointsForSite(site);
    const nsxPayload = PolicyDeployer._toNsxFormat(policy, scope);
    const policyName = PolicyDeployer._sanitizePolicyName(policy.name);

    const url =
      `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/` +
      `security-policies/${encodeURIComponent(policyName)}`;

    this._logger.info(
      `Deploying policy "${policyName}" to site "${site}" with scope "${scope}".`
    );
    this._logger.debug(`PATCH ${url}`);

    let response;
    try {
      response = await this._restClient.patch(url, nsxPayload);
    } catch (err) {
      this._logger.error(`PATCH failed for policy "${policyName}": ${err.message}`);
      throw new Error(
        `[DFW-8004] Failed to deploy policy "${policyName}": ${err.message}`
      );
    }

    if (response && response.status && response.status >= 400) {
      throw new Error(
        `[DFW-8004] NSX API returned status ${response.status} for policy "${policyName}".`
      );
    }

    const rulesDeployed = Array.isArray(policy.rules) ? policy.rules.length : 0;

    this._logger.info(
      `Successfully deployed policy "${policyName}" — ${rulesDeployed} rule(s).`
    );

    return {
      success: true,
      policyName,
      rulesDeployed,
      scope,
      site
    };
  }

  /**
   * Rolls back to a previous policy version. In production, the `commitHash`
   * would be used to retrieve a policy snapshot from version control. This
   * implementation fetches the current policy from NSX, applies the rollback
   * by re-deploying the previous version.
   *
   * @param {string} commitHash - The version-control commit hash identifying
   *   the desired policy version.
   * @param {string} site - Site code.
   * @returns {Promise<{ success: boolean, commitHash: string, site: string, message: string }>}
   *
   * @throws {Error} When the commit hash is invalid or the rollback fails.
   *
   * @example
   * const result = await deployer.rollback('abc123', 'NDCNG');
   */
  async rollback(commitHash, site) {
    if (!commitHash || typeof commitHash !== 'string') {
      throw new Error(
        '[DFW-8005] commitHash is required and must be a non-empty string.'
      );
    }
    if (!site || typeof site !== 'string') {
      throw new Error('[DFW-8005] site is required and must be a non-empty string.');
    }

    this._logger.info(
      `Initiating rollback to commit "${commitHash}" at site "${site}".`
    );

    const endpoints = this._config.getEndpointsForSite(site);

    // Retrieve the previous policy version from the version control system.
    // In production this would call a git/artifact API. Here we query NSX
    // for a revision reference stored as a tag.
    const revisionUrl =
      `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/` +
      `security-policies?tag=${encodeURIComponent(commitHash)}`;

    let revisionResponse;
    try {
      revisionResponse = await this._restClient.get(revisionUrl);
    } catch (err) {
      this._logger.error(`Rollback revision lookup failed: ${err.message}`);
      throw new Error(
        `[DFW-8005] Failed to retrieve policy for commit "${commitHash}": ${err.message}`
      );
    }

    const body = revisionResponse.body || revisionResponse;
    const policies = body.results || body;

    if (!Array.isArray(policies) || policies.length === 0) {
      throw new Error(
        `[DFW-8005] No policies found for commit "${commitHash}" at site "${site}".`
      );
    }

    // Re-deploy each policy from the previous version
    const deployResults = [];
    for (const policy of policies) {
      const policyName = PolicyDeployer._sanitizePolicyName(
        policy.display_name || policy.name || 'unknown'
      );
      const url =
        `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/` +
        `security-policies/${encodeURIComponent(policyName)}`;

      this._logger.info(`Rolling back policy "${policyName}".`);

      try {
        await this._restClient.patch(url, policy);
        deployResults.push({ policyName, success: true });
      } catch (err) {
        this._logger.error(`Rollback failed for policy "${policyName}": ${err.message}`);
        deployResults.push({ policyName, success: false, error: err.message });
      }
    }

    const allSucceeded = deployResults.every(r => r.success);

    if (!allSucceeded) {
      const failures = deployResults
        .filter(r => !r.success)
        .map(r => r.policyName)
        .join(', ');
      throw new Error(
        `[DFW-8005] Rollback partially failed. Failed policies: ${failures}`
      );
    }

    this._logger.info(
      `Rollback to commit "${commitHash}" completed. ` +
      `${deployResults.length} policy/policies redeployed.`
    );

    return {
      success: true,
      commitHash,
      site,
      message: `Rolled back ${deployResults.length} policy/policies to commit ${commitHash}.`
    };
  }

  /**
   * Validates a policy without deploying it. Performs structural validation
   * and conflict detection against a simulated or live rule set.
   *
   * @param {string|Object} policyYaml - Policy definition.
   * @param {string} site - Site code.
   * @returns {Promise<{
   *   valid: boolean,
   *   structureErrors: string[],
   *   conflicts: Object,
   *   policyName: string
   * }>}
   *
   * @example
   * const result = await deployer.dryRun(policy, 'NDCNG');
   * if (!result.valid) {
   *   console.error('Dry run failed', result.structureErrors, result.conflicts);
   * }
   */
  async dryRun(policyYaml, site) {
    const policy = PolicyDeployer._parsePolicy(policyYaml);

    // Step 1: Structural validation
    const structureResult = this.validatePolicyStructure(policy);

    // Step 2: Conflict detection against existing rules (best effort)
    let existingRules = [];
    if (site && typeof site === 'string') {
      try {
        const endpoints = this._config.getEndpointsForSite(site);
        const url =
          `${endpoints.nsxUrl}/policy/api/v1/infra/domains/default/security-policies`;

        this._logger.debug(`Dry-run: fetching existing policies from ${url}`);
        const response = await this._restClient.get(url);
        const body = response.body || response;
        const policies = body.results || [];

        // Flatten all rules from existing policies
        for (const p of policies) {
          if (Array.isArray(p.rules)) {
            existingRules = existingRules.concat(p.rules);
          }
        }
      } catch (err) {
        this._logger.warn(
          `Dry-run: could not fetch existing rules — conflict detection ` +
          `limited to proposed rules only. Error: ${err.message}`
        );
      }
    }

    const proposedRules = Array.isArray(policy.rules) ? policy.rules : [];
    const conflictResult = this._conflictDetector.analyze(proposedRules, existingRules);

    const valid = structureResult.valid && !conflictResult.hasIssues;

    this._logger.info(
      `Dry-run for policy "${policy.name || 'unknown'}": ` +
      `structure=${structureResult.valid ? 'OK' : 'FAIL'}, ` +
      `conflicts=${conflictResult.hasIssues ? 'FOUND' : 'NONE'}.`
    );

    return {
      valid,
      structureErrors: structureResult.errors,
      conflicts: conflictResult,
      policyName: policy.name || 'unknown'
    };
  }

  /**
   * Validates the structural correctness of a policy definition.
   *
   * Checks performed:
   *   - All required top-level fields are present.
   *   - `rules` is a non-empty array.
   *   - Each rule has all required fields.
   *   - Each rule's `action` is one of ALLOW, DROP, REJECT.
   *   - Source/destination groups and services are arrays.
   *
   * @param {Object} policy - Parsed policy definition.
   * @returns {{ valid: boolean, errors: string[] }}
   *
   * @example
   * const result = deployer.validatePolicyStructure(policy);
   * if (!result.valid) {
   *   console.error('Invalid policy:', result.errors);
   * }
   */
  validatePolicyStructure(policy) {
    const errors = [];

    if (!policy || typeof policy !== 'object') {
      return { valid: false, errors: ['Policy must be a non-null object.'] };
    }

    // Check required top-level fields
    for (const field of REQUIRED_POLICY_FIELDS) {
      if (policy[field] === undefined || policy[field] === null) {
        errors.push(`Missing required top-level field: "${field}".`);
      }
    }

    // Validate name
    if (policy.name !== undefined && typeof policy.name !== 'string') {
      errors.push('"name" must be a string.');
    }
    if (typeof policy.name === 'string' && policy.name.trim().length === 0) {
      errors.push('"name" must be a non-empty string.');
    }

    // Validate category
    if (
      policy.category !== undefined &&
      typeof policy.category === 'string' &&
      !['Application', 'Infrastructure', 'Environment', 'Emergency', 'Ethernet'].includes(
        policy.category
      )
    ) {
      errors.push(
        `Invalid category "${policy.category}". ` +
        `Must be one of: Application, Infrastructure, Environment, Emergency, Ethernet.`
      );
    }

    // Validate rules
    if (!Array.isArray(policy.rules)) {
      errors.push('"rules" must be an array.');
    } else if (policy.rules.length === 0) {
      errors.push('"rules" must contain at least one rule.');
    } else {
      policy.rules.forEach((rule, index) => {
        const prefix = `rules[${index}]`;

        if (!rule || typeof rule !== 'object') {
          errors.push(`${prefix}: must be a non-null object.`);
          return;
        }

        for (const field of REQUIRED_RULE_FIELDS) {
          if (rule[field] === undefined || rule[field] === null) {
            errors.push(`${prefix}: missing required field "${field}".`);
          }
        }

        if (rule.action && !VALID_ACTIONS.has(String(rule.action).toUpperCase())) {
          errors.push(
            `${prefix}: invalid action "${rule.action}". Must be ALLOW, DROP, or REJECT.`
          );
        }

        if (rule.source_groups !== undefined && !Array.isArray(rule.source_groups)) {
          errors.push(`${prefix}: "source_groups" must be an array.`);
        }
        if (rule.destination_groups !== undefined && !Array.isArray(rule.destination_groups)) {
          errors.push(`${prefix}: "destination_groups" must be an array.`);
        }
        if (rule.services !== undefined && !Array.isArray(rule.services)) {
          errors.push(`${prefix}: "services" must be an array.`);
        }
      });
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Parses a policy from JSON string or returns it if already an object.
   *
   * @private
   * @param {string|Object} input
   * @returns {Object}
   */
  static _parsePolicy(input) {
    if (typeof input === 'string') {
      try {
        return JSON.parse(input);
      } catch (err) {
        throw new Error(
          `[DFW-8002] Failed to parse policy definition as JSON: ${err.message}`
        );
      }
    }
    if (input && typeof input === 'object') {
      return input;
    }
    throw new Error(
      '[DFW-8002] Policy must be a JSON string or a non-null object.'
    );
  }

  /**
   * Converts an internal policy definition to the NSX API PATCH format.
   *
   * @private
   * @param {Object} policy - Validated internal policy object.
   * @param {string} scope - Deployment scope string.
   * @returns {Object} NSX-formatted payload.
   */
  static _toNsxFormat(policy, scope) {
    const nsxRules = (policy.rules || []).map((rule, index) => ({
      display_name: rule.name,
      id: PolicyDeployer._sanitizePolicyName(rule.name),
      sequence_number: rule.priority !== undefined ? rule.priority : (index + 1) * 10,
      source_groups: Array.isArray(rule.source_groups) ? rule.source_groups : ['ANY'],
      destination_groups: Array.isArray(rule.destination_groups) ? rule.destination_groups : ['ANY'],
      services: Array.isArray(rule.services) ? rule.services : ['ANY'],
      action: String(rule.action).toUpperCase(),
      scope: scope === 'GLOBAL' ? ['/infra/labels/default'] : [`/infra/labels/${scope}`],
      disabled: rule.disabled === true,
      logged: rule.logged !== false,
      tag: rule.tag || policy.tag || undefined
    }));

    return {
      display_name: policy.name,
      id: PolicyDeployer._sanitizePolicyName(policy.name),
      category: policy.category || 'Application',
      scope: scope === 'GLOBAL' ? ['/infra/labels/default'] : [`/infra/labels/${scope}`],
      rules: nsxRules,
      description: policy.description || `Policy-as-code: ${policy.name}`,
      tags: policy.tags || []
    };
  }

  /**
   * Sanitises a policy or rule name for use as an NSX object ID.
   * Replaces spaces and special characters with hyphens and lowercases.
   *
   * @private
   * @param {string} name
   * @returns {string}
   */
  static _sanitizePolicyName(name) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return 'unnamed-policy';
    }
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }
}

module.exports = PolicyDeployer;
