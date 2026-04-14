'use strict';

const CorrelationContext = require('../../../src/vro/actions/shared/CorrelationContext');

describe('CorrelationContext', () => {
  afterEach(() => {
    CorrelationContext.clear();
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------
  describe('create', () => {
    it('generates a correlation ID with correct format', () => {
      const id = CorrelationContext.create('12345');

      expect(id).toMatch(/^RITM-12345-\d+$/);
    });

    it('stores the correlation ID for retrieval via get()', () => {
      const id = CorrelationContext.create('99999');

      expect(CorrelationContext.get()).toBe(id);
    });

    it('accepts numeric input', () => {
      const id = CorrelationContext.create(54321);

      expect(id).toMatch(/^RITM-54321-\d+$/);
    });

    it('throws for invalid RITM number', () => {
      expect(() => CorrelationContext.create('abc'))
        .toThrow(/Invalid RITM number/);
    });
  });

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------
  describe('get', () => {
    it('returns null when no context exists', () => {
      expect(CorrelationContext.get()).toBeNull();
    });

    it('returns the active correlation ID', () => {
      CorrelationContext.create('10001');

      expect(CorrelationContext.get()).toMatch(/^RITM-10001-\d+$/);
    });
  });

  // ---------------------------------------------------------------------------
  // getHeaders
  // ---------------------------------------------------------------------------
  describe('getHeaders', () => {
    it('returns header object with correlation ID', () => {
      CorrelationContext.create('10001');

      const headers = CorrelationContext.getHeaders();

      expect(headers).toHaveProperty('X-Correlation-ID');
      expect(headers['X-Correlation-ID']).toMatch(/^RITM-10001-/);
    });

    it('returns empty string header when no context exists', () => {
      const headers = CorrelationContext.getHeaders();

      expect(headers['X-Correlation-ID']).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------
  describe('clear', () => {
    it('resets all context state to null', () => {
      CorrelationContext.create('10001');

      CorrelationContext.clear();

      expect(CorrelationContext.get()).toBeNull();
      expect(CorrelationContext.getRitmNumber()).toBeNull();
      expect(CorrelationContext.getCreatedAt()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // set
  // ---------------------------------------------------------------------------
  describe('set', () => {
    it('adopts a pre-existing valid correlation ID', () => {
      const id = 'RITM-55555-1679000000000';

      CorrelationContext.set(id);

      expect(CorrelationContext.get()).toBe(id);
      expect(CorrelationContext.getRitmNumber()).toBe('55555');
    });

    it('throws for invalid format', () => {
      expect(() => CorrelationContext.set('INVALID-FORMAT'))
        .toThrow(/Invalid correlation ID format/);
    });
  });

  // ---------------------------------------------------------------------------
  // getRitmNumber
  // ---------------------------------------------------------------------------
  describe('getRitmNumber', () => {
    it('returns the RITM number from the current context', () => {
      CorrelationContext.create('67890');

      expect(CorrelationContext.getRitmNumber()).toBe('67890');
    });

    it('returns null when no context exists', () => {
      expect(CorrelationContext.getRitmNumber()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getCreatedAt
  // ---------------------------------------------------------------------------
  describe('getCreatedAt', () => {
    it('returns a timestamp number after creation', () => {
      const before = Date.now();
      CorrelationContext.create('10001');
      const after = Date.now();

      const createdAt = CorrelationContext.getCreatedAt();

      expect(createdAt).toBeGreaterThanOrEqual(before);
      expect(createdAt).toBeLessThanOrEqual(after);
    });
  });

  // ---------------------------------------------------------------------------
  // isValid
  // ---------------------------------------------------------------------------
  describe('isValid', () => {
    it('returns true for valid correlation ID format', () => {
      expect(CorrelationContext.isValid('RITM-12345-1679000000000')).toBe(true);
    });

    it('returns false for invalid format', () => {
      expect(CorrelationContext.isValid('INVALID')).toBe(false);
      expect(CorrelationContext.isValid('')).toBe(false);
      expect(CorrelationContext.isValid(null)).toBe(false);
      expect(CorrelationContext.isValid(12345)).toBe(false);
    });
  });
});
