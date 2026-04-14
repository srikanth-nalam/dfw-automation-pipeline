'use strict';

const RuleRegistry = require('../../../src/vro/actions/dfw/RuleRegistry');

describe('RuleRegistry', () => {
  let registry;
  let deps;

  beforeEach(() => {
    deps = {
      restClient: {
        get: jest.fn().mockResolvedValue({
          result: {
            ruleId: 'DFW-R-0001',
            name: 'allow-web-to-db',
            state: 'REQUESTED',
            change_history: [
              { timestamp: '2026-01-01T00:00:00Z', fromState: null, toState: 'REQUESTED' }
            ]
          }
        }),
        post: jest.fn().mockResolvedValue({
          result: { sys_id: 'abc123', ruleId: 'DFW-R-0001' }
        }),
        patch: jest.fn().mockResolvedValue({
          result: { ruleId: 'DFW-R-0001', state: 'IMPACT_ANALYZED' }
        })
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      }
    };

    registry = new RuleRegistry(deps);
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    test('throws DFW-11001 when dependencies is null', () => {
      expect(() => new RuleRegistry(null)).toThrow(/DFW-11001/);
    });

    test('throws DFW-11001 when restClient is missing', () => {
      expect(() => new RuleRegistry({ logger: deps.logger })).toThrow(/DFW-11001/);
    });

    test('throws DFW-11001 when logger is missing', () => {
      expect(() => new RuleRegistry({ restClient: deps.restClient })).toThrow(/DFW-11001/);
    });

    test('creates instance with valid dependencies', () => {
      expect(() => new RuleRegistry(deps)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // generateRuleId
  // ---------------------------------------------------------------------------
  describe('generateRuleId', () => {
    test('generates sequential IDs starting at DFW-R-0001', () => {
      expect(registry.generateRuleId()).toBe('DFW-R-0001');
      expect(registry.generateRuleId()).toBe('DFW-R-0002');
      expect(registry.generateRuleId()).toBe('DFW-R-0003');
    });

    test('pads IDs to four digits', () => {
      const id = registry.generateRuleId();
      expect(id).toMatch(/^DFW-R-\d{4}$/);
    });

    test('increments independently per instance', () => {
      const other = new RuleRegistry(deps);
      expect(registry.generateRuleId()).toBe('DFW-R-0001');
      expect(other.generateRuleId()).toBe('DFW-R-0001');
      expect(registry.generateRuleId()).toBe('DFW-R-0002');
    });
  });

  // ---------------------------------------------------------------------------
  // register
  // ---------------------------------------------------------------------------
  describe('register', () => {
    test('creates record via REST post', async () => {
      const rule = { ruleId: 'DFW-R-0001', name: 'allow-web', state: 'REQUESTED' };

      await registry.register(rule);

      expect(deps.restClient.post).toHaveBeenCalledWith(
        expect.stringContaining('x_dfw_rule_registry'),
        expect.objectContaining({
          ruleId: 'DFW-R-0001',
          name: 'allow-web',
          state: 'REQUESTED'
        })
      );
    });

    test('appends initial change history entry', async () => {
      const rule = { ruleId: 'DFW-R-0001', name: 'allow-web', state: 'REQUESTED', owner: 'testuser' };

      await registry.register(rule);

      const payload = deps.restClient.post.mock.calls[0][1];
      expect(payload.change_history).toHaveLength(1);
      expect(payload.change_history[0].fromState).toBeNull();
      expect(payload.change_history[0].toState).toBe('REQUESTED');
      expect(payload.change_history[0].changedBy).toBe('testuser');
    });

    test('sets created_at and updated_at timestamps', async () => {
      const rule = { ruleId: 'DFW-R-0001', name: 'allow-web', state: 'REQUESTED' };

      await registry.register(rule);

      const payload = deps.restClient.post.mock.calls[0][1];
      expect(payload.created_at).toBeDefined();
      expect(payload.updated_at).toBeDefined();
    });

    test('throws DFW-11002 when rule is missing ruleId', async () => {
      await expect(registry.register({ name: 'test', state: 'REQUESTED' }))
        .rejects.toThrow(/DFW-11002/);
    });

    test('throws DFW-11002 when rule is missing name', async () => {
      await expect(registry.register({ ruleId: 'DFW-R-0001', state: 'REQUESTED' }))
        .rejects.toThrow(/DFW-11002/);
    });

    test('throws DFW-11002 when rule is missing state', async () => {
      await expect(registry.register({ ruleId: 'DFW-R-0001', name: 'test' }))
        .rejects.toThrow(/DFW-11002/);
    });

    test('throws DFW-11003 when REST post fails', async () => {
      deps.restClient.post.mockRejectedValue(new Error('Connection timeout'));

      await expect(
        registry.register({ ruleId: 'DFW-R-0001', name: 'test', state: 'REQUESTED' })
      ).rejects.toThrow(/DFW-11003/);
    });
  });

  // ---------------------------------------------------------------------------
  // updateState
  // ---------------------------------------------------------------------------
  describe('updateState', () => {
    test('patches rule state via REST', async () => {
      await registry.updateState('DFW-R-0001', 'IMPACT_ANALYZED', {
        reason: 'Analysis passed'
      });

      expect(deps.restClient.patch).toHaveBeenCalledWith(
        expect.stringContaining('DFW-R-0001'),
        expect.objectContaining({ state: 'IMPACT_ANALYZED' })
      );
    });

    test('appends to change history', async () => {
      await registry.updateState('DFW-R-0001', 'IMPACT_ANALYZED', {
        changedBy: 'system',
        reason: 'Test'
      });

      const payload = deps.restClient.patch.mock.calls[0][1];
      expect(payload.change_history).toHaveLength(2);
      expect(payload.change_history[1].toState).toBe('IMPACT_ANALYZED');
    });

    test('throws DFW-11004 when ruleId is empty', async () => {
      await expect(registry.updateState('', 'ENFORCED')).rejects.toThrow(/DFW-11004/);
    });

    test('throws DFW-11004 when newState is empty', async () => {
      await expect(registry.updateState('DFW-R-0001', '')).rejects.toThrow(/DFW-11004/);
    });

    test('throws DFW-11003 when REST patch fails', async () => {
      deps.restClient.patch.mockRejectedValue(new Error('Server error'));

      await expect(registry.updateState('DFW-R-0001', 'ENFORCED'))
        .rejects.toThrow(/DFW-11003/);
    });
  });

  // ---------------------------------------------------------------------------
  // getHistory
  // ---------------------------------------------------------------------------
  describe('getHistory', () => {
    test('returns change history array', async () => {
      const history = await registry.getHistory('DFW-R-0001');

      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(1);
      expect(history[0].toState).toBe('REQUESTED');
    });

    test('throws DFW-11004 when ruleId is empty', async () => {
      await expect(registry.getHistory('')).rejects.toThrow(/DFW-11004/);
    });
  });

  // ---------------------------------------------------------------------------
  // findByOwner
  // ---------------------------------------------------------------------------
  describe('findByOwner', () => {
    test('searches by owner via REST query', async () => {
      deps.restClient.get.mockResolvedValue({
        result: [
          { ruleId: 'DFW-R-0001', owner: 'john.doe' },
          { ruleId: 'DFW-R-0002', owner: 'john.doe' }
        ]
      });

      const rules = await registry.findByOwner('john.doe');

      expect(rules).toHaveLength(2);
      const url = deps.restClient.get.mock.calls[0][0];
      expect(url).toContain('owner=john.doe');
    });

    test('throws DFW-11005 when ownerId is empty', async () => {
      await expect(registry.findByOwner('')).rejects.toThrow(/DFW-11005/);
    });
  });

  // ---------------------------------------------------------------------------
  // findExpiring
  // ---------------------------------------------------------------------------
  describe('findExpiring', () => {
    test('queries for rules expiring within N days', async () => {
      deps.restClient.get.mockResolvedValue({
        result: [{ ruleId: 'DFW-R-0001', review_date: '2026-05-01T00:00:00Z' }]
      });

      const rules = await registry.findExpiring(30);

      expect(rules).toHaveLength(1);
      const url = deps.restClient.get.mock.calls[0][0];
      expect(url).toContain('review_date');
      expect(url).toContain('state!=EXPIRED');
    });

    test('defaults to 30 days', async () => {
      deps.restClient.get.mockResolvedValue({ result: [] });

      await registry.findExpiring();

      expect(deps.restClient.get).toHaveBeenCalled();
    });

    test('throws DFW-11005 when REST call fails', async () => {
      deps.restClient.get.mockRejectedValue(new Error('Timeout'));

      await expect(registry.findExpiring(14)).rejects.toThrow(/DFW-11005/);
    });
  });

  // ---------------------------------------------------------------------------
  // search
  // ---------------------------------------------------------------------------
  describe('search', () => {
    test('builds query from criteria object', async () => {
      deps.restClient.get.mockResolvedValue({
        result: [{ ruleId: 'DFW-R-0001', state: 'ENFORCED' }]
      });

      const results = await registry.search({ state: 'ENFORCED', owner: 'john' });

      expect(results).toHaveLength(1);
      const url = deps.restClient.get.mock.calls[0][0];
      expect(url).toContain('state=ENFORCED');
      expect(url).toContain('owner=john');
    });

    test('throws DFW-11005 when criteria is null', async () => {
      await expect(registry.search(null)).rejects.toThrow(/DFW-11005/);
    });

    test('throws DFW-11005 when REST call fails', async () => {
      deps.restClient.get.mockRejectedValue(new Error('Network error'));

      await expect(registry.search({ state: 'ENFORCED' })).rejects.toThrow(/DFW-11005/);
    });

    test('handles array response format', async () => {
      deps.restClient.get.mockResolvedValue([
        { ruleId: 'DFW-R-0001' }
      ]);

      const results = await registry.search({ state: 'ENFORCED' });
      expect(results).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getRule
  // ---------------------------------------------------------------------------
  describe('getRule', () => {
    test('fetches single rule by ID', async () => {
      const rule = await registry.getRule('DFW-R-0001');

      expect(rule.ruleId).toBe('DFW-R-0001');
      const url = deps.restClient.get.mock.calls[0][0];
      expect(url).toContain('DFW-R-0001');
    });

    test('throws DFW-11004 when ruleId is empty', async () => {
      await expect(registry.getRule('')).rejects.toThrow(/DFW-11004/);
    });

    test('throws DFW-11004 when REST call fails', async () => {
      deps.restClient.get.mockRejectedValue(new Error('Not found'));

      await expect(registry.getRule('DFW-R-9999')).rejects.toThrow(/DFW-11004/);
    });

    test('throws DFW-11004 when response is empty', async () => {
      deps.restClient.get.mockResolvedValue({ result: null });

      await expect(registry.getRule('DFW-R-0001')).rejects.toThrow(/DFW-11004/);
    });
  });
});
