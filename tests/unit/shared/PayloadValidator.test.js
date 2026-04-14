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
        Region: 'NDCNG',
        SecurityZone: 'Greenzone',
        Environment: 'Production',
        AppCI: 'MyApp',
        SystemRole: 'Web',
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
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Development',
          AppCI: 'TestApp',
          SystemRole: 'Application',
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

    test('should fail when SystemRole tag is missing', () => {
      const payload = buildValidPayload();
      delete payload.tags.SystemRole;
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
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Sandbox',
          AppCI: 'MyApp',
          SystemRole: 'Web',
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
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'MyApp',
          SystemRole: 'Web',
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
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Sandbox',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          Compliance: ['None'],
          DataClassification: 'Public'
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  describe('duplicate single-value categories', () => {
    test('should fail with DFW-4006 for duplicate single-value SystemRole values', () => {
      const payload = buildValidPayload();
      // Simulate a payload where a single-value category has multiple values
      payload.tags.SystemRole = ['Web', 'App'];
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
          SystemRole: 'Web',
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
        tags: { SystemRole: 'Application' },
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('day0_provision still requires all 5 mandatory tag fields', () => {
      const payload = buildValidPayload({
        tags: { SystemRole: 'Web' }
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
        tags: { Environment: 'Production', SystemRole: 'Web' }
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Payload guard — non-object inputs
  // ---------------------------------------------------------------------------
  describe('payload guard (non-object inputs)', () => {
    test('should reject null payload with DFW-4001', () => {
      const result = validator.validate(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('DFW-4001');
      expect(result.errors[0].field).toBe('payload');
    });

    test('should reject undefined payload', () => {
      const result = validator.validate(undefined);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('DFW-4001');
    });

    test('should reject array payload', () => {
      const result = validator.validate([1, 2, 3]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('DFW-4001');
      expect(result.errors[0].message).toContain('non-null JSON object');
    });

    test('should reject string payload', () => {
      const result = validator.validate('not an object');
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('DFW-4001');
    });

    test('should reject numeric payload', () => {
      const result = validator.validate(42);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('DFW-4001');
    });
  });

  // ---------------------------------------------------------------------------
  // vmName pattern edge cases
  // ---------------------------------------------------------------------------
  describe('vmName pattern validation', () => {
    test('should reject vmName starting with a digit', () => {
      const payload = buildValidPayload({ vmName: '1-invalid-name' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4005')).toBe(true);
    });

    test('should reject vmName shorter than 3 characters', () => {
      const payload = buildValidPayload({ vmName: 'ab' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4005')).toBe(true);
    });

    test('should reject vmName with special characters', () => {
      const payload = buildValidPayload({ vmName: 'vm_name@bad!' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4005')).toBe(true);
    });

    test('should accept vmName at minimum length (3 chars)', () => {
      const payload = buildValidPayload({ vmName: 'abc' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should accept vmName with hyphens', () => {
      const payload = buildValidPayload({ vmName: 'srv-web-prod-01' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should skip vmName format validation when vmName is not a string', () => {
      const payload = buildValidPayload();
      payload.vmName = 12345;
      const result = validator.validate(payload);
      // Should fail for required field type but NOT produce DFW-4005
      expect(result.errors.every(e => e.code !== 'DFW-4005')).toBe(true);
    });

    test('should skip vmName format validation when vmName is empty string', () => {
      const payload = buildValidPayload({ vmName: '   ' });
      const result = validator.validate(payload);
      // Empty string triggers required field error, not pattern error
      expect(result.errors.some(e => e.code === 'DFW-4001')).toBe(true);
    });

    test('should support custom vmNamePattern via constructor option', () => {
      const customValidator = new PayloadValidator({ vmNamePattern: /^custom-\d+$/ });
      const payload = buildValidPayload({ vmName: 'custom-123' });
      const result = customValidator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should reject vmName that fails custom pattern', () => {
      const customValidator = new PayloadValidator({ vmNamePattern: /^custom-\d+$/ });
      const payload = buildValidPayload({ vmName: 'test-vm-001' });
      const result = customValidator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4005')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // callbackUrl validation edge cases
  // ---------------------------------------------------------------------------
  describe('callbackUrl validation', () => {
    test('should reject callbackUrl with ftp protocol', () => {
      const payload = buildValidPayload({ callbackUrl: 'ftp://files.company.internal/callback' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.message.includes('http or https')
      )).toBe(true);
    });

    test('should reject invalid URL format', () => {
      const payload = buildValidPayload({ callbackUrl: 'not-a-valid-url' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.message.includes('not a valid URL')
      )).toBe(true);
    });

    test('should accept http callbackUrl', () => {
      const payload = buildValidPayload({ callbackUrl: 'http://snow.company.internal/api/callback' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should accept https callbackUrl', () => {
      const payload = buildValidPayload({ callbackUrl: 'https://snow.company.internal/api/callback' });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Tag structure edge cases
  // ---------------------------------------------------------------------------
  describe('tag structure edge cases', () => {
    test('should reject tags when provided as an array', () => {
      const payload = buildValidPayload({ tags: ['Region', 'NDCNG'] });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.message.includes('must be a JSON object')
      )).toBe(true);
    });

    test('should reject non-string tag values for required fields', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 123,
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'MyApp',
          SystemRole: 'Web'
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4002' && e.field === 'tags.Region'
      )).toBe(true);
    });

    test('should reject empty string tag values for required fields', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: '',
          Environment: 'Production',
          AppCI: 'MyApp',
          SystemRole: 'Web'
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.field === 'tags.SecurityZone'
      )).toBe(true);
    });

    test('should reject whitespace-only tag values for required fields', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: '   ',
          AppCI: 'MyApp',
          SystemRole: 'Web'
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.field === 'tags.Environment'
      )).toBe(true);
    });

    test('should reject Compliance as non-array type', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          Compliance: 'PCI'
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4002' && e.field === 'tags.Compliance'
      )).toBe(true);
    });

    test('should reject empty Compliance array', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          Compliance: []
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.message.includes('at least one value')
      )).toBe(true);
    });

    test('should reject Compliance array with empty string items', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          Compliance: ['PCI', '', 'SOX']
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4002' && e.field === 'tags.Compliance[1]'
      )).toBe(true);
    });

    test('should reject Compliance array with non-string items', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          Compliance: ['PCI', 42]
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4002' && e.field === 'tags.Compliance[1]'
      )).toBe(true);
    });

    test('should reject non-string DataClassification', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          DataClassification: 99
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4002' && e.field === 'tags.DataClassification'
      )).toBe(true);
    });

    test('should reject non-string CostCenter', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          CostCenter: true
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4002' && e.field === 'tags.CostCenter'
      )).toBe(true);
    });

    test('should accept valid optional tags', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Production',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          CostCenter: 'CC-12345',
          DataClassification: 'Internal',
          Compliance: ['SOX']
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Conflicting tag combinations — extended
  // ---------------------------------------------------------------------------
  describe('conflicting tag combinations — extended', () => {
    test('should fail with DFW-4003 for HIPAA + Sandbox combination', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Sandbox',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          Compliance: ['HIPAA']
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4003')).toBe(true);
      const conflictErr = result.errors.find(e => e.code === 'DFW-4003');
      expect(conflictErr.details.conflictingCompliance).toContain('HIPAA');
    });

    test('should fail with DFW-4003 for SOX + Sandbox combination', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Sandbox',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          Compliance: ['SOX']
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      const conflictErr = result.errors.find(e => e.code === 'DFW-4003');
      expect(conflictErr.details.conflictingCompliance).toContain('SOX');
    });

    test('should report multiple conflicting compliance values', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Sandbox',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          Compliance: ['PCI', 'HIPAA', 'SOX']
        }
      });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      const conflictErr = result.errors.find(e => e.code === 'DFW-4003');
      expect(conflictErr.details.conflictingCompliance).toEqual(['PCI', 'HIPAA', 'SOX']);
      expect(conflictErr.details.rule).toContain('PCI/HIPAA/SOX');
    });

    test('should not flag conflict when Compliance is not an array', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 'Sandbox',
          AppCI: 'MyApp',
          SystemRole: 'Web',
          Compliance: 'PCI'
        }
      });
      const result = validator.validate(payload);
      // DFW-4002 for wrong type, but not DFW-4003 for conflict
      expect(result.errors.some(e => e.code === 'DFW-4003')).toBe(false);
    });

    test('should not flag conflict when Environment is not a string', () => {
      const payload = buildValidPayload({
        tags: {
          Region: 'NDCNG',
          SecurityZone: 'Greenzone',
          Environment: 123,
          AppCI: 'MyApp',
          SystemRole: 'Web',
          Compliance: ['PCI']
        }
      });
      const result = validator.validate(payload);
      expect(result.errors.some(e => e.code === 'DFW-4003')).toBe(false);
    });

    test('should skip conflict detection when tags are missing', () => {
      const payload = {
        correlationId: 'RITM-55555-1679000000',
        requestType: 'drift_scan',
        site: 'NDCNG'
      };
      const result = validator.validate(payload);
      // No DFW-4003 errors
      expect(result.errors.some(e => e.code === 'DFW-4003')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Duplicate tag detection — extended
  // ---------------------------------------------------------------------------
  describe('duplicate tag detection — extended', () => {
    test('should flag Region as array with DFW-4006', () => {
      const payload = buildValidPayload();
      payload.tags.Region = ['NDCNG', 'TULNG'];
      const result = validator.validate(payload);
      expect(result.errors.some(e =>
        e.code === 'DFW-4006' && e.field === 'tags.Region'
      )).toBe(true);
    });

    test('should flag DataClassification as array with DFW-4006', () => {
      const payload = buildValidPayload();
      payload.tags.DataClassification = ['Internal', 'Public'];
      const result = validator.validate(payload);
      expect(result.errors.some(e =>
        e.code === 'DFW-4006' && e.field === 'tags.DataClassification'
      )).toBe(true);
    });

    test('should flag CostCenter as array with DFW-4006', () => {
      const payload = buildValidPayload();
      payload.tags.CostCenter = ['CC-001', 'CC-002'];
      const result = validator.validate(payload);
      expect(result.errors.some(e =>
        e.code === 'DFW-4006' && e.field === 'tags.CostCenter'
      )).toBe(true);
    });

    test('should include receivedCount in DFW-4006 details', () => {
      const payload = buildValidPayload();
      payload.tags.SecurityZone = ['Greenzone', 'DMZ', 'Restricted'];
      const result = validator.validate(payload);
      const dupErr = result.errors.find(e => e.code === 'DFW-4006' && e.field === 'tags.SecurityZone');
      expect(dupErr).toBeDefined();
      expect(dupErr.details.receivedCount).toBe(3);
    });

    test('should skip duplicate check when tags is not an object', () => {
      const payload = {
        correlationId: 'RITM-55555-1679000000',
        requestType: 'drift_scan',
        site: 'NDCNG'
      };
      const result = validator.validate(payload);
      expect(result.errors.some(e => e.code === 'DFW-4006')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Request type specific validation — drift_scan, migration_verify,
  // quarantine, impact_analysis edge cases
  // ---------------------------------------------------------------------------
  describe('drift_scan edge cases', () => {
    test('should accept drift_scan with optional tags provided', () => {
      const payload = {
        correlationId: 'RITM-DS-001',
        requestType: 'drift_scan',
        site: 'TULNG',
        tags: { Environment: 'Production' }
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should reject drift_scan with invalid site', () => {
      const payload = {
        correlationId: 'RITM-DS-002',
        requestType: 'drift_scan',
        site: 'INVALID'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4004')).toBe(true);
    });

    test('should reject drift_scan with missing correlationId', () => {
      const payload = {
        requestType: 'drift_scan',
        site: 'NDCNG'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'correlationId')).toBe(true);
    });
  });

  describe('migration_verify edge cases', () => {
    test('should fail when neither vmName nor vmId provided', () => {
      const payload = {
        correlationId: 'RITM-MV-001',
        requestType: 'migration_verify',
        site: 'NDCNG'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.message.includes('vmName')
      )).toBe(true);
    });

    test('should accept migration_verify with vmName only', () => {
      const payload = {
        correlationId: 'RITM-MV-002',
        requestType: 'migration_verify',
        site: 'TULNG',
        vmName: 'srv-migrated-01'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should accept migration_verify with vmId only', () => {
      const payload = {
        correlationId: 'RITM-MV-003',
        requestType: 'migration_verify',
        site: 'NDCNG',
        vmId: 'vm-mig-456'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should accept migration_verify with both vmName and vmId', () => {
      const payload = {
        correlationId: 'RITM-MV-004',
        requestType: 'migration_verify',
        site: 'NDCNG',
        vmName: 'srv-migrated-01',
        vmId: 'vm-mig-456'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  describe('quarantine edge cases', () => {
    test('should accept quarantine with optional tags provided', () => {
      const payload = {
        correlationId: 'RITM-QR-001',
        requestType: 'quarantine',
        site: 'NDCNG',
        vmId: 'vm-quarantine-01',
        callbackUrl: 'https://snow.company.internal/api/callback',
        tags: { Environment: 'Production', SecurityZone: 'Restricted' }
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should reject quarantine with empty vmId and no vmName', () => {
      const payload = {
        correlationId: 'RITM-QR-002',
        requestType: 'quarantine',
        site: 'NDCNG',
        vmId: '   ',
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
    });

    test('should accept quarantine with vmName instead of vmId', () => {
      const payload = {
        correlationId: 'RITM-QR-003',
        requestType: 'quarantine',
        site: 'NDCNG',
        vmName: 'srv-quarantine-vm',
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  describe('impact_analysis edge cases', () => {
    test('should fail when tags are missing (tags required for impact_analysis)', () => {
      const payload = {
        correlationId: 'RITM-IA-001',
        requestType: 'impact_analysis',
        site: 'NDCNG',
        vmId: 'vm-ia-001'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'tags')).toBe(true);
    });

    test('should fail with empty tags object for impact_analysis', () => {
      const payload = {
        correlationId: 'RITM-IA-002',
        requestType: 'impact_analysis',
        site: 'NDCNG',
        vmId: 'vm-ia-002',
        tags: {}
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.message.includes('at least one tag')
      )).toBe(true);
    });

    test('should validate present tag types even when not all are required', () => {
      const payload = {
        correlationId: 'RITM-IA-003',
        requestType: 'impact_analysis',
        site: 'NDCNG',
        vmName: 'srv-impact-01',
        tags: { Environment: 123 }
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4002' && e.field === 'tags.Environment'
      )).toBe(true);
    });

    test('should reject empty string tag in partial validation', () => {
      const payload = {
        correlationId: 'RITM-IA-004',
        requestType: 'impact_analysis',
        site: 'NDCNG',
        vmName: 'srv-impact-02',
        tags: { SystemRole: '   ' }
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.field === 'tags.SystemRole'
      )).toBe(true);
    });

    test('should reject Compliance as non-array in partial validation', () => {
      const payload = {
        correlationId: 'RITM-IA-005',
        requestType: 'impact_analysis',
        site: 'NDCNG',
        vmName: 'srv-impact-03',
        tags: { Environment: 'Production', Compliance: 'PCI' }
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4002' && e.field === 'tags.Compliance'
      )).toBe(true);
    });

    test('should reject empty Compliance array in partial validation', () => {
      const payload = {
        correlationId: 'RITM-IA-006',
        requestType: 'impact_analysis',
        site: 'NDCNG',
        vmName: 'srv-impact-04',
        tags: { Environment: 'Production', Compliance: [] }
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.message.includes('at least one value')
      )).toBe(true);
    });

    test('should not require callbackUrl for impact_analysis', () => {
      const payload = {
        correlationId: 'RITM-IA-007',
        requestType: 'impact_analysis',
        site: 'NDCNG',
        vmId: 'vm-ia-007',
        tags: { Environment: 'Production' }
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // bulk_tag and legacy_onboard — vmIdentifier 'none'
  // ---------------------------------------------------------------------------
  describe('bulk_tag request type', () => {
    test('should accept bulk_tag without vmName or vmId', () => {
      const payload = {
        correlationId: 'RITM-BT-001',
        requestType: 'bulk_tag',
        site: 'NDCNG',
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should accept bulk_tag with optional tags', () => {
      const payload = {
        correlationId: 'RITM-BT-002',
        requestType: 'bulk_tag',
        site: 'TULNG',
        callbackUrl: 'https://snow.company.internal/api/callback',
        tags: { Region: 'TULNG' }
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  describe('legacy_onboard request type', () => {
    test('should accept legacy_onboard without vmName or vmId', () => {
      const payload = {
        correlationId: 'RITM-LO-001',
        requestType: 'legacy_onboard',
        site: 'NDCNG',
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should accept legacy_onboard without tags', () => {
      const payload = {
        correlationId: 'RITM-LO-002',
        requestType: 'legacy_onboard',
        site: 'TULNG',
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // day2_tag_update — partial tag validation
  // ---------------------------------------------------------------------------
  describe('day2_tag_update tag validation', () => {
    test('should accept vmId instead of vmName', () => {
      const payload = {
        correlationId: 'RITM-D2-001',
        requestType: 'day2_tag_update',
        site: 'NDCNG',
        vmId: 'vm-d2-001',
        tags: { Environment: 'Staging' },
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should fail for day2_tag_update with empty tags object', () => {
      const payload = {
        correlationId: 'RITM-D2-002',
        requestType: 'day2_tag_update',
        site: 'NDCNG',
        vmName: 'test-vm-001',
        tags: {},
        callbackUrl: 'https://snow.company.internal/api/callback'
      };
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // _makeError static helper
  // ---------------------------------------------------------------------------
  describe('_makeError', () => {
    test('should create error without field or details', () => {
      const err = PayloadValidator._makeError('DFW-4001', 'Some error');
      expect(err).toEqual({ code: 'DFW-4001', message: 'Some error' });
      expect(err.field).toBeUndefined();
      expect(err.details).toBeUndefined();
    });

    test('should create error with field but no details', () => {
      const err = PayloadValidator._makeError('DFW-4002', 'Bad type', 'tags.Region');
      expect(err.code).toBe('DFW-4002');
      expect(err.field).toBe('tags.Region');
      expect(err.details).toBeUndefined();
    });

    test('should create error with field and details', () => {
      const err = PayloadValidator._makeError('DFW-4004', 'Bad site', 'site', { validValues: ['NDCNG'] });
      expect(err.code).toBe('DFW-4004');
      expect(err.field).toBe('site');
      expect(err.details).toEqual({ validValues: ['NDCNG'] });
    });
  });

  // ---------------------------------------------------------------------------
  // Ajv configuration
  // ---------------------------------------------------------------------------
  describe('Ajv configuration', () => {
    test('should function correctly when useAjv is set to false', () => {
      const noAjvValidator = new PayloadValidator({ useAjv: false });
      const payload = buildValidPayload();
      const result = noAjvValidator.validate(payload);
      expect(result.valid).toBe(true);
    });

    test('should produce same validation results with useAjv false', () => {
      const noAjvValidator = new PayloadValidator({ useAjv: false });
      const payload = buildValidPayload();
      delete payload.correlationId;
      const result = noAjvValidator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'DFW-4001')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Required fields with null values
  // ---------------------------------------------------------------------------
  describe('null field values', () => {
    test('should fail when correlationId is null', () => {
      const payload = buildValidPayload({ correlationId: null });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.field === 'correlationId'
      )).toBe(true);
    });

    test('should fail when site is null', () => {
      const payload = buildValidPayload({ site: null });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'DFW-4001' && e.field === 'site'
      )).toBe(true);
    });

    test('should fail when tags is null for day0_provision', () => {
      const payload = buildValidPayload({ tags: null });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
    });

    test('should fail when requestType is null', () => {
      const payload = buildValidPayload({ requestType: null });
      const result = validator.validate(payload);
      expect(result.valid).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Exposed constants
  // ---------------------------------------------------------------------------
  describe('exported constants', () => {
    test('VALID_REQUEST_TYPES contains all nine request types', () => {
      expect(PayloadValidator.VALID_REQUEST_TYPES).toHaveLength(9);
      expect(PayloadValidator.VALID_REQUEST_TYPES).toContain('drift_scan');
      expect(PayloadValidator.VALID_REQUEST_TYPES).toContain('migration_verify');
      expect(PayloadValidator.VALID_REQUEST_TYPES).toContain('quarantine');
      expect(PayloadValidator.VALID_REQUEST_TYPES).toContain('impact_analysis');
      expect(PayloadValidator.VALID_REQUEST_TYPES).toContain('bulk_tag');
      expect(PayloadValidator.VALID_REQUEST_TYPES).toContain('legacy_onboard');
    });

    test('VALID_SITES contains NDCNG and TULNG', () => {
      expect(PayloadValidator.VALID_SITES).toEqual(['NDCNG', 'TULNG']);
    });

    test('REQUIRED_TAG_FIELDS contains five fields', () => {
      expect(PayloadValidator.REQUIRED_TAG_FIELDS).toHaveLength(5);
    });

    test('ALL_TAG_FIELDS includes required and optional fields', () => {
      expect(PayloadValidator.ALL_TAG_FIELDS).toEqual(
        expect.arrayContaining(['Region', 'SecurityZone', 'Environment', 'AppCI', 'SystemRole', 'Compliance', 'DataClassification', 'CostCenter'])
      );
    });

    test('REQUEST_TYPE_RULES is frozen', () => {
      expect(Object.isFrozen(PayloadValidator.REQUEST_TYPE_RULES)).toBe(true);
    });

    test('VM_NAME_PATTERN is a RegExp', () => {
      expect(PayloadValidator.VM_NAME_PATTERN).toBeInstanceOf(RegExp);
    });

    test('PAYLOAD_SCHEMA has expected structure', () => {
      expect(PayloadValidator.PAYLOAD_SCHEMA.type).toBe('object');
      expect(PayloadValidator.PAYLOAD_SCHEMA.properties.tags.type).toBe('object');
    });
  });
});
