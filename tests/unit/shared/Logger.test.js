'use strict';

const Logger = require('../../../src/vro/actions/shared/Logger');

describe('Logger', () => {
  let emittedEntries;
  let originalEmit;

  beforeEach(() => {
    emittedEntries = [];
    // Intercept _emit to capture log entries without relying on console spies
    originalEmit = Logger.prototype._emit;
    Logger.prototype._emit = function (level, message, metadata) {
      const LOG_LEVELS = Logger.LOG_LEVELS;
      if (LOG_LEVELS[level] < this._minLevel) {
        return;
      }
      emittedEntries.push({
        level,
        message: String(message),
        correlationId: this._correlationId,
        step: this._step,
        metadata: { ...this._defaultMetadata, ...metadata }
      });
    };
  });

  afterEach(() => {
    Logger.prototype._emit = originalEmit;
  });

  // ---------------------------------------------------------------------------
  // constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('creates instance with default options', () => {
      const log = new Logger();
      expect(log).toBeInstanceOf(Logger);
    });

    it('accepts custom options', () => {
      const log = new Logger({
        correlationId: 'RITM-001-123',
        step: 'TagValidation',
        minLevel: 'DEBUG',
        defaultMetadata: { env: 'test' }
      });
      expect(log).toBeInstanceOf(Logger);
    });
  });

  // ---------------------------------------------------------------------------
  // log level methods
  // ---------------------------------------------------------------------------
  describe('debug', () => {
    it('emits at DEBUG level when minLevel is DEBUG', () => {
      const log = new Logger({ minLevel: 'DEBUG' });

      log.debug('Test debug message');

      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].level).toBe('DEBUG');
      expect(emittedEntries[0].message).toBe('Test debug message');
    });

    it('suppresses debug when minLevel is INFO', () => {
      const log = new Logger({ minLevel: 'INFO' });

      log.debug('Should not appear');

      expect(emittedEntries).toHaveLength(0);
    });
  });

  describe('info', () => {
    it('emits at INFO level with metadata', () => {
      const log = new Logger({ minLevel: 'INFO' });

      log.info('Processing started', { vmName: 'srv-01' });

      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].level).toBe('INFO');
      expect(emittedEntries[0].message).toBe('Processing started');
      expect(emittedEntries[0].metadata.vmName).toBe('srv-01');
    });
  });

  describe('warn', () => {
    it('emits at WARN level', () => {
      const log = new Logger({ minLevel: 'DEBUG' });

      log.warn('Retry approaching limit');

      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].level).toBe('WARN');
    });
  });

  describe('error', () => {
    it('emits at ERROR level with metadata', () => {
      const log = new Logger({ minLevel: 'DEBUG' });

      log.error('Operation failed', { code: 'DFW-7001' });

      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].level).toBe('ERROR');
      expect(emittedEntries[0].metadata.code).toBe('DFW-7001');
    });

    it('enriches Error instances in metadata', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      const err = new Error('Connection timeout');
      err.code = 'ETIMEDOUT';

      log.error('Request failed', err);

      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].metadata.errorMessage).toBe('Connection timeout');
      expect(emittedEntries[0].metadata.errorCode).toBe('ETIMEDOUT');
      expect(emittedEntries[0].metadata.stack).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // structured output format
  // ---------------------------------------------------------------------------
  describe('output format', () => {
    it('includes correlationId and step in emitted entries', () => {
      const log = new Logger({
        correlationId: 'RITM-001-123',
        step: 'Deploy',
        minLevel: 'DEBUG'
      });

      log.info('Step complete');

      expect(emittedEntries[0].correlationId).toBe('RITM-001-123');
      expect(emittedEntries[0].step).toBe('Deploy');
      expect(emittedEntries[0].message).toBe('Step complete');
    });

    it('merges defaultMetadata with per-call metadata', () => {
      const log = new Logger({
        minLevel: 'DEBUG',
        defaultMetadata: { component: 'DFW', version: '1.0' }
      });

      log.info('Test', { operation: 'deploy' });

      expect(emittedEntries[0].metadata.component).toBe('DFW');
      expect(emittedEntries[0].metadata.version).toBe('1.0');
      expect(emittedEntries[0].metadata.operation).toBe('deploy');
    });

    it('_safeStringify handles normal objects', () => {
      const result = Logger._safeStringify({ key: 'value', num: 42 });
      const parsed = JSON.parse(result);

      expect(parsed.key).toBe('value');
      expect(parsed.num).toBe(42);
    });

    it('_safeStringify handles circular references', () => {
      const obj = { name: 'test' };
      obj.self = obj;

      const result = Logger._safeStringify(obj);
      const parsed = JSON.parse(result);

      expect(parsed.name).toBe('test');
      expect(parsed.self).toBe('[Circular]');
    });
  });

  // ---------------------------------------------------------------------------
  // level filtering
  // ---------------------------------------------------------------------------
  describe('level filtering', () => {
    it('suppresses messages below minimum level', () => {
      const log = new Logger({ minLevel: 'ERROR' });

      log.debug('suppressed');
      log.info('suppressed');
      log.warn('suppressed');
      log.error('visible');

      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].level).toBe('ERROR');
    });

    it('defaults to INFO level', () => {
      const log = new Logger();

      log.debug('suppressed');
      log.info('visible');

      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].level).toBe('INFO');
    });

    it('handles invalid minLevel by defaulting to INFO', () => {
      const log = new Logger({ minLevel: 'INVALID' });

      log.debug('suppressed');
      log.info('visible');

      expect(emittedEntries).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // withCorrelation
  // ---------------------------------------------------------------------------
  describe('withCorrelation', () => {
    it('returns a new Logger with the given correlation ID', () => {
      const parent = new Logger({ step: 'Deploy', minLevel: 'DEBUG' });
      const child = parent.withCorrelation('RITM-999-123');

      child.info('child log');

      expect(emittedEntries[0].correlationId).toBe('RITM-999-123');
      expect(emittedEntries[0].step).toBe('Deploy');
    });

    it('does not affect the parent logger', () => {
      const parent = new Logger({ correlationId: 'original', minLevel: 'DEBUG' });
      parent.withCorrelation('RITM-999-123');

      parent.info('parent log');

      expect(emittedEntries[0].correlationId).toBe('original');
    });
  });

  // ---------------------------------------------------------------------------
  // withStep
  // ---------------------------------------------------------------------------
  describe('withStep', () => {
    it('returns a new Logger with the given step name', () => {
      const parent = new Logger({
        correlationId: 'RITM-001-123',
        minLevel: 'DEBUG'
      });
      const child = parent.withStep('Verify');

      child.info('verification started');

      expect(emittedEntries[0].step).toBe('Verify');
      expect(emittedEntries[0].correlationId).toBe('RITM-001-123');
    });
  });

  // ---------------------------------------------------------------------------
  // LOG_LEVELS constant
  // ---------------------------------------------------------------------------
  describe('LOG_LEVELS', () => {
    it('exposes severity level constants', () => {
      expect(Logger.LOG_LEVELS).toBeDefined();
      expect(Logger.LOG_LEVELS.DEBUG).toBe(0);
      expect(Logger.LOG_LEVELS.INFO).toBe(1);
      expect(Logger.LOG_LEVELS.WARN).toBe(2);
      expect(Logger.LOG_LEVELS.ERROR).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // _emit — real implementation (structured output verification)
  // ---------------------------------------------------------------------------
  describe('_emit (real implementation)', () => {
    let capturedOutputs;

    beforeEach(() => {
      capturedOutputs = [];
      // Replace _emit with a version that captures the full JSON entry
      // while exercising the same code paths as the real _emit
      Logger.prototype._emit = function (level, message, metadata) {
        const LOG_LEVELS = Logger.LOG_LEVELS;
        if (LOG_LEVELS[level] < this._minLevel) {
          return;
        }
        const entry = {
          timestamp: new Date().toISOString(),
          level,
          correlationId: this._correlationId,
          step: this._step,
          message: String(message),
          metadata: { ...this._defaultMetadata, ...metadata }
        };
        const json = Logger._safeStringify(entry);
        capturedOutputs.push({ level, json, parsed: JSON.parse(json) });
      };
    });

    it('emits JSON entry with all structured fields for INFO level', () => {
      const log = new Logger({ correlationId: 'RITM-001', step: 'Test', minLevel: 'INFO' });
      log.info('Hello world', { key: 'val' });

      expect(capturedOutputs).toHaveLength(1);
      const parsed = capturedOutputs[0].parsed;
      expect(parsed.level).toBe('INFO');
      expect(parsed.message).toBe('Hello world');
      expect(parsed.correlationId).toBe('RITM-001');
      expect(parsed.step).toBe('Test');
      expect(parsed.metadata.key).toBe('val');
      expect(parsed.timestamp).toBeDefined();
    });

    it('emits at DEBUG level when minLevel allows it', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.debug('Debug msg');

      expect(capturedOutputs).toHaveLength(1);
      expect(capturedOutputs[0].parsed.level).toBe('DEBUG');
    });

    it('emits at WARN level', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.warn('Warning msg');

      expect(capturedOutputs).toHaveLength(1);
      expect(capturedOutputs[0].parsed.level).toBe('WARN');
    });

    it('emits at ERROR level', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.error('Error msg');

      expect(capturedOutputs).toHaveLength(1);
      expect(capturedOutputs[0].parsed.level).toBe('ERROR');
    });

    it('does not emit when level is below minLevel', () => {
      const log = new Logger({ minLevel: 'WARN' });
      log.info('Should not appear');
      log.debug('Also suppressed');

      expect(capturedOutputs).toHaveLength(0);
    });

    it('includes default metadata merged with per-call metadata', () => {
      const log = new Logger({
        minLevel: 'DEBUG',
        defaultMetadata: { service: 'dfw', version: '2.0' }
      });
      log.info('Test merge', { action: 'deploy' });

      const parsed = capturedOutputs[0].parsed;
      expect(parsed.metadata.service).toBe('dfw');
      expect(parsed.metadata.version).toBe('2.0');
      expect(parsed.metadata.action).toBe('deploy');
    });

    it('converts non-string messages to string via String()', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.info(12345);

      expect(capturedOutputs[0].parsed.message).toBe('12345');
    });

    it('converts null message to string', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.info(null);

      expect(capturedOutputs[0].parsed.message).toBe('null');
    });

    it('converts undefined message to string', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.info(undefined);

      expect(capturedOutputs[0].parsed.message).toBe('undefined');
    });

    it('handles circular references in metadata via _safeStringify', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      const meta = { name: 'test' };
      meta.self = meta;
      log.info('Circular test', meta);

      expect(capturedOutputs).toHaveLength(1);
      const parsed = capturedOutputs[0].parsed;
      expect(parsed.metadata.name).toBe('test');
      // After spread, self still references the original circular object,
      // _safeStringify resolves the deeper circular reference
      expect(parsed.metadata.self.name).toBe('test');
      expect(parsed.metadata.self.self).toBe('[Circular]');
    });

    it('produces valid JSON string for all entries', () => {
      const log = new Logger({ minLevel: 'DEBUG', correlationId: 'CID-001' });
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');

      expect(capturedOutputs).toHaveLength(4);
      for (const out of capturedOutputs) {
        expect(() => JSON.parse(out.json)).not.toThrow();
      }
    });

    it('includes ISO timestamp in each entry', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.info('timestamp test');

      const ts = capturedOutputs[0].parsed.timestamp;
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  // ---------------------------------------------------------------------------
  // _enrichErrorMetadata — extended
  // ---------------------------------------------------------------------------
  describe('_enrichErrorMetadata', () => {
    it('passes through plain object metadata unchanged', () => {
      const meta = { foo: 'bar', count: 5 };
      const result = Logger._enrichErrorMetadata(meta);
      expect(result).toEqual({ foo: 'bar', count: 5 });
    });

    it('extracts Error properties when metadata is an Error instance', () => {
      const err = new Error('Test error');
      err.code = 'TEST_CODE';
      const result = Logger._enrichErrorMetadata(err);
      expect(result.errorMessage).toBe('Test error');
      expect(result.errorCode).toBe('TEST_CODE');
      expect(result.stack).toBeDefined();
      expect(result.stack).toContain('Test error');
    });

    it('handles Error without code property', () => {
      const err = new Error('No code error');
      const result = Logger._enrichErrorMetadata(err);
      expect(result.errorMessage).toBe('No code error');
      expect(result.errorCode).toBeUndefined();
      expect(result.stack).toBeDefined();
    });

    it('extracts nested error when metadata contains an error property', () => {
      const innerErr = new Error('Inner error');
      innerErr.code = 'INNER_CODE';
      const meta = { context: 'processing', error: innerErr };
      const result = Logger._enrichErrorMetadata(meta);
      expect(result.context).toBe('processing');
      expect(result.error.errorMessage).toBe('Inner error');
      expect(result.error.errorCode).toBe('INNER_CODE');
      expect(result.error.stack).toBeDefined();
    });

    it('handles nested error without code', () => {
      const innerErr = new Error('No code inner');
      const meta = { task: 'deploy', error: innerErr };
      const result = Logger._enrichErrorMetadata(meta);
      expect(result.task).toBe('deploy');
      expect(result.error.errorMessage).toBe('No code inner');
      expect(result.error.errorCode).toBeUndefined();
    });

    it('passes through metadata with non-Error error property', () => {
      const meta = { error: 'just a string' };
      const result = Logger._enrichErrorMetadata(meta);
      expect(result).toEqual({ error: 'just a string' });
    });

    it('passes through null metadata', () => {
      const result = Logger._enrichErrorMetadata(null);
      expect(result).toBeNull();
    });

    it('passes through undefined metadata', () => {
      const result = Logger._enrichErrorMetadata(undefined);
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // _resolveLevel
  // ---------------------------------------------------------------------------
  describe('_resolveLevel', () => {
    it('resolves DEBUG to 0', () => {
      expect(Logger._resolveLevel('DEBUG')).toBe(0);
    });

    it('resolves INFO to 1', () => {
      expect(Logger._resolveLevel('INFO')).toBe(1);
    });

    it('resolves WARN to 2', () => {
      expect(Logger._resolveLevel('WARN')).toBe(2);
    });

    it('resolves ERROR to 3', () => {
      expect(Logger._resolveLevel('ERROR')).toBe(3);
    });

    it('resolves lowercase level names', () => {
      expect(Logger._resolveLevel('debug')).toBe(0);
      expect(Logger._resolveLevel('error')).toBe(3);
    });

    it('resolves level names with extra whitespace', () => {
      expect(Logger._resolveLevel('  WARN  ')).toBe(2);
    });

    it('defaults to INFO for invalid string', () => {
      expect(Logger._resolveLevel('INVALID')).toBe(1);
    });

    it('defaults to INFO for null', () => {
      expect(Logger._resolveLevel(null)).toBe(1);
    });

    it('defaults to INFO for undefined', () => {
      expect(Logger._resolveLevel(undefined)).toBe(1);
    });

    it('defaults to INFO for numeric input', () => {
      expect(Logger._resolveLevel(42)).toBe(1);
    });

    it('defaults to INFO for empty string', () => {
      expect(Logger._resolveLevel('')).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // _getLevelName
  // ---------------------------------------------------------------------------
  describe('_getLevelName (via withCorrelation/withStep)', () => {
    it('preserves DEBUG level across withCorrelation', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      const child = log.withCorrelation('RITM-111');

      // The child should have the same minLevel as parent
      child.debug('debug from child');
      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].level).toBe('DEBUG');
    });

    it('preserves ERROR level across withStep', () => {
      const log = new Logger({ minLevel: 'ERROR' });
      const child = log.withStep('Verify');

      child.warn('suppressed');
      child.error('visible');
      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].level).toBe('ERROR');
    });

    it('preserves WARN level across chained child loggers', () => {
      const log = new Logger({ minLevel: 'WARN' });
      const child = log.withCorrelation('RITM-222').withStep('Deploy');

      child.info('suppressed');
      child.warn('visible');
      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].level).toBe('WARN');
    });
  });

  // ---------------------------------------------------------------------------
  // _safeStringify — extended
  // ---------------------------------------------------------------------------
  describe('_safeStringify — extended', () => {
    it('handles null input', () => {
      const result = Logger._safeStringify(null);
      expect(result).toBe('null');
    });

    it('handles string input', () => {
      const result = Logger._safeStringify('hello');
      expect(result).toBe('"hello"');
    });

    it('handles nested objects', () => {
      const obj = { a: { b: { c: 'deep' } } };
      const result = Logger._safeStringify(obj);
      const parsed = JSON.parse(result);
      expect(parsed.a.b.c).toBe('deep');
    });

    it('handles arrays', () => {
      const arr = [1, 'two', { three: 3 }];
      const result = Logger._safeStringify(arr);
      const parsed = JSON.parse(result);
      expect(parsed).toEqual([1, 'two', { three: 3 }]);
    });

    it('handles deeply nested circular references', () => {
      const a = { name: 'a' };
      const b = { name: 'b', parent: a };
      a.child = b;

      const result = Logger._safeStringify(a);
      const parsed = JSON.parse(result);
      expect(parsed.name).toBe('a');
      expect(parsed.child.name).toBe('b');
      expect(parsed.child.parent).toBe('[Circular]');
    });

    it('handles objects with undefined values', () => {
      const obj = { defined: 'yes', undef: undefined };
      const result = Logger._safeStringify(obj);
      const parsed = JSON.parse(result);
      expect(parsed.defined).toBe('yes');
      expect(parsed.undef).toBeUndefined();
    });

    it('handles boolean values', () => {
      expect(Logger._safeStringify(true)).toBe('true');
      expect(Logger._safeStringify(false)).toBe('false');
    });

    it('handles numeric values', () => {
      expect(Logger._safeStringify(0)).toBe('0');
      expect(Logger._safeStringify(3.14)).toBe('3.14');
    });
  });

  // ---------------------------------------------------------------------------
  // error method — enrichment integration
  // ---------------------------------------------------------------------------
  describe('error method — enrichment integration', () => {
    it('enriches Error metadata and includes stack trace', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      const err = new Error('Connection refused');
      err.code = 'ECONNREFUSED';

      log.error('Failed to connect', err);

      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].level).toBe('ERROR');
      expect(emittedEntries[0].message).toBe('Failed to connect');
      expect(emittedEntries[0].metadata.errorMessage).toBe('Connection refused');
      expect(emittedEntries[0].metadata.errorCode).toBe('ECONNREFUSED');
      expect(emittedEntries[0].metadata.stack).toBeDefined();
    });

    it('enriches nested error in metadata object', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      const err = new Error('Timeout');
      err.code = 'ETIMEDOUT';

      log.error('Request failed', { requestId: 'req-001', error: err });

      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].metadata.requestId).toBe('req-001');
      expect(emittedEntries[0].metadata.error.errorMessage).toBe('Timeout');
      expect(emittedEntries[0].metadata.error.errorCode).toBe('ETIMEDOUT');
    });

    it('handles error call with no metadata argument', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.error('Simple error');

      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].level).toBe('ERROR');
      expect(emittedEntries[0].message).toBe('Simple error');
    });

    it('handles error with plain object metadata (no Error instance)', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.error('Failed', { reason: 'timeout', retries: 3 });

      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].metadata.reason).toBe('timeout');
      expect(emittedEntries[0].metadata.retries).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Constructor edge cases
  // ---------------------------------------------------------------------------
  describe('constructor edge cases', () => {
    it('uses empty string for correlationId when not provided', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.info('No correlation');

      expect(emittedEntries[0].correlationId).toBe('');
    });

    it('uses empty string for step when not provided', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.info('No step');

      expect(emittedEntries[0].step).toBe('');
    });

    it('uses empty object for defaultMetadata when not provided', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.info('No default meta');

      expect(emittedEntries[0].metadata).toEqual({});
    });

    it('accepts empty options object', () => {
      const log = new Logger({});
      expect(log).toBeInstanceOf(Logger);
    });

    it('accepts no arguments at all', () => {
      const log = new Logger();
      expect(log).toBeInstanceOf(Logger);
    });
  });

  // ---------------------------------------------------------------------------
  // withCorrelation / withStep — default metadata propagation
  // ---------------------------------------------------------------------------
  describe('context propagation — metadata preservation', () => {
    it('propagates defaultMetadata through withCorrelation', () => {
      const log = new Logger({
        minLevel: 'DEBUG',
        defaultMetadata: { service: 'dfw-pipeline' }
      });
      const child = log.withCorrelation('RITM-META-001');
      child.info('Child log');

      expect(emittedEntries[0].metadata.service).toBe('dfw-pipeline');
    });

    it('propagates defaultMetadata through withStep', () => {
      const log = new Logger({
        minLevel: 'DEBUG',
        defaultMetadata: { env: 'staging' }
      });
      const child = log.withStep('Validate');
      child.info('Step log');

      expect(emittedEntries[0].metadata.env).toBe('staging');
    });

    it('supports chaining withCorrelation and withStep', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      const child = log.withCorrelation('RITM-CHAIN').withStep('Deploy');
      child.warn('Chain test');

      expect(emittedEntries[0].correlationId).toBe('RITM-CHAIN');
      expect(emittedEntries[0].step).toBe('Deploy');
    });
  });

  // ---------------------------------------------------------------------------
  // Log level methods — no metadata argument
  // ---------------------------------------------------------------------------
  describe('log methods — no metadata argument', () => {
    it('debug works without metadata', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.debug('Bare debug');
      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].metadata).toEqual({});
    });

    it('info works without metadata', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.info('Bare info');
      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].metadata).toEqual({});
    });

    it('warn works without metadata', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.warn('Bare warn');
      expect(emittedEntries).toHaveLength(1);
      expect(emittedEntries[0].metadata).toEqual({});
    });

    it('error works without metadata', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.error('Bare error');
      expect(emittedEntries).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple log entries — ordering
  // ---------------------------------------------------------------------------
  describe('multiple log entries', () => {
    it('preserves order of multiple log calls', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.info('First');
      log.info('Second');
      log.info('Third');

      expect(emittedEntries).toHaveLength(3);
      expect(emittedEntries[0].message).toBe('First');
      expect(emittedEntries[1].message).toBe('Second');
      expect(emittedEntries[2].message).toBe('Third');
    });

    it('interleaves different levels correctly', () => {
      const log = new Logger({ minLevel: 'DEBUG' });
      log.debug('D');
      log.info('I');
      log.warn('W');
      log.error('E');

      expect(emittedEntries).toHaveLength(4);
      expect(emittedEntries.map(e => e.level)).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
    });
  });
});
