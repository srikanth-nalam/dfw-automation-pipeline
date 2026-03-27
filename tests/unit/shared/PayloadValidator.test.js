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

  describe('new request types', () => {
    test('should accept quarantine as valid requestType', () => {
      const payload = buildValidPayload({
        requestType: 'quarantine',
        vmId: 'vm-123'
      });
      // quarantine does not require tags
      delete payload.tags;
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should accept impact_analysis as valid requestType', () => {
      const payload = {
        correlationId: 'RITM-99999-1679000000',
        requestType: 'impact_analysis',
        site: 'NDCNG',
        vmId: 'vm-456',
        vmName: 'test-vm-001',
        tags: {
          Tier: 'Web',
          Environment: 'Production'
        }
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should accept drift_scan as valid requestType', () => {
      const payload = {
        correlationId: 'RITM-88888-1679000000',
        requestType: 'drift_scan',
        site: 'NDCNG'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should accept migration_verify as valid requestType', () => {
      const payload = {
        correlationId: 'RITM-77777-1679000000',
        requestType: 'migration_verify',
        site: 'TULNG',
        vmId: 'vm-789'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('day_n_decommission should not require tags', () => {
      const payload = {
        correlationId: 'RITM-66666-1679000000',
        requestType: 'day_n_decommission',
        site: 'NDCNG',
        vmName: 'test-vm-decom',
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  describe('vmId as alternative identifier', () => {
    test('should accept vmId instead of vmName for quarantine', () => {
      const payload = {
        correlationId: 'RITM-55555-1679000000',
        requestType: 'quarantine',
        site: 'NDCNG',
        vmId: 'vm-123',
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should fail when neither vmName nor vmId provided for quarantine', () => {
      const payload = {
        correlationId: 'RITM-44444-1679000000',
        requestType: 'quarantine',
        site: 'NDCNG',
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4001')).toBe(true);
    });

    test('drift_scan should not require any VM identifier', () => {
      const payload = {
        correlationId: 'RITM-33333-1679000000',
        requestType: 'drift_scan',
        site: 'NDCNG'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  describe('conditional tag validation', () => {
    test('day2_tag_update requires tags but not all 5 mandatory fields', () => {
      const payload = {
        correlationId: 'RITM-22222-1679000000',
        requestType: 'day2_tag_update',
        site: 'NDCNG',
        vmName: 'test-vm-001',
        tags: { Tier: 'Application' },
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('day0_provision still requires all 5 mandatory tag fields', () => {
      const payload = buildValidPayload({
        tags: { Tier: 'Web' }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
    });

    test('impact_analysis validates present tag fields without requiring all', () => {
      const payload = {
        correlationId: 'RITM-11111-1679000000',
        requestType: 'impact_analysis',
        site: 'NDCNG',
        vmId: 'vm-999',
        vmName: 'test-vm-001',
        tags: { Environment: 'Production', Tier: 'Web' }
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });
});
