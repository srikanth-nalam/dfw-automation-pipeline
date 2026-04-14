'use strict';

// ---------------------------------------------------------------------------
// Mock ServiceNow globals before requiring the module.
// vroTrigger.js uses Class.create() + Object.extendsObject and exports via
// module.exports = VROTrigger. The Proxy on Class.create captures the
// prototype so we can build instances with Object.create.
// ---------------------------------------------------------------------------

let mockRestStatusCode = 202;
let mockRestBody = JSON.stringify({ executionId: 'exec-001' });

const mockRestMessage = {
  setEndpoint: jest.fn(),
  setHttpMethod: jest.fn(),
  setRequestHeader: jest.fn(),
  setRequestBody: jest.fn(),
  setHttpTimeout: jest.fn(),
  execute: jest.fn(() => ({
    getStatusCode: jest.fn(() => mockRestStatusCode),
    getBody: jest.fn(() => mockRestBody),
  })),
};

global.sn_ws = {
  RESTMessageV2: jest.fn(() => mockRestMessage),
};

global.GlideDateTime = jest.fn().mockImplementation(() => ({
  getDisplayValue: jest.fn(() => '2025-01-01 00:00:00'),
  getNumericValue: jest.fn(() => '1700000000000'),
}));

global.gs = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getProperty: jest.fn((key) => {
    if (key === 'dfw.vro.endpoint.url') {return 'https://vro.example.com';}
    if (key === 'dfw.vro.auth.token') {return 'mock-token';}
    if (key === 'dfw.snow.callback.url') {return 'https://snow.example.com';}
    return '';
  }),
  sleep: jest.fn(),
  eventQueue: jest.fn(),
};

global.GlideRecord = jest.fn().mockImplementation(() => ({
  addQuery: jest.fn(),
  query: jest.fn(),
  next: jest.fn(() => false),
  getValue: jest.fn(() => ''),
  setValue: jest.fn(),
  update: jest.fn(),
  insert: jest.fn(),
  get: jest.fn(() => true),
  getUniqueValue: jest.fn(() => 'mock-sys-id'),
  getDisplayValue: jest.fn(() => ''),
}));

global.AbstractAjaxProcessor = {};

let capturedPrototype = null;
global.Class = {
  create: jest.fn(() => {
    function Ctor() {}
    return new Proxy(Ctor, {
      set(target, prop, value) {
        if (prop === 'prototype') {
          capturedPrototype = value;
        }
        target[prop] = value;
        return true;
      },
    });
  }),
};

Object.extendsObject = jest.fn((base, proto) => proto);

// Mock CorrelationIdGenerator as a global (the source uses new global.CorrelationIdGenerator())
global.CorrelationIdGenerator = jest.fn().mockImplementation(() => ({
  generate: jest.fn((num) => 'RITM-' + String(num).replace(/^RITM/, '') + '-1700000000000'),
}));

require('../../../src/servicenow/integration/vroTrigger');

function createInstance() {
  return Object.create(capturedPrototype);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRitmGr(overrides = {}) {
  const variables = {
    site: { toString: () => overrides.site || 'NDCNG' },
    vm_name: { toString: () => overrides.vmName || 'vm-test-01' },
    application: { toString: () => overrides.application || 'APP001' },
    tier: { toString: () => overrides.tier || 'Web' },
    environment: { toString: () => overrides.environment || 'Production' },
    compliance: { toString: () => overrides.compliance || 'PCI' },
    data_classification: { toString: () => overrides.dataClassification || 'Confidential' },
    cost_center: { toString: () => overrides.costCenter || 'CC-1001' },
    justification: overrides.justification !== undefined
      ? { toString: () => overrides.justification }
      : null,
    vm_template: { toString: () => overrides.vmTemplate || 'rhel8-base' },
    cluster: { toString: () => overrides.cluster || 'cluster-01' },
    datastore: { toString: () => overrides.datastore || 'ds-01' },
    network: { toString: () => overrides.network || 'net-prod-01' },
    cpu_count: { toString: () => overrides.cpuCount || '4' },
    memory_gb: { toString: () => overrides.memoryGB || '16' },
    disk_gb: { toString: () => overrides.diskGB || '100' },
  };

  return {
    getValue: jest.fn((field) => {
      if (field === 'number') {return overrides.number || 'RITM0010001';}
      if (field === 'opened_by') {return overrides.openedBy || 'user-sys-id';}
      if (field === 'priority') {return overrides.priority || 'standard';}
      if (field === 'approval') {return overrides.approval || '';}
      if (field === 'short_description') {return overrides.shortDescription || 'DFW VM Build';}
      return '';
    }),
    variables,
    cat_item: {
      getDisplayValue: jest.fn(() => overrides.catItemName || 'DFW VM Build Request'),
    },
    opened_by: {
      getDisplayValue: jest.fn(() => 'Test User'),
    },
    approval: {
      getDisplayValue: jest.fn(() => 'Approved'),
    },
    work_notes: '',
    state: '',
    short_description: overrides.shortDescription || 'DFW VM Build',
    update: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VROTrigger', () => {
  let trigger;

  beforeEach(() => {
    trigger = createInstance();
    mockRestStatusCode = 202;
    mockRestBody = JSON.stringify({ executionId: 'exec-001' });
    mockRestMessage.execute.mockImplementation(() => ({
      getStatusCode: jest.fn(() => mockRestStatusCode),
      getBody: jest.fn(() => mockRestBody),
    }));
    jest.clearAllMocks();
  });

  // -- triggerWorkflow ---------------------------------------------------------

  test('triggerWorkflow returns success with executionId on 202', () => {
    const ritmGr = makeRitmGr();
    const result = trigger.triggerWorkflow(ritmGr);
    expect(result.success).toBe(true);
    expect(result.executionId).toBe('exec-001');
    expect(result.correlationId).toMatch(/^RITM-/);
  });

  test('triggerWorkflow retries on failure then succeeds', () => {
    let callCount = 0;
    mockRestMessage.execute.mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        throw new Error('Connection refused');
      }
      return {
        getStatusCode: jest.fn(() => 202),
        getBody: jest.fn(() => JSON.stringify({ executionId: 'exec-retry' })),
      };
    });

    const ritmGr = makeRitmGr();
    const result = trigger.triggerWorkflow(ritmGr);
    expect(result.success).toBe(true);
    expect(result.executionId).toBe('exec-retry');
    expect(gs.sleep).toHaveBeenCalledTimes(2);
  });

  test('triggerWorkflow returns failure after all retries exhausted', () => {
    mockRestMessage.execute.mockImplementation(() => {
      throw new Error('Connection refused');
    });

    const ritmGr = makeRitmGr();
    const result = trigger.triggerWorkflow(ritmGr);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/vRO Unreachable/);
  });

  test('triggerWorkflow updates RITM work notes on success', () => {
    const ritmGr = makeRitmGr();
    trigger.triggerWorkflow(ritmGr);
    expect(ritmGr.update).toHaveBeenCalled();
  });

  test('triggerWorkflow queues event after exhaustion', () => {
    mockRestMessage.execute.mockImplementation(() => {
      throw new Error('Timeout');
    });

    const ritmGr = makeRitmGr();
    trigger.triggerWorkflow(ritmGr);
    expect(gs.eventQueue).toHaveBeenCalledWith(
      'dfw.vro.unreachable',
      expect.anything(),
      expect.stringMatching(/^RITM-/),
      expect.any(String)
    );
  });

  // -- Payload building -------------------------------------------------------

  test('builds payload with correct structure', () => {
    const ritmGr = makeRitmGr();
    trigger.triggerWorkflow(ritmGr);

    expect(mockRestMessage.setRequestBody).toHaveBeenCalled();
    const body = JSON.parse(mockRestMessage.setRequestBody.mock.calls[0][0]);
    expect(body).toHaveProperty('correlationId');
    expect(body).toHaveProperty('requestType');
    expect(body).toHaveProperty('schemaVersion', 'v1');
    expect(body).toHaveProperty('vmName', 'vm-test-01');
    expect(body).toHaveProperty('site', 'NDCNG');
    expect(body).toHaveProperty('tags');
    expect(body.tags).toHaveProperty('Application', 'APP001');
    expect(body.tags).toHaveProperty('Environment', 'Production');
    expect(body).toHaveProperty('callbackUrl');
  });

  test('builds payload with Day 0 VM provisioning fields', () => {
    const ritmGr = makeRitmGr({ catItemName: 'DFW VM Build Request' });
    trigger.triggerWorkflow(ritmGr);

    const body = JSON.parse(mockRestMessage.setRequestBody.mock.calls[0][0]);
    expect(body.requestType).toBe('day0_provision');
    expect(body).toHaveProperty('vmTemplate', 'rhel8-base');
    expect(body).toHaveProperty('cpuCount', 4);
    expect(body).toHaveProperty('memoryGB', 16);
    expect(body).toHaveProperty('diskGB', 100);
  });

  test('Compliance tag is parsed as array', () => {
    const ritmGr = makeRitmGr({ compliance: 'PCI,HIPAA' });
    trigger.triggerWorkflow(ritmGr);

    const body = JSON.parse(mockRestMessage.setRequestBody.mock.calls[0][0]);
    expect(body.tags.Compliance).toEqual(['PCI', 'HIPAA']);
  });

  // -- Request type mapping ---------------------------------------------------

  test('maps Tag Update catalog item to day2_tag_update', () => {
    const ritmGr = makeRitmGr({ catItemName: 'DFW Tag Update Request' });
    trigger.triggerWorkflow(ritmGr);

    const body = JSON.parse(mockRestMessage.setRequestBody.mock.calls[0][0]);
    expect(body.requestType).toBe('day2_tag_update');
  });

  test('maps Decommission catalog item to day_n_decommission', () => {
    const ritmGr = makeRitmGr({ catItemName: 'DFW Decommission Request' });
    trigger.triggerWorkflow(ritmGr);

    const body = JSON.parse(mockRestMessage.setRequestBody.mock.calls[0][0]);
    expect(body.requestType).toBe('day_n_decommission');
  });

  test('maps Bulk catalog item to bulk_tag', () => {
    const ritmGr = makeRitmGr({ catItemName: 'DFW Bulk Operation' });
    trigger.triggerWorkflow(ritmGr);

    const body = JSON.parse(mockRestMessage.setRequestBody.mock.calls[0][0]);
    expect(body.requestType).toBe('bulk_tag');
  });

  test('defaults to day0_provision for unknown catalog items', () => {
    const ritmGr = makeRitmGr({ catItemName: 'Unknown Request' });
    trigger.triggerWorkflow(ritmGr);

    const body = JSON.parse(mockRestMessage.setRequestBody.mock.calls[0][0]);
    expect(body.requestType).toBe('day0_provision');
  });
});
