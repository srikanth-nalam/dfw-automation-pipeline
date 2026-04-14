/**
 * vCenter VAPI Mock Responses
 *
 * Provides mock responses for VMware vCenter REST / VAPI endpoints used
 * in DFW automation workflows (VM lifecycle, power state, tools status,
 * tag assignment).
 */

const vcenterApiMock = {
  // ---------------------------------------------------------------------------
  // VM lifecycle
  // ---------------------------------------------------------------------------

  /**
   * POST /rest/vcenter/vm – Create a virtual machine.
   * @param {string} [name='NDCNG-APP001-WEB-P01']
   * @returns {{ value: { vm: string, name: string } }}
   */
  createVm: (name = 'NDCNG-APP001-WEB-P01') => ({
    value: {
      vm: 'vm-123',
      name
    }
  }),

  /**
   * DELETE /rest/vcenter/vm/{vm} – Delete a virtual machine.
   * @param {string} vmId
   * @returns {{ value: null, status: 200, message: string }}
   */
  deleteVm: (vmId = 'vm-123') => ({
    value: null,
    status: 200,
    message: `VM ${vmId} deleted successfully`
  }),

  // ---------------------------------------------------------------------------
  // Power & tools
  // ---------------------------------------------------------------------------

  /**
   * GET /rest/vcenter/vm/{vm}/power – Retrieve VM power state.
   * @param {string} [state='POWERED_ON']
   * @returns {{ value: { state: string } }}
   */
  getVmPowerState: (state = 'POWERED_ON') => ({
    value: { state }
  }),

  /**
   * GET /rest/vcenter/vm/{vm}/tools – Retrieve VMware Tools status.
   * @param {string} [runState='RUNNING']
   * @returns {{ value: { run_state: string, version: string, version_number: number } }}
   */
  getVmToolsStatus: (runState = 'RUNNING') => ({
    value: {
      run_state: runState,
      version: '12352',
      version_number: 12352
    }
  }),

  // ---------------------------------------------------------------------------
  // Tag operations
  // ---------------------------------------------------------------------------

  /**
   * POST /rest/com/vmware/cis/tagging/tag-association – Assign tag to object.
   * @param {string} tagId
   * @param {string} objectId
   * @returns {{ status: 200, message: string }}
   */
  assignTag: (tagId = 'tag-1', objectId = 'vm-123') => ({
    status: 200,
    message: `Tag ${tagId} assigned to ${objectId} successfully`
  }),

  /**
   * POST /rest/com/vmware/cis/tagging/tag-association?~action=list-attached-tags
   * Returns category:tag pairs attached to a VM.
   * @param {string} [objectId='vm-123']
   * @returns {{ value: Array<{ category: string, tag: string }> }}
   */
  listAttachedTags: (objectId = 'vm-123') => ({
    value: [
      { category: 'Region', tag: 'NDCNG' },
      { category: 'SecurityZone', tag: 'Greenzone' },
      { category: 'Environment', tag: 'Production' },
      { category: 'AppCI', tag: 'APP001' },
      { category: 'SystemRole', tag: 'Web' },
      { category: 'Compliance', tag: 'PCI' },
      { category: 'DataClassification', tag: 'Confidential' },
      { category: 'CostCenter', tag: 'CC-IT-INFRA-001' }
    ]
  }),

  // ---------------------------------------------------------------------------
  // Lookup
  // ---------------------------------------------------------------------------

  /**
   * POST /rest/vcenter/vm?filter.names={name} – Locate a VM by display name.
   * @param {string} name
   * @returns {{ value: Array<{ vm: string, name: string, power_state: string }> }}
   */
  getVmByName: (name = 'NDCNG-APP001-WEB-P01') => ({
    value: [
      {
        vm: 'vm-123',
        name,
        power_state: 'POWERED_ON'
      }
    ]
  }),

  // ---------------------------------------------------------------------------
  // Error factories
  // ---------------------------------------------------------------------------

  /**
   * Factory: create a vCenter-style error response.
   * @param {number} status  HTTP status code
   * @param {string} errorType  e.g. 'ALREADY_EXISTS', 'NOT_FOUND'
   * @param {string} message  Human-readable description
   */
  createErrorResponse: (status, errorType, message) => ({
    type: errorType,
    value: {
      messages: [
        {
          id: `com.vmware.vapi.std.errors.${errorType.toLowerCase()}`,
          default_message: message,
          args: []
        }
      ]
    },
    status,
    message
  }),

  /** 404 – VM not found */
  error404: (vmId = 'vm-999') =>
    vcenterApiMock.createErrorResponse(404, 'NOT_FOUND', `VM ${vmId} not found`),

  /** 401 – Unauthorized */
  error401: () =>
    vcenterApiMock.createErrorResponse(401, 'UNAUTHENTICATED', 'Authentication required'),

  /** 503 – Service unavailable */
  error503: () =>
    vcenterApiMock.createErrorResponse(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable'),

  /** 409 – Already exists */
  error409: (name = 'NDCNG-APP001-WEB-P01') =>
    vcenterApiMock.createErrorResponse(409, 'ALREADY_EXISTS', `VM with name ${name} already exists`),

  // ---------------------------------------------------------------------------
  // Convenience factories
  // ---------------------------------------------------------------------------

  /**
   * Build a full VM record suitable for detailed GET /rest/vcenter/vm/{vm}.
   * @param {Object} overrides  Fields to override on the default record.
   * @returns {{ value: Object }}
   */
  createVmDetail: (overrides = {}) => ({
    value: {
      vm: 'vm-123',
      name: 'NDCNG-APP001-WEB-P01',
      power_state: 'POWERED_ON',
      cpu: { count: 2, cores_per_socket: 1 },
      memory: { size_MiB: 4096 },
      guest_OS: 'RHEL_8_64',
      ...overrides
    }
  })
};

module.exports = vcenterApiMock;
