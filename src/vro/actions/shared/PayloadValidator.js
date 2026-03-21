/**
 * @file PayloadValidator.js
 * @description JSON Schema validation for ServiceNow-to-vRO request payloads.
 *   Validates required fields, enumerated values, tag structure, and detects
 *   conflicting tag combinations per the DFW Automation Pipeline BRD.
 *
 *   Uses Ajv (Another JSON Schema Validator) when available, with a complete
 *   manual fallback validator so the module works in environments where Ajv
 *   cannot be installed.
 *
 *   Returns structured error objects using the DFW-4001 through DFW-4006
 *   error taxonomy.
 *
 * @module shared/PayloadValidator
 */

'use strict';

/**
 * Enumeration of valid request types.
 *
 * @constant {string[]}
 */
const VALID_REQUEST_TYPES = [
  'day0_provision',
  'day2_tag_update',
  'day_n_decommission',
  'bulk_tag',
  'legacy_onboard'
];

/**
 * Enumeration of valid site codes.
 *
 * @constant {string[]}
 */
const VALID_SITES = ['NDCNG', 'TULNG'];

/**
 * Required top-level fields in every payload.
 *
 * @constant {string[]}
 */
const REQUIRED_FIELDS = [
  'correlationId',
  'requestType',
  'vmName',
  'site',
  'tags',
  'callbackUrl'
];

/**
 * Required tag categories.
 *
 * @constant {string[]}
 */
const REQUIRED_TAG_FIELDS = [
  'Application',
  'Tier',
  'Environment',
  'Compliance',
  'DataClassification'
];

/**
 * Optional tag categories.
 *
 * @constant {string[]}
 */
const OPTIONAL_TAG_FIELDS = ['CostCenter'];

/**
 * All recognised tag categories (for detecting unknown fields).
 *
 * @constant {string[]}
 */
const ALL_TAG_FIELDS = [...REQUIRED_TAG_FIELDS, ...OPTIONAL_TAG_FIELDS];

/**
 * Compliance values that are incompatible with the Sandbox environment.
 *
 * @constant {string[]}
 */
const RESTRICTED_COMPLIANCE_VALUES = ['PCI', 'HIPAA', 'SOX'];

/**
 * Environment value that triggers the compliance conflict check.
 *
 * @constant {string}
 */
const SANDBOX_ENVIRONMENT = 'Sandbox';

/**
 * VM name regex pattern — alphanumeric plus hyphens, 3-63 chars.
 * Intentionally permissive; tighten to match actual naming convention.
 *
 * @constant {RegExp}
 */
const VM_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9\-]{2,62}$/;

/**
 * JSON Schema for the request payload (used by Ajv when available).
 *
 * @constant {Object}
 */
const PAYLOAD_SCHEMA = {
  type: 'object',
  required: REQUIRED_FIELDS,
  additionalProperties: true,
  properties: {
    correlationId: { type: 'string', minLength: 1 },
    requestType: { type: 'string', enum: VALID_REQUEST_TYPES },
    vmName: { type: 'string', pattern: VM_NAME_PATTERN.source },
    site: { type: 'string', enum: VALID_SITES },
    tags: {
      type: 'object',
      required: REQUIRED_TAG_FIELDS,
      properties: {
        Application: { type: 'string', minLength: 1 },
        Tier: { type: 'string', minLength: 1 },
        Environment: { type: 'string', minLength: 1 },
        Compliance: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1
        },
        DataClassification: { type: 'string', minLength: 1 },
        CostCenter: { type: 'string' }
      }
    },
    callbackUrl: { type: 'string', minLength: 1 }
  }
};

/**
 * Attempts to load Ajv. Returns `null` if unavailable.
 *
 * @private
 * @returns {Object|null} The Ajv constructor, or null.
 */
function _tryLoadAjv() {
  try {
    return require('ajv');
  } catch (_err) {
    return null;
  }
}

/**
 * PayloadValidator validates incoming SNOW-to-vRO request payloads against
 * the DFW Automation Pipeline schema. Validation errors are returned as
 * structured objects with DFW error codes.
 *
 * @class PayloadValidator
 *
 * @example
 * const validator = new PayloadValidator();
 * const result = validator.validate(payload);
 * if (!result.valid) {
 *   console.error(result.errors);
 * }
 */
class PayloadValidator {
  /**
   * Creates a new PayloadValidator instance.
   *
   * @param {Object} [options={}]             - Configuration.
   * @param {boolean} [options.useAjv=true]   - Whether to attempt Ajv-based
   *                                            validation. Set to `false` to
   *                                            force the manual validator.
   * @param {RegExp} [options.vmNamePattern]   - Custom regex for VM name
   *                                            validation.
   */
  constructor(options = {}) {
    /** @private */
    this._vmNamePattern = options.vmNamePattern || VM_NAME_PATTERN;

    /** @private */
    this._ajvValidate = null;

    if (options.useAjv !== false) {
      const Ajv = _tryLoadAjv();
      if (Ajv) {
        try {
          const ajv = new Ajv({ allErrors: true, verbose: true });
          this._ajvValidate = ajv.compile(PAYLOAD_SCHEMA);
        } catch (_err) {
          // Ajv compilation failed — fall back to manual
          this._ajvValidate = null;
        }
      }
    }
  }

  /**
   * Validates a request payload.
   *
   * @param {Object} payload - The incoming SNOW-to-vRO request payload.
   * @returns {{ valid: boolean, errors: Array<{ code: string, message: string, field?: string, details?: * }> }}
   *   A result object. `valid` is `true` when there are zero errors.
   *
   * @example
   * const result = validator.validate({
   *   correlationId: 'RITM-12345-1679000000000',
   *   requestType: 'day0_provision',
   *   vmName: 'srv-web-01',
   *   site: 'NDCNG',
   *   tags: {
   *     Application: 'WebPortal',
   *     Tier: 'Web',
   *     Environment: 'Production',
   *     Compliance: ['PCI'],
   *     DataClassification: 'Confidential'
   *   },
   *   callbackUrl: 'https://snow.company.internal/api/callback'
   * });
   *
   * // result.valid === true
   * // result.errors === []
   */
  validate(payload) {
    const errors = [];

    // Guard: payload must be a non-null object
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      errors.push(PayloadValidator._makeError(
        'DFW-4001',
        'Payload must be a non-null JSON object',
        'payload'
      ));
      return { valid: false, errors };
    }

    // --- Phase 1: Required field presence ---
    this._validateRequiredFields(payload, errors);

    // --- Phase 2: Enum and format validation ---
    this._validateRequestType(payload, errors);
    this._validateSite(payload, errors);
    this._validateVmName(payload, errors);
    this._validateCallbackUrl(payload, errors);

    // --- Phase 3: Tag structure ---
    this._validateTags(payload, errors);

    // --- Phase 4: Conflicting tag combinations ---
    this._validateConflictingTags(payload, errors);

    // --- Phase 5: Duplicate single-value tag categories ---
    this._validateDuplicateTags(payload, errors);

    return {
      valid: errors.length === 0,
      errors
    };
  }

  // ---------------------------------------------------------------------------
  // Private validation methods
  // ---------------------------------------------------------------------------

  /**
   * Validates that all required top-level fields are present and non-empty.
   *
   * @private
   * @param {Object} payload - Request payload.
   * @param {Array}  errors  - Accumulator.
   */
  _validateRequiredFields(payload, errors) {
    for (const field of REQUIRED_FIELDS) {
      if (payload[field] === undefined || payload[field] === null) {
        errors.push(PayloadValidator._makeError(
          'DFW-4001',
          `Missing required field: "${field}"`,
          field
        ));
      } else if (field !== 'tags' && typeof payload[field] === 'string' && payload[field].trim() === '') {
        errors.push(PayloadValidator._makeError(
          'DFW-4001',
          `Required field "${field}" must not be empty`,
          field
        ));
      }
    }
  }

  /**
   * Validates the requestType enum value.
   *
   * @private
   * @param {Object} payload - Request payload.
   * @param {Array}  errors  - Accumulator.
   */
  _validateRequestType(payload, errors) {
    if (payload.requestType !== undefined && payload.requestType !== null) {
      if (!VALID_REQUEST_TYPES.includes(payload.requestType)) {
        errors.push(PayloadValidator._makeError(
          'DFW-4002',
          `Invalid requestType "${payload.requestType}". Valid values: ${VALID_REQUEST_TYPES.join(', ')}`,
          'requestType',
          { validValues: VALID_REQUEST_TYPES }
        ));
      }
    }
  }

  /**
   * Validates the site enum value.
   *
   * @private
   * @param {Object} payload - Request payload.
   * @param {Array}  errors  - Accumulator.
   */
  _validateSite(payload, errors) {
    if (payload.site !== undefined && payload.site !== null) {
      if (!VALID_SITES.includes(payload.site)) {
        errors.push(PayloadValidator._makeError(
          'DFW-4004',
          `Invalid site value "${payload.site}". Must be one of: ${VALID_SITES.join(', ')}`,
          'site',
          { validValues: VALID_SITES }
        ));
      }
    }
  }

  /**
   * Validates the vmName format.
   *
   * @private
   * @param {Object} payload - Request payload.
   * @param {Array}  errors  - Accumulator.
   */
  _validateVmName(payload, errors) {
    if (typeof payload.vmName === 'string' && payload.vmName.trim() !== '') {
      if (!this._vmNamePattern.test(payload.vmName)) {
        errors.push(PayloadValidator._makeError(
          'DFW-4005',
          `VM name "${payload.vmName}" does not match naming convention (pattern: ${this._vmNamePattern.source})`,
          'vmName'
        ));
      }
    }
  }

  /**
   * Validates the callbackUrl format.
   *
   * @private
   * @param {Object} payload - Request payload.
   * @param {Array}  errors  - Accumulator.
   */
  _validateCallbackUrl(payload, errors) {
    if (typeof payload.callbackUrl === 'string' && payload.callbackUrl.trim() !== '') {
      try {
        const parsed = new URL(payload.callbackUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          errors.push(PayloadValidator._makeError(
            'DFW-4001',
            `callbackUrl must use http or https protocol, got "${parsed.protocol}"`,
            'callbackUrl'
          ));
        }
      } catch (_err) {
        errors.push(PayloadValidator._makeError(
          'DFW-4001',
          `callbackUrl is not a valid URL: "${payload.callbackUrl}"`,
          'callbackUrl'
        ));
      }
    }
  }

  /**
   * Validates the tags object: required fields, types, and constraints.
   *
   * @private
   * @param {Object} payload - Request payload.
   * @param {Array}  errors  - Accumulator.
   */
  _validateTags(payload, errors) {
    if (payload.tags === undefined || payload.tags === null) {
      // Already flagged by required-fields check
      return;
    }

    if (typeof payload.tags !== 'object' || Array.isArray(payload.tags)) {
      errors.push(PayloadValidator._makeError(
        'DFW-4001',
        'Field "tags" must be a JSON object',
        'tags'
      ));
      return;
    }

    const tags = payload.tags;

    // Required tag fields
    for (const field of REQUIRED_TAG_FIELDS) {
      if (tags[field] === undefined || tags[field] === null) {
        errors.push(PayloadValidator._makeError(
          'DFW-4001',
          `Missing required tag field: "tags.${field}"`,
          `tags.${field}`
        ));
        continue;
      }

      // Type-specific checks
      if (field === 'Compliance') {
        if (!Array.isArray(tags[field])) {
          errors.push(PayloadValidator._makeError(
            'DFW-4002',
            `Tag "Compliance" must be an array of strings, got ${typeof tags[field]}`,
            'tags.Compliance'
          ));
        } else if (tags[field].length === 0) {
          errors.push(PayloadValidator._makeError(
            'DFW-4001',
            'Tag "Compliance" array must contain at least one value',
            'tags.Compliance'
          ));
        } else {
          for (let i = 0; i < tags[field].length; i++) {
            if (typeof tags[field][i] !== 'string' || tags[field][i].trim() === '') {
              errors.push(PayloadValidator._makeError(
                'DFW-4002',
                `Tag "Compliance[${i}]" must be a non-empty string`,
                `tags.Compliance[${i}]`
              ));
            }
          }
        }
      } else {
        // String fields
        if (typeof tags[field] !== 'string') {
          errors.push(PayloadValidator._makeError(
            'DFW-4002',
            `Tag "${field}" must be a string, got ${typeof tags[field]}`,
            `tags.${field}`
          ));
        } else if (tags[field].trim() === '') {
          errors.push(PayloadValidator._makeError(
            'DFW-4001',
            `Tag "${field}" must not be empty`,
            `tags.${field}`
          ));
        }
      }
    }

    // Optional fields type check
    if (tags.CostCenter !== undefined && tags.CostCenter !== null) {
      if (typeof tags.CostCenter !== 'string') {
        errors.push(PayloadValidator._makeError(
          'DFW-4002',
          `Tag "CostCenter" must be a string, got ${typeof tags.CostCenter}`,
          'tags.CostCenter'
        ));
      }
    }
  }

  /**
   * Validates conflicting tag combinations. PCI, HIPAA, or SOX compliance
   * values are incompatible with the Sandbox environment.
   *
   * @private
   * @param {Object} payload - Request payload.
   * @param {Array}  errors  - Accumulator.
   */
  _validateConflictingTags(payload, errors) {
    if (!payload.tags || typeof payload.tags !== 'object') {
      return;
    }

    const environment = payload.tags.Environment;
    const compliance = payload.tags.Compliance;

    if (
      typeof environment === 'string' &&
      environment === SANDBOX_ENVIRONMENT &&
      Array.isArray(compliance)
    ) {
      const conflicts = compliance.filter(c => RESTRICTED_COMPLIANCE_VALUES.includes(c));
      if (conflicts.length > 0) {
        errors.push(PayloadValidator._makeError(
          'DFW-4003',
          `Conflicting tag combination: compliance values [${conflicts.join(', ')}] are not permitted with Environment="${SANDBOX_ENVIRONMENT}"`,
          'tags',
          {
            conflictingCompliance: conflicts,
            environment: SANDBOX_ENVIRONMENT,
            rule: 'PCI/HIPAA/SOX compliance requires non-Sandbox environment'
          }
        ));
      }
    }
  }

  /**
   * Validates that single-value tag categories are not duplicated.
   * (In practice, duplicates would come from array-typed fields or
   * repeated keys in a non-strict JSON parser.)
   *
   * @private
   * @param {Object} payload - Request payload.
   * @param {Array}  errors  - Accumulator.
   */
  _validateDuplicateTags(payload, errors) {
    if (!payload.tags || typeof payload.tags !== 'object') {
      return;
    }

    const singleValueFields = ['Application', 'Tier', 'Environment', 'DataClassification', 'CostCenter'];

    for (const field of singleValueFields) {
      const value = payload.tags[field];
      // Detect if a single-value field was accidentally sent as an array
      if (Array.isArray(value)) {
        errors.push(PayloadValidator._makeError(
          'DFW-4006',
          `Tag "${field}" is a single-value category but received an array with ${value.length} entries`,
          `tags.${field}`,
          { receivedCount: value.length }
        ));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  /**
   * Constructs a structured error object.
   *
   * @private
   * @static
   * @param {string}  code    - DFW error code.
   * @param {string}  message - Human-readable error message.
   * @param {string}  [field] - Field path that triggered the error.
   * @param {*}       [details] - Additional structured details.
   * @returns {{ code: string, message: string, field?: string, details?: * }}
   */
  static _makeError(code, message, field, details) {
    const err = { code, message };
    if (field !== undefined) {
      err.field = field;
    }
    if (details !== undefined) {
      err.details = details;
    }
    return err;
  }
}

/** Expose constants for external reference and testing. */
PayloadValidator.VALID_REQUEST_TYPES = VALID_REQUEST_TYPES;
PayloadValidator.VALID_SITES = VALID_SITES;
PayloadValidator.REQUIRED_FIELDS = REQUIRED_FIELDS;
PayloadValidator.REQUIRED_TAG_FIELDS = REQUIRED_TAG_FIELDS;
PayloadValidator.ALL_TAG_FIELDS = ALL_TAG_FIELDS;
PayloadValidator.VM_NAME_PATTERN = VM_NAME_PATTERN;
PayloadValidator.PAYLOAD_SCHEMA = PAYLOAD_SCHEMA;

module.exports = PayloadValidator;
