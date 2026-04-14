'use strict';

const SnowPayloadAdapter = require('../../../src/adapters/SnowPayloadAdapter');

describe('SnowPayloadAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new SnowPayloadAdapter();
  });

  const validSnowPayload = {
    correlation_id: 'RITM0012345',
    request_type: 'provision',
    vm_name: 'web-server-01',
    site: 'dfw',
    callback_url: 'https://snow.example.com/api/callback',
    callback_token: 'tok-abc-123',
    vm_template: 'rhel8-template',
    vm_cluster: 'cluster-prod-01',
    vm_datastore: 'ds-ssd-01',
    vm_network: 'vlan-100',
    vm_cpu: 4,
    vm_memory: 8192,
    vm_disk: 100,
    tags: { Application: 'APP001', Environment: 'Production' },
    requested_by: 'john.doe',
    approved_by: 'jane.smith',
    priority: 'high'
  };

  describe('toInternalModel', () => {
    test('transforms a full ServiceNow payload to internal domain model', () => {
      const result = adapter.toInternalModel(validSnowPayload);

      expect(result.correlationId).toBe('RITM0012345');
      expect(result.requestType).toBe('provision');
      expect(result.site).toBe('DFW');
      expect(result.callbackUrl).toBe('https://snow.example.com/api/callback');
      expect(result.callbackToken).toBe('tok-abc-123');
    });

    test('maps all VM specification fields', () => {
      const result = adapter.toInternalModel(validSnowPayload);

      expect(result.vm).toEqual({
        name: 'web-server-01',
        template: 'rhel8-template',
        cluster: 'cluster-prod-01',
        datastore: 'ds-ssd-01',
        network: 'vlan-100',
        cpu: 4,
        memory: 8192,
        disk: 100
      });
    });

    test('maps tag fields into the internal model', () => {
      const result = adapter.toInternalModel(validSnowPayload);

      expect(result.tags).toEqual({
        Application: 'APP001',
        Environment: 'Production'
      });
    });

    test('maps optional requestedBy, approvedBy, and priority', () => {
      const result = adapter.toInternalModel(validSnowPayload);

      expect(result.requestedBy).toBe('john.doe');
      expect(result.approvedBy).toBe('jane.smith');
      expect(result.priority).toBe('high');
    });

    test('handles missing optional fields with defaults', () => {
      const minimal = {
        correlation_id: 'RITM0099999',
        request_type: 'tag-update',
        vm_name: 'db-server-02',
        site: 'sjc',
        callback_url: 'https://snow.example.com/cb'
      };

      const result = adapter.toInternalModel(minimal);

      expect(result.vm.template).toBe('');
      expect(result.vm.cluster).toBe('');
      expect(result.vm.cpu).toBe(0);
      expect(result.vm.memory).toBe(0);
      expect(result.vm.disk).toBe(0);
      expect(result.requestedBy).toBe('');
      expect(result.approvedBy).toBe('');
      expect(result.callbackToken).toBe('');
      expect(result.priority).toBe('normal');
      expect(result.tags).toEqual({});
    });

    test('throws on null payload', () => {
      expect(() => adapter.toInternalModel(null)).toThrow('[DFW-3001]');
    });

    test('throws on non-object payload', () => {
      expect(() => adapter.toInternalModel('string')).toThrow('[DFW-3001]');
    });

    test('throws when required fields are missing', () => {
      expect(() => adapter.toInternalModel({ correlation_id: 'RITM001' }))
        .toThrow('missing required field(s)');
    });

    test('throws when a required field is empty string', () => {
      const payload = { ...validSnowPayload, correlation_id: '' };
      expect(() => adapter.toInternalModel(payload)).toThrow('correlation_id');
    });

    test('uppercases the site field', () => {
      const result = adapter.toInternalModel(validSnowPayload);
      expect(result.site).toBe('DFW');
    });

    test('falls back to vm_tags when tags key is absent', () => {
      const payload = {
        ...validSnowPayload,
        tags: undefined,
        vm_tags: { Tier: 'Database' }
      };

      const result = adapter.toInternalModel(payload);
      expect(result.tags).toEqual({ Tier: 'Database' });
    });
  });

  describe('toCallbackPayload', () => {
    test('transforms an internal result to SNOW callback format', () => {
      const internalResult = {
        correlationId: 'RITM0012345',
        status: 'completed',
        vm: { name: 'web-server-01' },
        tags: { Application: 'APP001' },
        completedSteps: ['validate', 'tag', 'deploy'],
        site: 'DFW',
        requestType: 'provision'
      };

      const result = adapter.toCallbackPayload(internalResult);

      expect(result.correlation_id).toBe('RITM0012345');
      expect(result.status).toBe('completed');
      expect(result.result).toBe('success');
      expect(result.vm_name).toBe('web-server-01');
      expect(result.completion_time).toBeDefined();
      expect(result.details.tags_applied).toEqual({ Application: 'APP001' });
      expect(result.details.completed_steps).toEqual(['validate', 'tag', 'deploy']);
      expect(result.details.site).toBe('DFW');
      expect(result.details.request_type).toBe('provision');
    });

    test('uses default status when not provided', () => {
      const result = adapter.toCallbackPayload({ correlationId: 'RITM001' });
      expect(result.status).toBe('completed');
    });

    test('handles missing vm gracefully', () => {
      const result = adapter.toCallbackPayload({ correlationId: 'RITM001' });
      expect(result.vm_name).toBe('');
    });

    test('handles missing completedSteps gracefully', () => {
      const result = adapter.toCallbackPayload({ correlationId: 'RITM001' });
      expect(result.details.completed_steps).toEqual([]);
    });

    test('throws on null result', () => {
      expect(() => adapter.toCallbackPayload(null)).toThrow('[DFW-3002]');
    });

    test('throws when correlationId is missing', () => {
      expect(() => adapter.toCallbackPayload({ status: 'completed' }))
        .toThrow('correlationId');
    });
  });

  describe('toErrorCallback', () => {
    test('maps an Error object with code and context', () => {
      const err = new Error('[DFW-5001] Connection refused');
      err.code = 'DFW-5001';
      err.context = {
        correlationId: 'RITM001',
        step: 'api-connectivity',
        retryCount: 2
      };

      const result = adapter.toErrorCallback(err);

      expect(result.correlation_id).toBe('RITM001');
      expect(result.status).toBe('failed');
      expect(result.result).toBe('failure');
      expect(result.errorCode).toBe('DFW-5001');
      expect(result.errorCategory).toBe('CONNECTIVITY');
      expect(result.failedStep).toBe('api-connectivity');
      expect(result.retryCount).toBe(2);
      expect(result.compensatingAction).toContain('network connectivity');
    });

    test('extracts error code from message when code property is absent', () => {
      const err = new Error('[DFW-1001] Invalid input field');

      const result = adapter.toErrorCallback(err);

      expect(result.errorCode).toBe('DFW-1001');
      expect(result.errorCategory).toBe('VALIDATION');
    });

    test('handles a plain string as error input', () => {
      const result = adapter.toErrorCallback('something went wrong');

      expect(result.status).toBe('failed');
      expect(result.errorMessage).toBe('something went wrong');
      expect(result.errorCode).toBe('DFW-9999');
    });

    test('handles null/falsy error with safe defaults', () => {
      const result = adapter.toErrorCallback(null);

      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('DFW-9999');
      expect(result.errorCategory).toBe('UNKNOWN');
      expect(result.errorMessage).toBe('An unknown error occurred.');
    });

    test('categorizes DFW-2xxx as TAGGING errors', () => {
      const err = new Error('[DFW-2001] Tag failure');
      err.code = 'DFW-2001';

      const result = adapter.toErrorCallback(err);
      expect(result.errorCategory).toBe('TAGGING');
      expect(result.compensatingAction).toContain('tag categories');
    });

    test('categorizes DFW-7xxx as DFW_POLICY errors', () => {
      const err = new Error('[DFW-7001] Policy conflict');
      err.code = 'DFW-7001';

      const result = adapter.toErrorCallback(err);
      expect(result.errorCategory).toBe('DFW_POLICY');
      expect(result.failedStep).toBe('dfw-policy-validation');
    });

    test('includes completion_time as an ISO string', () => {
      const result = adapter.toErrorCallback(new Error('fail'));
      expect(result.completion_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('handles a plain object with message and correlationId', () => {
      const errObj = {
        message: 'Timeout reached',
        correlationId: 'RITM-555',
        retryCount: 3
      };

      const result = adapter.toErrorCallback(errObj);

      expect(result.correlation_id).toBe('RITM-555');
      expect(result.errorMessage).toBe('Timeout reached');
      expect(result.retryCount).toBe(3);
    });
  });
});
