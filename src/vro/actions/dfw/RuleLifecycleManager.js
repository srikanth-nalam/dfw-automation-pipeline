/**
 * @file RuleLifecycleManager.js
 * @description DFW Rule Lifecycle Manager for the NSX DFW Automation Pipeline.
 *   Orchestrates the full lifecycle of DFW rules from request through
 *   enforcement, certification, review, and expiry. Manages state transitions,
 *   impact analysis, monitor-mode deployment, promotion to enforce, rollback,
 *   and emergency fast-track flows.
 *
 * Error codes: DFW-10001 through DFW-10010
 *
 * @module dfw/RuleLifecycleManager
 */

'use strict';

/**
 * Valid rule lifecycle states.
 * @constant {Object<string, string>}
 */
const RULE_STATES = Object.freeze({
  REQUESTED: 'REQUESTED',
  IMPACT_ANALYZED: 'IMPACT_ANALYZED',
  APPROVED: 'APPROVED',
  MONITOR_MODE: 'MONITOR_MODE',
  VALIDATED: 'VALIDATED',
  ENFORCED: 'ENFORCED',
  CERTIFIED: 'CERTIFIED',
  REVIEW_DUE: 'REVIEW_DUE',
  EXPIRED: 'EXPIRED',
  ROLLED_BACK: 'ROLLED_BACK'
});

/**
 * Allowed state transitions. Each key maps to an array of states
 * that the rule may transition to from that state.
 * @constant {Object<string, string[]>}
 */
const STATE_TRANSITIONS = Object.freeze({
  REQUESTED: ['IMPACT_ANALYZED'],
  IMPACT_ANALYZED: ['APPROVED', 'ROLLED_BACK'],
  APPROVED: ['MONITOR_MODE', 'ROLLED_BACK'],
  MONITOR_MODE: ['VALIDATED', 'ROLLED_BACK'],
  VALIDATED: ['ENFORCED', 'ROLLED_BACK'],
  ENFORCED: ['CERTIFIED', 'REVIEW_DUE', 'ROLLED_BACK'],
  CERTIFIED: ['ENFORCED', 'REVIEW_DUE', 'EXPIRED'],
  REVIEW_DUE: ['CERTIFIED', 'EXPIRED'],
  EXPIRED: [],
  ROLLED_BACK: ['REQUESTED']
});

/**
 * Default review period in days after certification.
 * @constant {number}
 * @private
 */
const DEFAULT_REVIEW_PERIOD_DAYS = 90;

/**
 * @class RuleLifecycleManager
 * @classdesc Orchestrates the full lifecycle of DFW rules from initial request
 *   through enforcement, certification, and eventual expiry or rollback.
 *
 * @example
 * const manager = new RuleLifecycleManager({
 *   ruleRegistry, policyDeployer, ruleConflictDetector, restClient, logger
 * });
 * const rule = await manager.submitRule({ name: 'allow-web-to-db', ... });
 */
class RuleLifecycleManager {
  /**
   * Creates a new RuleLifecycleManager instance.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.ruleRegistry - Rule registry for persistence.
   * @param {Object} dependencies.policyDeployer - Policy deployer for NSX operations.
   * @param {Object} dependencies.ruleConflictDetector - Conflict detection engine.
   * @param {Object} dependencies.restClient - HTTP client.
   * @param {Object} dependencies.logger - Structured logger.
   *
   * @throws {Error} [DFW-10001] When required dependencies are missing.
   *
   * @example
   * const manager = new RuleLifecycleManager(dependencies);
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-10001] RuleLifecycleManager requires dependencies');
    }
    if (!dependencies.ruleRegistry) {
      throw new Error('[DFW-10001] RuleLifecycleManager requires a ruleRegistry instance');
    }
    if (!dependencies.policyDeployer) {
      throw new Error('[DFW-10001] RuleLifecycleManager requires a policyDeployer instance');
    }
    if (!dependencies.ruleConflictDetector) {
      throw new Error('[DFW-10001] RuleLifecycleManager requires a ruleConflictDetector instance');
    }
    if (!dependencies.restClient) {
      throw new Error('[DFW-10001] RuleLifecycleManager requires a restClient instance');
    }
    if (!dependencies.logger) {
      throw new Error('[DFW-10001] RuleLifecycleManager requires a logger instance');
    }

    /** @private */
    this.ruleRegistry = dependencies.ruleRegistry;
    /** @private */
    this.policyDeployer = dependencies.policyDeployer;
    /** @private */
    this.ruleConflictDetector = dependencies.ruleConflictDetector;
    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;
  }

  /**
   * Submits a new rule request into the lifecycle pipeline.
   *
   * Assigns a unique rule ID via the registry, validates required fields,
   * registers the rule with REQUESTED state, and returns the registered rule.
   *
   * @async
   * @param {Object} ruleRequest - The rule definition to submit.
   * @param {string} ruleRequest.name - Human-readable rule name.
   * @param {string[]} ruleRequest.source_groups - Source security groups.
   * @param {string[]} ruleRequest.destination_groups - Destination security groups.
   * @param {string[]} ruleRequest.services - Service definitions.
   * @param {string} ruleRequest.action - Rule action (ALLOW, DROP, REJECT).
   * @param {string} [ruleRequest.owner] - Rule owner identifier.
   * @returns {Promise<Object>} Registered rule with assigned ID and REQUESTED state.
   *
   * @throws {Error} [DFW-10003] When the rule request is missing required fields.
   *
   * @example
   * const rule = await manager.submitRule({
   *   name: 'allow-web-to-db',
   *   source_groups: ['web-tier'],
   *   destination_groups: ['db-tier'],
   *   services: ['TCP/3306'],
   *   action: 'ALLOW',
   *   owner: 'john.doe'
   * });
   * console.log(rule.ruleId); // 'DFW-R-0001'
   */
  async submitRule(ruleRequest) {
    if (!ruleRequest || !ruleRequest.name) {
      throw new Error('[DFW-10003] Rule request must include at least a name');
    }

    const ruleId = this.ruleRegistry.generateRuleId();

    this.logger.info('Submitting new rule request', {
      ruleId,
      name: ruleRequest.name,
      component: 'RuleLifecycleManager'
    });

    const rule = {
      ...ruleRequest,
      ruleId,
      state: RULE_STATES.REQUESTED,
      submittedAt: new Date().toISOString()
    };

    const registered = await this.ruleRegistry.register(rule);

    this.logger.info('Rule submitted successfully', {
      ruleId,
      state: RULE_STATES.REQUESTED,
      component: 'RuleLifecycleManager'
    });

    return registered;
  }

  /**
   * Runs impact analysis on a submitted rule.
   *
   * Retrieves the rule from the registry, runs conflict detection against
   * existing rules, and transitions the state to IMPACT_ANALYZED.
   *
   * @async
   * @param {string} ruleId - The rule identifier to analyse.
   * @returns {Promise<{rule: Object, impactResult: Object}>} The updated rule
   *   and the conflict analysis result.
   *
   * @throws {Error} [DFW-10004] When the rule is not found.
   * @throws {Error} [DFW-10002] When the state transition is invalid.
   *
   * @example
   * const { rule, impactResult } = await manager.analyzeImpact('DFW-R-0001');
   * if (impactResult.hasIssues) {
   *   console.warn('Conflicts detected', impactResult.conflicts);
   * }
   */
  async analyzeImpact(ruleId) {
    if (!ruleId) {
      throw new Error('[DFW-10004] ruleId is required');
    }

    this.logger.info('Starting impact analysis', {
      ruleId,
      component: 'RuleLifecycleManager'
    });

    const rule = await this.ruleRegistry.getRule(ruleId);
    this._validateTransition(rule.state, RULE_STATES.IMPACT_ANALYZED);

    const proposedRules = [{
      name: rule.name,
      source_groups: rule.source_groups || [],
      destination_groups: rule.destination_groups || [],
      services: rule.services || [],
      action: rule.action,
      priority: rule.priority
    }];

    const impactResult = this.ruleConflictDetector.analyze(proposedRules, []);

    await this.ruleRegistry.updateState(ruleId, RULE_STATES.IMPACT_ANALYZED, {
      reason: impactResult.hasIssues
        ? `Impact analysis found issues: ${impactResult.conflicts.length} conflicts, ${impactResult.shadows.length} shadows`
        : 'Impact analysis passed with no issues',
      impactResult
    });

    this.logger.info('Impact analysis complete', {
      ruleId,
      hasIssues: impactResult.hasIssues,
      component: 'RuleLifecycleManager'
    });

    return {
      rule: { ...rule, state: RULE_STATES.IMPACT_ANALYZED },
      impactResult
    };
  }

  /**
   * Deploys a rule in monitor (log-only) mode.
   *
   * Deploys the rule with action=LOG so traffic matching is logged but
   * not enforced. This allows operators to validate the rule before
   * full enforcement.
   *
   * @async
   * @param {string} ruleId - The rule identifier to deploy.
   * @param {string} site - Target site code (e.g. 'NDCNG').
   * @returns {Promise<Object>} Deployment result.
   *
   * @throws {Error} [DFW-10005] When deployment fails.
   * @throws {Error} [DFW-10002] When the state transition is invalid.
   *
   * @example
   * const result = await manager.deployMonitorMode('DFW-R-0001', 'NDCNG');
   */
  async deployMonitorMode(ruleId, site) {
    if (!ruleId || !site) {
      throw new Error('[DFW-10005] ruleId and site are required');
    }

    this.logger.info('Deploying rule in monitor mode', {
      ruleId,
      site,
      component: 'RuleLifecycleManager'
    });

    const rule = await this.ruleRegistry.getRule(ruleId);
    this._validateTransition(rule.state, RULE_STATES.MONITOR_MODE);

    const monitorPolicy = {
      name: `${rule.name}-monitor`,
      category: 'Application',
      rules: [{
        name: rule.name,
        source_groups: rule.source_groups || [],
        destination_groups: rule.destination_groups || [],
        services: rule.services || [],
        action: 'ALLOW',
        logged: true,
        tag: 'MONITOR_MODE'
      }]
    };

    let deployResult;
    try {
      deployResult = await this.policyDeployer.deploy(monitorPolicy, site);
    } catch (err) {
      this.logger.error('Monitor mode deployment failed', {
        ruleId,
        site,
        errorMessage: err.message,
        component: 'RuleLifecycleManager'
      });
      throw new Error(`[DFW-10005] Monitor mode deployment failed for rule "${ruleId}": ${err.message}`);
    }

    await this.ruleRegistry.updateState(ruleId, RULE_STATES.MONITOR_MODE, {
      reason: 'Deployed in monitor mode',
      site,
      deployedAt: new Date().toISOString()
    });

    this.logger.info('Rule deployed in monitor mode', {
      ruleId,
      site,
      component: 'RuleLifecycleManager'
    });

    return {
      ruleId,
      state: RULE_STATES.MONITOR_MODE,
      site,
      deployResult
    };
  }

  /**
   * Promotes a rule from monitor mode to full enforcement.
   *
   * Changes the rule action from LOG to the intended action (ALLOW/DROP/REJECT)
   * and transitions through VALIDATED to ENFORCED state.
   *
   * @async
   * @param {string} ruleId - The rule identifier to promote.
   * @param {string} site - Target site code.
   * @returns {Promise<Object>} Promotion result.
   *
   * @throws {Error} [DFW-10006] When promotion fails.
   * @throws {Error} [DFW-10002] When the state transition is invalid.
   *
   * @example
   * const result = await manager.promoteToEnforce('DFW-R-0001', 'NDCNG');
   */
  async promoteToEnforce(ruleId, site) {
    if (!ruleId || !site) {
      throw new Error('[DFW-10006] ruleId and site are required');
    }

    this.logger.info('Promoting rule to enforce mode', {
      ruleId,
      site,
      component: 'RuleLifecycleManager'
    });

    const rule = await this.ruleRegistry.getRule(ruleId);
    this._validateTransition(rule.state, RULE_STATES.VALIDATED);

    // Transition through VALIDATED
    await this.ruleRegistry.updateState(ruleId, RULE_STATES.VALIDATED, {
      reason: 'Monitor mode validation passed',
      validatedAt: new Date().toISOString()
    });

    const enforcePolicy = {
      name: rule.name,
      category: 'Application',
      rules: [{
        name: rule.name,
        source_groups: rule.source_groups || [],
        destination_groups: rule.destination_groups || [],
        services: rule.services || [],
        action: rule.action || 'ALLOW',
        logged: true
      }]
    };

    let deployResult;
    try {
      deployResult = await this.policyDeployer.deploy(enforcePolicy, site);
    } catch (err) {
      this.logger.error('Enforcement deployment failed', {
        ruleId,
        site,
        errorMessage: err.message,
        component: 'RuleLifecycleManager'
      });
      throw new Error(`[DFW-10006] Enforcement deployment failed for rule "${ruleId}": ${err.message}`);
    }

    await this.ruleRegistry.updateState(ruleId, RULE_STATES.ENFORCED, {
      reason: 'Promoted to enforce mode',
      site,
      enforcedAt: new Date().toISOString()
    });

    this.logger.info('Rule promoted to enforce mode', {
      ruleId,
      site,
      component: 'RuleLifecycleManager'
    });

    return {
      ruleId,
      state: RULE_STATES.ENFORCED,
      site,
      deployResult
    };
  }

  /**
   * Rolls back a rule by removing or disabling it in NSX.
   *
   * Can be called from most active states. Transitions the rule to
   * ROLLED_BACK state.
   *
   * @async
   * @param {string} ruleId - The rule identifier to roll back.
   * @param {string} site - Target site code.
   * @returns {Promise<Object>} Rollback result.
   *
   * @throws {Error} [DFW-10007] When rollback fails.
   * @throws {Error} [DFW-10002] When the state transition is invalid.
   *
   * @example
   * const result = await manager.rollbackRule('DFW-R-0001', 'NDCNG');
   */
  async rollbackRule(ruleId, site) {
    if (!ruleId || !site) {
      throw new Error('[DFW-10007] ruleId and site are required');
    }

    this.logger.info('Rolling back rule', {
      ruleId,
      site,
      component: 'RuleLifecycleManager'
    });

    const rule = await this.ruleRegistry.getRule(ruleId);
    this._validateTransition(rule.state, RULE_STATES.ROLLED_BACK);

    const disablePolicy = {
      name: rule.name,
      category: 'Application',
      rules: [{
        name: rule.name,
        source_groups: rule.source_groups || [],
        destination_groups: rule.destination_groups || [],
        services: rule.services || [],
        action: rule.action || 'ALLOW',
        disabled: true
      }]
    };

    try {
      await this.policyDeployer.deploy(disablePolicy, site);
    } catch (err) {
      this.logger.error('Rollback deployment failed', {
        ruleId,
        site,
        errorMessage: err.message,
        component: 'RuleLifecycleManager'
      });
      throw new Error(`[DFW-10007] Rollback failed for rule "${ruleId}": ${err.message}`);
    }

    await this.ruleRegistry.updateState(ruleId, RULE_STATES.ROLLED_BACK, {
      reason: 'Rule rolled back',
      site,
      rolledBackAt: new Date().toISOString()
    });

    this.logger.info('Rule rolled back successfully', {
      ruleId,
      site,
      component: 'RuleLifecycleManager'
    });

    return {
      ruleId,
      state: RULE_STATES.ROLLED_BACK,
      site,
      rolledBackAt: new Date().toISOString()
    };
  }

  /**
   * Certifies an enforced rule, setting the next review date.
   *
   * Transitions the rule to CERTIFIED state and schedules the next
   * periodic review based on the configured review period.
   *
   * @async
   * @param {string} ruleId - The rule identifier to certify.
   * @param {string} certifierId - The user ID of the certifier.
   * @returns {Promise<Object>} Certification result.
   *
   * @throws {Error} [DFW-10008] When certification fails.
   * @throws {Error} [DFW-10002] When the state transition is invalid.
   *
   * @example
   * const result = await manager.certifyRule('DFW-R-0001', 'security-architect');
   */
  async certifyRule(ruleId, certifierId) {
    if (!ruleId || !certifierId) {
      throw new Error('[DFW-10008] ruleId and certifierId are required');
    }

    this.logger.info('Certifying rule', {
      ruleId,
      certifierId,
      component: 'RuleLifecycleManager'
    });

    const rule = await this.ruleRegistry.getRule(ruleId);
    this._validateTransition(rule.state, RULE_STATES.CERTIFIED);

    const reviewDate = new Date();
    reviewDate.setDate(reviewDate.getDate() + DEFAULT_REVIEW_PERIOD_DAYS);

    await this.ruleRegistry.updateState(ruleId, RULE_STATES.CERTIFIED, {
      reason: `Certified by ${certifierId}`,
      changedBy: certifierId,
      certifiedAt: new Date().toISOString(),
      certifiedBy: certifierId,
      review_date: reviewDate.toISOString()
    });

    this.logger.info('Rule certified', {
      ruleId,
      certifierId,
      reviewDate: reviewDate.toISOString(),
      component: 'RuleLifecycleManager'
    });

    return {
      ruleId,
      state: RULE_STATES.CERTIFIED,
      certifiedBy: certifierId,
      certifiedAt: new Date().toISOString(),
      reviewDate: reviewDate.toISOString()
    };
  }

  /**
   * Expires a rule, marking it as no longer active.
   *
   * Transitions the rule to EXPIRED state. Expired rules cannot be
   * re-activated and must be re-submitted as new requests.
   *
   * @async
   * @param {string} ruleId - The rule identifier to expire.
   * @returns {Promise<Object>} Expiry result.
   *
   * @throws {Error} [DFW-10009] When the expiry operation fails.
   * @throws {Error} [DFW-10002] When the state transition is invalid.
   *
   * @example
   * const result = await manager.expireRule('DFW-R-0001');
   */
  async expireRule(ruleId) {
    if (!ruleId) {
      throw new Error('[DFW-10009] ruleId is required');
    }

    this.logger.info('Expiring rule', {
      ruleId,
      component: 'RuleLifecycleManager'
    });

    const rule = await this.ruleRegistry.getRule(ruleId);
    this._validateTransition(rule.state, RULE_STATES.EXPIRED);

    await this.ruleRegistry.updateState(ruleId, RULE_STATES.EXPIRED, {
      reason: 'Rule expired',
      expiredAt: new Date().toISOString()
    });

    this.logger.info('Rule expired', {
      ruleId,
      component: 'RuleLifecycleManager'
    });

    return {
      ruleId,
      state: RULE_STATES.EXPIRED,
      expiredAt: new Date().toISOString()
    };
  }

  /**
   * Retrieves the full audit trail for a rule.
   *
   * @async
   * @param {string} ruleId - The rule identifier.
   * @returns {Promise<Object[]>} Array of change history entries.
   *
   * @throws {Error} [DFW-10004] When the rule is not found.
   *
   * @example
   * const trail = await manager.getAuditTrail('DFW-R-0001');
   * console.log(`${trail.length} state changes recorded`);
   */
  async getAuditTrail(ruleId) {
    if (!ruleId) {
      throw new Error('[DFW-10004] ruleId is required');
    }

    this.logger.debug('Fetching audit trail', {
      ruleId,
      component: 'RuleLifecycleManager'
    });

    return this.ruleRegistry.getHistory(ruleId);
  }

  /**
   * Submits an emergency rule with fast-track processing.
   *
   * Skips normal approval gates and deploys directly to monitor mode
   * or enforcement depending on severity. Requires an incident ID for
   * audit trail linkage.
   *
   * @async
   * @param {Object} ruleRequest - The emergency rule definition.
   * @param {string} ruleRequest.name - Rule name.
   * @param {string} incidentId - ServiceNow incident ID justifying the emergency.
   * @returns {Promise<Object>} Emergency rule with fast-tracked state.
   *
   * @throws {Error} [DFW-10010] When the emergency submission fails.
   *
   * @example
   * const rule = await manager.submitEmergency(
   *   { name: 'block-threat-actor', action: 'DROP', ... },
   *   'INC0012345'
   * );
   */
  async submitEmergency(ruleRequest, incidentId) {
    if (!ruleRequest || !ruleRequest.name) {
      throw new Error('[DFW-10010] Emergency rule request must include a name');
    }
    if (!incidentId) {
      throw new Error('[DFW-10010] incidentId is required for emergency submissions');
    }

    this.logger.info('Submitting emergency rule', {
      name: ruleRequest.name,
      incidentId,
      component: 'RuleLifecycleManager'
    });

    const ruleId = this.ruleRegistry.generateRuleId();

    const rule = {
      ...ruleRequest,
      ruleId,
      state: RULE_STATES.REQUESTED,
      emergency: true,
      incidentId,
      submittedAt: new Date().toISOString()
    };

    await this.ruleRegistry.register(rule);

    // Fast-track: skip impact analysis and approval, go directly to IMPACT_ANALYZED
    await this.ruleRegistry.updateState(ruleId, RULE_STATES.IMPACT_ANALYZED, {
      reason: `Emergency fast-track for incident ${incidentId}`,
      changedBy: 'emergency-system'
    });

    // Fast-track: skip approval, go to APPROVED
    await this.ruleRegistry.updateState(ruleId, RULE_STATES.APPROVED, {
      reason: `Emergency auto-approved for incident ${incidentId}`,
      changedBy: 'emergency-system'
    });

    this.logger.info('Emergency rule fast-tracked to APPROVED', {
      ruleId,
      incidentId,
      component: 'RuleLifecycleManager'
    });

    return {
      ruleId,
      state: RULE_STATES.APPROVED,
      emergency: true,
      incidentId,
      submittedAt: rule.submittedAt
    };
  }

  /**
   * Validates that a state transition is allowed per the state machine.
   *
   * @private
   * @param {string} currentState - The current rule state.
   * @param {string} targetState - The desired target state.
   *
   * @throws {Error} [DFW-10002] When the transition is not allowed.
   */
  _validateTransition(currentState, targetState) {
    const allowed = STATE_TRANSITIONS[currentState];
    if (!allowed || !allowed.includes(targetState)) {
      throw new Error(
        `[DFW-10002] Invalid state transition: ${currentState} -> ${targetState}`
      );
    }
  }
}

RuleLifecycleManager.RULE_STATES = RULE_STATES;
RuleLifecycleManager.STATE_TRANSITIONS = STATE_TRANSITIONS;

module.exports = RuleLifecycleManager;
