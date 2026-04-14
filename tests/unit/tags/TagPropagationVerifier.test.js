'use strict';

const TagPropagationVerifier = require('../../../src/vro/actions/tags/TagPropagationVerifier');

describe('TagPropagationVerifier', () => {
  let restClient;
  let logger;
  let verifier;

  beforeEach(() => {
    restClient = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn()
    };

    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    verifier = new TagPropagationVerifier(restClient, logger, {
      pollingInterval: 10,
      maxWait: 100
    });
  });

  // ---------------------------------------------------------------------------
  // constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('throws without restClient', () => {
      expect(() => new TagPropagationVerifier(null, logger))
        .toThrow('TagPropagationVerifier requires a restClient instance');
    });

    it('throws without logger', () => {
      expect(() => new TagPropagationVerifier(restClient, null))
        .toThrow('TagPropagationVerifier requires a logger instance');
    });

    it('uses default config when none provided', () => {
      const v = new TagPropagationVerifier(restClient, logger);
      expect(v.pollingInterval).toBe(10000);
      expect(v.maxWait).toBe(60000);
    });

    it('uses custom config when provided', () => {
      const v = new TagPropagationVerifier(restClient, logger, {
        pollingInterval: 5000,
        maxWait: 30000
      });
      expect(v.pollingInterval).toBe(5000);
      expect(v.maxWait).toBe(30000);
    });
  });

  // ---------------------------------------------------------------------------
  // verifyPropagation
  // ---------------------------------------------------------------------------
  describe('verifyPropagation', () => {
    it('returns synced=true when expected tags match on first poll', async () => {
      restClient.get.mockResolvedValue({
        body: {
          tags: [
            { scope: 'Application', tag: 'APP001' },
            { scope: 'Environment', tag: 'Production' }
          ]
        }
      });

      const result = await verifier.verifyPropagation(
        'vm-123',
        { Application: 'APP001', Environment: 'Production' },
        'NDCNG'
      );

      expect(result.synced).toBe(true);
      expect(result.actualTags.Application).toBe('APP001');
      expect(result.actualTags.Environment).toBe('Production');
      expect(result.duration).toBeDefined();
    });

    it('retries until tags match', async () => {
      restClient.get
        .mockResolvedValueOnce({
          body: { tags: [{ scope: 'Application', tag: 'OLD_VALUE' }] }
        })
        .mockResolvedValueOnce({
          body: { tags: [{ scope: 'Application', tag: 'APP001' }] }
        });

      const result = await verifier.verifyPropagation(
        'vm-123',
        { Application: 'APP001' },
        'NDCNG'
      );

      expect(result.synced).toBe(true);
      expect(restClient.get).toHaveBeenCalledTimes(2);
    });

    it('throws on timeout when tags never match', async () => {
      restClient.get.mockResolvedValue({
        body: { tags: [{ scope: 'Application', tag: 'WRONG' }] }
      });

      await expect(
        verifier.verifyPropagation('vm-123', { Application: 'APP001' }, 'NDCNG')
      ).rejects.toThrow(/timed out/i);
    });

    it('handles multi-value tags (Compliance)', async () => {
      restClient.get.mockResolvedValue({
        body: {
          tags: [
            { scope: 'Compliance', tag: 'PCI' },
            { scope: 'Compliance', tag: 'SOX' }
          ]
        }
      });

      const result = await verifier.verifyPropagation(
        'vm-123',
        { Compliance: ['PCI', 'SOX'] },
        'NDCNG'
      );

      expect(result.synced).toBe(true);
      expect(result.actualTags.Compliance).toEqual(expect.arrayContaining(['PCI', 'SOX']));
    });

    it('calls correct NSX URL for the given site', async () => {
      restClient.get.mockResolvedValue({
        body: { tags: [{ scope: 'Application', tag: 'APP001' }] }
      });

      await verifier.verifyPropagation('vm-123', { Application: 'APP001' }, 'TULNG');

      expect(restClient.get).toHaveBeenCalledWith(
        expect.stringContaining('nsx-manager-TULNG'),
        expect.any(Object)
      );
    });
  });

  // ---------------------------------------------------------------------------
  // waitForSync
  // ---------------------------------------------------------------------------
  describe('waitForSync', () => {
    it('returns on first successful fetch when no matchFn provided', async () => {
      restClient.get.mockResolvedValue({
        body: { tags: [{ scope: 'Application', tag: 'APP001' }] }
      });

      const result = await verifier.waitForSync('vm-123', 'NDCNG');

      expect(result.actualTags).toBeDefined();
      expect(result.attempts).toBe(1);
    });

    it('retries on fetch failure', async () => {
      restClient.get
        .mockRejectedValueOnce(new Error('Connection reset'))
        .mockResolvedValueOnce({
          body: { tags: [{ scope: 'Application', tag: 'APP001' }] }
        });

      const result = await verifier.waitForSync('vm-123', 'NDCNG', 10, 200);

      expect(result.attempts).toBe(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch tags'),
        expect.any(Object)
      );
    });

    it('throws DFW-7004 error on timeout', async () => {
      restClient.get.mockResolvedValue({
        body: { tags: [] }
      });

      const matchFn = () => false; // never matches

      await expect(
        verifier.waitForSync('vm-123', 'NDCNG', 10, 50, matchFn)
      ).rejects.toThrow(/timed out/i);
    });

    it('uses instance-level defaults when no interval/timeout provided', async () => {
      restClient.get.mockResolvedValue({
        body: { tags: [{ scope: 'Application', tag: 'APP001' }] }
      });

      const result = await verifier.waitForSync('vm-123', 'NDCNG');

      expect(result.actualTags).toBeDefined();
    });
  });
});
