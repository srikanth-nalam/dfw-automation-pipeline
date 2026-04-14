'use strict';

const GroupReconciler = require('../../../src/vro/actions/groups/GroupReconciler');

describe('GroupReconciler', () => {
  let groupVerifier;
  let restClient;
  let logger;
  let reconciler;

  beforeEach(() => {
    groupVerifier = {
      getEffectiveGroups: jest.fn(),
      predictGroupChanges: jest.fn()
    };

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

    reconciler = new GroupReconciler(groupVerifier, restClient, logger);
  });

  // ---------------------------------------------------------------------------
  // constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('throws without groupVerifier', () => {
      expect(() => new GroupReconciler(null, restClient, logger))
        .toThrow('GroupReconciler requires a groupVerifier instance');
    });

    it('throws without restClient', () => {
      expect(() => new GroupReconciler(groupVerifier, null, logger))
        .toThrow('GroupReconciler requires a restClient instance');
    });

    it('throws without logger', () => {
      expect(() => new GroupReconciler(groupVerifier, restClient, null))
        .toThrow('GroupReconciler requires a logger instance');
    });
  });

  // ---------------------------------------------------------------------------
  // reconcile
  // ---------------------------------------------------------------------------
  describe('reconcile', () => {
    it('reconciles VM with no discrepancies', async () => {
      restClient.get.mockResolvedValue({
        body: { tags: [{ scope: 'Application', tag: 'APP001' }] }
      });
      groupVerifier.predictGroupChanges.mockReturnValue({ groupsToJoin: ['group-a', 'group-b'] });
      groupVerifier.getEffectiveGroups.mockResolvedValue(['group-a', 'group-b']);

      const report = await reconciler.reconcile('vm-123', 'NDCNG', {
        expectedGroups: ['group-a', 'group-b']
      });

      expect(report.status).toBe('RECONCILED');
      expect(report.discrepancies).toEqual([]);
      expect(report.vmId).toBe('vm-123');
    });

    it('detects missing group memberships', async () => {
      groupVerifier.getEffectiveGroups.mockResolvedValue(['group-a']);

      const report = await reconciler.reconcile('vm-123', 'NDCNG', {
        expectedGroups: ['group-a', 'group-b', 'group-c']
      });

      expect(report.status).toBe('DISCREPANCIES_FOUND');
      const missingGroups = report.discrepancies
        .filter(d => d.expected === true && d.actual === false)
        .map(d => d.groupName);
      expect(missingGroups).toContain('group-b');
      expect(missingGroups).toContain('group-c');
    });

    it('detects extra group memberships', async () => {
      groupVerifier.getEffectiveGroups.mockResolvedValue(['group-a', 'group-b', 'group-extra']);

      const report = await reconciler.reconcile('vm-123', 'NDCNG', {
        expectedGroups: ['group-a', 'group-b']
      });

      expect(report.status).toBe('DISCREPANCIES_FOUND');
      const extraGroups = report.discrepancies
        .filter(d => d.expected === false && d.actual === true)
        .map(d => d.groupName);
      expect(extraGroups).toContain('group-extra');
    });

    it('handles VM with no group memberships', async () => {
      groupVerifier.getEffectiveGroups.mockResolvedValue([]);

      const report = await reconciler.reconcile('vm-new', 'NDCNG', {
        expectedGroups: ['group-a']
      });

      expect(report.status).toBe('DISCREPANCIES_FOUND');
      expect(report.actualGroups).toEqual([]);
      expect(report.discrepancies).toHaveLength(1);
    });

    it('handles empty expected groups', async () => {
      restClient.get.mockResolvedValue({
        body: { tags: [] }
      });
      groupVerifier.predictGroupChanges.mockReturnValue({ groupsToJoin: [] });
      groupVerifier.getEffectiveGroups.mockResolvedValue([]);

      const report = await reconciler.reconcile('vm-123', 'NDCNG');

      expect(report.status).toBe('RECONCILED');
      expect(report.discrepancies).toEqual([]);
    });

    it('logs reconciliation results', async () => {
      groupVerifier.getEffectiveGroups.mockResolvedValue(['group-a']);

      await reconciler.reconcile('vm-123', 'NDCNG', {
        expectedGroups: ['group-a']
      });

      expect(logger.info).toHaveBeenCalledWith(
        'Starting group reconciliation',
        expect.objectContaining({ vmId: 'vm-123', site: 'NDCNG' })
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Reconciliation complete'),
        expect.any(Object)
      );
    });

    it('handles API errors gracefully', async () => {
      groupVerifier.getEffectiveGroups.mockRejectedValue(new Error('NSX API timeout'));

      const report = await reconciler.reconcile('vm-123', 'NDCNG', {
        expectedGroups: ['group-a']
      });

      expect(report.status).toBe('ERROR');
      expect(report.error).toBeDefined();
      expect(report.error.message).toContain('NSX API timeout');
    });

    it('includes timestamps in report', async () => {
      groupVerifier.getEffectiveGroups.mockResolvedValue(['group-a']);

      const report = await reconciler.reconcile('vm-123', 'NDCNG', {
        expectedGroups: ['group-a']
      });

      expect(report.timestamp).toBeDefined();
      expect(typeof report.timestamp).toBe('string');
      expect(() => new Date(report.timestamp)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // reportDiscrepancies
  // ---------------------------------------------------------------------------
  describe('reportDiscrepancies', () => {
    it('generates structured discrepancy report', async () => {
      groupVerifier.getEffectiveGroups.mockResolvedValue(['group-a']);

      const report = await reconciler.reportDiscrepancies('vm-123', 'NDCNG', {
        expectedGroups: ['group-a', 'group-b']
      });

      expect(report.vmId).toBe('vm-123');
      expect(report.status).toBe('DISCREPANCIES_FOUND');
      expect(report.summary).toContain('1 discrepancies found');
      expect(report.summary).toContain('missing group(s)');
      expect(report.discrepancies[0]).toHaveProperty('type');
    });
  });
});
