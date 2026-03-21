const RetryHandler = require('../../../src/vro/actions/shared/RetryHandler');

describe('RetryHandler', () => {
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      withCorrelation: jest.fn().mockReturnThis()
    };
  });

  test('should succeed on first attempt without retry', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const handler = new RetryHandler({ logger: mockLogger });
    const result = await handler.run(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('should retry and succeed on 2nd attempt', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('success');
    const handler = new RetryHandler({
      logger: mockLogger,
      retryIntervals: [50, 100, 200]
    });
    const result = await handler.run(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('should throw after all retries exhausted', async () => {
    const error = new Error('persistent failure');
    const fn = jest.fn().mockRejectedValue(error);
    const handler = new RetryHandler({
      logger: mockLogger,
      retryIntervals: [50, 100, 200],
      maxRetries: 3
    });
    await expect(handler.run(fn)).rejects.toThrow('persistent failure');
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  test('should respect custom shouldRetry predicate', async () => {
    const err = new Error('Bad Request');
    err.status = 400;
    const fn = jest.fn().mockRejectedValue(err);
    const handler = new RetryHandler({
      logger: mockLogger,
      retryIntervals: [50],
      shouldRetry: (error) => error.status >= 500
    });
    await expect(handler.run(fn)).rejects.toThrow('Bad Request');
    expect(fn).toHaveBeenCalledTimes(1); // No retry for 400
  });

  test('should apply exponential backoff timing', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('success');
    const intervals = [50, 100, 200];
    const handler = new RetryHandler({ logger: mockLogger, retryIntervals: intervals });
    const start = Date.now();
    await handler.run(fn);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(140); // ~50 + ~100
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('should enrich error with retryCount and operationName on exhaustion', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    const handler = new RetryHandler({
      logger: mockLogger,
      retryIntervals: [10, 20],
      maxRetries: 2,
      operationName: 'fetchTags'
    });
    try {
      await handler.run(fn);
      throw new Error('should not reach here');
    } catch (err) {
      expect(err.retryCount).toBe(2);
      expect(err.operationName).toBe('fetchTags');
    }
  });

  test('should not retry errors marked as non-retryable (default predicate)', async () => {
    const err = new Error('client error');
    err.retryable = false;
    const fn = jest.fn().mockRejectedValue(err);
    const handler = new RetryHandler({
      logger: mockLogger,
      retryIntervals: [50, 100]
    });
    await expect(handler.run(fn)).rejects.toThrow('client error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('should default retryIntervals to [5000, 15000, 45000]', () => {
    const handler = new RetryHandler({ logger: mockLogger });
    expect(RetryHandler.DEFAULT_RETRY_INTERVALS).toEqual([5000, 15000, 45000]);
  });

  test('should support custom retry strategy with getDelay method', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');
    const strategy = { getDelay: jest.fn().mockReturnValue(30) };
    const handler = new RetryHandler({
      logger: mockLogger,
      retryStrategy: strategy,
      maxRetries: 3
    });
    const result = await handler.run(fn);
    expect(result).toBe('ok');
    expect(strategy.getDelay).toHaveBeenCalledWith(0);
  });

  test('static execute convenience method should work', async () => {
    const fn = jest.fn().mockResolvedValue('done');
    const result = await RetryHandler.execute(fn, { logger: mockLogger });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('should log warning on each failed attempt', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('oops'))
      .mockResolvedValue('ok');
    const handler = new RetryHandler({
      logger: mockLogger,
      retryIntervals: [10]
    });
    await handler.run(fn);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toContain('failed on attempt');
  });
});
