const CircuitBreaker = require('../../../src/vro/actions/shared/CircuitBreaker');

describe('CircuitBreaker', () => {
  let mockLogger;

  beforeEach(() => {
    // Reset all shared state between tests
    CircuitBreaker.resetAll();

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      withCorrelation: jest.fn().mockReturnThis()
    };
  });

  afterEach(() => {
    CircuitBreaker.resetAll();
  });

  test('initial state should be CLOSED', () => {
    const breaker = new CircuitBreaker('test-endpoint', { logger: mockLogger });
    expect(breaker.getState()).toBe('CLOSED');
  });

  test('successful calls should not change state from CLOSED', async () => {
    const breaker = new CircuitBreaker('test-endpoint', {
      logger: mockLogger,
      failureThreshold: 3
    });
    const fn = jest.fn().mockResolvedValue('ok');

    await breaker.execute(fn);
    await breaker.execute(fn);
    await breaker.execute(fn);

    expect(breaker.getState()).toBe('CLOSED');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('should transition CLOSED -> OPEN after failureThreshold consecutive failures', async () => {
    const breaker = new CircuitBreaker('test-endpoint', {
      logger: mockLogger,
      failureThreshold: 3,
      windowSize: 60000
    });
    const fn = jest.fn().mockRejectedValue(new Error('service down'));

    // Trigger failures up to the threshold
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fn)).rejects.toThrow('service down');
    }

    expect(breaker.getState()).toBe('OPEN');
  });

  test('OPEN state should immediately reject calls without executing the function', async () => {
    const breaker = new CircuitBreaker('test-endpoint', {
      logger: mockLogger,
      failureThreshold: 2,
      resetTimeout: 60000,
      windowSize: 60000
    });
    const failingFn = jest.fn().mockRejectedValue(new Error('fail'));
    const normalFn = jest.fn().mockResolvedValue('should not run');

    // Trip the breaker
    await expect(breaker.execute(failingFn)).rejects.toThrow('fail');
    await expect(breaker.execute(failingFn)).rejects.toThrow('fail');
    expect(breaker.getState()).toBe('OPEN');

    // Now the breaker is OPEN — calls should be rejected without executing fn
    await expect(breaker.execute(normalFn)).rejects.toThrow('DFW-6004');
    expect(normalFn).not.toHaveBeenCalled();
  });

  test('OPEN state error should have correct code and statusCode', async () => {
    const breaker = new CircuitBreaker('test-endpoint', {
      logger: mockLogger,
      failureThreshold: 2,
      resetTimeout: 60000,
      windowSize: 60000
    });
    const failingFn = jest.fn().mockRejectedValue(new Error('fail'));

    // Trip the breaker
    await expect(breaker.execute(failingFn)).rejects.toThrow();
    await expect(breaker.execute(failingFn)).rejects.toThrow();

    try {
      await breaker.execute(jest.fn());
      throw new Error('should not reach here');
    } catch (err) {
      expect(err.code).toBe('DFW-6004');
      expect(err.statusCode).toBe(503);
      expect(err.retryable).toBe(false);
      expect(err.endpoint).toBe('test-endpoint');
    }
  });

  test('should transition OPEN -> HALF_OPEN after resetTimeout expires', async () => {
    const breaker = new CircuitBreaker('test-endpoint', {
      logger: mockLogger,
      failureThreshold: 2,
      resetTimeout: 100, // 100ms for fast testing
      windowSize: 60000
    });
    const failingFn = jest.fn().mockRejectedValue(new Error('fail'));

    // Trip the breaker
    await expect(breaker.execute(failingFn)).rejects.toThrow();
    await expect(breaker.execute(failingFn)).rejects.toThrow();
    expect(breaker.getState()).toBe('OPEN');

    // Wait for resetTimeout to elapse
    await new Promise(resolve => setTimeout(resolve, 150));

    // getState() auto-transitions OPEN -> HALF_OPEN when timeout has elapsed
    expect(breaker.getState()).toBe('HALF_OPEN');
  });

  test('should transition HALF_OPEN -> CLOSED on successful probe', async () => {
    const breaker = new CircuitBreaker('test-endpoint', {
      logger: mockLogger,
      failureThreshold: 2,
      resetTimeout: 100,
      windowSize: 60000
    });
    const failingFn = jest.fn().mockRejectedValue(new Error('fail'));
    const successFn = jest.fn().mockResolvedValue('recovered');

    // Trip the breaker
    await expect(breaker.execute(failingFn)).rejects.toThrow();
    await expect(breaker.execute(failingFn)).rejects.toThrow();

    // Wait for resetTimeout
    await new Promise(resolve => setTimeout(resolve, 150));

    // Execute a successful probe in HALF_OPEN state
    const result = await breaker.execute(successFn);
    expect(result).toBe('recovered');
    expect(breaker.getState()).toBe('CLOSED');
  });

  test('should transition HALF_OPEN -> OPEN on failed probe', async () => {
    const breaker = new CircuitBreaker('test-endpoint', {
      logger: mockLogger,
      failureThreshold: 2,
      resetTimeout: 100,
      windowSize: 60000
    });
    const failingFn = jest.fn().mockRejectedValue(new Error('still failing'));

    // Trip the breaker
    await expect(breaker.execute(failingFn)).rejects.toThrow();
    await expect(breaker.execute(failingFn)).rejects.toThrow();

    // Wait for resetTimeout
    await new Promise(resolve => setTimeout(resolve, 150));

    // Execute a failing probe in HALF_OPEN state
    await expect(breaker.execute(failingFn)).rejects.toThrow('still failing');
    expect(breaker.getState()).toBe('OPEN');
  });

  test('reset() method should return to CLOSED state', async () => {
    const breaker = new CircuitBreaker('test-endpoint', {
      logger: mockLogger,
      failureThreshold: 2,
      windowSize: 60000
    });
    const failingFn = jest.fn().mockRejectedValue(new Error('fail'));

    // Trip the breaker
    await expect(breaker.execute(failingFn)).rejects.toThrow();
    await expect(breaker.execute(failingFn)).rejects.toThrow();
    expect(breaker.getState()).toBe('OPEN');

    // Reset manually
    breaker.reset();
    expect(breaker.getState()).toBe('CLOSED');
  });

  test('getStats() should return failure count and state', async () => {
    const breaker = new CircuitBreaker('stats-endpoint', {
      logger: mockLogger,
      failureThreshold: 5,
      windowSize: 60000
    });
    const successFn = jest.fn().mockResolvedValue('ok');
    const failingFn = jest.fn().mockRejectedValue(new Error('fail'));

    await breaker.execute(successFn);
    await breaker.execute(successFn);
    await expect(breaker.execute(failingFn)).rejects.toThrow();

    const stats = breaker.getStats();
    expect(stats.name).toBe('stats-endpoint');
    expect(stats.state).toBe('CLOSED');
    expect(stats.totalSuccesses).toBe(2);
    expect(stats.totalFailures).toBe(1);
    expect(stats.consecutiveFailures).toBe(1);
    expect(stats.failureThreshold).toBe(5);
    expect(stats.recentFailures).toBe(1);
    expect(stats.lastFailureTime).not.toBeNull();
    expect(stats.lastSuccessTime).not.toBeNull();
  });

  test('successful call after failure should reset consecutiveFailures counter', async () => {
    const breaker = new CircuitBreaker('test-endpoint', {
      logger: mockLogger,
      failureThreshold: 5,
      windowSize: 60000
    });
    const failFn = jest.fn().mockRejectedValue(new Error('fail'));
    const successFn = jest.fn().mockResolvedValue('ok');

    await expect(breaker.execute(failFn)).rejects.toThrow();
    await expect(breaker.execute(failFn)).rejects.toThrow();
    await breaker.execute(successFn);

    const stats = breaker.getStats();
    expect(stats.consecutiveFailures).toBe(0);
    expect(stats.totalFailures).toBe(2);
    expect(stats.state).toBe('CLOSED');
  });

  test('should require a non-empty endpoint name', () => {
    expect(() => new CircuitBreaker('', { logger: mockLogger }))
      .toThrow('CircuitBreaker requires a non-empty endpoint name');
    expect(() => new CircuitBreaker(null, { logger: mockLogger }))
      .toThrow('CircuitBreaker requires a non-empty endpoint name');
  });

  test('static resetAll() clears all tracked endpoints', async () => {
    new CircuitBreaker('ep1', { logger: mockLogger });
    new CircuitBreaker('ep2', { logger: mockLogger });
    expect(CircuitBreaker.getTrackedEndpointCount()).toBe(2);

    CircuitBreaker.resetAll();
    expect(CircuitBreaker.getTrackedEndpointCount()).toBe(0);
  });
});
