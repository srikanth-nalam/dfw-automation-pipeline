/**
 * @file RestClient.js
 * @description HTTP client wrapper for the DFW Automation Pipeline. Composes
 *   {@link CircuitBreaker} and {@link RetryHandler} to provide resilient HTTP
 *   communication with downstream APIs (vCenter, NSX Manager). Correlation
 *   headers are automatically injected via {@link CorrelationContext}.
 *
 *   The actual network transport is abstracted behind an `httpClient` interface
 *   injected via the constructor, making the class fully testable without
 *   network access.
 *
 * @module shared/RestClient
 */

'use strict';

const CircuitBreaker = require('./CircuitBreaker');
const RetryHandler = require('./RetryHandler');
const CorrelationContext = require('./CorrelationContext');
const Logger = require('./Logger');

/**
 * Default HTTP client implementation. In a real vRO environment this would
 * delegate to the platform's HTTP plugin. Here it wraps the global `fetch`
 * when available or throws a descriptive error.
 *
 * @private
 * @param {string} method  - HTTP method (GET, POST, PATCH, DELETE).
 * @param {string} url     - Fully-qualified URL.
 * @param {Object} headers - Request headers.
 * @param {*}      [body]  - Request body (will be JSON-stringified if object).
 * @returns {Promise<{ statusCode: number, headers: Object, body: * }>}
 */
async function defaultHttpClient(method, url, headers, body) {
  /* istanbul ignore next — runtime environment check */
  if (typeof fetch === 'undefined') {
    throw new Error(
      'No HTTP client available. Supply an httpClient via the RestClient constructor ' +
      'or ensure a global fetch implementation exists.'
    );
  }

  const requestOptions = {
    method,
    headers: { ...headers }
  };

  if (body !== undefined && body !== null) {
    requestOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!requestOptions.headers['Content-Type']) {
      requestOptions.headers['Content-Type'] = 'application/json';
    }
  }

  const response = await fetch(url, requestOptions);

  let responseBody;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    responseBody = await response.json();
  } else {
    responseBody = await response.text();
  }

  // Construct a normalised response envelope
  const result = {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: responseBody
  };

  // Throw on server errors so the retry handler can catch them
  if (response.status >= 400) {
    const error = new Error(
      `HTTP ${method} ${url} returned ${response.status}`
    );
    error.statusCode = response.status;
    error.response = result;
    error.retryable = response.status >= 500 || response.status === 429;
    throw error;
  }

  return result;
}

/**
 * RestClient provides resilient HTTP methods that route each request through a
 * per-endpoint {@link CircuitBreaker} and {@link RetryHandler} before reaching
 * the underlying HTTP transport.
 *
 * @class RestClient
 *
 * @example
 * const client = new RestClient({
 *   baseUrl: 'https://nsx-manager-ndcng.company.internal',
 *   endpointName: 'nsx-manager-ndcng',
 *   defaultHeaders: { Accept: 'application/json' }
 * });
 *
 * const result = await client.get('/api/v1/fabric/virtual-machines');
 */
class RestClient {
  /**
   * Creates a new RestClient instance.
   *
   * @param {Object}   [options={}]                        - Configuration.
   * @param {string}   [options.baseUrl='']                - Base URL prepended to
   *                                                         all relative paths.
   * @param {string}   [options.endpointName='default']    - Logical name used for
   *                                                         circuit breaker tracking.
   * @param {Object}   [options.defaultHeaders={}]         - Headers merged into
   *                                                         every request.
   * @param {Function} [options.httpClient]                - Custom HTTP transport
   *                                                         `(method, url, headers, body) => Promise<response>`.
   *                                                         Defaults to a global-fetch wrapper.
   * @param {Object}   [options.retryOptions={}]           - Options forwarded to
   *                                                         {@link RetryHandler}.
   * @param {Object}   [options.circuitBreakerOptions={}]  - Options forwarded to
   *                                                         {@link CircuitBreaker}.
   * @param {Logger}   [options.logger]                    - Logger instance.
   */
  constructor(options = {}) {
    /** @private */
    this._baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
    /** @private */
    this._endpointName = options.endpointName || 'default';
    /** @private */
    this._defaultHeaders = options.defaultHeaders || {};
    /** @private */
    this._httpClient = options.httpClient || defaultHttpClient;
    /** @private */
    this._retryOptions = options.retryOptions || {};
    /** @private */
    this._logger = options.logger || new Logger({ step: 'RestClient', minLevel: 'DEBUG' });

    /** @private */
    this._circuitBreaker = new CircuitBreaker(this._endpointName, {
      ...(options.circuitBreakerOptions || {}),
      logger: this._logger
    });
  }

  // ---------------------------------------------------------------------------
  // Public HTTP methods
  // ---------------------------------------------------------------------------

  /**
   * Sends an HTTP GET request.
   *
   * @param {string} url                - Absolute URL or path relative to `baseUrl`.
   * @param {Object} [headers={}]       - Additional request headers.
   * @returns {Promise<{ statusCode: number, headers: Object, body: * }>}
   *   The normalised HTTP response.
   *
   * @example
   * const response = await client.get('/api/v1/fabric/virtual-machines');
   * console.log(response.body);
   */
  async get(url, headers = {}) {
    return this._request('GET', url, undefined, headers);
  }

  /**
   * Sends an HTTP POST request.
   *
   * @param {string} url            - Absolute URL or path relative to `baseUrl`.
   * @param {*}      body           - Request body (object or string).
   * @param {Object} [headers={}]   - Additional request headers.
   * @returns {Promise<{ statusCode: number, headers: Object, body: * }>}
   *
   * @example
   * const response = await client.post('/api/v1/tags', { name: 'App:WebTier' });
   */
  async post(url, body, headers = {}) {
    return this._request('POST', url, body, headers);
  }

  /**
   * Sends an HTTP PATCH request.
   *
   * @param {string} url            - Absolute URL or path relative to `baseUrl`.
   * @param {*}      body           - Request body (object or string).
   * @param {Object} [headers={}]   - Additional request headers.
   * @returns {Promise<{ statusCode: number, headers: Object, body: * }>}
   *
   * @example
   * const response = await client.patch('/api/v1/tags/abc123', { value: 'updated' });
   */
  async patch(url, body, headers = {}) {
    return this._request('PATCH', url, body, headers);
  }

  /**
   * Sends an HTTP DELETE request.
   *
   * @param {string} url            - Absolute URL or path relative to `baseUrl`.
   * @param {Object} [headers={}]   - Additional request headers.
   * @returns {Promise<{ statusCode: number, headers: Object, body: * }>}
   *
   * @example
   * const response = await client.delete('/api/v1/tags/abc123');
   */
  async delete(url, headers = {}) {
    return this._request('DELETE', url, undefined, headers);
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Returns the underlying circuit breaker instance for advanced inspection.
   *
   * @returns {CircuitBreaker}
   */
  getCircuitBreaker() {
    return this._circuitBreaker;
  }

  /**
   * Returns the logical endpoint name.
   *
   * @returns {string}
   */
  getEndpointName() {
    return this._endpointName;
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Core request pipeline: CircuitBreaker -> RetryHandler -> HTTP transport.
   *
   * @private
   * @param {string}  method  - HTTP method.
   * @param {string}  url     - URL or path.
   * @param {*}       [body]  - Request body.
   * @param {Object}  headers - Additional headers.
   * @returns {Promise<{ statusCode: number, headers: Object, body: * }>}
   */
  async _request(method, url, body, headers) {
    const resolvedUrl = this._resolveUrl(url);
    const mergedHeaders = this._buildHeaders(headers);

    this._logger.debug(`${method} ${resolvedUrl}`, {
      method,
      url: resolvedUrl,
      endpoint: this._endpointName
    });

    const startTime = Date.now();

    try {
      const response = await this._circuitBreaker.execute(async () => {
        return RetryHandler.execute(
          async () => {
            return this._httpClient(method, resolvedUrl, mergedHeaders, body);
          },
          {
            ...this._retryOptions,
            operationName: `${method} ${resolvedUrl}`,
            logger: this._logger
          }
        );
      });

      const duration = Date.now() - startTime;
      this._logger.info(`${method} ${resolvedUrl} completed`, {
        method,
        url: resolvedUrl,
        statusCode: response.statusCode,
        durationMs: duration,
        endpoint: this._endpointName
      });

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      this._logger.error(`${method} ${resolvedUrl} failed`, {
        method,
        url: resolvedUrl,
        durationMs: duration,
        endpoint: this._endpointName,
        errorMessage: error.message,
        errorCode: error.code || undefined,
        statusCode: error.statusCode || undefined
      });

      throw error;
    }
  }

  /**
   * Resolves a URL by prepending `baseUrl` if the URL is relative.
   *
   * @private
   * @param {string} url - Raw URL or path.
   * @returns {string} Fully-qualified URL.
   */
  _resolveUrl(url) {
    if (!url) {
      return this._baseUrl;
    }
    // Already absolute
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    // Relative path
    const path = url.startsWith('/') ? url : `/${url}`;
    return `${this._baseUrl}${path}`;
  }

  /**
   * Builds the final headers object by merging defaults, correlation headers,
   * and call-specific headers (highest priority wins).
   *
   * @private
   * @param {Object} callHeaders - Per-call headers.
   * @returns {Object} Merged headers object.
   */
  _buildHeaders(callHeaders) {
    return {
      Accept: 'application/json',
      ...this._defaultHeaders,
      ...CorrelationContext.getHeaders(),
      ...callHeaders
    };
  }
}

module.exports = RestClient;
