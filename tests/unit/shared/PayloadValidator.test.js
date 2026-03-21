const PayloadValidator = require('../../../src/vro/actions/shared/PayloadValidator');

describe('PayloadValidator', () => {
  let validator;
  let mockLogger;

  /**
   * Helper to build a valid Day0 payload.
   * Tests can clone and modify fields to create invalid variants.
   */
  function buildValidPayload(overrides = {}) {
    const base = {
      correlationId: 'RITM-12345-1679000000',
      requestType: 'day0_provision',
      site: 'NDCNG',
      vmName: 'test-vm-001',
      callbackUrl: 'https://snow.company.internal/api/callback',
      tags: {
        Tier: 'Web',
        Environment: 'Production',
        Application: 'MyApp',
        Compliance: ['PCI'],
        DataClassification: 'Confidential'
      }
    };
    return { ...base, ...overrides };
  }

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      withCorrelation: jest.fn().mockReturnThis()
    };
    validator = new PayloadValidator({ logger: mockLogger });
  });

  describe('valid payloads', () => {
    test('should pass validation for a valid Day0 payload', () => {
      const payload = buildValidPayload();
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should pass validation for TULNG site', () => {
      const payload = buildValidPayload({ site: 'TULNG' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should pass validation with valid tag structure', () => {
      const payload = buildValidPayload({
        tags: {
          Tier: 'Application',
          Environment: 'Development',
          Application: 'TestApp',
          Compliance: ['None'],
          DataClassification: 'Internal'
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('correlationId validation', () => {
    test('should fail with DFW-4001 when correlationId is missing', () => {
      const payload = buildValidPayload();
      delete payload.correlationId;
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4001')).toBe(true);
    });

    test('should fail with DFW-4001 when correlationId is empty string', () => {
      const payload = buildValidPayload({ correlationId: '' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4001')).toBe(true);
    });
  });

  describe('requestType validation', () => {
    test('should fail for invalid requestType', () => {
      const payload = buildValidPayload({ requestType: 'InvalidType' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('should fail when requestType is missing', () => {
      const payload = buildValidPayload();
      delete payload.requestType;
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
    });
  });

  describe('site validation', () => {
    test('should fail with DFW-4004 for invalid site', () => {
      const payload = buildValidPayload({ site: 'INVALID_SITE' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4004')).toBe(true);
    });

    test('should fail with DFW-4001 for missing site', () => {
      const payload = buildValidPayload();
      delete payload.site;
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4001')).toBe(true);
    });

    test('should accept NDCNG as valid site', () => {
      const payload = buildValidPayload({ site: 'NDCNG' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should accept TULNG as valid site', () => {
      const payload = buildValidPayload({ site: 'TULNG' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  describe('tag validation', () => {
    test('should fail when required tag fields are missing', () => {
      const payload = buildValidPayload({ tags: {} });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('should fail when tags object is missing entirely', () => {
      const payload = buildValidPayload();
      delete payload.tags;
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
    });

    test('should fail when Tier tag is missing', () => {
      const payload = buildValidPayload();
      delete payload.tags.Tier;
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
    });

    test('should fail when Environment tag is missing', () => {
      const payload = buildValidPayload();
      delete payload.tags.Environment;
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
    });
  });

  describe('conflicting tag combinations', () => {
    test('should fail with DFW-4003 for PCI + Sandbox combination', () => {
      const payload = buildValidPayload({
        tags: {
          Tier: 'Web',
          Environment: 'Sandbox',
          Application: 'MyApp',
          Compliance: ['PCI'],
          DataClassification: 'Internal'
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4003')).toBe(true);
    });

    test('should allow PCI in non-Sandbox environments', () => {
      const payload = buildValidPayload({
        tags: {
          Tier: 'Web',
          Environment: 'Production',
          Application: 'MyApp',
          Compliance: ['PCI'],
          DataClassification: 'Confidential'
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should allow Sandbox with non-PCI compliance', () => {
      const payload = buildValidPayload({
        tags: {
          Tier: 'Web',
          Environment: 'Sandbox',
          Application: 'MyApp',
          Compliance: ['None'],
          DataClassification: 'Public'
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  describe('duplicate single-value categories', () => {
    test('should fail with DFW-4006 for duplicate single-value tag categories', () => {
      const payload = buildValidPayload();
      // Simulate a payload where a single-value category has multiple values
      payload.tags.Tier = ['Web', 'App'];
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4006')).toBe(true);
    });

    test('should fail with DFW-4006 for duplicate Environment values', () => {
      const payload = buildValidPayload();
      payload.tags.Environment = ['Production', 'Development'];
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4006')).toBe(true);
    });
  });

  describe('multiple validation errors', () => {
    test('should collect all errors when multiple fields are invalid', () => {
      const payload = {
        // Missing correlationId, invalid site, no tags, no callbackUrl
        requestType: 'invalid_type',
        site: 'INVALID',
        vmName: 'test-vm'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });
});
