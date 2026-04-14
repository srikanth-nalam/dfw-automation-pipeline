'use strict';

const RuleReviewScheduler = require('../../../src/vro/actions/dfw/RuleReviewScheduler');

describe('RuleReviewScheduler', () => {
  let scheduler;
  let deps;

  const pastDate = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString();
  };

  const futureDate = (daysAhead) => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    return d.toISOString();
  };

  const buildRule = (overrides = {}) => ({
    ruleId: 'DFW-R-0001',
    name: 'allow-web-to-db',
    state: 'CERTIFIED',
    owner: 'john.doe',
    review_date: futureDate(10),
    certifiedBy: 'security-architect',
    ...overrides
  });

  beforeEach(() => {
    deps = {
      ruleRegistry: {
        findExpiring: jest.fn().mockResolvedValue([
          buildRule({ ruleId: 'DFW-R-0001', review_date: futureDate(10) }),
          buildRule({ ruleId: 'DFW-R-0002', review_date: futureDate(25) })
        ]),
        updateState: jest.fn().mockResolvedValue({ state: 'EXPIRED' })
      },
      restClient: {
        post: jest.fn().mockResolvedValue({ status: 200 }),
        get: jest.fn().mockResolvedValue({ result: [] })
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      }
    };

    scheduler = new RuleReviewScheduler(deps);
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    test('throws DFW-12001 when dependencies is null', () => {
      expect(() => new RuleReviewScheduler(null)).toThrow(/DFW-12001/);
    });

    test('throws DFW-12001 when ruleRegistry is missing', () => {
      expect(() => new RuleReviewScheduler({
        restClient: deps.restClient,
        logger: deps.logger
      })).toThrow(/DFW-12001/);
    });

    test('throws DFW-12001 when restClient is missing', () => {
      expect(() => new RuleReviewScheduler({
        ruleRegistry: deps.ruleRegistry,
        logger: deps.logger
      })).toThrow(/DFW-12001/);
    });

    test('throws DFW-12001 when logger is missing', () => {
      expect(() => new RuleReviewScheduler({
        ruleRegistry: deps.ruleRegistry,
        restClient: deps.restClient
      })).toThrow(/DFW-12001/);
    });

    test('creates instance with valid dependencies', () => {
      expect(() => new RuleReviewScheduler(deps)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // scanForDueReviews
  // ---------------------------------------------------------------------------
  describe('scanForDueReviews', () => {
    test('returns rules from registry findExpiring', async () => {
      const rules = await scheduler.scanForDueReviews(30);

      expect(rules).toHaveLength(2);
      expect(deps.ruleRegistry.findExpiring).toHaveBeenCalledWith(30);
    });

    test('uses default grace period of 30 days', async () => {
      await scheduler.scanForDueReviews();

      expect(deps.ruleRegistry.findExpiring).toHaveBeenCalledWith(30);
    });

    test('passes custom grace period', async () => {
      await scheduler.scanForDueReviews(14);

      expect(deps.ruleRegistry.findExpiring).toHaveBeenCalledWith(14);
    });

    test('throws DFW-12002 when registry call fails', async () => {
      deps.ruleRegistry.findExpiring.mockRejectedValue(new Error('DB timeout'));

      await expect(scheduler.scanForDueReviews(30)).rejects.toThrow(/DFW-12002/);
    });
  });

  // ---------------------------------------------------------------------------
  // notifyOwners
  // ---------------------------------------------------------------------------
  describe('notifyOwners', () => {
    test('sends notifications for each rule', async () => {
      const rules = [
        buildRule({ ruleId: 'DFW-R-0001' }),
        buildRule({ ruleId: 'DFW-R-0002', owner: 'jane.doe' })
      ];

      const result = await scheduler.notifyOwners(rules);

      expect(result.notificationsSent).toBe(2);
      expect(result.failures).toEqual([]);
      expect(deps.restClient.post).toHaveBeenCalledTimes(2);
    });

    test('returns zero sent for empty array', async () => {
      const result = await scheduler.notifyOwners([]);

      expect(result.notificationsSent).toBe(0);
      expect(deps.restClient.post).not.toHaveBeenCalled();
    });

    test('throws DFW-12003 when rules is not an array', async () => {
      await expect(scheduler.notifyOwners('invalid')).rejects.toThrow(/DFW-12003/);
    });

    test('records failures without throwing', async () => {
      deps.restClient.post
        .mockResolvedValueOnce({ status: 200 })
        .mockRejectedValueOnce(new Error('SMTP error'));

      const rules = [
        buildRule({ ruleId: 'DFW-R-0001' }),
        buildRule({ ruleId: 'DFW-R-0002' })
      ];

      const result = await scheduler.notifyOwners(rules);

      expect(result.notificationsSent).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].ruleId).toBe('DFW-R-0002');
    });

    test('sends notification with correct structure', async () => {
      const rules = [buildRule()];

      await scheduler.notifyOwners(rules);

      const payload = deps.restClient.post.mock.calls[0][1];
      expect(payload.type).toBe('review_reminder');
      expect(payload.recipients).toBe('john.doe');
      expect(payload.subject).toContain('DFW-R-0001');
      expect(payload.body).toContain('DFW Rule Review Reminder');
    });

    test('calculates priority based on review date proximity', async () => {
      const overdueRule = buildRule({ review_date: pastDate(5) });
      const soonRule = buildRule({ ruleId: 'DFW-R-0002', review_date: futureDate(3) });

      await scheduler.notifyOwners([overdueRule, soonRule]);

      const payloads = deps.restClient.post.mock.calls.map((c) => c[1]);
      expect(payloads[0].priority).toBe(1); // Overdue
      expect(payloads[1].priority).toBe(2); // Within a week
    });
  });

  // ---------------------------------------------------------------------------
  // escalateOverdue
  // ---------------------------------------------------------------------------
  describe('escalateOverdue', () => {
    test('escalates rules past escalation threshold', async () => {
      const rules = [
        buildRule({ ruleId: 'DFW-R-0001', review_date: pastDate(20) }),
        buildRule({ ruleId: 'DFW-R-0002', review_date: pastDate(5) })
      ];

      const result = await scheduler.escalateOverdue(rules, 14);

      expect(result.escalated).toBe(1);
      expect(result.escalatedRules[0].ruleId).toBe('DFW-R-0001');
      expect(result.escalatedRules[0].daysPastDue).toBeGreaterThanOrEqual(19);
    });

    test('does not escalate rules within grace period', async () => {
      const rules = [
        buildRule({ ruleId: 'DFW-R-0001', review_date: pastDate(5) })
      ];

      const result = await scheduler.escalateOverdue(rules, 14);

      expect(result.escalated).toBe(0);
      expect(deps.restClient.post).not.toHaveBeenCalled();
    });

    test('sends escalation with priority 1', async () => {
      const rules = [buildRule({ review_date: pastDate(30) })];

      await scheduler.escalateOverdue(rules, 14);

      const payload = deps.restClient.post.mock.calls[0][1];
      expect(payload.type).toBe('escalation');
      expect(payload.priority).toBe(1);
      expect(payload.recipients).toBe('Security Architect');
    });

    test('throws DFW-12004 when rules is not an array', async () => {
      await expect(scheduler.escalateOverdue(null)).rejects.toThrow(/DFW-12004/);
    });

    test('throws DFW-12004 when REST post fails', async () => {
      deps.restClient.post.mockRejectedValue(new Error('Service down'));

      const rules = [buildRule({ review_date: pastDate(30) })];

      await expect(scheduler.escalateOverdue(rules, 14)).rejects.toThrow(/DFW-12004/);
    });

    test('skips rules without review_date', async () => {
      const rules = [buildRule({ review_date: null })];

      const result = await scheduler.escalateOverdue(rules, 14);

      expect(result.escalated).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // autoExpire
  // ---------------------------------------------------------------------------
  describe('autoExpire', () => {
    test('expires rules past the grace period', async () => {
      const rules = [
        buildRule({ ruleId: 'DFW-R-0001', review_date: pastDate(70), state: 'REVIEW_DUE' }),
        buildRule({ ruleId: 'DFW-R-0002', review_date: pastDate(30), state: 'REVIEW_DUE' })
      ];

      const result = await scheduler.autoExpire(rules, 60);

      expect(result.expired).toBe(1);
      expect(result.expiredRules[0].ruleId).toBe('DFW-R-0001');
      expect(deps.ruleRegistry.updateState).toHaveBeenCalledWith(
        'DFW-R-0001',
        'EXPIRED',
        expect.objectContaining({ changedBy: 'review-scheduler' })
      );
    });

    test('does not expire rules within grace period', async () => {
      const rules = [
        buildRule({ ruleId: 'DFW-R-0001', review_date: pastDate(30), state: 'REVIEW_DUE' })
      ];

      const result = await scheduler.autoExpire(rules, 60);

      expect(result.expired).toBe(0);
    });

    test('only expires rules in REVIEW_DUE or CERTIFIED state', async () => {
      const rules = [
        buildRule({ ruleId: 'DFW-R-0001', review_date: pastDate(90), state: 'ENFORCED' }),
        buildRule({ ruleId: 'DFW-R-0002', review_date: pastDate(90), state: 'CERTIFIED' }),
        buildRule({ ruleId: 'DFW-R-0003', review_date: pastDate(90), state: 'REVIEW_DUE' })
      ];

      const result = await scheduler.autoExpire(rules, 60);

      expect(result.expired).toBe(2);
      const expiredIds = result.expiredRules.map((r) => r.ruleId);
      expect(expiredIds).toContain('DFW-R-0002');
      expect(expiredIds).toContain('DFW-R-0003');
      expect(expiredIds).not.toContain('DFW-R-0001');
    });

    test('throws DFW-12005 when rules is not an array', async () => {
      await expect(scheduler.autoExpire('invalid')).rejects.toThrow(/DFW-12005/);
    });

    test('throws DFW-12005 when registry update fails', async () => {
      deps.ruleRegistry.updateState.mockRejectedValue(new Error('Update failed'));

      const rules = [
        buildRule({ ruleId: 'DFW-R-0001', review_date: pastDate(90), state: 'REVIEW_DUE' })
      ];

      await expect(scheduler.autoExpire(rules, 60)).rejects.toThrow(/DFW-12005/);
    });

    test('skips rules without review_date', async () => {
      const rules = [
        buildRule({ ruleId: 'DFW-R-0001', review_date: null, state: 'REVIEW_DUE' })
      ];

      const result = await scheduler.autoExpire(rules, 60);

      expect(result.expired).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // generateReviewReport
  // ---------------------------------------------------------------------------
  describe('generateReviewReport', () => {
    test('generates report with all required fields', async () => {
      const report = await scheduler.generateReviewReport();

      expect(report.timestamp).toBeDefined();
      expect(report.totalDueWithin30).toBeDefined();
      expect(report.totalDueWithin14).toBeDefined();
      expect(report.totalOverdue).toBeDefined();
      expect(report.rulesByState).toBeDefined();
      expect(report.healthScore).toBeDefined();
    });

    test('counts overdue rules correctly', async () => {
      deps.ruleRegistry.findExpiring.mockImplementation((days) => {
        if (days === 30) {
          return Promise.resolve([
            buildRule({ ruleId: 'DFW-R-0001', review_date: pastDate(5), state: 'CERTIFIED' }),
            buildRule({ ruleId: 'DFW-R-0002', review_date: futureDate(10), state: 'CERTIFIED' })
          ]);
        }
        return Promise.resolve([
          buildRule({ ruleId: 'DFW-R-0001', review_date: pastDate(5), state: 'CERTIFIED' })
        ]);
      });

      const report = await scheduler.generateReviewReport();

      expect(report.totalDueWithin30).toBe(2);
      expect(report.totalDueWithin14).toBe(1);
      expect(report.totalOverdue).toBe(1);
    });

    test('calculates health score based on overdue ratio', async () => {
      deps.ruleRegistry.findExpiring.mockResolvedValue([
        buildRule({ ruleId: 'DFW-R-0001', review_date: futureDate(5) }),
        buildRule({ ruleId: 'DFW-R-0002', review_date: futureDate(10) })
      ]);

      const report = await scheduler.generateReviewReport();

      // No overdue rules, all have future dates
      expect(report.healthScore).toBe(100);
    });

    test('returns 100% health when no rules due', async () => {
      deps.ruleRegistry.findExpiring.mockResolvedValue([]);

      const report = await scheduler.generateReviewReport();

      expect(report.healthScore).toBe(100);
      expect(report.totalDueWithin30).toBe(0);
    });

    test('groups rules by state', async () => {
      deps.ruleRegistry.findExpiring.mockResolvedValue([
        buildRule({ ruleId: 'DFW-R-0001', state: 'CERTIFIED', review_date: futureDate(5) }),
        buildRule({ ruleId: 'DFW-R-0002', state: 'CERTIFIED', review_date: futureDate(10) }),
        buildRule({ ruleId: 'DFW-R-0003', state: 'REVIEW_DUE', review_date: futureDate(3) })
      ]);

      const report = await scheduler.generateReviewReport();

      expect(report.rulesByState.CERTIFIED).toBe(2);
      expect(report.rulesByState.REVIEW_DUE).toBe(1);
    });

    test('throws DFW-12002 when registry call fails', async () => {
      deps.ruleRegistry.findExpiring.mockRejectedValue(new Error('Registry down'));

      await expect(scheduler.generateReviewReport()).rejects.toThrow(/DFW-12002/);
    });
  });
});
