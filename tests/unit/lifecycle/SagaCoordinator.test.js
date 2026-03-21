'use strict';

const SagaCoordinator = require('../../../src/vro/actions/lifecycle/SagaCoordinator');

describe('SagaCoordinator', () => {
  let logger;
  let saga;

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    saga = new SagaCoordinator(logger);
  });

  // ---------------------------------------------------------------------------
  // begin
  // ---------------------------------------------------------------------------
  describe('begin', () => {
    it('initializes an empty journal and marks saga as active', () => {
      saga.begin('RITM-00001-1679000000000');

      expect(saga.isActive()).toBe(true);
      expect(saga.getJournal()).toEqual([]);
      expect(logger.info).toHaveBeenCalledWith(
        'Saga started',
        expect.objectContaining({ correlationId: 'RITM-00001-1679000000000' })
      );
    });

    it('throws if a saga is already active', () => {
      saga.begin('RITM-00001');

      expect(() => saga.begin('RITM-00002'))
        .toThrow(/Cannot begin a new saga/);
    });

    it('clears previous journal entries on new begin', async () => {
      saga.begin('RITM-00001');
      await saga.recordStep('step-1', jest.fn());
      await saga.compensate(); // ends the saga

      saga.begin('RITM-00002');
      expect(saga.getJournal()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // recordStep
  // ---------------------------------------------------------------------------
  describe('recordStep', () => {
    it('adds entry to the journal with step name and compensating action', async () => {
      saga.begin('RITM-00001');
      const compensate = jest.fn();

      await saga.recordStep('provisionVM', compensate);

      const journal = saga.getJournal();
      expect(journal).toHaveLength(1);
      expect(journal[0].stepName).toBe('provisionVM');
      expect(journal[0].compensatingAction).toBe(compensate);
      expect(journal[0].compensated).toBe(false);
      expect(journal[0].timestamp).toBeDefined();
    });

    it('adds multiple steps in order', async () => {
      saga.begin('RITM-00001');
      await saga.recordStep('provisionVM', jest.fn());
      await saga.recordStep('applyTags', jest.fn());
      await saga.recordStep('verifyGroups', jest.fn());

      const journal = saga.getJournal();
      expect(journal).toHaveLength(3);
      expect(journal[0].stepName).toBe('provisionVM');
      expect(journal[1].stepName).toBe('applyTags');
      expect(journal[2].stepName).toBe('verifyGroups');
    });

    it('throws when no saga is active', async () => {
      await expect(saga.recordStep('someStep', jest.fn()))
        .rejects.toThrow(/no saga is currently active/);
    });

    it('throws when compensating action is not a function', async () => {
      saga.begin('RITM-00001');
      await expect(saga.recordStep('badStep', 'not-a-function'))
        .rejects.toThrow(/must be a function/);
    });
  });

  // ---------------------------------------------------------------------------
  // compensate — reverse order
  // ---------------------------------------------------------------------------
  describe('compensate', () => {
    it('executes compensating actions in REVERSE order', async () => {
      saga.begin('RITM-00001');

      const executionOrder = [];

      await saga.recordStep('step-1', jest.fn(async () => { executionOrder.push('compensate-1'); }));
      await saga.recordStep('step-2', jest.fn(async () => { executionOrder.push('compensate-2'); }));
      await saga.recordStep('step-3', jest.fn(async () => { executionOrder.push('compensate-3'); }));

      const result = await saga.compensate();

      // Verify reverse order: step-3, step-2, step-1
      expect(executionOrder).toEqual(['compensate-3', 'compensate-2', 'compensate-1']);
      expect(result.compensated).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it('continues even if one compensation fails', async () => {
      saga.begin('RITM-00001');

      const step1Compensate = jest.fn().mockResolvedValue(undefined);
      const step2Compensate = jest.fn().mockRejectedValue(new Error('Compensation failed'));
      const step3Compensate = jest.fn().mockResolvedValue(undefined);

      await saga.recordStep('step-1', step1Compensate);
      await saga.recordStep('step-2', step2Compensate);
      await saga.recordStep('step-3', step3Compensate);

      const result = await saga.compensate();

      // All compensations should be attempted
      expect(step3Compensate).toHaveBeenCalled(); // first (reverse)
      expect(step2Compensate).toHaveBeenCalled(); // second (fails)
      expect(step1Compensate).toHaveBeenCalled(); // third (still runs)

      expect(result.compensated).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].stepName).toBe('step-2');
      expect(result.errors[0].error).toBe('Compensation failed');
    });

    it('marks saga as inactive after compensation', async () => {
      saga.begin('RITM-00001');
      await saga.recordStep('step-1', jest.fn());

      expect(saga.isActive()).toBe(true);

      await saga.compensate();

      expect(saga.isActive()).toBe(false);
    });

    it('handles empty journal gracefully', async () => {
      saga.begin('RITM-00001');

      const result = await saga.compensate();

      expect(result.compensated).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.errors).toEqual([]);
      expect(saga.isActive()).toBe(false);
    });

    it('throws when no saga is active', async () => {
      await expect(saga.compensate())
        .rejects.toThrow(/no saga is currently active/);
    });
  });

  // ---------------------------------------------------------------------------
  // getJournal
  // ---------------------------------------------------------------------------
  describe('getJournal', () => {
    it('returns a copy of the journal (not the internal array)', async () => {
      saga.begin('RITM-00001');
      await saga.recordStep('step-1', jest.fn());

      const journal1 = saga.getJournal();
      const journal2 = saga.getJournal();

      // Different array references
      expect(journal1).not.toBe(journal2);
      // Same content
      expect(journal1).toEqual(journal2);
    });

    it('returns all recorded steps with expected properties', async () => {
      saga.begin('RITM-00001');
      const comp1 = jest.fn();
      const comp2 = jest.fn();

      await saga.recordStep('provisionVM', comp1);
      await saga.recordStep('applyTags', comp2);

      const journal = saga.getJournal();

      expect(journal).toHaveLength(2);
      expect(journal[0]).toEqual(expect.objectContaining({
        stepName: 'provisionVM',
        compensatingAction: comp1,
        compensated: false
      }));
      expect(journal[1]).toEqual(expect.objectContaining({
        stepName: 'applyTags',
        compensatingAction: comp2,
        compensated: false
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // isActive
  // ---------------------------------------------------------------------------
  describe('isActive', () => {
    it('returns false before begin', () => {
      expect(saga.isActive()).toBe(false);
    });

    it('returns true after begin', () => {
      saga.begin('RITM-00001');
      expect(saga.isActive()).toBe(true);
    });

    it('returns false after compensate', async () => {
      saga.begin('RITM-00001');
      await saga.recordStep('step-1', jest.fn());
      await saga.compensate();

      expect(saga.isActive()).toBe(false);
    });
  });
});
