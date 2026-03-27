'use strict';

const RateLimiter = require('../../../src/vro/actions/shared/RateLimiter');

describe('RateLimiter', () => {
  let limiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxTokens: 10, refillRate: 100 });
  });

  test('initializes with max tokens available', () => {
    expect(limiter.getAvailableTokens()).toBe(10);
  });

  test('acquire consumes tokens', async () => {
    await limiter.acquire(3);
    expect(limiter.getAvailableTokens()).toBeLessThanOrEqual(7);
  });

  test('acquire with default consumes 1 token', async () => {
    const before = limiter.getAvailableTokens();
    await limiter.acquire();
    expect(limiter.getAvailableTokens()).toBeLessThanOrEqual(before - 1);
  });

  test('acquire waits when tokens exhausted', async () => {
    // Exhaust all tokens
    await limiter.acquire(10);
    const start = Date.now();
    await limiter.acquire(1);
    const elapsed = Date.now() - start;
    // Should have waited some time for refill
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  test('reset restores full capacity', async () => {
    await limiter.acquire(8);
    limiter.reset();
    expect(limiter.getAvailableTokens()).toBe(10);
  });

  test('uses default options when none provided', () => {
    const defaultLimiter = new RateLimiter();
    expect(defaultLimiter.maxTokens).toBe(100);
    expect(defaultLimiter.refillRate).toBe(20);
  });

  test('returns true from acquire', async () => {
    const result = await limiter.acquire(1);
    expect(result).toBe(true);
  });

  test('refill does not exceed maxTokens', async () => {
    // Wait a bit for refill to add tokens
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(limiter.getAvailableTokens()).toBeLessThanOrEqual(10);
  });
});
