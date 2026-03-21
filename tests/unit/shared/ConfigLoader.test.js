const ConfigLoader = require('../../../src/vro/actions/shared/ConfigLoader');

describe('ConfigLoader', () => {
  let loader;

  beforeEach(() => {
    loader = new ConfigLoader();
  });

  describe('get()', () => {
    test('should return config value for a valid dot-notation key', () => {
      const result = loader.get('retry.maxRetries');
      expect(result).toBe(3);
    });

    test('should return nested object for partial key path', () => {
      const retry = loader.get('retry');
      expect(retry).toHaveProperty('intervals');
      expect(retry).toHaveProperty('maxRetries');
    });

    test('should return defaultValue when key does not exist', () => {
      const result = loader.get('nonexistent.key', 'fallback');
      expect(result).toBe('fallback');
    });

    test('should return undefined when key does not exist and no default given', () => {
      const result = loader.get('nonexistent.deep.path');
      expect(result).toBeUndefined();
    });

    test('should return defaultValue for empty string key', () => {
      const result = loader.get('', 'default');
      expect(result).toBe('default');
    });

    test('should return deeply nested values', () => {
      const url = loader.get('sites.NDCNG.vcenterUrl');
      expect(url).toBe('https://vcenter-ndcng.company.internal');
    });
  });

  describe('getEndpointsForSite()', () => {
    test('should return correct NDCNG endpoints', () => {
      const endpoints = loader.getEndpointsForSite('NDCNG');
      expect(endpoints).toEqual({
        vcenterUrl: 'https://vcenter-ndcng.company.internal',
        nsxUrl: 'https://nsx-manager-ndcng.company.internal',
        nsxGlobalUrl: 'https://nsx-global-ndcng.company.internal'
      });
    });

    test('should return correct TULNG endpoints', () => {
      const endpoints = loader.getEndpointsForSite('TULNG');
      expect(endpoints).toEqual({
        vcenterUrl: 'https://vcenter-tulng.company.internal',
        nsxUrl: 'https://nsx-manager-tulng.company.internal',
        nsxGlobalUrl: 'https://nsx-global-tulng.company.internal'
      });
    });

    test('should throw error with DFW-4004 for invalid site', () => {
      expect(() => loader.getEndpointsForSite('INVALID'))
        .toThrow('DFW-4004');
    });

    test('should throw error for empty string site', () => {
      expect(() => loader.getEndpointsForSite(''))
        .toThrow('DFW-4004');
    });

    test('should throw error for null site', () => {
      expect(() => loader.getEndpointsForSite(null))
        .toThrow('DFW-4004');
    });

    test('should handle case-insensitive site lookup', () => {
      const endpoints = loader.getEndpointsForSite('ndcng');
      expect(endpoints.vcenterUrl).toBe('https://vcenter-ndcng.company.internal');
    });

    test('error message should list valid sites', () => {
      try {
        loader.getEndpointsForSite('BADSITE');
        throw new Error('should not reach here');
      } catch (err) {
        expect(err.message).toContain('NDCNG');
        expect(err.message).toContain('TULNG');
      }
    });
  });

  describe('getRetryConfig()', () => {
    test('should return retry intervals and maxRetries', () => {
      const config = loader.getRetryConfig();
      expect(config).toEqual({
        intervals: [5000, 15000, 45000],
        maxRetries: 3
      });
    });

    test('should return a copy (not a reference) of intervals array', () => {
      const config1 = loader.getRetryConfig();
      const config2 = loader.getRetryConfig();
      config1.intervals.push(99999);
      expect(config2.intervals).toEqual([5000, 15000, 45000]);
    });
  });

  describe('getCircuitBreakerConfig()', () => {
    test('should return failureThreshold and resetTimeout', () => {
      const config = loader.getCircuitBreakerConfig();
      expect(config).toEqual({
        failureThreshold: 5,
        resetTimeout: 60000,
        windowSize: 300000
      });
    });
  });

  describe('config override via constructor', () => {
    test('should override default values with provided overrides', () => {
      const custom = new ConfigLoader({
        retry: { maxRetries: 5 }
      });
      expect(custom.get('retry.maxRetries')).toBe(5);
      // Intervals should still be default since we only overrode maxRetries
      expect(custom.get('retry.intervals')).toEqual([5000, 15000, 45000]);
    });

    test('should override nested site endpoints', () => {
      const custom = new ConfigLoader({
        sites: {
          NDCNG: {
            vcenterUrl: 'https://custom-vcenter.example.com'
          }
        }
      });
      const endpoints = custom.getEndpointsForSite('NDCNG');
      expect(endpoints.vcenterUrl).toBe('https://custom-vcenter.example.com');
      // Other NDCNG endpoints should remain default
      expect(endpoints.nsxUrl).toBe('https://nsx-manager-ndcng.company.internal');
    });

    test('should override circuit breaker config', () => {
      const custom = new ConfigLoader({
        circuitBreaker: { failureThreshold: 10 }
      });
      const config = custom.getCircuitBreakerConfig();
      expect(config.failureThreshold).toBe(10);
      expect(config.resetTimeout).toBe(60000); // unchanged
    });

    test('should override logging level', () => {
      const custom = new ConfigLoader({
        logging: { minLevel: 'DEBUG' }
      });
      expect(custom.get('logging.minLevel')).toBe('DEBUG');
    });
  });

  describe('toJSON()', () => {
    test('should return a deep clone of the config', () => {
      const json = loader.toJSON();
      expect(json.retry.maxRetries).toBe(3);
      // Mutating the returned object should not affect the loader
      json.retry.maxRetries = 999;
      expect(loader.get('retry.maxRetries')).toBe(3);
    });
  });
});
