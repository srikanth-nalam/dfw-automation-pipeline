'use strict';

// ---------------------------------------------------------------------------
// Mock ServiceNow globals before requiring the module.
// correlationIdGenerator.js uses Class.create() and assigns .prototype but
// has no module.exports. We capture the prototype through the constructor
// returned by Class.create().
// ---------------------------------------------------------------------------

let capturedPrototype = null;

global.gs = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

global.GlideDateTime = jest.fn().mockImplementation(() => ({
  getNumericValue: jest.fn(() => '1700000000000'),
}));

global.Class = {
  create: jest.fn(() => {
    function Ctor() {}
    // Use a Proxy or defineProperty to capture prototype assignment
    const handler = {
      set(target, prop, value) {
        if (prop === 'prototype') {
          capturedPrototype = value;
        }
        target[prop] = value;
        return true;
      },
    };
    return new Proxy(Ctor, handler);
  }),
};

require('../../../src/servicenow/integration/correlationIdGenerator');

function createInstance() {
  const instance = Object.create(capturedPrototype);
  if (typeof instance.initialize === 'function') {
    instance.initialize();
  }
  return instance;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CorrelationIdGenerator', () => {
  let generator;

  beforeEach(() => {
    generator = createInstance();
    jest.clearAllMocks();
  });

  // -- generate ---------------------------------------------------------------

  test('generate returns correlation ID in RITM-{number}-{epoch} format', () => {
    const id = generator.generate('0010001');
    expect(id).toMatch(/^RITM-0010001-\d{13,}$/);
  });

  test('generate strips RITM prefix from input', () => {
    const id = generator.generate('RITM0010001');
    expect(id).toMatch(/^RITM-0010001-\d{13,}$/);
  });

  test('generate throws on empty ritmNumber', () => {
    expect(() => generator.generate('')).toThrow(/DFW-6001/);
  });

  test('generate throws on invalid (non-numeric) ritmNumber', () => {
    expect(() => generator.generate('ABCDEF')).toThrow(/DFW-6002/);
  });

  // -- parse ------------------------------------------------------------------

  test('parse returns components for valid correlation ID', () => {
    const parsed = generator.parse('RITM-0010001-1679500000000');
    expect(parsed).not.toBeNull();
    expect(parsed.prefix).toBe('RITM');
    expect(parsed.ritmNumber).toBe('0010001');
    expect(parsed.timestamp).toBe(1679500000000);
    expect(parsed.generatedAt).toBe(new Date(1679500000000).toISOString());
  });

  test('parse returns null for invalid format', () => {
    expect(generator.parse('INVALID-FORMAT')).toBeNull();
  });

  test('parse returns null for null input', () => {
    expect(generator.parse(null)).toBeNull();
  });

  // -- validate ---------------------------------------------------------------

  test('validate returns valid for well-formed correlation ID', () => {
    const result = generator.validate('RITM-0010001-1679500000000');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('');
  });

  test('validate rejects empty string', () => {
    const result = generator.validate('');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/null|empty/i);
  });

  test('validate rejects malformed format', () => {
    const result = generator.validate('NOT-A-CORRELATION-ID');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/format/i);
  });

  test('validate rejects epoch outside valid range', () => {
    const result = generator.validate('RITM-0010001-9999');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/format/i);
  });

  // -- constants --------------------------------------------------------------

  test('PREFIX is RITM', () => {
    expect(generator.PREFIX).toBe('RITM');
  });

  test('SEPARATOR is hyphen', () => {
    expect(generator.SEPARATOR).toBe('-');
  });

  test('FORMAT_PATTERN is a RegExp', () => {
    expect(generator.FORMAT_PATTERN).toBeInstanceOf(RegExp);
  });
});
