/**
 * @file RuleRequestPipeline.js
 * @description Unified intake pipeline for DFW rule requests in ServiceNow.
 *   All rule requests -- regardless of source -- flow through this pipeline.
 *   Supports four intake channels: catalog submissions, application onboarding,
 *   emergency security incident rules, and audit finding remediations.
 *
 *   Each submission is validated, assigned a tracking record, and placed into
 *   the pipeline for downstream processing by the vRO lifecycle workflow.
 *
 * @module servicenow/integration/RuleRequestPipeline
 */

'use strict';

/**
 * Valid source types for rule requests entering the pipeline.
 * @constant {string[]}
 */
const VALID_SOURCES = ['catalog', 'onboarding', 'emergency', 'audit'];

/**
 * Valid pipeline statuses for tracking rule request lifecycle.
 * @constant {string[]}
 */
const PIPELINE_STATUSES = [
  'submitted',
  'validating',
  'pending_approval',
  'approved',
  'processing',
  'completed',
  'failed',
  'rejected'
];

/**
 * Valid rule actions that may be requested.
 * @constant {string[]}
 */
const VALID_RULE_ACTIONS = ['allow', 'deny', 'drop', 'reject'];

/**
 * Valid IP protocol identifiers.
 * @constant {string[]}
 */
const VALID_PROTOCOLS = ['TCP', 'UDP', 'ICMP', 'ANY'];

/**
 * Maximum number of rule definitions permitted in a single onboarding submission.
 * @constant {number}
 */
const MAX_ONBOARDING_RULES = 200;

/**
 * @class RuleRequestPipeline
 * @classdesc Unified intake pipeline for DFW rule requests. Validates incoming
 *   requests, creates tracking records, and returns pipeline status.
 *
 * @example
 * const pipeline = new RuleRequestPipeline({ restClient, logger });
 * const result = await pipeline.submitFromCatalog(catalogRequest);
 */
class RuleRequestPipeline {
  /**
   * Creates a new RuleRequestPipeline.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.restClient - HTTP client for REST API calls
   *   to ServiceNow and vRO endpoints.
   * @param {Object} dependencies.logger - Structured logger instance for
   *   pipeline event logging.
   * @throws {Error} If dependencies are not provided (DFW-9100).
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-9100] RuleRequestPipeline requires dependencies');
    }
    if (!dependencies.restClient) {
      throw new Error('[DFW-9101] RuleRequestPipeline requires restClient dependency');
    }
    if (!dependencies.logger) {
      throw new Error('[DFW-9102] RuleRequestPipeline requires logger dependency');
    }

    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this._trackingRecords = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public API -- Submission methods
  // ---------------------------------------------------------------------------

  /**
   * Submits a standard rule request originating from the ServiceNow catalog.
   *
   * Validates the catalog request payload, creates a tracking record, and
   * returns the pipeline status for the newly created request.
   *
   * @async
   * @param {Object} catalogRequest - The catalog rule request payload.
   * @param {string} catalogRequest.ritmNumber - The RITM number for the request.
   * @param {string} catalogRequest.requestedBy - Sys ID of the requesting user.
   * @param {string} catalogRequest.sourceGroup - Source security group name.
   * @param {string} catalogRequest.destinationGroup - Destination security group name.
   * @param {string} catalogRequest.action - Rule action (allow, deny, drop, reject).
   * @param {string} catalogRequest.protocol - Protocol (TCP, UDP, ICMP, ANY).
   * @param {string|number} [catalogRequest.port] - Port or port range.
   * @param {string} [catalogRequest.justification] - Business justification text.
   * @param {string} [catalogRequest.expirationDate] - Optional rule expiration date.
   * @returns {Promise<Object>} Pipeline status with requestId, status, and tracking details.
   * @throws {Error} If validation fails (DFW-9110).
   */
  async submitFromCatalog(catalogRequest) {
    this.logger.info('Processing catalog rule request submission', {
      ritmNumber: catalogRequest && catalogRequest.ritmNumber,
      component: 'RuleRequestPipeline'
    });

    const validationErrors = this._validateCatalogRequest(catalogRequest);
    if (validationErrors.length > 0) {
      this.logger.warn('Catalog rule request validation failed', {
        errors: validationErrors,
        ritmNumber: catalogRequest && catalogRequest.ritmNumber,
        component: 'RuleRequestPipeline'
      });
      throw new Error(
        '[DFW-9110] Catalog rule request validation failed: ' +
        validationErrors.join('; ')
      );
    }

    const requestId = this._generateRequestId('CAT');
    const trackingRecord = {
      requestId,
      source: 'catalog',
      status: 'submitted',
      ritmNumber: catalogRequest.ritmNumber,
      requestedBy: catalogRequest.requestedBy,
      sourceGroup: catalogRequest.sourceGroup,
      destinationGroup: catalogRequest.destinationGroup,
      action: catalogRequest.action,
      protocol: catalogRequest.protocol,
      port: catalogRequest.port || null,
      justification: catalogRequest.justification || '',
      expirationDate: catalogRequest.expirationDate || null,
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ status: 'submitted', timestamp: new Date().toISOString(), detail: 'Catalog request received' }]
    };

    this._trackingRecords.set(requestId, trackingRecord);

    try {
      await this.restClient.post('/api/now/table/u_dfw_rule_request', {
        u_request_id: requestId,
        u_source: 'catalog',
        u_status: 'submitted',
        u_ritm_number: catalogRequest.ritmNumber,
        u_requested_by: catalogRequest.requestedBy,
        u_source_group: catalogRequest.sourceGroup,
        u_destination_group: catalogRequest.destinationGroup,
        u_action: catalogRequest.action,
        u_protocol: catalogRequest.protocol,
        u_port: catalogRequest.port || '',
        u_justification: catalogRequest.justification || ''
      });
    } catch (err) {
      this.logger.warn('Failed to persist tracking record to ServiceNow', {
        requestId,
        errorMessage: err.message,
        component: 'RuleRequestPipeline'
      });
      // Pipeline continues -- in-memory tracking serves as fallback
    }

    this.logger.info('Catalog rule request submitted successfully', {
      requestId,
      ritmNumber: catalogRequest.ritmNumber,
      component: 'RuleRequestPipeline'
    });

    return {
      requestId,
      source: 'catalog',
      status: 'submitted',
      ritmNumber: catalogRequest.ritmNumber,
      submittedAt: trackingRecord.submittedAt
    };
  }

  /**
   * Submits rule requests originating from application onboarding.
   *
   * Accepts a batch of rule definitions associated with a single application
   * identifier, validates each rule, and creates tracking records for the batch.
   *
   * @async
   * @param {string} appId - The application CI identifier being onboarded.
   * @param {Array<Object>} ruleDefinitions - Array of rule definition objects.
   * @param {string} ruleDefinitions[].sourceGroup - Source security group.
   * @param {string} ruleDefinitions[].destinationGroup - Destination security group.
   * @param {string} ruleDefinitions[].action - Rule action.
   * @param {string} ruleDefinitions[].protocol - Protocol.
   * @param {string|number} [ruleDefinitions[].port] - Port or port range.
   * @returns {Promise<Object>} Batch submission result with individual rule statuses.
   * @throws {Error} If appId is missing (DFW-9120) or ruleDefinitions exceeds limit (DFW-9121).
   */
  async submitFromOnboarding(appId, ruleDefinitions) {
    this.logger.info('Processing onboarding rule request submission', {
      appId,
      ruleCount: ruleDefinitions && ruleDefinitions.length,
      component: 'RuleRequestPipeline'
    });

    if (!appId || typeof appId !== 'string' || appId.trim() === '') {
      throw new Error('[DFW-9120] Application ID is required for onboarding rule submission');
    }

    if (!Array.isArray(ruleDefinitions) || ruleDefinitions.length === 0) {
      throw new Error('[DFW-9121] At least one rule definition is required for onboarding');
    }

    if (ruleDefinitions.length > MAX_ONBOARDING_RULES) {
      throw new Error(
        `[DFW-9122] Onboarding submission exceeds maximum of ${MAX_ONBOARDING_RULES} rules. ` +
        `Received: ${ruleDefinitions.length}`
      );
    }

    const batchId = this._generateRequestId('ONB');
    const results = [];

    for (let i = 0; i < ruleDefinitions.length; i++) {
      const ruleDef = ruleDefinitions[i];
      const ruleErrors = this._validateRuleDefinition(ruleDef, i);

      if (ruleErrors.length > 0) {
        results.push({
          index: i,
          status: 'rejected',
          errors: ruleErrors
        });
        continue;
      }

      const requestId = `${batchId}-R${String(i).padStart(4, '0')}`;
      const trackingRecord = {
        requestId,
        batchId,
        source: 'onboarding',
        status: 'submitted',
        appId,
        sourceGroup: ruleDef.sourceGroup,
        destinationGroup: ruleDef.destinationGroup,
        action: ruleDef.action,
        protocol: ruleDef.protocol,
        port: ruleDef.port || null,
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: [{ status: 'submitted', timestamp: new Date().toISOString(), detail: 'Onboarding rule received' }]
      };

      this._trackingRecords.set(requestId, trackingRecord);
      results.push({
        index: i,
        requestId,
        status: 'submitted'
      });
    }

    const submittedCount = results.filter((r) => r.status === 'submitted').length;
    const rejectedCount = results.filter((r) => r.status === 'rejected').length;

    try {
      await this.restClient.post('/api/now/table/u_dfw_rule_request_batch', {
        u_batch_id: batchId,
        u_source: 'onboarding',
        u_app_id: appId,
        u_total_rules: ruleDefinitions.length,
        u_submitted_count: submittedCount,
        u_rejected_count: rejectedCount
      });
    } catch (err) {
      this.logger.warn('Failed to persist onboarding batch record', {
        batchId,
        errorMessage: err.message,
        component: 'RuleRequestPipeline'
      });
    }

    this.logger.info('Onboarding rule request batch submitted', {
      batchId,
      appId,
      submittedCount,
      rejectedCount,
      component: 'RuleRequestPipeline'
    });

    return {
      batchId,
      source: 'onboarding',
      appId,
      totalRules: ruleDefinitions.length,
      submittedCount,
      rejectedCount,
      results
    };
  }

  /**
   * Submits an emergency rule request tied to a security incident.
   *
   * Emergency rules bypass normal approval workflows and are fast-tracked
   * into the pipeline. The incident identifier is required for audit trail
   * and post-incident review.
   *
   * @async
   * @param {string} incidentId - The security incident identifier (e.g., INC0012345).
   * @param {Object} ruleRequest - The emergency rule request payload.
   * @param {string} ruleRequest.sourceGroup - Source security group.
   * @param {string} ruleRequest.destinationGroup - Destination security group.
   * @param {string} ruleRequest.action - Rule action (typically 'deny' or 'drop').
   * @param {string} ruleRequest.protocol - Protocol.
   * @param {string|number} [ruleRequest.port] - Port or port range.
   * @param {string} ruleRequest.justification - Required justification for emergency rule.
   * @param {string} ruleRequest.requestedBy - Sys ID of the requesting user.
   * @returns {Promise<Object>} Pipeline status with requestId and emergency flag.
   * @throws {Error} If incidentId is missing (DFW-9130) or justification is empty (DFW-9131).
   */
  async submitEmergency(incidentId, ruleRequest) {
    this.logger.info('Processing emergency rule request submission', {
      incidentId,
      component: 'RuleRequestPipeline'
    });

    if (!incidentId || typeof incidentId !== 'string' || incidentId.trim() === '') {
      throw new Error('[DFW-9130] Incident ID is required for emergency rule submission');
    }

    if (!ruleRequest || typeof ruleRequest !== 'object') {
      throw new Error('[DFW-9131] Emergency rule request payload is required');
    }

    if (!ruleRequest.justification || ruleRequest.justification.trim() === '') {
      throw new Error('[DFW-9132] Justification is mandatory for emergency rule requests');
    }

    const ruleErrors = this._validateRuleDefinition(ruleRequest, 0);
    if (ruleErrors.length > 0) {
      throw new Error(
        '[DFW-9133] Emergency rule request validation failed: ' +
        ruleErrors.join('; ')
      );
    }

    const requestId = this._generateRequestId('EMR');
    const trackingRecord = {
      requestId,
      source: 'emergency',
      status: 'approved',
      incidentId,
      requestedBy: ruleRequest.requestedBy || 'system',
      sourceGroup: ruleRequest.sourceGroup,
      destinationGroup: ruleRequest.destinationGroup,
      action: ruleRequest.action,
      protocol: ruleRequest.protocol,
      port: ruleRequest.port || null,
      justification: ruleRequest.justification,
      emergency: true,
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [
        { status: 'submitted', timestamp: new Date().toISOString(), detail: 'Emergency rule received from incident ' + incidentId },
        { status: 'approved', timestamp: new Date().toISOString(), detail: 'Auto-approved: emergency rule' }
      ]
    };

    this._trackingRecords.set(requestId, trackingRecord);

    try {
      await this.restClient.post('/api/now/table/u_dfw_rule_request', {
        u_request_id: requestId,
        u_source: 'emergency',
        u_status: 'approved',
        u_incident_id: incidentId,
        u_source_group: ruleRequest.sourceGroup,
        u_destination_group: ruleRequest.destinationGroup,
        u_action: ruleRequest.action,
        u_protocol: ruleRequest.protocol,
        u_port: ruleRequest.port || '',
        u_justification: ruleRequest.justification,
        u_emergency: true
      });
    } catch (err) {
      this.logger.warn('Failed to persist emergency rule record', {
        requestId,
        incidentId,
        errorMessage: err.message,
        component: 'RuleRequestPipeline'
      });
    }

    this.logger.info('Emergency rule request submitted and auto-approved', {
      requestId,
      incidentId,
      component: 'RuleRequestPipeline'
    });

    return {
      requestId,
      source: 'emergency',
      status: 'approved',
      incidentId,
      emergency: true,
      submittedAt: trackingRecord.submittedAt
    };
  }

  /**
   * Submits a rule request originating from an audit finding.
   *
   * Audit-driven rules are tagged for compliance tracking and linked
   * to the originating audit finding for regulatory evidence.
   *
   * @async
   * @param {string} auditFindingId - The audit finding identifier.
   * @param {Object} ruleRequest - The rule request payload.
   * @param {string} ruleRequest.sourceGroup - Source security group.
   * @param {string} ruleRequest.destinationGroup - Destination security group.
   * @param {string} ruleRequest.action - Rule action.
   * @param {string} ruleRequest.protocol - Protocol.
   * @param {string|number} [ruleRequest.port] - Port or port range.
   * @param {string} ruleRequest.complianceFramework - Compliance framework
   *   driving the audit finding (e.g., PCI, HIPAA, SOX).
   * @param {string} [ruleRequest.remediationDeadline] - Deadline for remediation.
   * @returns {Promise<Object>} Pipeline status with requestId and audit metadata.
   * @throws {Error} If auditFindingId is missing (DFW-9140).
   */
  async submitFromAudit(auditFindingId, ruleRequest) {
    this.logger.info('Processing audit-driven rule request submission', {
      auditFindingId,
      component: 'RuleRequestPipeline'
    });

    if (!auditFindingId || typeof auditFindingId !== 'string' || auditFindingId.trim() === '') {
      throw new Error('[DFW-9140] Audit finding ID is required for audit rule submission');
    }

    if (!ruleRequest || typeof ruleRequest !== 'object') {
      throw new Error('[DFW-9141] Audit rule request payload is required');
    }

    const ruleErrors = this._validateRuleDefinition(ruleRequest, 0);
    if (ruleErrors.length > 0) {
      throw new Error(
        '[DFW-9142] Audit rule request validation failed: ' +
        ruleErrors.join('; ')
      );
    }

    const requestId = this._generateRequestId('AUD');
    const trackingRecord = {
      requestId,
      source: 'audit',
      status: 'submitted',
      auditFindingId,
      sourceGroup: ruleRequest.sourceGroup,
      destinationGroup: ruleRequest.destinationGroup,
      action: ruleRequest.action,
      protocol: ruleRequest.protocol,
      port: ruleRequest.port || null,
      complianceFramework: ruleRequest.complianceFramework || '',
      remediationDeadline: ruleRequest.remediationDeadline || null,
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ status: 'submitted', timestamp: new Date().toISOString(), detail: 'Audit finding rule received from ' + auditFindingId }]
    };

    this._trackingRecords.set(requestId, trackingRecord);

    try {
      await this.restClient.post('/api/now/table/u_dfw_rule_request', {
        u_request_id: requestId,
        u_source: 'audit',
        u_status: 'submitted',
        u_audit_finding_id: auditFindingId,
        u_source_group: ruleRequest.sourceGroup,
        u_destination_group: ruleRequest.destinationGroup,
        u_action: ruleRequest.action,
        u_protocol: ruleRequest.protocol,
        u_port: ruleRequest.port || '',
        u_compliance_framework: ruleRequest.complianceFramework || ''
      });
    } catch (err) {
      this.logger.warn('Failed to persist audit rule record', {
        requestId,
        auditFindingId,
        errorMessage: err.message,
        component: 'RuleRequestPipeline'
      });
    }

    this.logger.info('Audit-driven rule request submitted', {
      requestId,
      auditFindingId,
      complianceFramework: ruleRequest.complianceFramework || 'unspecified',
      component: 'RuleRequestPipeline'
    });

    return {
      requestId,
      source: 'audit',
      status: 'submitted',
      auditFindingId,
      complianceFramework: ruleRequest.complianceFramework || '',
      submittedAt: trackingRecord.submittedAt
    };
  }

  // ---------------------------------------------------------------------------
  // Public API -- Status query
  // ---------------------------------------------------------------------------

  /**
   * Retrieves the current pipeline status for a given request.
   *
   * Checks the in-memory tracking store first, then falls back to a
   * ServiceNow REST query if the record is not found locally.
   *
   * @async
   * @param {string} requestId - The pipeline request identifier.
   * @returns {Promise<Object>} The current tracking record for the request.
   * @throws {Error} If requestId is missing (DFW-9150) or not found (DFW-9151).
   */
  async getStatus(requestId) {
    if (!requestId || typeof requestId !== 'string' || requestId.trim() === '') {
      throw new Error('[DFW-9150] Request ID is required to retrieve pipeline status');
    }

    // Check in-memory tracking store first
    const localRecord = this._trackingRecords.get(requestId);
    if (localRecord) {
      return {
        requestId: localRecord.requestId,
        source: localRecord.source,
        status: localRecord.status,
        submittedAt: localRecord.submittedAt,
        updatedAt: localRecord.updatedAt,
        history: localRecord.history
      };
    }

    // Fall back to ServiceNow REST lookup
    try {
      const response = await this.restClient.get(
        `/api/now/table/u_dfw_rule_request?sysparm_query=u_request_id=${encodeURIComponent(requestId)}&sysparm_limit=1`
      );

      if (response && response.result && response.result.length > 0) {
        const record = response.result[0];
        return {
          requestId: record.u_request_id,
          source: record.u_source,
          status: record.u_status,
          submittedAt: record.sys_created_on,
          updatedAt: record.sys_updated_on,
          history: []
        };
      }
    } catch (err) {
      this.logger.warn('Failed to query ServiceNow for request status', {
        requestId,
        errorMessage: err.message,
        component: 'RuleRequestPipeline'
      });
    }

    throw new Error(
      `[DFW-9151] Rule request not found: ${requestId}`
    );
  }

  // ---------------------------------------------------------------------------
  // Private -- Validation helpers
  // ---------------------------------------------------------------------------

  /**
   * Validates a catalog rule request payload.
   *
   * @private
   * @param {Object} request - The catalog request to validate.
   * @returns {string[]} Array of validation error messages (empty if valid).
   */
  _validateCatalogRequest(request) {
    const errors = [];

    if (!request || typeof request !== 'object') {
      errors.push('Request payload must be a non-null object');
      return errors;
    }

    if (!request.ritmNumber || typeof request.ritmNumber !== 'string' || request.ritmNumber.trim() === '') {
      errors.push('ritmNumber is required');
    }

    if (!request.requestedBy || typeof request.requestedBy !== 'string' || request.requestedBy.trim() === '') {
      errors.push('requestedBy is required');
    }

    errors.push(...this._validateRuleDefinition(request, 0));

    return errors;
  }

  /**
   * Validates an individual rule definition.
   *
   * @private
   * @param {Object} ruleDef - The rule definition to validate.
   * @param {number} index - Index position in the batch (for error messages).
   * @returns {string[]} Array of validation error messages (empty if valid).
   */
  _validateRuleDefinition(ruleDef, index) {
    const errors = [];
    const prefix = index > 0 ? `Rule[${index}]: ` : '';

    if (!ruleDef.sourceGroup || typeof ruleDef.sourceGroup !== 'string' || ruleDef.sourceGroup.trim() === '') {
      errors.push(`${prefix}sourceGroup is required`);
    }

    if (!ruleDef.destinationGroup || typeof ruleDef.destinationGroup !== 'string' || ruleDef.destinationGroup.trim() === '') {
      errors.push(`${prefix}destinationGroup is required`);
    }

    if (!ruleDef.action || VALID_RULE_ACTIONS.indexOf(ruleDef.action) === -1) {
      errors.push(
        `${prefix}action must be one of: ${VALID_RULE_ACTIONS.join(', ')}`
      );
    }

    if (!ruleDef.protocol || VALID_PROTOCOLS.indexOf(ruleDef.protocol) === -1) {
      errors.push(
        `${prefix}protocol must be one of: ${VALID_PROTOCOLS.join(', ')}`
      );
    }

    if (ruleDef.port !== undefined && ruleDef.port !== null && ruleDef.port !== '') {
      const portStr = String(ruleDef.port);
      const portRangePattern = /^\d{1,5}(-\d{1,5})?$/;
      if (!portRangePattern.test(portStr)) {
        errors.push(`${prefix}port must be a valid port number or range (e.g., 443 or 8080-8090)`);
      }
    }

    return errors;
  }

  /**
   * Generates a unique request identifier with the given prefix.
   *
   * @private
   * @param {string} prefix - Three-letter prefix indicating the source type
   *   (CAT, ONB, EMR, AUD).
   * @returns {string} A unique request identifier in the format
   *   DFW-{prefix}-{timestamp}-{random}.
   */
  _generateRequestId(prefix) {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `DFW-${prefix}-${timestamp}-${random}`;
  }
}

/**
 * Exported constants for external use and testing.
 * @type {Object}
 */
RuleRequestPipeline.VALID_SOURCES = VALID_SOURCES;
RuleRequestPipeline.PIPELINE_STATUSES = PIPELINE_STATUSES;
RuleRequestPipeline.VALID_RULE_ACTIONS = VALID_RULE_ACTIONS;
RuleRequestPipeline.VALID_PROTOCOLS = VALID_PROTOCOLS;
RuleRequestPipeline.MAX_ONBOARDING_RULES = MAX_ONBOARDING_RULES;

module.exports = RuleRequestPipeline;
