'use strict';

// ---------------------------------------------------------------------------
// Mock ServiceNow globals before requiring the module.
// catalogItemValidation.js uses Class.create() + Object.extendsObject and
// has no module.exports. We capture the prototype through the constructor
// returned by Class.create().
// ---------------------------------------------------------------------------

let capturedPrototype = null;
let mockGrHasNext = true;
let mockGrRows = [];
let mockGrRowIndex = -1;

const mockGlideRecord = jest.fn().mockImplementation((table) => {
  mockGrRowIndex = -1;
  const isConflictTable = table === 'u_tag_conflict_rules';
  return {
    addQuery: jest.fn(),
    setLimit: jest.fn(),
    query: jest.fn(),
    orderBy: jest.fn(),
    // For dictionary lookups (_isValidDictionaryValue), return true by default.
    // For conflict rules, use the rows array.
    hasNext: jest.fn(() => {
      if (isConflictTable) {return mockGrRowIndex + 1 < mockGrRows.length;}
      return mockGrHasNext;
    }),
    next: jest.fn(() => {
      if (isConflictTable) {
        mockGrRowIndex++;
        return mockGrRowIndex < mockGrRows.length;
      }
      return false;
    }),
    getValue: jest.fn((field) => {
      if (mockGrRowIndex >= 0 && mockGrRowIndex < mockGrRows.length) {
        return mockGrRows[mockGrRowIndex][field] || '';
      }
      return '';
    }),
    getUniqueValue: jest.fn(() => 'mock-sys-id'),
  };
});

const mockGs = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  getProperty: jest.fn(() => ''),
};

global.GlideRecord = mockGlideRecord;
global.gs = mockGs;
global.AbstractAjaxProcessor = {};

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

// Object.extendsObject merges proto onto the base prototype
const originalExtendsObject = Object.extendsObject;
Object.extendsObject = jest.fn((base, proto) => proto);

require('../../../src/servicenow/catalog/server-scripts/catalogItemValidation');

function createInstance() {
  const instance = Object.create(capturedPrototype);
  instance.getParameter = jest.fn();
  return instance;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validVariables(overrides = {}) {
  return {
    region: 'NDCNG',
    security_zone: 'Greenzone',
    environment: 'Production',
    app_ci: 'APP001',
    system_role: 'Web',
    compliance: '',
    data_classification: 'Internal',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CatalogItemValidation', () => {
  let validator;

  beforeEach(() => {
    validator = createInstance();
    mockGrHasNext = true;
    mockGrRows = [];
    mockGrRowIndex = -1;
    jest.clearAllMocks();
  });

  // -- Constants --------------------------------------------------------------

  test('VM_BUILD_REQUIRED_FIELDS lists 5 required fields', () => {
    expect(validator.VM_BUILD_REQUIRED_FIELDS).toHaveLength(5);
  });

  test('TAG_UPDATE_REQUIRED_FIELDS includes vm_ci', () => {
    const fields = validator.TAG_UPDATE_REQUIRED_FIELDS.map((f) => f.field);
    expect(fields).toContain('vm_ci');
  });

  test('TAG_CATEGORIES includes all 8 categories', () => {
    expect(validator.TAG_CATEGORIES).toHaveLength(8);
  });

  test('SINGLE_VALUE_CATEGORIES includes Region', () => {
    expect(validator.SINGLE_VALUE_CATEGORIES).toContain('Region');
  });

  test('MULTI_VALUE_CATEGORIES includes Compliance', () => {
    expect(validator.MULTI_VALUE_CATEGORIES).toContain('Compliance');
  });

  // -- validate method --------------------------------------------------------

  test('validate returns valid for complete vm_build variables', () => {
    const result = validator.validate(validVariables(), 'vm_build');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('validate returns errors for missing required fields', () => {
    const result = validator.validate({}, 'vm_build');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(5);
  });

  test('validate returns error when region is empty', () => {
    const result = validator.validate(validVariables({ region: '' }), 'vm_build');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'region')).toBe(true);
  });

  test('validate skips value validation when required fields missing', () => {
    const result = validator.validate({ region: 'NDCNG' }, 'vm_build');
    expect(result.valid).toBe(false);
    // Errors should only be about missing required fields, not dictionary lookup
    const codes = result.errors.map((e) => e.code);
    expect(codes.every((c) => c.includes('1001'))).toBe(true);
  });

  test('validate uses TAG_UPDATE_REQUIRED_FIELDS for tag_update request', () => {
    const result = validator.validate(validVariables(), 'tag_update');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'vm_ci')).toBe(true);
  });

  // -- Conflict detection -----------------------------------------------------

  test('detects PCI + Sandbox conflict', () => {
    const vars = validVariables({ compliance: 'PCI', environment: 'Sandbox' });
    const result = validator.validate(vars, 'vm_build');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code.includes('4003'))).toBe(true);
  });

  test('detects HIPAA + Sandbox conflict', () => {
    const vars = validVariables({ compliance: 'HIPAA', environment: 'Sandbox' });
    const result = validator.validate(vars, 'vm_build');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code.includes('4004'))).toBe(true);
  });

  test('detects Database + Sandbox conflict', () => {
    const vars = validVariables({ system_role: 'Database', environment: 'Sandbox', compliance: 'PCI' });
    const result = validator.validate(vars, 'vm_build');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'system_role')).toBe(true);
  });

  // -- validateAjax -----------------------------------------------------------

  test('validateAjax parses JSON and returns result', () => {
    validator.getParameter = jest.fn((name) => {
      if (name === 'sysparm_variables') {
        return JSON.stringify(validVariables());
      }
      if (name === 'sysparm_request_type') {
        return 'vm_build';
      }
      return '';
    });

    const resultStr = validator.validateAjax();
    const result = JSON.parse(resultStr);
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('errors');
  });

  test('validateAjax returns error for invalid JSON', () => {
    validator.getParameter = jest.fn(() => 'not-json');
    const resultStr = validator.validateAjax();
    const result = JSON.parse(resultStr);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toMatch(/5001/);
  });

  // -- Cardinality validation -------------------------------------------------

  test('rejects None combined with other compliance values', () => {
    const vars = validVariables({ compliance: 'PCI,None' });
    const result = validator.validate(vars, 'vm_build');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code.includes('3001'))).toBe(true);
  });

  test('rejects duplicate compliance values', () => {
    const vars = validVariables({ compliance: 'PCI,PCI' });
    const result = validator.validate(vars, 'vm_build');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code.includes('3002'))).toBe(true);
  });

  // -- Conditional rules ------------------------------------------------------

  test('Database system role requires compliance other than None', () => {
    const vars = validVariables({ system_role: 'Database', compliance: 'None' });
    const result = validator.validate(vars, 'vm_build');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code.includes('5002'))).toBe(true);
  });
});
