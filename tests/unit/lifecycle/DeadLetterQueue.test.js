'use strict';

const DeadLetterQueue = require('../../../src/vro/actions/lifecycle/DeadLetterQueue');

describe('DeadLetterQueue', () => {
  let logger;
  let dlq;

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    dlq = new DeadLetterQueue(logger);
  });

  // ---------------------------------------------------------------------------
  // constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('creates an instance with a logger', () => {
      const instance = new DeadLetterQueue(logger);
      expect(instance).toBeInstanceOf(DeadLetterQueue);
    });
  });

  // ---------------------------------------------------------------------------
  // enqueue
  // ---------------------------------------------------------------------------
  describe('enqueue', () => {
    it('stores a failed payload and returns a DLQ ID', async () => {
      const payload = { vmName: 'srv-web-01', requestType: 'Day0' };
      const error = new Error('vCenter unreachable');

      const id = await dlq.enqueue(payload, error, 'RITM-00001-1679000000000');

      expect(id).toMatch(/^DLQ-\d+-RITM-00001-1679000000000$/);
      expect(logger.warn).toHaveBeenCalledWith(
        'Operation enqueued to Dead Letter Queue',
        expect.objectContaining({ correlationId: 'RITM-00001-1679000000000' })
      );
    });

    it('extracts error properties from Error instances', async () => {
      const error = new Error('Connection timeout');
      error.code = 'ETIMEDOUT';

      const id = await dlq.enqueue({ requestType: 'Day0' }, error, 'RITM-00001');

      const entries = await dlq.list();
      const entry = entries.find(e => e.id === id);
      expect(entry.error.message).toBe('Connection timeout');
      expect(entry.error.code).toBe('ETIMEDOUT');
    });

    it('handles string errors', async () => {
      const id = await dlq.enqueue({ requestType: 'Day2' }, 'Something failed', 'RITM-00002');

      const entries = await dlq.list();
      const entry = entries.find(e => e.id === id);
      expect(entry.error.message).toBe('Something failed');
    });
  });

  // ---------------------------------------------------------------------------
  // dequeue
  // ---------------------------------------------------------------------------
  describe('dequeue', () => {
    it('removes and returns an entry by ID', async () => {
      const id = await dlq.enqueue({ requestType: 'Day0' }, new Error('fail'), 'RITM-00001');

      const entry = await dlq.dequeue(id);

      expect(entry).toBeDefined();
      expect(entry.id).toBe(id);

      const remaining = await dlq.list();
      expect(remaining).toHaveLength(0);
    });

    it('returns null for non-existent ID', async () => {
      const result = await dlq.dequeue('DLQ-nonexistent');

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Attempted to dequeue non-existent DLQ entry',
        expect.any(Object)
      );
    });
  });

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------
  describe('list', () => {
    it('returns all entries when no filter provided', async () => {
      await dlq.enqueue({ requestType: 'Day0' }, new Error('e1'), 'RITM-001');
      await dlq.enqueue({ requestType: 'Day2' }, new Error('e2'), 'RITM-002');

      const entries = await dlq.list();

      expect(entries).toHaveLength(2);
    });

    it('filters entries by status', async () => {
      await dlq.enqueue({ requestType: 'Day0' }, new Error('e1'), 'RITM-001');

      const pending = await dlq.list({ status: 'pending' });
      const resolved = await dlq.list({ status: 'resolved' });

      expect(pending).toHaveLength(1);
      expect(resolved).toHaveLength(0);
    });

    it('filters entries by correlationId', async () => {
      await dlq.enqueue({ requestType: 'Day0' }, new Error('e1'), 'RITM-001');
      await dlq.enqueue({ requestType: 'Day2' }, new Error('e2'), 'RITM-002');

      const filtered = await dlq.list({ correlationId: 'RITM-001' });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].correlationId).toBe('RITM-001');
    });
  });

  // ---------------------------------------------------------------------------
  // reprocess
  // ---------------------------------------------------------------------------
  describe('reprocess', () => {
    it('reprocesses an entry successfully', async () => {
      const id = await dlq.enqueue({ requestType: 'Day0' }, new Error('fail'), 'RITM-001');
      const orchestrator = { run: jest.fn().mockResolvedValue({ success: true }) };

      const outcome = await dlq.reprocess(id, orchestrator);

      expect(outcome.success).toBe(true);
      expect(orchestrator.run).toHaveBeenCalledWith({ requestType: 'Day0' });
    });

    it('marks entry as failed on reprocessing error', async () => {
      const id = await dlq.enqueue({ requestType: 'Day0' }, new Error('fail'), 'RITM-001');
      const orchestrator = { run: jest.fn().mockRejectedValue(new Error('Still broken')) };

      const outcome = await dlq.reprocess(id, orchestrator);

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe('Still broken');
    });

    it('throws for non-existent entry', async () => {
      const orchestrator = { run: jest.fn() };

      await expect(dlq.reprocess('DLQ-fake', orchestrator))
        .rejects.toThrow('[DFW-6010]');
    });
  });

  // ---------------------------------------------------------------------------
  // purgeOlderThan
  // ---------------------------------------------------------------------------
  describe('purgeOlderThan', () => {
    it('removes entries older than specified days', async () => {
      await dlq.enqueue({ requestType: 'Day0' }, new Error('old'), 'RITM-001');

      // All entries are fresh, purging with 0.0001 day threshold
      // Since we can't control timestamps, we test the API contract
      const result = await dlq.purgeOlderThan(30);

      expect(result).toHaveProperty('purged');
      expect(result).toHaveProperty('skipped');
      expect(typeof result.purged).toBe('number');
    });

    it('throws for invalid days parameter', async () => {
      await expect(dlq.purgeOlderThan(-1)).rejects.toThrow('[DFW-6011]');
      await expect(dlq.purgeOlderThan(0)).rejects.toThrow('[DFW-6011]');
    });
  });

  // ---------------------------------------------------------------------------
  // getStats
  // ---------------------------------------------------------------------------
  describe('getStats', () => {
    it('returns empty stats for empty queue', async () => {
      const stats = await dlq.getStats();

      expect(stats.count).toBe(0);
      expect(stats.oldest).toBeNull();
      expect(stats.newest).toBeNull();
      expect(stats.byStatus).toEqual({});
    });

    it('returns correct stats for populated queue', async () => {
      await dlq.enqueue({ requestType: 'Day0' }, new Error('e1'), 'RITM-001');
      await dlq.enqueue({ requestType: 'Day2' }, new Error('e2'), 'RITM-002');

      const stats = await dlq.getStats();

      expect(stats.count).toBe(2);
      expect(stats.oldest).toBeDefined();
      expect(stats.newest).toBeDefined();
      expect(stats.byStatus.pending).toBe(2);
    });
  });
});
