/**
 * @file PhantomVMDetector.js
 * @description Cross-references NSX fabric VM inventory against vCenter VM inventory
 *   to find "phantom" VMs — records in NSX for VMs that no longer exist in vCenter.
 *
 * Error codes:
 *   - DFW-9100  PhantomVMDetector general error
 *   - DFW-9101  NSX inventory fetch failed
 *   - DFW-9102  vCenter inventory fetch failed
 *
 * @module lifecycle/PhantomVMDetector
 */

'use strict';

/**
 * @class PhantomVMDetector
 * @classdesc Detects phantom VMs by comparing NSX fabric inventory with vCenter.
 *
 * @example
 * const detector = new PhantomVMDetector(dependencies);
 * const report = await detector.detect('NDCNG', { includeTagDetails: true });
 */
class PhantomVMDetector {
  /**
   * Creates a new PhantomVMDetector.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.restClient - HTTP client.
   * @param {Object} dependencies.logger - Structured logger.
   * @param {Object} dependencies.configLoader - Configuration loader.
   * @param {Object} dependencies.tagOperations - Tag management operations.
   *
   * @throws {Error} DFW-9100 when required dependencies are missing.
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-9100] PhantomVMDetector requires dependencies');
    }

    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;
    /** @private */
    this.configLoader = dependencies.configLoader;
    /** @private */
    this.tagOperations = dependencies.tagOperations;
  }

  /**
   * Detects phantom VMs at a site by cross-referencing NSX and vCenter.
   *
   * @async
   * @param {string} site - Site code (NDCNG or TULNG).
   * @param {Object} [options={}] - Detection options.
   * @param {boolean} [options.includeTagDetails=true] - Include tag details for phantoms.
   * @param {boolean} [options.cleanupTags=false] - Remove tags from phantom VMs.
   * @returns {Promise<Object>} Detection report.
   *
   * @throws {Error} DFW-9100 on general failure.
   */
  async detect(site, options = {}) {
    const includeTagDetails = options.includeTagDetails !== false;
    const cleanupTags = options.cleanupTags === true;

    this.logger.info('Starting phantom VM detection', {
      site,
      includeTagDetails,
      cleanupTags,
      component: 'PhantomVMDetector'
    });

    try {
      const endpoints = this.configLoader.getEndpointsForSite(site);

      // Step 1: Get all VMs from NSX fabric
      const nsxVMs = await this._getNsxVMInventory(site, endpoints);

      // Step 2: Get all VMs from vCenter
      const vcenterVMs = await this._getVcenterVMInventory(site, endpoints);

      // Step 3: Build sets of VM external IDs
      const vcenterVMIds = new Set(vcenterVMs.map(vm => vm.vm || vm.vmId || vm.id));

      // Step 4: Phantom VMs = NSX set - vCenter set
      const phantomVMs = [];
      let cleanedUp = 0;

      for (const nsxVM of nsxVMs) {
        const vmId = nsxVM.external_id || nsxVM.vm || nsxVM.id;

        if (!vcenterVMIds.has(vmId)) {
          const phantomEntry = {
            vmId,
            displayName: nsxVM.display_name || nsxVM.name || vmId,
            lastSeen: nsxVM._last_modified_time || null
          };

          // Step 5: Get tag details
          if (includeTagDetails) {
            try {
              const details = await this._getPhantomVMDetails(vmId, site);
              phantomEntry.tags = details.tags || {};
              phantomEntry.groups = details.groups || [];
            } catch (detailErr) {
              this.logger.warn('Failed to get phantom VM details', {
                vmId,
                errorMessage: detailErr.message,
                component: 'PhantomVMDetector'
              });
              phantomEntry.tags = {};
              phantomEntry.groups = [];
            }
          }

          // Step 6: Cleanup tags if requested
          if (cleanupTags) {
            try {
              await this._cleanupPhantomVM(vmId, site);
              cleanedUp += 1;
            } catch (cleanupErr) {
              this.logger.warn('Failed to cleanup phantom VM tags', {
                vmId,
                errorMessage: cleanupErr.message,
                component: 'PhantomVMDetector'
              });
            }
          }

          phantomVMs.push(phantomEntry);
        }
      }

      const result = {
        site,
        timestamp: new Date().toISOString(),
        nsxVMCount: nsxVMs.length,
        vcenterVMCount: vcenterVMs.length,
        phantomVMCount: phantomVMs.length,
        phantomVMs,
        cleanedUp
      };

      this.logger.info('Phantom VM detection completed', {
        site,
        nsxVMCount: nsxVMs.length,
        vcenterVMCount: vcenterVMs.length,
        phantomVMCount: phantomVMs.length,
        cleanedUp,
        component: 'PhantomVMDetector'
      });

      return result;
    } catch (err) {
      this.logger.error('Phantom VM detection failed', {
        site,
        errorMessage: err.message,
        component: 'PhantomVMDetector'
      });
      throw new Error(`[DFW-9100] PhantomVMDetector detection failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns all VMs from NSX fabric inventory.
   *
   * @private
   * @async
   * @param {string} site - Site code.
   * @param {Object} endpoints - Resolved endpoints.
   * @returns {Promise<Array>} NSX VM list.
   */
  async _getNsxVMInventory(site, endpoints) {
    try {
      const url = `${endpoints.nsxUrl}/api/v1/fabric/virtual-machines`;
      const response = await this.restClient.get(url);
      const body = response.body || response;
      return body.results || body || [];
    } catch (err) {
      throw new Error(`[DFW-9101] NSX inventory fetch failed: ${err.message}`);
    }
  }

  /**
   * Returns all VMs from vCenter inventory.
   *
   * @private
   * @async
   * @param {string} site - Site code.
   * @param {Object} endpoints - Resolved endpoints.
   * @returns {Promise<Array>} vCenter VM list.
   */
  async _getVcenterVMInventory(site, endpoints) {
    try {
      const url = `${endpoints.vcenterUrl}/api/vcenter/vm`;
      const response = await this.restClient.get(url);
      if (Array.isArray(response)) { return response; }
      if (response && Array.isArray(response.value)) { return response.value; }
      const body = response.body || response;
      return body.results || body || [];
    } catch (err) {
      throw new Error(`[DFW-9102] vCenter inventory fetch failed: ${err.message}`);
    }
  }

  /**
   * Gets tags and group details for a phantom VM.
   *
   * @private
   * @async
   * @param {string} vmId - VM identifier.
   * @param {string} site - Site code.
   * @returns {Promise<{tags: Object, groups: Array}>} Tag and group details.
   */
  async _getPhantomVMDetails(vmId, site) {
    const tags = await this.tagOperations.getCurrentTags(vmId, site);
    return { tags: tags || {}, groups: [] };
  }

  /**
   * Removes tags from a phantom VM record.
   *
   * @private
   * @async
   * @param {string} vmId - VM identifier.
   * @param {string} site - Site code.
   * @returns {Promise<void>}
   */
  async _cleanupPhantomVM(vmId, site) {
    this.logger.info('Cleaning up phantom VM tags', {
      vmId,
      site,
      component: 'PhantomVMDetector'
    });

    const currentTags = await this.tagOperations.getCurrentTags(vmId, site);
    if (currentTags && Object.keys(currentTags).length > 0) {
      await this.tagOperations.removeTags(vmId, Object.keys(currentTags), site);
    }
  }
}

module.exports = PhantomVMDetector;
