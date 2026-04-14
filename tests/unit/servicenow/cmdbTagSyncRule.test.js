'use strict';

// Set up minimal globals so the IIFE can execute without ReferenceError
// when the module is first required for its exported constants.
global.current = { getValue: jest.fn(() => ''), getUniqueValue: jest.fn(() => '') };
global.previous = { getValue: jest.fn(() => '') };
global.GlideRecord = jest.fn().mockImplementation(() => ({
  addQuery: jest.fn(), setLimit: jest.fn(), query: jest.fn(), get: jest.fn(() => false),
  hasNext: jest.fn(() => false), next: jest.fn(() => false), getValue: jest.fn(() => ''),
  initialize: jest.fn(), setValue: jest.fn(), insert: jest.fn(), update: jest.fn(),
  setWorkflow: jest.fn(),
}));
global.gs = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  getUserName: jest.fn(() => ''), nowDateTime: jest.fn(() => ''),
  getProperty: jest.fn(() => ''), eventQueue: jest.fn(),
};
global.sn_ws = { RESTMessageV2: jest.fn(() => ({
  setEndpoint: jest.fn(), setHttpMethod: jest.fn(), setRequestHeader: jest.fn(),
  setRequestBody: jest.fn(), setHttpTimeout: jest.fn(),
  execute: jest.fn(() => ({ getStatusCode: jest.fn(() => 200), getBody: jest.fn(() => '{}') })),
})) };

describe('cmdbTagSyncRule', () => {
  // ---------------------------------------------------------------------------
  // Exported constants
  // ---------------------------------------------------------------------------

  const mod = require('../../../src/servicenow/business-rules/cmdbTagSyncRule');

  describe('MONITORED_FIELDS', () => {
    test('contains 5 tag fields', () => {
      expect(mod.MONITORED_FIELDS).toHaveLength(5);
    });

    test('contains expected tag categories', () => {
      const categories = mod.MONITORED_FIELDS.map((f) => f.tagCategory);
      expect(categories).toEqual(
        expect.arrayContaining(['Region', 'SecurityZone', 'Environment', 'AppCI', 'SystemRole'])
      );
    });

    test('maps to expected CMDB fields', () => {
      const cmdbFields = mod.MONITORED_FIELDS.map((f) => f.cmdbField);
      expect(cmdbFields).toEqual(
        expect.arrayContaining([
          'u_region', 'u_security_zone', 'u_environment', 'u_app_ci', 'u_system_role',
        ])
      );
    });
  });

  test('exports DAY2_WORKFLOW_PATH', () => {
    expect(mod.DAY2_WORKFLOW_PATH).toBe('/api/vro/v1/workflows/dfw-day2-tag-sync/trigger');
  });

  test('REST_TIMEOUT_MS is defined', () => {
    expect(mod.REST_TIMEOUT_MS).toBe(30000);
  });

  // ---------------------------------------------------------------------------
  // IIFE behavioral tests
  // ---------------------------------------------------------------------------

  function buildMocks({ currentFields = {}, previousFields = {}, changeApproved = true } = {}) {
    const current = {
      getValue: jest.fn((field) => currentFields[field] || ''),
      getUniqueValue: jest.fn(() => 'ci-sys-id-001'),
    };
    const previous = {
      getValue: jest.fn((field) => previousFields[field] || ''),
    };

    const restResponse = {
      getStatusCode: jest.fn(() => 202),
      getBody: jest.fn(() => JSON.stringify({ executionId: 'exec-001' })),
    };

    const restMessage = {
      setEndpoint: jest.fn(),
      setHttpMethod: jest.fn(),
      setRequestHeader: jest.fn(),
      setRequestBody: jest.fn(),
      setHttpTimeout: jest.fn(),
      execute: jest.fn(() => restResponse),
    };

    const auditRecord = {
      initialize: jest.fn(),
      setValue: jest.fn(),
      insert: jest.fn(() => 'audit-sys-id'),
    };

    const ciRecord = {
      get: jest.fn(() => true),
      setValue: jest.fn(),
      setWorkflow: jest.fn(),
      update: jest.fn(),
    };

    const changeRequestRecord = {
      get: jest.fn(() => changeApproved),
      getValue: jest.fn((field) => {
        if (field === 'approval') {return 'approved';}
        if (field === 'number') {return 'CHG0010001';}
        return '';
      }),
    };

    const GlideRecord = jest.fn((table) => {
      if (table === 'u_dfw_audit_log') {return auditRecord;}
      if (table === 'cmdb_ci_vm_instance') {return ciRecord;}
      if (table === 'change_request') {return changeRequestRecord;}
      return auditRecord;
    });

    const gs = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      getUserName: jest.fn(() => 'admin'),
      nowDateTime: jest.fn(() => '2025-01-01 00:00:00'),
      getProperty: jest.fn((key) => {
        if (key === 'dfw.vro.endpoint.url') {return 'https://vro.example.com';}
        if (key === 'dfw.vro.auth.token') {return 'mock-token';}
        if (key === 'dfw.snow.callback.url') {return 'https://snow.example.com';}
        if (key === 'dfw.cmdb.allow_direct_edits') {return 'true';}
        return '';
      }),
      eventQueue: jest.fn(),
    };

    const sn_ws = {
      RESTMessageV2: jest.fn(() => restMessage),
    };

    return { current, previous, GlideRecord, gs, sn_ws, restMessage };
  }

  function runRule(opts = {}) {
    const mocks = buildMocks(opts);

    jest.isolateModules(() => {
      global.GlideRecord = mocks.GlideRecord;
      global.gs = mocks.gs;
      global.current = mocks.current;
      global.previous = mocks.previous;
      global.sn_ws = mocks.sn_ws;

      require('../../../src/servicenow/business-rules/cmdbTagSyncRule');
    });

    delete global.GlideRecord;
    delete global.gs;
    delete global.current;
    delete global.previous;
    delete global.sn_ws;

    return mocks;
  }

  test('detectChangedFields when region changes', () => {
    const mocks = runRule({
      currentFields: { u_region: 'TULNG', u_security_zone: 'DMZ', u_environment: 'Production', u_app_ci: 'APP1', u_system_role: 'Web', name: 'vm-01', u_change_request: '' },
      previousFields: { u_region: 'NDCNG', u_security_zone: 'DMZ', u_environment: 'Production', u_app_ci: 'APP1', u_system_role: 'Web' },
    });
    // When region changes, the rule should detect the change and log it
    expect(mocks.gs.info).toHaveBeenCalled();
    const infoCall = mocks.gs.info.mock.calls[0][0];
    expect(infoCall).toMatch(/Region/);
  });

  test('builds correct sync payload structure', () => {
    const mocks = runRule({
      currentFields: { u_region: 'TULNG', u_security_zone: 'DMZ', u_environment: 'Production', u_app_ci: 'APP1', u_system_role: 'Web', name: 'vm-01', object_id: 'vm-123', u_site: 'TULNG', u_change_request: '' },
      previousFields: { u_region: 'NDCNG', u_security_zone: 'DMZ', u_environment: 'Production', u_app_ci: 'APP1', u_system_role: 'Web' },
    });
    // The REST message should have been called with a JSON body containing payload fields
    expect(mocks.restMessage.setRequestBody).toHaveBeenCalled();
    const body = JSON.parse(mocks.restMessage.setRequestBody.mock.calls[0][0]);
    expect(body).toHaveProperty('correlationId');
    expect(body).toHaveProperty('requestType', 'day2_tag_update');
    expect(body).toHaveProperty('changedTags');
    expect(body).toHaveProperty('previousTags');
    expect(body).toHaveProperty('currentTags');
    expect(body.changedTags).toHaveProperty('Region', 'TULNG');
    expect(body.previousTags).toHaveProperty('Region', 'NDCNG');
  });

  test('does not trigger on non-tag field changes', () => {
    const mocks = runRule({
      currentFields: { u_region: 'NDCNG', u_security_zone: 'DMZ', u_environment: 'Production', u_app_ci: 'APP1', u_system_role: 'Web', name: 'vm-01-updated' },
      previousFields: { u_region: 'NDCNG', u_security_zone: 'DMZ', u_environment: 'Production', u_app_ci: 'APP1', u_system_role: 'Web', name: 'vm-01' },
    });
    // No tag-relevant fields changed so info log about change detected should not fire
    expect(mocks.gs.info).not.toHaveBeenCalled();
  });

  test('handles CI record without VM UUID', () => {
    const mocks = runRule({
      currentFields: { u_region: 'TULNG', u_security_zone: 'DMZ', u_environment: 'Production', u_app_ci: 'APP1', u_system_role: 'Web', name: 'vm-01', object_id: '', u_site: '', u_change_request: '' },
      previousFields: { u_region: 'NDCNG', u_security_zone: 'DMZ', u_environment: 'Production', u_app_ci: 'APP1', u_system_role: 'Web' },
    });
    // Should still proceed with the unique value fallback
    expect(mocks.restMessage.setRequestBody).toHaveBeenCalled();
    const body = JSON.parse(mocks.restMessage.setRequestBody.mock.calls[0][0]);
    expect(body.vmId).toBe('ci-sys-id-001');
  });

  test('logs correlation ID', () => {
    const mocks = runRule({
      currentFields: { u_region: 'TULNG', u_security_zone: 'DMZ', u_environment: 'Production', u_app_ci: 'APP1', u_system_role: 'Web', name: 'vm-01', u_change_request: '' },
      previousFields: { u_region: 'NDCNG', u_security_zone: 'DMZ', u_environment: 'Production', u_app_ci: 'APP1', u_system_role: 'Web' },
    });
    // The success info log should contain a correlation ID
    const successLog = mocks.gs.info.mock.calls.find((c) => c[0].includes('Correlation ID'));
    expect(successLog).toBeDefined();
  });
});
