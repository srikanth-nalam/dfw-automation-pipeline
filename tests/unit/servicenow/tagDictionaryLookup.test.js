'use strict';

// ---------------------------------------------------------------------------
// Mock ServiceNow globals before requiring the module.
// tagDictionaryLookup.js uses Class.create() + Object.extendsObject and has
// no module.exports. We capture the prototype via a Proxy on Class.create().
// ---------------------------------------------------------------------------

let capturedPrototype = null;
let mockGrRows = [];
let mockGrRowIndex = -1;

const mockGlideRecord = jest.fn().mockImplementation(() => {
  mockGrRowIndex = -1;
  return {
    addQuery: jest.fn(),
    setLimit: jest.fn(),
    orderBy: jest.fn(),
    query: jest.fn(),
    hasNext: jest.fn(() => mockGrRowIndex + 1 < mockGrRows.length),
    next: jest.fn(() => {
      mockGrRowIndex++;
      return mockGrRowIndex < mockGrRows.length;
    }),
    getValue: jest.fn((field) => {
      if (mockGrRowIndex >= 0 && mockGrRowIndex < mockGrRows.length) {
        return mockGrRows[mockGrRowIndex][field] !== undefined
          ? mockGrRows[mockGrRowIndex][field]
          : '';
      }
      return '';
    }),
    getUniqueValue: jest.fn(() => {
      if (mockGrRowIndex >= 0 && mockGrRowIndex < mockGrRows.length) {
        return mockGrRows[mockGrRowIndex].sys_id || 'mock-sys-id';
      }
      return 'mock-sys-id';
    }),
  };
});

const mockGs = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
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

Object.extendsObject = jest.fn((base, proto) => proto);

require('../../../src/servicenow/catalog/server-scripts/tagDictionaryLookup');

function createInstance() {
  const instance = Object.create(capturedPrototype);
  instance.getParameter = jest.fn();
  return instance;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TagDictionaryLookup', () => {
  let lookup;

  beforeEach(() => {
    lookup = createInstance();
    mockGrRows = [];
    mockGrRowIndex = -1;
    jest.clearAllMocks();
  });

  // -- Constants --------------------------------------------------------------

  test('TABLE_TAG_DICTIONARY is u_enterprise_tag_dictionary', () => {
    expect(lookup.TABLE_TAG_DICTIONARY).toBe('u_enterprise_tag_dictionary');
  });

  test('TABLE_CONFLICT_RULES is u_tag_conflict_rules', () => {
    expect(lookup.TABLE_CONFLICT_RULES).toBe('u_tag_conflict_rules');
  });

  // -- getTagValues -----------------------------------------------------------

  test('getTagValues returns empty array for empty category', () => {
    const result = lookup.getTagValues('');
    expect(result).toEqual([]);
  });

  test('getTagValues returns array of tag value objects', () => {
    mockGrRows = [
      { u_value: 'NDCNG', u_display_name: 'NDC Next-Gen', u_description: 'Primary DC', u_deprecated: 'false', u_replacement: '' },
      { u_value: 'TULNG', u_display_name: 'TUL Next-Gen', u_description: 'Secondary DC', u_deprecated: 'false', u_replacement: '' },
    ];
    const result = lookup.getTagValues('Region');
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('value', 'NDCNG');
    expect(result[0]).toHaveProperty('displayName', 'NDC Next-Gen');
    expect(result[0]).toHaveProperty('deprecated', false);
  });

  // -- validateTagValue -------------------------------------------------------

  test('validateTagValue returns false for empty category', () => {
    expect(lookup.validateTagValue('', 'Production')).toBe(false);
  });

  test('validateTagValue returns false for empty value', () => {
    expect(lookup.validateTagValue('Environment', '')).toBe(false);
  });

  test('validateTagValue returns true when dictionary entry exists', () => {
    mockGrRows = [{ u_value: 'Production' }];
    expect(lookup.validateTagValue('Environment', 'Production')).toBe(true);
  });

  // -- getTagMetadata ---------------------------------------------------------

  test('getTagMetadata returns null for null category', () => {
    expect(lookup.getTagMetadata(null, 'PCI')).toBeNull();
  });

  test('getTagMetadata returns metadata object when found', () => {
    mockGrRows = [{
      u_value: 'PCI',
      u_display_name: 'PCI DSS',
      u_description: 'Payment Card Industry',
      u_category: 'Compliance',
      u_active: 'true',
      u_applicable_environments: 'Production,Staging',
      u_applicable_tiers: 'Web,Database',
      u_requires_approval: 'true',
      u_approval_group: 'group-sys-id',
      u_sort_order: '10',
      u_deprecated: 'false',
      u_replacement: '',
    }];
    const meta = lookup.getTagMetadata('Compliance', 'PCI');
    expect(meta).not.toBeNull();
    expect(meta.value).toBe('PCI');
    expect(meta.displayName).toBe('PCI DSS');
    expect(meta.active).toBe(true);
    expect(meta.applicableEnvironments).toEqual(['Production', 'Staging']);
    expect(meta.requiresApproval).toBe(true);
  });

  // -- getConflictRules -------------------------------------------------------

  test('getConflictRules returns array of conflict rule objects', () => {
    mockGrRows = [{
      sys_id: 'rule-001',
      u_category_1: 'Compliance',
      u_value_1: 'PCI',
      u_category_2: 'Environment',
      u_value_2: 'Sandbox',
      u_error_message: 'PCI cannot be in Sandbox',
      u_error_code: 'DFW-4003',
    }];
    const rules = lookup.getConflictRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].category1).toBe('Compliance');
    expect(rules[0].value1).toBe('PCI');
    expect(rules[0].errorCode).toBe('DFW-4003');
    expect(rules[0].active).toBe(true);
  });
});
