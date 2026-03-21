/**
 * @file ConfigLoader.js
 * @description Loads configuration from vRO property pages (simulated as JSON config).
 *   Provides centralized access to endpoint URLs, retry settings, circuit breaker
 *   settings, and other externalized configuration values. Supports per-site endpoint
 *   resolution and vault-reference patterns for secrets.
 *
 * @module shared/ConfigLoader
 */

'use strict';

/**
 * Default configuration values used as a fallback when no override is supplied.
 * Secrets use the `{{vault:secret/...}}` pattern so that actual credentials are
 * never hard-coded; a secrets manager resolves them at runtime.
 *
 * @constant {Object} DEFAULT_CONFIG
 */
const DEFAULT_CONFIG = {
  /** Per-site endpoint definitions keyed by canonical site code. */
  sites: {
    NDCNG: {
      vcenterUrl: 'https://vcenter-ndcng.company.internal',
      nsxUrl: 'https://nsx-manager-ndcng.company.internal',
      nsxGlobalUrl: 'https://nsx-global-ndcng.company.internal'
    },
    TULNG: {
      vcenterUrl: 'https://vcenter-tulng.company.internal',
      nsxUrl: 'https://nsx-manager-tulng.company.internal',
      nsxGlobalUrl: 'https://nsx-global-tulng.company.internal'
    }
  },

  /** Authentication credentials — vault references, never plain-text. */
  auth: {
    vcenterUsername: '{{vault:secret/vro/vcenter/username}}',
    vcenterPassword: '{{vault:secret/vro/vcenter/password}}',
    nsxUsername: '{{vault:secret/vro/nsx/username}}',
    nsxPassword: '{{vault:secret/vro/nsx/password}}',
    nsxGlobalUsername: '{{vault:secret/vro/nsx-global/username}}',
    nsxGlobalPassword: '{{vault:secret/vro/nsx-global/password}}'
  },

  /** Retry handler defaults. */
  retry: {
    intervals: [5000, 15000, 45000],
    maxRetries: 3
  },

  /** Circuit breaker defaults. */
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeout: 60000,
    windowSize: 300000
  },

  /** HTTP request defaults. */
  http: {
    timeout: 30000,
    followRedirects: true,
    maxRedirects: 5
  },

  /** SNOW callback configuration. */
  callback: {
    maxRetries: 3,
    retryIntervals: [2000, 5000, 10000]
  },

  /** Logging level threshold. */
  logging: {
    minLevel: 'INFO'
  }
};

/**
 * ConfigLoader provides centralized, read-only access to pipeline configuration.
 *
 * Configuration is resolved in the following priority order (highest first):
 *   1. Override object supplied to the constructor
 *   2. Default configuration embedded in this module
 *
 * In a real vRO environment the override would be sourced from a vRO
 * Configuration Element or external property page.
 *
 * @class ConfigLoader
 */
class ConfigLoader {
  /**
   * Creates a new ConfigLoader instance.
   *
   * @param {Object} [overrides={}] - Optional configuration overrides that are
   *   deep-merged on top of the default configuration. Keys follow the same
   *   dot-notation structure as DEFAULT_CONFIG.
   *
   * @example
   * const loader = new ConfigLoader({ logging: { minLevel: 'DEBUG' } });
   * loader.get('logging.minLevel'); // => 'DEBUG'
   */
  constructor(overrides = {}) {
    /** @private */
    this._config = ConfigLoader._deepMerge(
      ConfigLoader._deepClone(DEFAULT_CONFIG),
      overrides
    );
  }

  /**
   * Retrieves a configuration value by dot-notation key path.
   *
   * @param {string} key - Dot-delimited key path (e.g. `'retry.maxRetries'`).
   * @param {*} [defaultValue=undefined] - Value returned when the key does not exist.
   * @returns {*} The resolved configuration value, or `defaultValue` if not found.
   *
   * @example
   * loader.get('sites.NDCNG.vcenterUrl');
   * // => 'https://vcenter-ndcng.company.internal'
   *
   * @example
   * loader.get('nonexistent.key', 'fallback');
   * // => 'fallback'
   */
  get(key, defaultValue = undefined) {
    if (typeof key !== 'string' || key.length === 0) {
      return defaultValue;
    }

    const parts = key.split('.');
    let current = this._config;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return defaultValue;
      }
      current = current[part];
    }

    return current !== undefined ? current : defaultValue;
  }

  /**
   * Returns the endpoint URLs for a given site.
   *
   * @param {string} site - Site code. Must be one of `'NDCNG'` or `'TULNG'`.
   * @returns {{ vcenterUrl: string, nsxUrl: string, nsxGlobalUrl: string }}
   *   An object containing the three endpoint URLs for the requested site.
   * @throws {Error} If the supplied site code is not configured. Error message
   *   includes the DFW-4004 code reference.
   *
   * @example
   * const endpoints = loader.getEndpointsForSite('NDCNG');
   * // => { vcenterUrl: '...', nsxUrl: '...', nsxGlobalUrl: '...' }
   */
  getEndpointsForSite(site) {
    const normalised = typeof site === 'string' ? site.toUpperCase().trim() : '';
    const siteConfig = this.get(`sites.${normalised}`);

    if (!siteConfig) {
      const validSites = Object.keys(this._config.sites || {}).join(', ');
      throw new Error(
        `[DFW-4004] Invalid site value "${site}". Valid sites: ${validSites}`
      );
    }

    return {
      vcenterUrl: siteConfig.vcenterUrl,
      nsxUrl: siteConfig.nsxUrl,
      nsxGlobalUrl: siteConfig.nsxGlobalUrl
    };
  }

  /**
   * Returns the retry handler configuration.
   *
   * @returns {{ intervals: number[], maxRetries: number }}
   *   An object with the retry intervals array and maximum retry count.
   *
   * @example
   * const retryCfg = loader.getRetryConfig();
   * // => { intervals: [5000, 15000, 45000], maxRetries: 3 }
   */
  getRetryConfig() {
    return {
      intervals: Array.isArray(this.get('retry.intervals'))
        ? [...this.get('retry.intervals')]
        : [5000, 15000, 45000],
      maxRetries: this.get('retry.maxRetries', 3)
    };
  }

  /**
   * Returns the circuit breaker configuration.
   *
   * @returns {{ failureThreshold: number, resetTimeout: number, windowSize: number }}
   *   An object with threshold, timeout, and sliding window values.
   *
   * @example
   * const cbCfg = loader.getCircuitBreakerConfig();
   * // => { failureThreshold: 5, resetTimeout: 60000, windowSize: 300000 }
   */
  getCircuitBreakerConfig() {
    return {
      failureThreshold: this.get('circuitBreaker.failureThreshold', 5),
      resetTimeout: this.get('circuitBreaker.resetTimeout', 60000),
      windowSize: this.get('circuitBreaker.windowSize', 300000)
    };
  }

  /**
   * Returns the HTTP request configuration.
   *
   * @returns {{ timeout: number, followRedirects: boolean, maxRedirects: number }}
   */
  getHttpConfig() {
    return {
      timeout: this.get('http.timeout', 30000),
      followRedirects: this.get('http.followRedirects', true),
      maxRedirects: this.get('http.maxRedirects', 5)
    };
  }

  /**
   * Returns the full configuration snapshot (deep-cloned to prevent mutation).
   *
   * @returns {Object} A deep clone of the entire resolved configuration.
   */
  toJSON() {
    return ConfigLoader._deepClone(this._config);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Deep-clones a plain object or array.
   *
   * @private
   * @param {*} obj - Value to clone.
   * @returns {*} A structurally identical, reference-independent copy.
   */
  static _deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(item => ConfigLoader._deepClone(item));
    }
    const cloned = {};
    for (const key of Object.keys(obj)) {
      cloned[key] = ConfigLoader._deepClone(obj[key]);
    }
    return cloned;
  }

  /**
   * Deep-merges `source` into `target` in-place and returns `target`.
   *
   * @private
   * @param {Object} target - The base object.
   * @param {Object} source - The overriding object.
   * @returns {Object} The mutated `target`.
   */
  static _deepMerge(target, source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return target;
    }
    for (const key of Object.keys(source)) {
      const srcVal = source[key];
      const tgtVal = target[key];

      if (
        srcVal !== null &&
        typeof srcVal === 'object' &&
        !Array.isArray(srcVal) &&
        tgtVal !== null &&
        typeof tgtVal === 'object' &&
        !Array.isArray(tgtVal)
      ) {
        ConfigLoader._deepMerge(tgtVal, srcVal);
      } else {
        target[key] = ConfigLoader._deepClone(srcVal);
      }
    }
    return target;
  }
}

module.exports = ConfigLoader;
