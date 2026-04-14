'use strict';

const NSXHygieneOrchestrator = require('../../../src/vro/actions/lifecycle/NSXHygieneOrchestrator');

describe('NSXHygieneOrchestrator', () => {
  let orchestrator;
  let deps;

  beforeEach(() => {
    deps = {
      orphanGroupCleaner: {
        sweep: jest.fn().mockResolvedValue({
          orphanedGroups: 2,
          deletedGroups: 1,
          skippedGroups: 1
        })
      },
      staleRuleReaper: {
        reap: jest.fn().mockResolvedValue({
          staleRules: 3,
          expiredRules: 1,
          unmanagedRules: 0,
          disabledRules: 3,
          skippedRules: 1
        })
      },
      policyDeployer: {
        cleanupEmptySections: jest.fn().mockResolvedValue({
          emptySections: 1,
          deletedSections: 1
        })
      },
      staleTagRemediator: {
        remediate: jest.fn().mockResolvedValue({
          totalStaleVMs: 5,
          remediatedVMs: 3,
          manualReviewVMs: 2
        })
      },
      phantomVMDetector: {
        detect: jest.fn().mockResolvedValue({
          phantomVMCount: 2
        })
      },
      unregisteredVMOnboarder: {
        onboard: jest.fn().mockResolvedValue({
          totalUnregistered: 3,
          onboarded: 2,
          manualReview: 1
        })
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      },
      configLoader: {
        getEndpointsForSite: jest.fn().mockReturnValue({
          nsxUrl: 'https://nsx-ndcng.test',
          vcenterUrl: 'https://vcenter-ndcng.test'
        })
      },
      snowAdapter: {
        toCallbackPayload: jest.fn().mockResolvedValue({ incidents: [] })
      }
    };

    orchestrator = new NSXHygieneOrchestrator(deps);
  });

  // Constructor
  test('throws when dependencies is null', () => {
    expect(() => new NSXHygieneOrchestrator(null)).toThrow(/DFW-9300/);
  });

  // FULL scope runs all tasks
  test('FULL scope runs all 6 tasks', async () => {
    const report = await orchestrator.runHygieneSweep({
      correlationId: 'HYG-001',
      site: 'NDCNG',
      scope: 'FULL',
      dryRun: true
    });

    expect(deps.phantomVMDetector.detect).toHaveBeenCalledWith('NDCNG', { dryRun: true });
    expect(deps.orphanGroupCleaner.sweep).toHaveBeenCalledWith('NDCNG', { dryRun: true });
    expect(deps.staleRuleReaper.reap).toHaveBeenCalledWith('NDCNG', { dryRun: true });
    expect(deps.policyDeployer.cleanupEmptySections).toHaveBeenCalledWith('NDCNG', { dryRun: true });
    expect(deps.staleTagRemediator.remediate).toHaveBeenCalledWith('NDCNG', { dryRun: true });
    expect(deps.unregisteredVMOnboarder.onboard).toHaveBeenCalledWith('NDCNG', { dryRun: true });

    expect(report.scope).toBe('FULL');
    expect(Object.keys(report.tasks)).toHaveLength(6);
  });

  // QUICK scope runs only fast tasks
  test('QUICK scope runs only phantom, orphanGroups, staleRules', async () => {
    const report = await orchestrator.runHygieneSweep({
      correlationId: 'HYG-002',
      site: 'NDCNG',
      scope: 'QUICK',
      dryRun: true
    });

    expect(deps.phantomVMDetector.detect).toHaveBeenCalled();
    expect(deps.orphanGroupCleaner.sweep).toHaveBeenCalled();
    expect(deps.staleRuleReaper.reap).toHaveBeenCalled();
    expect(deps.policyDeployer.cleanupEmptySections).not.toHaveBeenCalled();
    expect(deps.staleTagRemediator.remediate).not.toHaveBeenCalled();
    expect(deps.unregisteredVMOnboarder.onboard).not.toHaveBeenCalled();

    expect(report.scope).toBe('QUICK');
    expect(Object.keys(report.tasks)).toHaveLength(3);
  });

  // Aggregates metrics correctly
  test('aggregates summary metrics from all tasks', async () => {
    const report = await orchestrator.runHygieneSweep({
      correlationId: 'HYG-003',
      site: 'NDCNG',
      scope: 'FULL',
      dryRun: true
    });

    expect(report.summary.totalIssuesFound).toBeGreaterThan(0);
    expect(report.summary).toHaveProperty('autoRemediated');
    expect(report.summary).toHaveProperty('manualReviewRequired');
    expect(report.summary).toHaveProperty('incidentsCreated');
  });

  // Determines overall status
  test('returns ISSUES_FOUND when issues found but no remediation', async () => {
    deps.orphanGroupCleaner.sweep.mockResolvedValue({
      orphanedGroups: 2,
      deletedGroups: 0,
      skippedGroups: 2
    });
    deps.staleRuleReaper.reap.mockResolvedValue({
      staleRules: 0,
      expiredRules: 0,
      unmanagedRules: 0,
      disabledRules: 0,
      skippedRules: 0
    });
    deps.phantomVMDetector.detect.mockResolvedValue({ phantomVMCount: 1 });

    const report = await orchestrator.runHygieneSweep({
      correlationId: 'HYG-004',
      site: 'NDCNG',
      scope: 'QUICK',
      dryRun: true
    });

    expect(report.overallStatus).toBe('ISSUES_FOUND');
  });

  test('returns CLEAN when no issues found', async () => {
    deps.orphanGroupCleaner.sweep.mockResolvedValue({
      orphanedGroups: 0, deletedGroups: 0, skippedGroups: 0
    });
    deps.staleRuleReaper.reap.mockResolvedValue({
      staleRules: 0, expiredRules: 0, unmanagedRules: 0, disabledRules: 0, skippedRules: 0
    });
    deps.phantomVMDetector.detect.mockResolvedValue({ phantomVMCount: 0 });

    const report = await orchestrator.runHygieneSweep({
      correlationId: 'HYG-005',
      site: 'NDCNG',
      scope: 'QUICK',
      dryRun: true
    });

    expect(report.overallStatus).toBe('CLEAN');
  });

  // Individual task failure is non-blocking
  test('continues to next task when one fails', async () => {
    deps.phantomVMDetector.detect.mockRejectedValue(new Error('Detector failure'));

    const report = await orchestrator.runHygieneSweep({
      correlationId: 'HYG-006',
      site: 'NDCNG',
      scope: 'FULL',
      dryRun: true
    });

    expect(report.tasks.phantom.status).toBe('FAILED');
    expect(report.tasks.orphanGroups).toBeDefined();
    expect(report.tasks.staleRules).toBeDefined();
  });

  // Sends callback to ServiceNow
  test('sends callback when callbackUrl is provided', async () => {
    await orchestrator.runHygieneSweep({
      correlationId: 'HYG-007',
      site: 'NDCNG',
      scope: 'QUICK',
      dryRun: true,
      callbackUrl: 'https://snow.test/callback'
    });

    expect(deps.snowAdapter.toCallbackPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hygieneCallback',
        callbackUrl: 'https://snow.test/callback'
      })
    );
  });

  // Custom task list
  test('supports custom task list override', async () => {
    const report = await orchestrator.runHygieneSweep({
      correlationId: 'HYG-008',
      site: 'NDCNG',
      dryRun: true,
      tasks: ['phantom', 'staleRules']
    });

    expect(deps.phantomVMDetector.detect).toHaveBeenCalled();
    expect(deps.staleRuleReaper.reap).toHaveBeenCalled();
    expect(deps.orphanGroupCleaner.sweep).not.toHaveBeenCalled();
    expect(Object.keys(report.tasks)).toHaveLength(2);
  });

  // Report structure
  test('report contains all required fields', async () => {
    const report = await orchestrator.runHygieneSweep({
      correlationId: 'HYG-009',
      site: 'NDCNG',
      scope: 'FULL',
      dryRun: true
    });

    expect(report).toHaveProperty('correlationId');
    expect(report).toHaveProperty('site');
    expect(report).toHaveProperty('scope');
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('duration');
    expect(report).toHaveProperty('tasks');
    expect(report).toHaveProperty('summary');
    expect(report).toHaveProperty('overallStatus');
  });
});
