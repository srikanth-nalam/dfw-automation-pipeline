/**
 * @file CMDBValidator.js
 * @description CMDB Data Quality Validator for the DFW Automation Pipeline.
 *   Extracts, validates, and reports on CMDB data quality for all NSX-eligible
 *   workloads across the enterprise VM estate.
 *
 * Error codes: DFW-9001 through DFW-9006
 *
 * @module cmdb/CMDBValidator
 */

'use strict';

/**
 * Mandatory tag fields that every VM must have populated.
 * @constant {string[]}
 * @private
 */
const MANDATORY_FIELDS = Object.freeze([
  'region',
  'securityZone',
  'environment',
  'appCI',
  'systemRole'
]);

/**
 * Optional tag fields tracked for completeness reporting.
 * @constant {string[]}
 * @private
 */
const OPTIONAL_FIELDS = Object.freeze([
  'compliance',
  'dataClassification',
  'costCenter'
]);

/**
 * Allowed values for each mandatory and optional tag field.
 * @constant {Object<string, string[]>}
 * @private
 */
const ALLOWED_VALUES = Object.freeze({
  region: ['NDCNG', 'TULNG'],
  securityZone: ['Greenzone', 'DMZ', 'Restricted', 'Management', 'External'],
  environment: ['Production', 'Pre-Production', 'UAT', 'Staging', 'Development', 'Sandbox', 'DR'],
  systemRole: ['Web', 'Application', 'Database', 'Middleware', 'Utility', 'SharedServices']
});

/**
 * Default CMDB REST table path for VM configuration items.
 * @constant {string}
 * @private
 */
const CMDB_VM_TABLE = '/api/now/table/cmdb_ci_vm_instance';

/**
 * @class CMDBValidator
 * @classdesc Extracts, validates, and reports on CMDB data quality for all
 *   NSX-eligible workloads. Provides coverage analysis, value quality checks,
 *   gap reporting, and remediation task generation.
 *
 * @example
 * const validator = new CMDBValidator({ restClient, logger, configLoader });
 * const report = await validator.generateGapReport('NDCNG');
 */
class CMDBValidator {
  /**
   * Creates a new CMDBValidator instance.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.restClient - HTTP client with `get` and `post` methods.
   * @param {Object} dependencies.logger - Structured logger with `info`, `warn`, `error`, `debug`.
   * @param {Object} dependencies.configLoader - Configuration loader with `getEndpointsForSite`.
   *
   * @throws {Error} [DFW-9001] When required dependencies are missing.
   *
   * @example
   * const validator = new CMDBValidator({ restClient, logger, configLoader });
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-9001] CMDBValidator requires dependencies');
    }
    if (!dependencies.restClient) {
      throw new Error('[DFW-9001] CMDBValidator requires a restClient instance');
    }
    if (!dependencies.logger) {
      throw new Error('[DFW-9001] CMDBValidator requires a logger instance');
    }
    if (!dependencies.configLoader) {
      throw new Error('[DFW-9001] CMDBValidator requires a configLoader instance');
    }

    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this.configLoader = dependencies.configLoader;
  }

  /**
   * Pulls the full VM estate from the CMDB for a given site.
   *
   * Queries the cmdb_ci_vm_instance table via REST and applies optional
   * filters such as operational_status. Returns a normalised inventory
   * object suitable for coverage and quality validation.
   *
   * @async
   * @param {string} site - Site code (e.g. 'NDCNG', 'TULNG').
   * @param {Object} [filters={}] - Optional query filters.
   * @param {number} [filters.operational_status] - Operational status filter (1 = active).
   * @param {string} [filters.owner] - Filter by CI owner.
   * @returns {Promise<{totalVMs: number, vms: Object[]}>} Inventory result.
   *
   * @throws {Error} [DFW-9002] When the site is invalid or the REST call fails.
   *
   * @example
   * const inventory = await validator.extractVMInventory('NDCNG', { operational_status: 1 });
   * console.log(`Found ${inventory.totalVMs} VMs`);
   */
  async extractVMInventory(site, filters = {}) {
    if (!site || typeof site !== 'string') {
      throw new Error('[DFW-9002] site is required and must be a non-empty string');
    }

    this.logger.info('Extracting VM inventory from CMDB', {
      site,
      filters,
      component: 'CMDBValidator'
    });

    const endpoints = this.configLoader.getEndpointsForSite(site);
    const queryParams = this._buildQueryParams(filters);
    const url = `${endpoints.snowUrl}${CMDB_VM_TABLE}${queryParams}`;

    let response;
    try {
      response = await this.restClient.get(url);
    } catch (err) {
      this.logger.error('Failed to extract VM inventory from CMDB', {
        site,
        errorMessage: err.message,
        component: 'CMDBValidator'
      });
      throw new Error(`[DFW-9002] Failed to extract VM inventory: ${err.message}`);
    }

    const records = this._extractRecords(response);
    const vms = records.map((record) => this._normalizeVMRecord(record));

    this.logger.info('VM inventory extraction complete', {
      site,
      totalVMs: vms.length,
      component: 'CMDBValidator'
    });

    return {
      totalVMs: vms.length,
      vms
    };
  }

  /**
   * Checks each VM in the inventory for 5-tag completeness.
   *
   * Evaluates every VM against the mandatory tag fields (Region, SecurityZone,
   * Environment, AppCI, SystemRole) and produces a detailed coverage report
   * including per-field statistics.
   *
   * @param {Object} inventory - Inventory object from {@link extractVMInventory}.
   * @param {Object[]} inventory.vms - Array of normalised VM records.
   * @returns {{
   *   totalVMs: number,
   *   fullyPopulated: number,
   *   partiallyPopulated: number,
   *   unpopulated: number,
   *   coverageByField: Object,
   *   vmsMissingFields: Object[]
   * }} Coverage analysis result.
   *
   * @throws {Error} [DFW-9003] When inventory is invalid.
   *
   * @example
   * const coverage = await validator.validateCoverage(inventory);
   * console.log(`${coverage.fullyPopulated} of ${coverage.totalVMs} VMs fully tagged`);
   */
  async validateCoverage(inventory) {
    if (!inventory || !Array.isArray(inventory.vms)) {
      throw new Error('[DFW-9003] Invalid inventory: expected object with vms array');
    }

    const { vms } = inventory;
    let fullyPopulated = 0;
    let partiallyPopulated = 0;
    let unpopulated = 0;
    const vmsMissingFields = [];

    const coverageByField = {};
    for (const field of MANDATORY_FIELDS) {
      coverageByField[field] = { populated: 0, missing: 0, percent: 0 };
    }

    for (const vm of vms) {
      const missingFields = [];

      for (const field of MANDATORY_FIELDS) {
        const value = vm[field];
        if (value !== undefined && value !== null && value !== '') {
          coverageByField[field].populated += 1;
        } else {
          coverageByField[field].missing += 1;
          missingFields.push(field);
        }
      }

      if (missingFields.length === 0) {
        fullyPopulated += 1;
      } else if (missingFields.length === MANDATORY_FIELDS.length) {
        unpopulated += 1;
        vmsMissingFields.push({
          vmId: vm.vmId,
          vmName: vm.vmName,
          missingFields
        });
      } else {
        partiallyPopulated += 1;
        vmsMissingFields.push({
          vmId: vm.vmId,
          vmName: vm.vmName,
          missingFields
        });
      }
    }

    // Calculate percentages
    const total = vms.length;
    for (const field of MANDATORY_FIELDS) {
      coverageByField[field].percent = total > 0
        ? Math.round((coverageByField[field].populated / total) * 100)
        : 100;
    }

    this.logger.info('Coverage validation complete', {
      totalVMs: total,
      fullyPopulated,
      partiallyPopulated,
      unpopulated,
      component: 'CMDBValidator'
    });

    return {
      totalVMs: total,
      fullyPopulated,
      partiallyPopulated,
      unpopulated,
      coverageByField,
      vmsMissingFields
    };
  }

  /**
   * Cross-checks VM tag values against the allowed tag dictionary.
   *
   * For each VM that has a value for a validated field (region, securityZone,
   * environment, systemRole), verifies that the value is in the allowed list.
   * AppCI is not validated against a dictionary because it references dynamic
   * CMDB configuration items.
   *
   * @param {Object} inventory - Inventory object from {@link extractVMInventory}.
   * @param {Object[]} inventory.vms - Array of normalised VM records.
   * @returns {{
   *   totalChecked: number,
   *   validValues: number,
   *   invalidValues: number,
   *   invalidEntries: Object[]
   * }} Quality analysis result.
   *
   * @throws {Error} [DFW-9004] When inventory is invalid.
   *
   * @example
   * const quality = await validator.validateQuality(inventory);
   * if (quality.invalidValues > 0) {
   *   console.warn('Found invalid tag values', quality.invalidEntries);
   * }
   */
  async validateQuality(inventory) {
    if (!inventory || !Array.isArray(inventory.vms)) {
      throw new Error('[DFW-9004] Invalid inventory: expected object with vms array');
    }

    const { vms } = inventory;
    let totalChecked = 0;
    let validValues = 0;
    let invalidValues = 0;
    const invalidEntries = [];

    const validatedFields = Object.keys(ALLOWED_VALUES);

    for (const vm of vms) {
      for (const field of validatedFields) {
        const value = vm[field];
        if (value === undefined || value === null || value === '') {
          continue;
        }

        totalChecked += 1;
        const allowed = ALLOWED_VALUES[field];

        if (allowed.includes(value)) {
          validValues += 1;
        } else {
          invalidValues += 1;
          invalidEntries.push({
            vmId: vm.vmId,
            vmName: vm.vmName,
            field,
            value,
            reason: `Value "${value}" is not in the allowed list for ${field}: [${allowed.join(', ')}]`
          });
        }
      }
    }

    this.logger.info('Quality validation complete', {
      totalChecked,
      validValues,
      invalidValues,
      component: 'CMDBValidator'
    });

    return {
      totalChecked,
      validValues,
      invalidValues,
      invalidEntries
    };
  }

  /**
   * Generates a structured gap analysis report combining coverage and quality
   * checks for a given site.
   *
   * Orchestrates the full validation pipeline: extract inventory, validate
   * coverage, validate quality, then assemble a dashboard-ready report with
   * summary metrics, top gaps, and actionable recommendations.
   *
   * @async
   * @param {string} site - Site code (e.g. 'NDCNG').
   * @returns {Promise<{
   *   site: string,
   *   timestamp: string,
   *   summary: Object,
   *   coverageMetrics: Object,
   *   qualityMetrics: Object,
   *   topGaps: Object[],
   *   recommendations: string[]
   * }>} Full gap analysis report.
   *
   * @throws {Error} [DFW-9005] When gap report generation fails.
   *
   * @example
   * const report = await validator.generateGapReport('NDCNG');
   * console.log(`${report.summary.readyForNSX} VMs ready for NSX`);
   */
  async generateGapReport(site) {
    if (!site || typeof site !== 'string') {
      throw new Error('[DFW-9005] site is required and must be a non-empty string');
    }

    this.logger.info('Generating gap report', {
      site,
      component: 'CMDBValidator'
    });

    let inventory;
    try {
      inventory = await this.extractVMInventory(site, { operational_status: 1 });
    } catch (err) {
      throw new Error(`[DFW-9005] Gap report failed during inventory extraction: ${err.message}`);
    }

    const coverageMetrics = await this.validateCoverage(inventory);
    const qualityMetrics = await this.validateQuality(inventory);

    const readyForNSX = this._countReadyVMs(inventory.vms, qualityMetrics);
    const needsRemediation = inventory.totalVMs - readyForNSX;

    const topGaps = this._identifyTopGaps(coverageMetrics, qualityMetrics);
    const recommendations = this._generateRecommendations(coverageMetrics, qualityMetrics);

    const report = {
      site,
      timestamp: new Date().toISOString(),
      summary: {
        totalVMs: inventory.totalVMs,
        readyForNSX,
        needsRemediation
      },
      coverageMetrics,
      qualityMetrics,
      topGaps,
      recommendations
    };

    this.logger.info('Gap report generated', {
      site,
      totalVMs: inventory.totalVMs,
      readyForNSX,
      needsRemediation,
      component: 'CMDBValidator'
    });

    return report;
  }

  /**
   * Creates ServiceNow remediation tasks for CI owners based on a gap report.
   *
   * Groups missing fields by CI owner and creates one task per owner with
   * all their affected VMs listed. Tasks are created via the ServiceNow REST API.
   *
   * @async
   * @param {Object} gapReport - Gap report from {@link generateGapReport}.
   * @returns {Promise<{tasksCreated: number, tasksByOwner: Object[]}>}
   *
   * @throws {Error} [DFW-9006] When task creation fails.
   *
   * @example
   * const tasks = await validator.generateRemediationTasks(gapReport);
   * console.log(`Created ${tasks.tasksCreated} remediation tasks`);
   */
  async generateRemediationTasks(gapReport) {
    if (!gapReport || !gapReport.coverageMetrics) {
      throw new Error('[DFW-9006] Invalid gap report: missing coverageMetrics');
    }

    const vmsMissing = gapReport.coverageMetrics.vmsMissingFields || [];
    if (vmsMissing.length === 0) {
      this.logger.info('No remediation tasks needed, all VMs fully tagged', {
        component: 'CMDBValidator'
      });
      return { tasksCreated: 0, tasksByOwner: [] };
    }

    // Group VMs by owner
    const ownerMap = {};
    for (const vm of vmsMissing) {
      const owner = vm.owner || 'unassigned';
      if (!ownerMap[owner]) {
        ownerMap[owner] = [];
      }
      ownerMap[owner].push({
        vmId: vm.vmId,
        vmName: vm.vmName,
        missingFields: vm.missingFields
      });
    }

    const endpoints = this.configLoader.getEndpointsForSite(gapReport.site);
    const tasksByOwner = [];
    let tasksCreated = 0;

    for (const [owner, vmList] of Object.entries(ownerMap)) {
      const taskPayload = {
        assigned_to: owner,
        short_description: `CMDB remediation: ${vmList.length} VM(s) missing mandatory DFW tags`,
        description: this._buildTaskDescription(vmList),
        priority: vmList.length > 10 ? 2 : 3,
        category: 'CMDB Data Quality'
      };

      try {
        await this.restClient.post(
          `${endpoints.snowUrl}/api/now/table/sc_task`,
          taskPayload
        );
        tasksCreated += 1;
        tasksByOwner.push({
          owner,
          taskCount: 1,
          vmList: vmList.map((v) => v.vmId)
        });
      } catch (err) {
        this.logger.error('Failed to create remediation task', {
          owner,
          errorMessage: err.message,
          component: 'CMDBValidator'
        });
        throw new Error(`[DFW-9006] Failed to create remediation task for owner "${owner}": ${err.message}`);
      }
    }

    this.logger.info('Remediation tasks created', {
      tasksCreated,
      owners: Object.keys(ownerMap).length,
      component: 'CMDBValidator'
    });

    return { tasksCreated, tasksByOwner };
  }

  /**
   * Computes dashboard-ready KPI metrics from a gap report.
   *
   * Returns overall readiness percentage, coverage score, quality score,
   * and an estimated number of remediation days based on the size of the
   * remediation backlog.
   *
   * @param {Object} gapReport - Gap report from {@link generateGapReport}.
   * @returns {{
   *   overallReadiness: number,
   *   coverageScore: number,
   *   qualityScore: number,
   *   estimatedRemediationDays: number
   * }} KPI metrics.
   *
   * @throws {Error} [DFW-9005] When the gap report is invalid.
   *
   * @example
   * const metrics = validator.getMetrics(gapReport);
   * console.log(`Overall readiness: ${metrics.overallReadiness}%`);
   */
  getMetrics(gapReport) {
    if (!gapReport || !gapReport.summary || !gapReport.coverageMetrics || !gapReport.qualityMetrics) {
      throw new Error('[DFW-9005] Invalid gap report: missing required sections');
    }

    const { summary, coverageMetrics, qualityMetrics } = gapReport;
    const totalVMs = summary.totalVMs;

    const overallReadiness = totalVMs > 0
      ? Math.round((summary.readyForNSX / totalVMs) * 100)
      : 100;

    const coverageScore = totalVMs > 0
      ? Math.round((coverageMetrics.fullyPopulated / totalVMs) * 100)
      : 100;

    const qualityScore = qualityMetrics.totalChecked > 0
      ? Math.round((qualityMetrics.validValues / qualityMetrics.totalChecked) * 100)
      : 100;

    // Estimate ~50 VMs per day remediation capacity
    const estimatedRemediationDays = Math.ceil(summary.needsRemediation / 50);

    return {
      overallReadiness,
      coverageScore,
      qualityScore,
      estimatedRemediationDays
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Builds URL query parameters from a filters object.
   *
   * @private
   * @param {Object} filters - Filter key-value pairs.
   * @returns {string} Query string including leading '?' or empty string.
   */
  _buildQueryParams(filters) {
    const params = [];
    if (filters.operational_status !== undefined) {
      params.push(`sysparm_query=operational_status=${filters.operational_status}`);
    }
    if (filters.owner) {
      const ownerParam = params.length > 0
        ? `^owned_by=${filters.owner}`
        : `sysparm_query=owned_by=${filters.owner}`;
      params.push(ownerParam);
    }
    return params.length > 0 ? `?${params.join('&')}` : '';
  }

  /**
   * Extracts the records array from a REST response.
   *
   * @private
   * @param {Object|Array} response - REST response.
   * @returns {Object[]} Extracted records.
   */
  _extractRecords(response) {
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

  /**
   * Normalises a raw CMDB record into the standard VM record format.
   *
   * @private
   * @param {Object} record - Raw CMDB record.
   * @returns {Object} Normalised VM record.
   */
  _normalizeVMRecord(record) {
    return {
      vmId: record.sys_id || record.vmId || record.vm_id,
      vmName: record.name || record.vmName || record.vm_name,
      ciSysId: record.sys_id || record.ciSysId,
      region: record.u_region || record.region || null,
      securityZone: record.u_security_zone || record.securityZone || null,
      environment: record.u_environment || record.environment || null,
      appCI: record.u_app_ci || record.appCI || null,
      systemRole: record.u_system_role || record.systemRole || null,
      compliance: record.u_compliance || record.compliance || null,
      dataClassification: record.u_data_classification || record.dataClassification || null,
      costCenter: record.u_cost_center || record.costCenter || null,
      owner: record.owned_by || record.owner || null,
      lastUpdated: record.sys_updated_on || record.lastUpdated || null
    };
  }

  /**
   * Counts VMs that are ready for NSX (fully tagged with valid values).
   *
   * @private
   * @param {Object[]} vms - Normalised VM records.
   * @param {Object} qualityMetrics - Quality validation result.
   * @returns {number} Count of NSX-ready VMs.
   */
  _countReadyVMs(vms, qualityMetrics) {
    const invalidVmIds = new Set(
      (qualityMetrics.invalidEntries || []).map((entry) => entry.vmId)
    );

    let readyCount = 0;
    for (const vm of vms) {
      const hasAllMandatory = MANDATORY_FIELDS.every(
        (field) => vm[field] !== undefined && vm[field] !== null && vm[field] !== ''
      );
      if (hasAllMandatory && !invalidVmIds.has(vm.vmId)) {
        readyCount += 1;
      }
    }

    return readyCount;
  }

  /**
   * Identifies the top gaps from coverage and quality metrics.
   *
   * @private
   * @param {Object} coverageMetrics - Coverage validation result.
   * @param {Object} qualityMetrics - Quality validation result.
   * @returns {Object[]} Sorted list of top gaps.
   */
  _identifyTopGaps(coverageMetrics, qualityMetrics) {
    const gaps = [];

    // Coverage gaps
    for (const [field, stats] of Object.entries(coverageMetrics.coverageByField)) {
      if (stats.missing > 0) {
        gaps.push({
          type: 'coverage',
          field,
          count: stats.missing,
          percent: 100 - stats.percent,
          description: `${stats.missing} VMs missing ${field}`
        });
      }
    }

    // Quality gaps by field
    const qualityByField = {};
    for (const entry of qualityMetrics.invalidEntries || []) {
      if (!qualityByField[entry.field]) {
        qualityByField[entry.field] = 0;
      }
      qualityByField[entry.field] += 1;
    }

    for (const [field, count] of Object.entries(qualityByField)) {
      gaps.push({
        type: 'quality',
        field,
        count,
        description: `${count} VMs have invalid values for ${field}`
      });
    }

    // Sort by count descending
    gaps.sort((a, b) => b.count - a.count);

    return gaps;
  }

  /**
   * Generates actionable recommendations based on metrics.
   *
   * @private
   * @param {Object} coverageMetrics - Coverage validation result.
   * @param {Object} qualityMetrics - Quality validation result.
   * @returns {string[]} List of recommendation strings.
   */
  _generateRecommendations(coverageMetrics, qualityMetrics) {
    const recommendations = [];

    // Coverage recommendations
    for (const [field, stats] of Object.entries(coverageMetrics.coverageByField)) {
      if (stats.percent < 80) {
        recommendations.push(
          `Critical: ${field} coverage is only ${stats.percent}%. ` +
          `Prioritise populating ${field} for ${stats.missing} VMs.`
        );
      } else if (stats.percent < 95) {
        recommendations.push(
          `Warning: ${field} coverage is ${stats.percent}%. ` +
          `${stats.missing} VMs still need ${field} populated.`
        );
      }
    }

    // Quality recommendations
    if (qualityMetrics.invalidValues > 0) {
      recommendations.push(
        `${qualityMetrics.invalidValues} tag values do not match the allowed dictionary. ` +
        `Review and correct invalid entries to ensure NSX group membership accuracy.`
      );
    }

    // General recommendations
    if (coverageMetrics.unpopulated > 0) {
      recommendations.push(
        `${coverageMetrics.unpopulated} VMs have no mandatory tags at all. ` +
        `Consider bulk-assigning default values based on CMDB relationships.`
      );
    }

    // Optional field recommendations for enhanced governance
    if (OPTIONAL_FIELDS.length > 0 && coverageMetrics.fullyPopulated > 0) {
      recommendations.push(
        `Consider populating optional fields (${OPTIONAL_FIELDS.join(', ')}) ` +
        `for enhanced compliance tracking and cost allocation.`
      );
    }

    return recommendations;
  }

  /**
   * Builds a human-readable task description for a remediation task.
   *
   * @private
   * @param {Object[]} vmList - List of VMs with missing fields.
   * @returns {string} Formatted task description.
   */
  _buildTaskDescription(vmList) {
    const lines = [
      'The following VMs are missing mandatory DFW tag fields in CMDB.',
      'Please update the CMDB records with the correct values.',
      ''
    ];

    for (const vm of vmList) {
      lines.push(`- ${vm.vmName || vm.vmId}: missing [${vm.missingFields.join(', ')}]`);
    }

    return lines.join('\n');
  }
}

module.exports = CMDBValidator;
