const ErrorFactory = require('../../../src/vro/actions/shared/ErrorFactory');

describe('ErrorFactory', () => {
  describe('createError()', () => {
    test('should return a DfwError instance', () => {
      const error = ErrorFactory.createError('DFW-4001');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ErrorFactory.DfwError);
      expect(error.name).toBe('DfwError');
    });

    test('should set the correct error code', () => {
      const error = ErrorFactory.createError('DFW-4001');
      expect(error.code).toBe('DFW-4001');
    });

    test('should use default message from taxonomy when no custom message provided', () => {
      const error = ErrorFactory.createError('DFW-4001');
      expect(error.message).toBe('Missing required field in request payload');
    });

    test('should use custom message when provided', () => {
      const error = ErrorFactory.createError('DFW-4001', 'Field "vmName" is missing');
      expect(error.message).toBe('Field "vmName" is missing');
      expect(error.code).toBe('DFW-4001');
    });

    test('should set failedStep when provided', () => {
      const error = ErrorFactory.createError('DFW-4001', 'Missing field', 'PayloadValidation');
      expect(error.failedStep).toBe('PayloadValidation');
    });

    test('should set retryCount when provided', () => {
      const error = ErrorFactory.createError('DFW-6003', 'NSX unreachable', 'NSXConnect', 3);
      expect(error.retryCount).toBe(3);
    });

    test('should set details when provided', () => {
      const details = { vmId: 'vm-123', site: 'NDCNG' };
      const error = ErrorFactory.createError('DFW-7003', 'VAPI error', 'TagApply', 0, details);
      expect(error.details).toEqual(details);
    });

    test('should include timestamp', () => {
      const error = ErrorFactory.createError('DFW-4001');
      expect(error.timestamp).toBeDefined();
      // Should be a valid ISO date string
      expect(() => new Date(error.timestamp)).not.toThrow();
    });

    test('should have a proper stack trace', () => {
      const error = ErrorFactory.createError('DFW-4001');
      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');
    });
  });

  describe('error code categories - INPUT_VALIDATION', () => {
    test('DFW-4001 should return INPUT_VALIDATION category and 400 status', () => {
      const error = ErrorFactory.createError('DFW-4001');
      expect(error.category).toBe('INPUT_VALIDATION');
      expect(error.httpStatus).toBe(400);
    });

    test('DFW-4003 (conflicting tags) should return INPUT_VALIDATION/400', () => {
      const error = ErrorFactory.createError('DFW-4003');
      expect(error.category).toBe('INPUT_VALIDATION');
      expect(error.httpStatus).toBe(400);
      expect(error.message).toBe('Conflicting tag combination');
    });

    test('DFW-4004 (invalid site) should return INPUT_VALIDATION/400', () => {
      const error = ErrorFactory.createError('DFW-4004');
      expect(error.category).toBe('INPUT_VALIDATION');
      expect(error.httpStatus).toBe(400);
      expect(error.message).toContain('site');
    });

    test('DFW-4006 (duplicate single-value tag) should return INPUT_VALIDATION/400', () => {
      const error = ErrorFactory.createError('DFW-4006');
      expect(error.category).toBe('INPUT_VALIDATION');
      expect(error.httpStatus).toBe(400);
      expect(error.message).toContain('Duplicate single-value tag');
    });
  });

  describe('error code categories - CONNECTIVITY', () => {
    test('DFW-6004 should return CONNECTIVITY category and 503 status', () => {
      const error = ErrorFactory.createError('DFW-6004');
      expect(error.category).toBe('CONNECTIVITY');
      expect(error.httpStatus).toBe(503);
      expect(error.message).toContain('Circuit breaker');
    });

    test('DFW-6001 (vCenter unreachable) should return CONNECTIVITY/503', () => {
      const error = ErrorFactory.createError('DFW-6001');
      expect(error.category).toBe('CONNECTIVITY');
      expect(error.httpStatus).toBe(503);
    });

    test('DFW-6005 (gateway timeout) should return CONNECTIVITY/504', () => {
      const error = ErrorFactory.createError('DFW-6005');
      expect(error.category).toBe('CONNECTIVITY');
      expect(error.httpStatus).toBe(504);
    });
  });

  describe('error code categories - AUTHENTICATION', () => {
    test('DFW-5001 should return AUTHENTICATION/401', () => {
      const error = ErrorFactory.createError('DFW-5001');
      expect(error.category).toBe('AUTHENTICATION');
      expect(error.httpStatus).toBe(401);
    });

    test('DFW-5003 should return AUTHENTICATION/403', () => {
      const error = ErrorFactory.createError('DFW-5003');
      expect(error.category).toBe('AUTHENTICATION');
      expect(error.httpStatus).toBe(403);
    });
  });

  describe('error code categories - INFRASTRUCTURE', () => {
    test('DFW-7004 should return INFRASTRUCTURE/500', () => {
      const error = ErrorFactory.createError('DFW-7004');
      expect(error.category).toBe('INFRASTRUCTURE');
      expect(error.httpStatus).toBe(500);
    });
  });

  describe('error code categories - PARTIAL_SUCCESS', () => {
    test('DFW-8001 should return PARTIAL_SUCCESS/207', () => {
      const error = ErrorFactory.createError('DFW-8001');
      expect(error.category).toBe('PARTIAL_SUCCESS');
      expect(error.httpStatus).toBe(207);
    });
  });

  describe('unknown error code handling', () => {
    test('should fall back to DFW-9001 for unknown codes', () => {
      const error = ErrorFactory.createError('DFW-9999');
      expect(error.code).toBe('DFW-9001');
      expect(error.category).toBe('UNKNOWN');
      expect(error.httpStatus).toBe(500);
    });

    test('should use custom message even for unknown codes', () => {
      const error = ErrorFactory.createError('DFW-9999', 'Something went wrong');
      expect(error.message).toBe('Something went wrong');
      expect(error.code).toBe('DFW-9001');
    });
  });

  describe('createCallbackPayload()', () => {
    test('should create properly formatted callback from DfwError', () => {
      const error = ErrorFactory.createError('DFW-4001', 'Missing vmName', 'PayloadValidation');
      const payload = ErrorFactory.createCallbackPayload('COR-12345', error);

      expect(payload.correlationId).toBe('COR-12345');
      expect(payload.status).toBe('FAILED_VALIDATION');
      expect(payload.error).toBeDefined();
      expect(payload.error.code).toBe('DFW-4001');
      expect(payload.error.category).toBe('INPUT_VALIDATION');
      expect(payload.error.httpStatus).toBe(400);
      expect(payload.error.message).toBe('Missing vmName');
      expect(payload.timestamp).toBeDefined();
    });

    test('should set status to FAILED_CONNECTIVITY for connectivity errors', () => {
      const error = ErrorFactory.createError('DFW-6004', 'Circuit breaker open');
      const payload = ErrorFactory.createCallbackPayload('COR-67890', error);
      expect(payload.status).toBe('FAILED_CONNECTIVITY');
    });

    test('should set status to FAILED_INFRASTRUCTURE for infrastructure errors', () => {
      const error = ErrorFactory.createError('DFW-7004', 'Tag propagation timeout');
      const payload = ErrorFactory.createCallbackPayload('COR-99999', error);
      expect(payload.status).toBe('FAILED_INFRASTRUCTURE');
    });

    test('should set status to PARTIAL_SUCCESS for partial success errors', () => {
      const error = ErrorFactory.createError('DFW-8001');
      const payload = ErrorFactory.createCallbackPayload('COR-11111', error);
      expect(payload.status).toBe('PARTIAL_SUCCESS');
    });

    test('should include compensating action when provided', () => {
      const error = ErrorFactory.createError('DFW-7003');
      const payload = ErrorFactory.createCallbackPayload(
        'COR-54321',
        error,
        'Retry tag application manually via ServiceNow'
      );
      expect(payload.compensatingAction).toBe('Retry tag application manually via ServiceNow');
    });

    test('should wrap plain Error objects with DFW-9001', () => {
      const plainError = new Error('Something unexpected');
      const payload = ErrorFactory.createCallbackPayload('COR-00000', plainError);
      expect(payload.error.code).toBe('DFW-9001');
      expect(payload.error.message).toBe('Something unexpected');
      expect(payload.status).toBe('FAILED');
    });

    test('should handle null correlationId gracefully', () => {
      const error = ErrorFactory.createError('DFW-4001');
      const payload = ErrorFactory.createCallbackPayload(null, error);
      expect(payload.correlationId).toBe('');
    });
  });

  describe('getTaxonomy()', () => {
    test('should return taxonomy entry for known codes', () => {
      const entry = ErrorFactory.getTaxonomy('DFW-4001');
      expect(entry).toEqual({
        category: 'INPUT_VALIDATION',
        httpStatus: 400,
        defaultMessage: 'Missing required field in request payload'
      });
    });

    test('should return null for unknown codes', () => {
      expect(ErrorFactory.getTaxonomy('DFW-9999')).toBeNull();
    });
  });

  describe('getAllCodes()', () => {
    test('should return an array of all registered error codes', () => {
      const codes = ErrorFactory.getAllCodes();
      expect(Array.isArray(codes)).toBe(true);
      expect(codes).toContain('DFW-4001');
      expect(codes).toContain('DFW-6004');
      expect(codes).toContain('DFW-7004');
      expect(codes).toContain('DFW-9001');
    });

    test('should include codes from all categories', () => {
      const codes = ErrorFactory.getAllCodes();
      // Input validation
      expect(codes).toContain('DFW-4001');
      // Authentication
      expect(codes).toContain('DFW-5001');
      // Connectivity
      expect(codes).toContain('DFW-6001');
      // Infrastructure
      expect(codes).toContain('DFW-7001');
      // Partial success
      expect(codes).toContain('DFW-8001');
      // Unknown
      expect(codes).toContain('DFW-9001');
    });
  });

  describe('getCodesByCategory()', () => {
    test('should return all codes for INPUT_VALIDATION category', () => {
      const codes = ErrorFactory.getCodesByCategory('INPUT_VALIDATION');
      expect(codes).toContain('DFW-4001');
      expect(codes).toContain('DFW-4003');
      expect(codes).toContain('DFW-4004');
      expect(codes).toContain('DFW-4006');
      // Should not contain codes from other categories
      expect(codes).not.toContain('DFW-6004');
    });

    test('should return all codes for CONNECTIVITY category', () => {
      const codes = ErrorFactory.getCodesByCategory('CONNECTIVITY');
      expect(codes).toContain('DFW-6001');
      expect(codes).toContain('DFW-6004');
    });

    test('should return empty array for unknown category', () => {
      const codes = ErrorFactory.getCodesByCategory('NONEXISTENT');
      expect(codes).toEqual([]);
    });
  });

  describe('isRetryable()', () => {
    test('CONNECTIVITY errors should be retryable', () => {
      expect(ErrorFactory.isRetryable('DFW-6004')).toBe(true);
    });

    test('INFRASTRUCTURE errors should be retryable', () => {
      expect(ErrorFactory.isRetryable('DFW-7004')).toBe(true);
    });

    test('INPUT_VALIDATION errors should NOT be retryable', () => {
      expect(ErrorFactory.isRetryable('DFW-4001')).toBe(false);
    });

    test('AUTHENTICATION errors should NOT be retryable', () => {
      expect(ErrorFactory.isRetryable('DFW-5001')).toBe(false);
    });

    test('unknown codes should NOT be retryable', () => {
      expect(ErrorFactory.isRetryable('DFW-9999')).toBe(false);
    });
  });

  describe('DfwError toJSON()', () => {
    test('should return a plain object with all error fields', () => {
      const error = ErrorFactory.createError('DFW-4001', 'Missing field', 'Validation', 0, { field: 'vmName' });
      const json = error.toJSON();

      expect(json.code).toBe('DFW-4001');
      expect(json.category).toBe('INPUT_VALIDATION');
      expect(json.httpStatus).toBe(400);
      expect(json.message).toBe('Missing field');
      expect(json.failedStep).toBe('Validation');
      expect(json.retryCount).toBe(0);
      expect(json.details).toEqual({ field: 'vmName' });
      expect(json.timestamp).toBeDefined();
    });
  });
});
