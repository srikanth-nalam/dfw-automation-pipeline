/**
 * NSX Manager API Mock Responses
 *
 * Provides mock responses for NSX-T Manager REST API endpoints used
 * in DFW automation workflows (tag management, group membership,
 * effective firewall rules).
 */

const nsxApiMock = {
  // ---------------------------------------------------------------------------
  // GET /api/v1/fabric/virtual-machines/{vmId}/tags
  // ---------------------------------------------------------------------------
  getVmTags: (vmId) => ({
    results: [
      { tag: 'APP001', scope: 'Application' },
      { tag: 'Web', scope: 'Tier' },
      { tag: 'Production', scope: 'Environment' },
      { tag: 'PCI', scope: 'Compliance' },
      { tag: 'Confidential', scope: 'DataClassification' },
      { tag: 'CC-IT-INFRA-001', scope: 'CostCenter' }
    ]
  }),

  // ---------------------------------------------------------------------------
  // PATCH /api/v1/fabric/virtual-machines/{vmId}/tags
  // ---------------------------------------------------------------------------
  updateVmTags: (vmId, tags) => ({
    status: 200,
    message: 'Tags updated successfully'
  }),

  // ---------------------------------------------------------------------------
  // GET /api/v1/fabric/virtual-machines/{vmId}/groups
  // ---------------------------------------------------------------------------
  getVmGroups: (vmId) => ({
    results: [
      { display_name: 'APP001_Web_Production', id: 'group-1' },
      { display_name: 'All-Production-VMs', id: 'group-2' },
      { display_name: 'All-PCI-VMs', id: 'group-3' },
      { display_name: 'All-Confidential-Data-VMs', id: 'group-4' },
      { display_name: 'All-Web-Tier-VMs', id: 'group-5' }
    ]
  }),

  // ---------------------------------------------------------------------------
  // GET effective firewall rules for a VM
  // ---------------------------------------------------------------------------
  getEffectiveRules: (vmId) => ({
    results: [
      {
        id: 'rule-1',
        display_name: 'APP001-Web-Allow-HTTPS-Inbound',
        action: 'ALLOW',
        source_groups: ['Load-Balancer-Pools'],
        destination_groups: ['APP001_Web_Production'],
        services: ['TCP/443', 'TCP/80'],
        logged: false
      },
      {
        id: 'rule-2',
        display_name: 'Allow-DNS-UDP',
        action: 'ALLOW',
        source_groups: ['ANY'],
        destination_groups: ['Shared-Services-DNS-Servers'],
        services: ['UDP/53'],
        logged: false
      }
    ]
  }),

  // ---------------------------------------------------------------------------
  // Empty / default responses
  // ---------------------------------------------------------------------------

  /** Empty tags response for a brand-new VM with no tags applied yet. */
  getEmptyTags: () => ({ results: [] }),

  /** Empty groups response for a VM that has not been placed in any group. */
  getEmptyGroups: () => ({ results: [] }),

  // ---------------------------------------------------------------------------
  // Error responses
  // ---------------------------------------------------------------------------
  error503: () => {
    const err = new Error('Service Unavailable');
    err.status = 503;
    throw err;
  },
  error401: () => {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  },
  error404: () => {
    const err = new Error('Not Found');
    err.status = 404;
    throw err;
  },

  // ---------------------------------------------------------------------------
  // Factories
  // ---------------------------------------------------------------------------

  /**
   * Create a custom tags response with the supplied tag/scope pairs.
   * @param {Array<{tag: string, scope: string}>} tags
   * @returns {{ results: Array<{tag: string, scope: string}> }}
   */
  createTagsResponse: (tags) => ({ results: tags }),

  /**
   * Create a custom groups response.
   * @param {Array<{display_name: string, id: string}>} groups
   * @returns {{ results: Array<{display_name: string, id: string}> }}
   */
  createGroupsResponse: (groups) => ({ results: groups }),

  /**
   * Create a custom effective-rules response.
   * @param {Array<Object>} rules
   * @returns {{ results: Array<Object> }}
   */
  createEffectiveRulesResponse: (rules) => ({ results: rules }),

  /**
   * Create a custom error with the given status and message.
   * @param {number} status
   * @param {string} message
   */
  createError: (status, message) => {
    const err = new Error(message);
    err.status = status;
    throw err;
  }
};

module.exports = nsxApiMock;
