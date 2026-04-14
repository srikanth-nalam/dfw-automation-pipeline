'use strict';

jest.mock('../../../src/vro/actions/shared/CircuitBreaker');
jest.mock('../../../src/vro/actions/shared/RetryHandler');
jest.mock('../../../src/vro/actions/shared/CorrelationContext');
jest.mock('../../../src/vro/actions/shared/Logger');

const RestClient = require('../../../src/vro/actions/shared/RestClient');
const CircuitBreaker = require('../../../src/vro/actions/shared/CircuitBreaker');
const RetryHandler = require('../../../src/vro/actions/shared/RetryHandler');
const CorrelationContext = require('../../../src/vro/actions/shared/CorrelationContext');
const Logger = require('../../../src/vro/actions/shared/Logger');

describe('RestClient', () => {
  let httpClient;
  let circuitBreakerInstance;
  let client;

  beforeEach(() => {
    httpClient = jest.fn().mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: { data: 'test' }
    });

    circuitBreakerInstance = {
      execute: jest.fn((fn) => fn())
    };

    CircuitBreaker.mockImplementation(() => circuitBreakerInstance);
    RetryHandler.execute = jest.fn((fn) => fn());
    CorrelationContext.getHeaders.mockReturnValue({ 'X-Correlation-ID': 'RITM-001-123' });
    Logger.mockImplementation(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    }));

    client = new RestClient({
      baseUrl: 'https://nsx-manager.test',
      endpointName: 'nsx-test',
      defaultHeaders: { Authorization: 'Bearer token123' },
      httpClient
    });
  });

  // ---------------------------------------------------------------------------
  // constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('creates instance with default options', () => {
      const defaultClient = new RestClient();
      expect(defaultClient).toBeInstanceOf(RestClient);
    });

    it('strips trailing slashes from baseUrl', () => {
      const c = new RestClient({ baseUrl: 'https://api.test///', httpClient });
      expect(c.getEndpointName()).toBe('default');
    });

    it('uses provided endpoint name', () => {
      const c = new RestClient({ endpointName: 'vcenter-prod', httpClient });
      expect(c.getEndpointName()).toBe('vcenter-prod');
    });
  });

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------
  describe('get', () => {
    it('sends GET request to resolved URL', async () => {
      const response = await client.get('/api/v1/fabric/virtual-machines');

      expect(httpClient).toHaveBeenCalledWith(
        'GET',
        'https://nsx-manager.test/api/v1/fabric/virtual-machines',
        expect.objectContaining({ Authorization: 'Bearer token123' }),
        undefined
      );
      expect(response.body.data).toBe('test');
    });

    it('handles absolute URLs without prepending baseUrl', async () => {
      await client.get('https://other-api.test/path');

      expect(httpClient).toHaveBeenCalledWith(
        'GET',
        'https://other-api.test/path',
        expect.any(Object),
        undefined
      );
    });
  });

  // ---------------------------------------------------------------------------
  // post
  // ---------------------------------------------------------------------------
  describe('post', () => {
    it('sends POST request with body', async () => {
      const body = { name: 'App:WebTier' };

      await client.post('/api/v1/tags', body);

      expect(httpClient).toHaveBeenCalledWith(
        'POST',
        'https://nsx-manager.test/api/v1/tags',
        expect.any(Object),
        body
      );
    });
  });

  // ---------------------------------------------------------------------------
  // patch
  // ---------------------------------------------------------------------------
  describe('patch', () => {
    it('sends PATCH request with body', async () => {
      const body = { value: 'updated' };

      await client.patch('/api/v1/tags/abc123', body);

      expect(httpClient).toHaveBeenCalledWith(
        'PATCH',
        'https://nsx-manager.test/api/v1/tags/abc123',
        expect.any(Object),
        body
      );
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------
  describe('delete', () => {
    it('sends DELETE request', async () => {
      await client.delete('/api/v1/tags/abc123');

      expect(httpClient).toHaveBeenCalledWith(
        'DELETE',
        'https://nsx-manager.test/api/v1/tags/abc123',
        expect.any(Object),
        undefined
      );
    });
  });

  // ---------------------------------------------------------------------------
  // headers
  // ---------------------------------------------------------------------------
  describe('headers', () => {
    it('merges default, correlation, and call-specific headers', async () => {
      await client.get('/api/test', { 'X-Custom': 'value' });

      const calledHeaders = httpClient.mock.calls[0][2];
      expect(calledHeaders.Accept).toBe('application/json');
      expect(calledHeaders.Authorization).toBe('Bearer token123');
      expect(calledHeaders['X-Correlation-ID']).toBe('RITM-001-123');
      expect(calledHeaders['X-Custom']).toBe('value');
    });
  });

  // ---------------------------------------------------------------------------
  // circuit breaker integration
  // ---------------------------------------------------------------------------
  describe('circuit breaker', () => {
    it('routes requests through the circuit breaker', async () => {
      await client.get('/api/test');

      expect(circuitBreakerInstance.execute).toHaveBeenCalledTimes(1);
    });

    it('exposes circuit breaker via getCircuitBreaker()', () => {
      const cb = client.getCircuitBreaker();

      expect(cb).toBe(circuitBreakerInstance);
    });
  });

  // ---------------------------------------------------------------------------
  // retry integration
  // ---------------------------------------------------------------------------
  describe('retry', () => {
    it('routes requests through RetryHandler', async () => {
      await client.get('/api/test');

      expect(RetryHandler.execute).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // error handling
  // ---------------------------------------------------------------------------
  describe('error handling', () => {
    it('throws when httpClient rejects', async () => {
      httpClient.mockRejectedValue(new Error('Network error'));
      RetryHandler.execute.mockRejectedValue(new Error('Network error'));
      circuitBreakerInstance.execute.mockRejectedValue(new Error('Network error'));

      await expect(client.get('/api/test')).rejects.toThrow('Network error');
    });

    it('propagates HTTP status errors', async () => {
      const httpError = new Error('HTTP GET returned 503');
      httpError.statusCode = 503;
      circuitBreakerInstance.execute.mockRejectedValue(httpError);

      await expect(client.get('/api/test')).rejects.toThrow('503');
    });
  });

  // ---------------------------------------------------------------------------
  // getEndpointName
  // ---------------------------------------------------------------------------
  describe('getEndpointName', () => {
    it('returns the configured endpoint name', () => {
      expect(client.getEndpointName()).toBe('nsx-test');
    });
  });
});
