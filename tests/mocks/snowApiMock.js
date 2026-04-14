/**
 * ServiceNow API Mock Responses
 *
 * Provides mock responses for ServiceNow REST API endpoints used in the
 * DFW automation pipeline (RITM retrieval, updates, tag dictionary,
 * callback payloads).
 */

// ---------------------------------------------------------------------------
// Default RITM field values – used as the base for factory-created records
// ---------------------------------------------------------------------------
const defaultRitmFields = {
  sys_id: 'abc123def456',
  number: 'RITM0012345',
  state: '2',
  short_description: 'DFW Tag Automation - APP001 Web Production',
  description: 'Automated DFW tag assignment for APP001 Web tier in Production',
  assignment_group: { value: 'group-dfw-auto', display_value: 'DFW Automation' },
  assigned_to: { value: 'user-auto-svc', display_value: 'SVC-DFW-Automation' },
  opened_at: '2026-03-20 10:00:00',
  opened_by: { value: 'user-requester', display_value: 'John Doe' },
  u_vm_name: 'NDCNG-APP001-WEB-P01',
  u_region: 'NDCNG',
  u_security_zone: 'Greenzone',
  u_environment: 'Production',
  u_app_ci: 'APP001',
  u_system_role: 'Web',
  u_compliance: 'PCI',
  u_data_classification: 'Confidential',
  u_cost_center: 'CC-IT-INFRA-001',
  u_site: 'NDCNG',
  u_callback_url: 'https://snow.example.com/api/now/table/sc_req_item/abc123def456',
  u_automation_status: 'In Progress',
  u_automation_log: ''
};

// ---------------------------------------------------------------------------
// Tag dictionary entries
// ---------------------------------------------------------------------------
const tagDictionaryEntries = [
  {
    sys_id: 'td-001',
    u_scope: 'Region',
    u_tag_value: 'NDCNG',
    u_description: 'North Data Center - Next Gen region',
    u_active: true
  },
  {
    sys_id: 'td-002',
    u_scope: 'SecurityZone',
    u_tag_value: 'Greenzone',
    u_description: 'Greenzone security zone',
    u_active: true
  },
  {
    sys_id: 'td-003',
    u_scope: 'Environment',
    u_tag_value: 'Production',
    u_description: 'Production environment',
    u_active: true
  },
  {
    sys_id: 'td-004',
    u_scope: 'AppCI',
    u_tag_value: 'APP001',
    u_description: 'Application CI identifier for APP001',
    u_active: true
  },
  {
    sys_id: 'td-005',
    u_scope: 'SystemRole',
    u_tag_value: 'Web',
    u_description: 'Web system role',
    u_active: true
  },
  {
    sys_id: 'td-006',
    u_scope: 'Compliance',
    u_tag_value: 'PCI',
    u_description: 'PCI-DSS compliance scope',
    u_active: true
  },
  {
    sys_id: 'td-007',
    u_scope: 'DataClassification',
    u_tag_value: 'Confidential',
    u_description: 'Confidential data classification',
    u_active: true
  },
  {
    sys_id: 'td-008',
    u_scope: 'CostCenter',
    u_tag_value: 'CC-IT-INFRA-001',
    u_description: 'IT Infrastructure cost center',
    u_active: true
  }
];

// ---------------------------------------------------------------------------
// Mock implementation
// ---------------------------------------------------------------------------
const snowApiMock = {
  // ---------------------------------------------------------------------------
  // GET /api/now/table/sc_req_item/{sys_id}
  // ---------------------------------------------------------------------------

  /**
   * Retrieve a mock RITM record.
   * @param {string} [sysId='abc123def456']
   * @returns {{ result: Object }}
   */
  getRitmRecord: (sysId = 'abc123def456') => ({
    result: {
      ...defaultRitmFields,
      sys_id: sysId
    }
  }),

  // ---------------------------------------------------------------------------
  // PATCH /api/now/table/sc_req_item/{sys_id}
  // ---------------------------------------------------------------------------

  /**
   * Update a RITM record.
   * @param {string} sysId
   * @param {Object} fields  Key-value pairs to update.
   * @returns {{ result: Object }}
   */
  updateRitm: (sysId = 'abc123def456', fields = {}) => ({
    result: {
      ...defaultRitmFields,
      sys_id: sysId,
      ...fields,
      sys_updated_on: '2026-03-21 12:00:00',
      sys_updated_by: 'SVC-DFW-Automation'
    }
  }),

  // ---------------------------------------------------------------------------
  // GET /api/now/table/u_tag_dictionary
  // ---------------------------------------------------------------------------

  /**
   * Return the full tag dictionary.
   * @returns {{ result: Array<Object> }}
   */
  getTagDictionary: () => ({
    result: tagDictionaryEntries
  }),

  // ---------------------------------------------------------------------------
  // Callback payloads
  // ---------------------------------------------------------------------------

  /**
   * Build a success callback payload for posting back to ServiceNow.
   * @param {string} [ritmNumber='RITM0012345']
   * @param {Object} [details={}]  Additional detail fields.
   * @returns {Object}
   */
  successCallback: (ritmNumber = 'RITM0012345', details = {}) => ({
    result: 'success',
    ritm_number: ritmNumber,
    automation_status: 'Complete',
    message: 'DFW tag automation completed successfully',
    timestamp: '2026-03-21T12:00:00.000Z',
    tags_applied: [
      { scope: 'Region', tag: 'NDCNG' },
      { scope: 'SecurityZone', tag: 'Greenzone' },
      { scope: 'Environment', tag: 'Production' },
      { scope: 'AppCI', tag: 'APP001' },
      { scope: 'SystemRole', tag: 'Web' },
      { scope: 'Compliance', tag: 'PCI' },
      { scope: 'DataClassification', tag: 'Confidential' },
      { scope: 'CostCenter', tag: 'CC-IT-INFRA-001' }
    ],
    groups_verified: [
      'APP001_Web_Production',
      'All-Production-VMs',
      'All-PCI-VMs',
      'All-Confidential-Data-VMs',
      'All-Web-SystemRole-VMs'
    ],
    ...details
  }),

  /**
   * Build a failure callback payload for posting back to ServiceNow.
   * @param {string} [ritmNumber='RITM0012345']
   * @param {string} [errorMessage='An unexpected error occurred']
   * @param {Object} [details={}]  Additional detail fields.
   * @returns {Object}
   */
  failureCallback: (ritmNumber = 'RITM0012345', errorMessage = 'An unexpected error occurred', details = {}) => ({
    result: 'failure',
    ritm_number: ritmNumber,
    automation_status: 'Failed',
    message: errorMessage,
    timestamp: '2026-03-21T12:00:00.000Z',
    retry_eligible: true,
    ...details
  }),

  // ---------------------------------------------------------------------------
  // Factory – build a custom RITM payload
  // ---------------------------------------------------------------------------

  /**
   * Create a custom RITM record by merging overrides into the defaults.
   * @param {Object} overrides  Fields to override on the base RITM.
   * @returns {{ result: Object }}
   */
  createRitmPayload: (overrides = {}) => ({
    result: {
      ...defaultRitmFields,
      ...overrides
    }
  }),

  // ---------------------------------------------------------------------------
  // Error responses
  // ---------------------------------------------------------------------------

  /** 404 – Record not found */
  error404: (sysId = 'abc123def456') => ({
    error: {
      message: `Record not found for sys_id: ${sysId}`,
      detail: 'Could not find record in table sc_req_item'
    },
    status: 'failure'
  }),

  /** 401 – Unauthorized */
  error401: () => ({
    error: {
      message: 'User Not Authenticated',
      detail: 'Required to provide Auth information'
    },
    status: 'failure'
  }),

  /** 403 – Forbidden */
  error403: () => ({
    error: {
      message: 'Insufficient rights to update record',
      detail: 'Security restricted: write access denied'
    },
    status: 'failure'
  }),

  // ---------------------------------------------------------------------------
  // Expose defaults for advanced test scenarios
  // ---------------------------------------------------------------------------
  _defaults: { ...defaultRitmFields },
  _tagDictionary: [...tagDictionaryEntries]
};

module.exports = snowApiMock;
