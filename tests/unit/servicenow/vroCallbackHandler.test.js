'use strict';

// ---------------------------------------------------------------------------
// Mock ServiceNow globals before requiring the module.
// vroCallbackHandler.js uses Class.create(), assigns .prototype, and exports
// via module.exports = VROCallbackHandler. We use the Proxy approach to
// capture the prototype set by the module.
// ---------------------------------------------------------------------------

let capturedPrototype = null;
let mockGrRows = [];
let mockGrRowIndex = -1;
const mockGrInsertId = 'inc-sys-id-001';

const makeMockGr = () => {
  mockGrRowIndex = -1;
  return {
    addQuery: jest.fn(),
    setLimit: jest.fn(),
    orderBy: jest.fn(),
    orderByDesc: jest.fn(),
    query: jest.fn(),
    initialize: jest.fn(),
    hasNext: jest.fn(() => mockGrRowIndex + 1 < mockGrRows.length),
    next: jest.fn(() => {
      mockGrRowIndex++;
      return mockGrRowIndex < mockGrRows.length;
    }),
    get: jest.fn(() => mockGrRows.length > 0),
    getValue: jest.fn((field) => {
      if (mockGrRowIndex >= 0 && mockGrRowIndex < mockGrRows.length) {
        return mockGrRows[mockGrRowIndex][field] !== undefined
          ? mockGrRows[mockGrRowIndex][field]
          : '';
      }
      return '';
    }),
    setValue: jest.fn(),
    insert: jest.fn(() => mockGrInsertId),
    update: jest.fn(),
    getUniqueValue: jest.fn(() => 'mock-sys-id'),
    work_notes: '',
  };
};

global.GlideRecord = jest.fn().mockImplementation(() => makeMockGr());

global.GlideDateTime = jest.fn().mockImplementation(() => ({
  getDisplayValue: jest.fn(() => '2025-01-01 00:00:00'),
  getNumericValue: jest.fn(() => '1700000000000'),
}));

global.gs = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getProperty: jest.fn(() => 'DFW Automation Support'),
};

global.CorrelationIdGenerator = jest.fn().mockImplementation(() => ({
  validate: jest.fn(() => ({ valid: true, reason: '' })),
  parse: jest.fn(() => ({ prefix: 'RITM', ritmNumber: '0010001', timestamp: 1679500000000 })),
}));

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

require('../../../src/servicenow/integration/vroCallbackHandler');

function createInstance() {
  const instance = Object.create(capturedPrototype);
  if (typeof instance.initialize === 'function') {
    instance.initialize();
  }
  return instance;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body) {
  return {
    body: {
      data: body,
      dataString: JSON.stringify(body),
    },
  };
}

function makeResponse() {
  return {
    setStatus: jest.fn(),
  };
}

function successPayload(overrides = {}) {
  return {
    correlationId: 'RITM-0010001-1679500000000',
    status: 'SUCCESS',
    requestType: 'day0_provision',
    executionId: 'exec-001',
    timestamp: '2025-01-01T00:00:00Z',
    result: {
      vmDetails: { name: 'vm-test-01', moRef: 'vm-123', ipAddress: '10.0.0.1', site: 'NDCNG' },
      appliedTags: { Region: 'NDCNG', Environment: 'Production' },
      groupMemberships: ['SG-Web-Production'],
      activeDFWPolicies: ['DFW-Allow-Web-To-App'],
    },
    ...overrides,
  };
}

function failurePayload(overrides = {}) {
  return {
    correlationId: 'RITM-0010001-1679500000000',
    status: 'FAILURE',
    requestType: 'day0_provision',
    timestamp: '2025-01-01T00:00:00Z',
    error: {
      code: 'DFW-7001',
      message: 'NSX API connection failed',
      failedStep: 'applyTags',
      severity: 'HIGH',
      category: 'CONNECTIVITY',
      retryCount: 3,
    },
    compensatingAction: 'Rolled back VM provisioning',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VROCallbackHandler', () => {
  let handler;

  beforeEach(() => {
    handler = createInstance();
    mockGrRows = [{ number: 'RITM0010001', u_correlation_id: 'RITM-0010001-1679500000000', opened_by: 'user-001', request: 'req-001' }];
    mockGrRowIndex = -1;
    jest.clearAllMocks();
  });

  // -- Constants --------------------------------------------------------------

  test('RITM_STATES contains expected state values', () => {
    expect(handler.RITM_STATES.CLOSED_COMPLETE).toBe('3');
    expect(handler.RITM_STATES.CLOSED_INCOMPLETE).toBe('4');
    expect(handler.RITM_STATES.IN_PROGRESS).toBe('2');
  });

  test('INCIDENT_PRIORITY_MAP maps severity to priority', () => {
    expect(handler.INCIDENT_PRIORITY_MAP.CRITICAL).toBe('1');
    expect(handler.INCIDENT_PRIORITY_MAP.HIGH).toBe('2');
    expect(handler.INCIDENT_PRIORITY_MAP.MEDIUM).toBe('3');
  });

  test('INCIDENT_WORTHY_ERRORS includes DFW-7001', () => {
    expect(handler.INCIDENT_WORTHY_ERRORS).toContain('DFW-7001');
  });

  test('DEFAULT_INCIDENT_GROUP is defined', () => {
    expect(handler.DEFAULT_INCIDENT_GROUP).toBe('DFW Automation Support');
  });

  // -- process method ---------------------------------------------------------

  test('process returns 400 for empty request body', () => {
    const req = { body: { data: null, dataString: '' } };
    const res = makeResponse();
    const result = handler.process(req, res);
    expect(res.setStatus).toHaveBeenCalledWith(400);
    expect(result.errorCode).toBe('DFW-CB-4001');
  });

  test('process returns 400 for missing correlationId', () => {
    const req = makeRequest({ status: 'SUCCESS', requestType: 'day0_provision' });
    const res = makeResponse();
    const result = handler.process(req, res);
    expect(res.setStatus).toHaveBeenCalledWith(400);
    expect(result.errorCode).toBe('DFW-CB-4002');
  });

  test('process returns 400 for missing status', () => {
    const req = makeRequest({ correlationId: 'RITM-0010001-1679500000000', requestType: 'day0_provision' });
    const res = makeResponse();
    const result = handler.process(req, res);
    expect(res.setStatus).toHaveBeenCalledWith(400);
    expect(result.errorCode).toBe('DFW-CB-4002');
  });

  test('process returns 404 when no RITM found for correlationId', () => {
    mockGrRows = [];
    const req = makeRequest(successPayload());
    const res = makeResponse();
    const result = handler.process(req, res);
    expect(res.setStatus).toHaveBeenCalledWith(404);
    expect(result.errorCode).toBe('DFW-CB-4004');
  });

  test('process handles SUCCESS callback and returns 200', () => {
    const req = makeRequest(successPayload());
    const res = makeResponse();
    const result = handler.process(req, res);
    expect(res.setStatus).toHaveBeenCalledWith(200);
    expect(result.status).toBe('success');
    expect(result.message).toMatch(/Closed Complete/);
  });

  test('process handles FAILURE callback and returns 200', () => {
    const req = makeRequest(failurePayload());
    const res = makeResponse();
    const result = handler.process(req, res);
    expect(res.setStatus).toHaveBeenCalledWith(200);
    expect(result.status).toBe('success');
    expect(result.message).toMatch(/Failed/);
  });

  test('process rejects unknown status via validation', () => {
    // 'UNKNOWN_STATUS' is not in validStatuses so _validateCallbackPayload catches it
    const req = makeRequest(successPayload({ status: 'UNKNOWN_STATUS' }));
    const res = makeResponse();
    const result = handler.process(req, res);
    expect(res.setStatus).toHaveBeenCalledWith(400);
    expect(result.errorCode).toBe('DFW-CB-4002');
  });

  test('process handles PARTIAL_SUCCESS callback', () => {
    const req = makeRequest(successPayload({
      status: 'PARTIAL_SUCCESS',
      result: { completedSteps: ['provisionVM'], failedSteps: ['applyTags'] },
      error: { code: 'DFW-7002', message: 'Tag apply failed' },
    }));
    const res = makeResponse();
    const result = handler.process(req, res);
    expect(res.setStatus).toHaveBeenCalledWith(200);
    expect(result.message).toMatch(/partial success/);
  });

  // -- RITM update on success -------------------------------------------------

  test('success handler updates RITM state to CLOSED_COMPLETE', () => {
    const req = makeRequest(successPayload());
    const res = makeResponse();
    handler.process(req, res);
    // The GlideRecord setValue should have been called with state = '3'
    const allGrCalls = global.GlideRecord.mock.results;
    let stateSet = false;
    for (const call of allGrCalls) {
      const grInstance = call.value;
      if (grInstance.setValue.mock.calls.some((c) => c[0] === 'state' && c[1] === '3')) {
        stateSet = true;
      }
    }
    expect(stateSet).toBe(true);
  });

  // -- RITM update on failure -------------------------------------------------

  test('failure handler sets RITM state to CLOSED_INCOMPLETE', () => {
    const req = makeRequest(failurePayload());
    const res = makeResponse();
    handler.process(req, res);
    const allGrCalls = global.GlideRecord.mock.results;
    let stateSet = false;
    for (const call of allGrCalls) {
      const grInstance = call.value;
      if (grInstance.setValue.mock.calls.some((c) => c[0] === 'state' && c[1] === '4')) {
        stateSet = true;
      }
    }
    expect(stateSet).toBe(true);
  });

  // -- Incident creation ------------------------------------------------------

  test('failure creates incident for INCIDENT_WORTHY_ERRORS', () => {
    const req = makeRequest(failurePayload());
    const res = makeResponse();
    handler.process(req, res);
    // Incident GlideRecord should have been created (table='incident')
    const incidentCall = global.GlideRecord.mock.calls.find((c) => c[0] === 'incident');
    expect(incidentCall).toBeDefined();
  });

  test('failure with non-incident-worthy low severity error does not create incident', () => {
    const payload = failurePayload({
      error: { code: 'DFW-9999', message: 'Minor issue', severity: 'LOW', category: 'VALIDATION' },
    });
    const req = makeRequest(payload);
    const res = makeResponse();
    handler.process(req, res);
    // Should not create an incident for a LOW severity non-worthy error
    const incidentCall = global.GlideRecord.mock.calls.find((c) => c[0] === 'incident');
    expect(incidentCall).toBeUndefined();
  });

  // -- Payload validation -----------------------------------------------------

  test('validates requestType is required', () => {
    const req = makeRequest({ correlationId: 'RITM-0010001-1679500000000', status: 'SUCCESS' });
    const res = makeResponse();
    const result = handler.process(req, res);
    expect(res.setStatus).toHaveBeenCalledWith(400);
    expect(result.message).toMatch(/requestType/);
  });
});
