/**
 * @fileoverview ServiceNow Integration - vRO Trigger
 * Builds and sends REST payload to vRO. Generates correlationId.
 * Handles 3 retries if vRO unreachable.
 * Sets RITM to "Failed - vRO Unreachable" after exhaustion.
 */

const VROTrigger = Class.create();
VROTrigger.prototype = Object.extendsObject(AbstractAjaxProcessor, {

  /**
   * Triggers vRO DFW lifecycle workflow from an RITM record
   * @param {GlideRecord} ritmGr - The RITM GlideRecord
   * @returns {object} Result with executionId or error
   */
  triggerWorkflow: function(ritmGr) {
    const correlationId = new global.CorrelationIdGenerator().generate(ritmGr.getValue('number'));
    const payload = this._buildPayload(ritmGr, correlationId);

    const maxRetries = 3;
    const retryIntervals = [5000, 15000, 45000];
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = this._sendToVRO(payload);
        if (response.getStatusCode() === 202) {
          this._updateRITMWorkNotes(ritmGr, 'vRO workflow triggered successfully. Correlation ID: ' + correlationId);
          return {
            success: true,
            executionId: JSON.parse(response.getBody()).executionId,
            correlationId: correlationId
          };
        }
        lastError = 'HTTP ' + response.getStatusCode() + ': ' + response.getBody();
      } catch (e) {
        lastError = e.getMessage ? e.getMessage() : String(e);
      }

      if (attempt < maxRetries) {
        this._updateRITMWorkNotes(ritmGr, 'vRO trigger attempt ' + (attempt + 1) + ' failed: ' + lastError + '. Retrying in ' + (retryIntervals[attempt] / 1000) + 's...');
        gs.sleep(retryIntervals[attempt]);
      }
    }

    // All retries exhausted
    this._handleExhaustion(ritmGr, correlationId, lastError);
    return {
      success: false,
      correlationId: correlationId,
      error: 'vRO Unreachable after ' + maxRetries + ' retries: ' + lastError
    };
  },

  /**
   * Builds the structured REST payload from RITM record
   * @private
   */
  _buildPayload: function(ritmGr, correlationId) {
    const requestType = this._determineRequestType(ritmGr);
    const site = ritmGr.variables.site.toString();

    const payload = {
      correlationId: correlationId,
      requestType: requestType,
      schemaVersion: 'v1',
      vmName: ritmGr.variables.vm_name.toString(),
      site: site,
      tags: {
        Application: ritmGr.variables.application.toString(),
        Tier: ritmGr.variables.tier.toString(),
        Environment: ritmGr.variables.environment.toString(),
        Compliance: this._parseMultiValue(ritmGr.variables.compliance.toString()),
        DataClassification: ritmGr.variables.data_classification.toString(),
        CostCenter: ritmGr.variables.cost_center.toString()
      },
      requestedBy: ritmGr.getValue('opened_by'),
      requestedByDisplayName: ritmGr.opened_by.getDisplayValue(),
      callbackUrl: gs.getProperty('dfw.snow.callback.url') + '/api/now/v1/dfw/callback',
      callbackToken: '{{vault:secret/snow-api-token}}',
      priority: ritmGr.getValue('priority') || 'standard',
      justification: ritmGr.variables.justification ? ritmGr.variables.justification.toString() : ''
    };

    // Add VM provisioning fields for Day 0
    if (requestType === 'day0_provision') {
      payload.vmTemplate = ritmGr.variables.vm_template.toString();
      payload.cluster = ritmGr.variables.cluster.toString();
      payload.datastore = ritmGr.variables.datastore.toString();
      payload.network = ritmGr.variables.network.toString();
      payload.cpuCount = parseInt(ritmGr.variables.cpu_count.toString(), 10);
      payload.memoryGB = parseInt(ritmGr.variables.memory_gb.toString(), 10);
      payload.diskGB = parseInt(ritmGr.variables.disk_gb.toString(), 10);
    }

    // Add approval info
    if (ritmGr.getValue('approval')) {
      payload.approvedBy = ritmGr.approval.getDisplayValue();
      payload.approvalTimestamp = new GlideDateTime().getDisplayValue();
    }

    return payload;
  },

  _determineRequestType: function(ritmGr) {
    const catItemName = ritmGr.cat_item.getDisplayValue();
    if (catItemName.indexOf('Build') > -1) { return 'day0_provision'; }
    if (catItemName.indexOf('Tag Update') > -1) { return 'day2_tag_update'; }
    if (catItemName.indexOf('Decommission') > -1) { return 'day_n_decommission'; }
    if (catItemName.indexOf('Bulk') > -1) { return 'bulk_tag'; }
    if (catItemName.indexOf('Legacy') > -1) { return 'legacy_onboard'; }
    return 'day0_provision';
  },

  _parseMultiValue: function(value) {
    if (!value) { return ['None']; }
    return value.split(',').map(function(v) { return v.trim(); });
  },

  _sendToVRO: function(payload) {
    const restMessage = new sn_ws.RESTMessageV2();
    restMessage.setEndpoint(gs.getProperty('dfw.vro.endpoint.url') + '/api/vro/v1/workflows/dfw-lifecycle/trigger');
    restMessage.setHttpMethod('POST');
    restMessage.setRequestHeader('Content-Type', 'application/json');
    restMessage.setRequestHeader('X-Correlation-ID', payload.correlationId);
    restMessage.setRequestHeader('Authorization', 'Bearer ' + gs.getProperty('dfw.vro.auth.token'));
    restMessage.setRequestBody(JSON.stringify(payload));
    restMessage.setHttpTimeout(30000);
    return restMessage.execute();
  },

  _updateRITMWorkNotes: function(ritmGr, note) {
    ritmGr.work_notes = note;
    ritmGr.update();
  },

  _handleExhaustion: function(ritmGr, correlationId, lastError) {
    ritmGr.state = 4; // Failed
    ritmGr.work_notes = '[DFW Automation] FAILED - vRO Unreachable after 3 retries.\n' +
      'Correlation ID: ' + correlationId + '\n' +
      'Last Error: ' + lastError + '\n' +
      'Action Required: Operations team to verify vRO availability and reprocess.';
    ritmGr.short_description = ritmGr.getValue('short_description') + ' [Failed - vRO Unreachable]';
    ritmGr.update();

    // Notify Operations Lead
    gs.eventQueue('dfw.vro.unreachable', ritmGr, correlationId, lastError);
  },

  type: 'VROTrigger'
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VROTrigger;
}
