'use strict';

jest.mock('../../../src/vro/actions/lifecycle/Day0Orchestrator');
jest.mock('../../../src/vro/actions/lifecycle/Day2Orchestrator');
jest.mock('../../../src/vro/actions/lifecycle/DayNOrchestrator');
jest.mock('../../../src/vro/actions/lifecycle/QuarantineOrchestrator');
jest.mock('../../../src/vro/actions/lifecycle/MigrationBulkTagger');
jest.mock('../../../src/vro/actions/dfw/RuleLifecycleManager');

const LifecycleOrchestrator = require('../../../src/vro/actions/lifecycle/LifecycleOrchestrator');
const Day0Orchestrator = require('../../../src/vro/actions/lifecycle/Day0Orchestrator');
const Day2Orchestrator = require('../../../src/vro/actions/lifecycle/Day2Orchestrator');
const DayNOrchestrator = require('../../../src/vro/actions/lifecycle/DayNOrchestrator');
const QuarantineOrchestrator = require('../../../src/vro/actions/lifecycle/QuarantineOrchestrator');
const MigrationBulkTagger = require('../../../src/vro/actions/lifecycle/MigrationBulkTagger');
const RuleLifecycleManager = require('../../../src/vro/actions/dfw/RuleLifecycleManager');

describe('LifecycleOrchestrator', () => {
  let dependencies;
  let ConcreteOrchestrator;

  beforeEach(() => {
    dependencies = {
      configLoader: {
        getEndpointsForSite: jest.fn().mockReturnValue({
          vcenterUrl: 'https://vcenter.test',
          nsxUrl: 'https://nsx.test',
          nsxGlobalUrl: 'https://nsx-global.test'
        })
      },
      restClient: {
        get: jest.fn(),
        post: jest.fn().mockResolvedValue({ statusCode: 200 }),
        patch: jest.fn(),
        delete: jest.fn()
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      },
      payloadValidator: {
        validate: jest.fn().mockResolvedValue({ valid: true })
      },
      sagaCoordinator: {
        begin: jest.fn(),
        isActive: jest.fn().mockReturnValue(false),
        compensate: jest.fn().mockResolvedValue({ compensated: 0, failed: 0, errors: [] })
      },
      deadLetterQueue: {
        enqueue: jest.fn().mockResolvedValue('DLQ-123')
      },
      tagOperations: {},
      groupVerifier: {},
      dfwValidator: {},
      snowAdapter: {}
    };

    // Create a concrete subclass for testing non-static methods
    ConcreteOrchestrator = class extends LifecycleOrchestrator {
      async prepare() { return { prepared: true }; }
      async execute() { return { executed: true }; }
      async verify() { return { verified: true }; }
    };

    // Reset mock constructors
    [Day0Orchestrator, Day2Orchestrator, DayNOrchestrator,
      QuarantineOrchestrator, MigrationBulkTagger, RuleLifecycleManager
    ].forEach(Mock => {
      Mock.mockImplementation(function () {
        this.prepare = jest.fn().mockResolvedValue({});
        this.execute = jest.fn().mockResolvedValue({});
        this.verify = jest.fn().mockResolvedValue({});
      });
    });
  });

  // ---------------------------------------------------------------------------
  // constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('cannot be instantiated directly', () => {
      expect(() => new LifecycleOrchestrator(dependencies))
        .toThrow('[DFW-6100]');
    });

    it('can be instantiated via a subclass', () => {
      const instance = new ConcreteOrchestrator(dependencies);
      expect(instance).toBeInstanceOf(LifecycleOrchestrator);
    });
  });

  // ---------------------------------------------------------------------------
  // create (factory)
  // ---------------------------------------------------------------------------
  describe('create', () => {
    it('creates a Day0Orchestrator for "Day0" request type', () => {
      LifecycleOrchestrator.create('Day0', dependencies);
      expect(Day0Orchestrator).toHaveBeenCalledWith(dependencies);
    });

    it('creates a Day2Orchestrator for "Day2" request type', () => {
      LifecycleOrchestrator.create('Day2', dependencies);
      expect(Day2Orchestrator).toHaveBeenCalledWith(dependencies);
    });

    it('creates a DayNOrchestrator for "DayN" request type', () => {
      LifecycleOrchestrator.create('DayN', dependencies);
      expect(DayNOrchestrator).toHaveBeenCalledWith(dependencies);
    });

    it('creates a QuarantineOrchestrator for "Quarantine" request type', () => {
      LifecycleOrchestrator.create('Quarantine', dependencies);
      expect(QuarantineOrchestrator).toHaveBeenCalledWith(dependencies);
    });

    it('creates a MigrationBulkTagger for "MigrationBulkTag" request type', () => {
      LifecycleOrchestrator.create('MigrationBulkTag', dependencies);
      expect(MigrationBulkTagger).toHaveBeenCalledWith(dependencies);
    });

    it('creates a RuleLifecycleManager for "RuleLifecycle" request type', () => {
      LifecycleOrchestrator.create('RuleLifecycle', dependencies);
      expect(RuleLifecycleManager).toHaveBeenCalledWith(dependencies);
    });

    it('throws for unknown request type', () => {
      expect(() => LifecycleOrchestrator.create('UnknownType', dependencies))
        .toThrow('[DFW-6105]');
    });

    it('throws for empty request type', () => {
      expect(() => LifecycleOrchestrator.create('', dependencies))
        .toThrow('[DFW-6105]');
    });
  });

  // ---------------------------------------------------------------------------
  // run
  // ---------------------------------------------------------------------------
  describe('run', () => {
    it('calls steps in correct order', async () => {
      const executionOrder = [];
      const orchestrator = new ConcreteOrchestrator(dependencies);
      orchestrator.prepare = jest.fn(async () => { executionOrder.push('prepare'); return {}; });
      orchestrator.execute = jest.fn(async () => { executionOrder.push('execute'); return {}; });
      orchestrator.verify = jest.fn(async () => { executionOrder.push('verify'); return {}; });

      const payload = {
        correlationId: 'RITM-001-123',
        requestType: 'Day0',
        site: 'NDCNG',
        callbackUrl: 'https://snow.test/callback'
      };

      const result = await orchestrator.run(payload);

      expect(result.success).toBe(true);
      expect(executionOrder).toEqual(['prepare', 'execute', 'verify']);
    });

    it('returns success result with step durations', async () => {
      const orchestrator = new ConcreteOrchestrator(dependencies);
      const payload = {
        correlationId: 'RITM-001-123',
        requestType: 'Day0',
        site: 'NDCNG'
      };

      const result = await orchestrator.run(payload);

      expect(result.success).toBe(true);
      expect(result.correlationId).toBe('RITM-001-123');
      expect(result.workflowStepDurations).toBeDefined();
    });

    it('handles failure by compensating and enqueuing to DLQ', async () => {
      const orchestrator = new ConcreteOrchestrator(dependencies);
      orchestrator.execute = jest.fn().mockRejectedValue(new Error('vCenter down'));
      dependencies.sagaCoordinator.isActive.mockReturnValue(true);

      const payload = {
        correlationId: 'RITM-001-123',
        requestType: 'Day0',
        site: 'NDCNG'
      };

      const result = await orchestrator.run(payload);

      expect(result.success).toBe(false);
      expect(dependencies.sagaCoordinator.compensate).toHaveBeenCalled();
      expect(dependencies.deadLetterQueue.enqueue).toHaveBeenCalled();
    });

    it('generates auto correlation ID when missing', async () => {
      const orchestrator = new ConcreteOrchestrator(dependencies);
      const payload = { requestType: 'Day0', site: 'NDCNG' };

      const result = await orchestrator.run(payload);

      expect(result.correlationId).toMatch(/^AUTO-\d+$/);
    });
  });

  // ---------------------------------------------------------------------------
  // validate
  // ---------------------------------------------------------------------------
  describe('validate', () => {
    it('delegates to payloadValidator', async () => {
      const orchestrator = new ConcreteOrchestrator(dependencies);
      const payload = { correlationId: 'RITM-001', requestType: 'Day0' };

      const result = await orchestrator.validate(payload);

      expect(result.valid).toBe(true);
      expect(dependencies.payloadValidator.validate).toHaveBeenCalledWith(payload);
    });

    it('throws on validation failure', async () => {
      dependencies.payloadValidator.validate.mockResolvedValue({
        valid: false,
        errors: ['Missing vmName']
      });
      const orchestrator = new ConcreteOrchestrator(dependencies);

      await expect(orchestrator.validate({ correlationId: 'RITM-001' }))
        .rejects.toThrow('[DFW-6101]');
    });
  });

  // ---------------------------------------------------------------------------
  // resolveEndpoints
  // ---------------------------------------------------------------------------
  describe('resolveEndpoints', () => {
    it('resolves endpoints for a site', async () => {
      const orchestrator = new ConcreteOrchestrator(dependencies);

      const endpoints = await orchestrator.resolveEndpoints('NDCNG');

      expect(endpoints.vcenterUrl).toBe('https://vcenter.test');
      expect(endpoints.nsxUrl).toBe('https://nsx.test');
      expect(dependencies.configLoader.getEndpointsForSite).toHaveBeenCalledWith('NDCNG');
    });
  });

  // ---------------------------------------------------------------------------
  // callback
  // ---------------------------------------------------------------------------
  describe('callback', () => {
    it('sends callback to ServiceNow', async () => {
      const orchestrator = new ConcreteOrchestrator(dependencies);
      const payload = {
        correlationId: 'RITM-001',
        requestType: 'Day0',
        callbackUrl: 'https://snow.test/api/callback'
      };
      const result = { success: true };

      await orchestrator.callback(payload, result);

      expect(dependencies.restClient.post).toHaveBeenCalledWith(
        'https://snow.test/api/callback',
        expect.objectContaining({
          correlationId: 'RITM-001',
          status: 'completed'
        })
      );
    });

    it('skips callback when no URL provided', async () => {
      const orchestrator = new ConcreteOrchestrator(dependencies);

      await orchestrator.callback({ correlationId: 'RITM-001' }, { success: true });

      expect(dependencies.restClient.post).not.toHaveBeenCalled();
      expect(dependencies.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No callback URL'),
        expect.any(Object)
      );
    });
  });
});
