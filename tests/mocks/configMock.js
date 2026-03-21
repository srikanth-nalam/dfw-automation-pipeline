/**
 * Configuration Mock for Testing
 *
 * Provides test-friendly configuration values with shortened timeouts and
 * low thresholds so that tests run quickly and deterministically.
 */

// ---------------------------------------------------------------------------
// Raw configuration object
// ---------------------------------------------------------------------------
const configMock = {
  // -------------------------------------------------------------------------
  // Site endpoints
  // -------------------------------------------------------------------------
  sites: {
    NDCNG: {
      nsxManager: 'https://nsx-manager.ndcng.example.com',
      vcenter: 'https://vcenter.ndcng.example.com',
      displayName: 'North Data Center - Next Gen'
    },
    TULNG: {
      nsxManager: 'https://nsx-manager.tulng.example.com',
      vcenter: 'https://vcenter.tulng.example.com',
      displayName: 'Tulsa Data Center - Next Gen'
    }
  },

  // -------------------------------------------------------------------------
  // ServiceNow endpoint
  // -------------------------------------------------------------------------
  servicenow: {
    baseUrl: 'https://snow.example.com',
    apiPath: '/api/now/table',
    callbackPath: '/api/now/table/sc_req_item'
  },

  // -------------------------------------------------------------------------
  // Retry configuration (short intervals for tests)
  // -------------------------------------------------------------------------
  retry: {
    intervals: [100, 200, 300],
    maxRetries: 3
  },

  // -------------------------------------------------------------------------
  // Circuit breaker configuration (low thresholds for tests)
  // -------------------------------------------------------------------------
  circuitBreaker: {
    failureThreshold: 3,
    resetTimeout: 1000
  },

  // -------------------------------------------------------------------------
  // Timeouts (milliseconds, short for tests)
  // -------------------------------------------------------------------------
  timeouts: {
    apiRequest: 2000,
    tagVerification: 1000,
    groupVerification: 1000,
    ruleVerification: 1000
  },

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------
  logging: {
    level: 'debug',
    includeTimestamps: true,
    includeCorrelationId: true
  }
};

// ---------------------------------------------------------------------------
// Mock config loader factory
// ---------------------------------------------------------------------------

/**
 * Create a mock config loader that returns the test configuration.
 * Accepts optional overrides that are deep-merged into the base config.
 *
 * @param {Object} [overrides={}]  Partial config to merge on top of defaults.
 * @returns {{ loadConfig: Function, getConfig: Function, getSiteConfig: Function }}
 */
function createMockConfigLoader(overrides = {}) {
  // Simple deep merge (one level deep for each top-level key)
  const merged = { ...configMock };
  for (const key of Object.keys(overrides)) {
    if (
      typeof overrides[key] === 'object' &&
      overrides[key] !== null &&
      !Array.isArray(overrides[key]) &&
      typeof merged[key] === 'object' &&
      merged[key] !== null
    ) {
      merged[key] = { ...merged[key], ...overrides[key] };
    } else {
      merged[key] = overrides[key];
    }
  }

  return {
    /**
     * Simulate loading configuration (sync, returns the merged config).
     * @returns {Object}
     */
    loadConfig: () => merged,

    /**
     * Retrieve the full configuration object.
     * @returns {Object}
     */
    getConfig: () => merged,

    /**
     * Retrieve site-specific configuration.
     * @param {string} siteCode  e.g. 'NDCNG' or 'TULNG'
     * @returns {Object|undefined}
     */
    getSiteConfig: (siteCode) => merged.sites[siteCode],

    /**
     * Retrieve the retry configuration.
     * @returns {{ intervals: number[], maxRetries: number }}
     */
    getRetryConfig: () => merged.retry,

    /**
     * Retrieve the circuit breaker configuration.
     * @returns {{ failureThreshold: number, resetTimeout: number }}
     */
    getCircuitBreakerConfig: () => merged.circuitBreaker
  };
}

module.exports = { configMock, createMockConfigLoader };
