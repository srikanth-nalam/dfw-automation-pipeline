'use strict';

const MigrationBulkTagger = require('../../../src/vro/actions/lifecycle/MigrationBulkTagger');

describe('MigrationBulkTagger', () => {
  let tagger;
  let deps;

  const buildTags = (overrides = {}) => ({
    Region: 'US-Central',
    SecurityZone: 'Greenzone',
    Environment: 'Production',
    AppCI: 'APP-001',
    SystemRole: 'WebServer',
    ...overrides
  });

  const buildVM = (id, overrides = {}) => ({
    vmId: `vm-${id}`,
    vmName: `VM-${String(id).padStart(3, '0')}`,
    tags: buildTags(),
    ...overrides
  });

  const buildManifest = (overrides = {}) => ({
    waveId: 'WAVE-001',
    vms: [buildVM(1), buildVM(2), buildVM(3)],
    site: 'NDCNG',
    scheduledDate: '2026-05-01T06:00:00Z',
    ...overrides
  });

  beforeEach(() => {
    deps = {
      tagOperations: {
        getTags: jest.fn().mockResolvedValue(buildTags()),
        applyTags: jest.fn().mockResolvedValue({ applied: true }),
        verifyPropagation: jest.fn().mockResolvedValue({ propagated: true })
      },
      cmdbValidator: {
        validateTagCompleteness: jest.fn().mockResolvedValue({
          complete: true,
          missingCategories: []
        })
      },
      migrationVerifier: {
        verifyPostMigration: jest.fn().mockResolvedValue({
          tagsPreserved: true,
          missingTags: {},
          reapplied: false,
          groupMembershipVerified: true
        })
      },
      bulkTagOrchestrator: {
        executeBulk: jest.fn().mockResolvedValue({
          status: 'completed',
          totalVMs: 3,
          successCount: 3,
          failureCount: 0,
          skippedCount: 0,
          results: [
            { vmId: 'vm-1', status: 'success' },
            { vmId: 'vm-2', status: 'success' },
            { vmId: 'vm-3', status: 'success' }
          ],
          failedVMs: []
        })
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

    tagger = new MigrationBulkTagger(deps);
  });

  // -------------------------------------------------------------------------
  // Constructor tests
  // -------------------------------------------------------------------------

  test('throws DFW-8600 when dependencies is null', () => {
    expect(() => new MigrationBulkTagger(null)).toThrow(/DFW-8600/);
  });

  test('throws DFW-8601 when tagOperations is missing', () => {
    delete deps.tagOperations;
    expect(() => new MigrationBulkTagger(deps)).toThrow(/DFW-8601/);
  });

  test('throws DFW-8602 when cmdbValidator is missing', () => {
    delete deps.cmdbValidator;
    expect(() => new MigrationBulkTagger(deps)).toThrow(/DFW-8602/);
  });

  test('throws DFW-8605 when logger is missing', () => {
    delete deps.logger;
    expect(() => new MigrationBulkTagger(deps)).toThrow(/DFW-8605/);
  });

  // -------------------------------------------------------------------------
  // loadManifest tests
  // -------------------------------------------------------------------------

  test('loads and validates a valid manifest', async () => {
    const result = await tagger.loadManifest(buildManifest());

    expect(result.waveId).toBe('WAVE-001');
    expect(result.totalVMs).toBe(3);
    expect(result.validVMs).toBe(3);
    expect(result.invalidVMs).toBe(0);
    expect(result.manifest).toBeDefined();
    expect(result.manifest.vms).toHaveLength(3);
  });

  test('throws DFW-8610 when manifest is missing waveId', async () => {
    await expect(
      tagger.loadManifest(buildManifest({ waveId: '' }))
    ).rejects.toThrow(/DFW-8610/);
  });

  test('throws DFW-8610 when manifest has empty vms array', async () => {
    await expect(
      tagger.loadManifest(buildManifest({ vms: [] }))
    ).rejects.toThrow(/DFW-8610/);
  });

  test('throws DFW-8610 when manifest is missing site', async () => {
    await expect(
      tagger.loadManifest(buildManifest({ site: '' }))
    ).rejects.toThrow(/DFW-8610/);
  });

  test('separates valid and invalid VMs in manifest', async () => {
    const manifest = buildManifest({
      vms: [
        buildVM(1),
        buildVM(2, { tags: { Region: 'US-Central' } }), // missing mandatory tags
        buildVM(3)
      ]
    });

    const result = await tagger.loadManifest(manifest);

    expect(result.validVMs).toBe(2);
    expect(result.invalidVMs).toBe(1);
  });

  test('validates mandatory tag categories on each VM', async () => {
    const manifest = buildManifest({
      vms: [
        buildVM(1, { tags: { Region: 'US-Central', SecurityZone: 'Greenzone' } })
      ]
    });

    const result = await tagger.loadManifest(manifest);

    expect(result.invalidVMs).toBe(1);
    expect(result.manifest.invalidVMs[0].errors.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // preValidate tests
  // -------------------------------------------------------------------------

  test('pre-validates all VMs against CMDB successfully', async () => {
    const { manifest } = await tagger.loadManifest(buildManifest());
    const result = await tagger.preValidate(manifest, 'NDCNG');

    expect(result.waveId).toBe('WAVE-001');
    expect(result.readyCount).toBe(3);
    expect(result.notReadyCount).toBe(0);
    expect(result.readyVMs).toHaveLength(3);
  });

  test('identifies VMs with incomplete CMDB tags', async () => {
    deps.cmdbValidator.validateTagCompleteness
      .mockResolvedValueOnce({ complete: true, missingCategories: [] })
      .mockResolvedValueOnce({ complete: false, missingCategories: ['AppCI', 'SystemRole'] })
      .mockResolvedValueOnce({ complete: true, missingCategories: [] });

    const { manifest } = await tagger.loadManifest(buildManifest());
    const result = await tagger.preValidate(manifest, 'NDCNG');

    expect(result.readyCount).toBe(2);
    expect(result.notReadyCount).toBe(1);
    expect(result.gapDetails).toHaveLength(1);
    expect(result.gapDetails[0].missingCategories).toContain('AppCI');
  });

  test('throws DFW-8620 when manifest is invalid for pre-validation', async () => {
    await expect(tagger.preValidate(null, 'NDCNG')).rejects.toThrow(/DFW-8620/);
  });

  test('throws DFW-8621 when site is missing for pre-validation', async () => {
    const { manifest } = await tagger.loadManifest(buildManifest());
    await expect(tagger.preValidate(manifest, '')).rejects.toThrow(/DFW-8621/);
  });

  test('handles CMDB validator errors gracefully during pre-validation', async () => {
    deps.cmdbValidator.validateTagCompleteness
      .mockRejectedValueOnce(new Error('CMDB timeout'));

    const { manifest } = await tagger.loadManifest(buildManifest({
      vms: [buildVM(1)]
    }));

    const result = await tagger.preValidate(manifest, 'NDCNG');

    expect(result.notReadyCount).toBe(1);
    expect(result.notReadyVMs[0].status).toBe('validation_error');
  });

  // -------------------------------------------------------------------------
  // executeWave tests
  // -------------------------------------------------------------------------

  test('executes wave tagging and returns results', async () => {
    await tagger.loadManifest(buildManifest());
    const result = await tagger.executeWave('WAVE-001', 'NDCNG');

    expect(result.waveId).toBe('WAVE-001');
    expect(result.processedCount).toBe(3);
    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(0);
    expect(result.status).toBe('completed');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  test('delegates to bulkTagOrchestrator with correct payload', async () => {
    await tagger.loadManifest(buildManifest());
    await tagger.executeWave('WAVE-001', 'NDCNG');

    expect(deps.bulkTagOrchestrator.executeBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'MIGRATION-WAVE-001',
        site: 'NDCNG',
        vms: expect.arrayContaining([
          expect.objectContaining({ vmId: 'vm-1' })
        ])
      })
    );
  });

  test('throws DFW-8630 when wave is not loaded', async () => {
    await expect(
      tagger.executeWave('WAVE-NONEXISTENT', 'NDCNG')
    ).rejects.toThrow(/DFW-8630/);
  });

  test('throws DFW-8631 when site is missing for execution', async () => {
    await tagger.loadManifest(buildManifest());
    await expect(tagger.executeWave('WAVE-001', '')).rejects.toThrow(/DFW-8631/);
  });

  test('handles bulk orchestrator failure', async () => {
    deps.bulkTagOrchestrator.executeBulk.mockRejectedValue(
      new Error('NSX API unavailable')
    );

    await tagger.loadManifest(buildManifest());

    await expect(tagger.executeWave('WAVE-001', 'NDCNG')).rejects.toThrow('NSX API unavailable');
    expect(deps.logger.error).toHaveBeenCalledWith(
      'Migration wave execution failed',
      expect.objectContaining({ waveId: 'WAVE-001' })
    );
  });

  // -------------------------------------------------------------------------
  // verifyPostMigration tests
  // -------------------------------------------------------------------------

  test('verifies all VMs with tags preserved', async () => {
    await tagger.loadManifest(buildManifest());
    const result = await tagger.verifyPostMigration('WAVE-001', 'TULNG');

    expect(result.waveId).toBe('WAVE-001');
    expect(result.verifiedCount).toBe(3);
    expect(result.driftedCount).toBe(0);
    expect(result.missingCount).toBe(0);
    expect(result.details).toHaveLength(3);
  });

  test('detects drifted tags with reapplication', async () => {
    deps.migrationVerifier.verifyPostMigration
      .mockResolvedValueOnce({ tagsPreserved: true, missingTags: {}, reapplied: false })
      .mockResolvedValueOnce({
        tagsPreserved: false,
        missingTags: { SecurityZone: 'Greenzone' },
        reapplied: true
      })
      .mockResolvedValueOnce({ tagsPreserved: true, missingTags: {}, reapplied: false });

    await tagger.loadManifest(buildManifest());
    const result = await tagger.verifyPostMigration('WAVE-001', 'TULNG');

    expect(result.verifiedCount).toBe(2);
    expect(result.driftedCount).toBe(1);
    expect(result.details[1].status).toBe('drifted_reapplied');
  });

  test('handles verification errors for individual VMs', async () => {
    deps.migrationVerifier.verifyPostMigration
      .mockResolvedValueOnce({ tagsPreserved: true, missingTags: {}, reapplied: false })
      .mockRejectedValueOnce(new Error('VM not found at destination'))
      .mockResolvedValueOnce({ tagsPreserved: true, missingTags: {}, reapplied: false });

    await tagger.loadManifest(buildManifest());
    const result = await tagger.verifyPostMigration('WAVE-001', 'TULNG');

    expect(result.verifiedCount).toBe(2);
    expect(result.missingCount).toBe(1);
    expect(result.details[1].status).toBe('verification_failed');
  });

  test('throws DFW-8640 when wave is not loaded for verification', async () => {
    await expect(
      tagger.verifyPostMigration('WAVE-MISSING', 'TULNG')
    ).rejects.toThrow(/DFW-8640/);
  });

  // -------------------------------------------------------------------------
  // generateWaveReport tests
  // -------------------------------------------------------------------------

  test('generates wave report with execution data', async () => {
    await tagger.loadManifest(buildManifest());
    await tagger.executeWave('WAVE-001', 'NDCNG');
    const report = await tagger.generateWaveReport('WAVE-001');

    expect(report.waveId).toBe('WAVE-001');
    expect(report.site).toBe('NDCNG');
    expect(report.totalVMs).toBe(3);
    expect(report.execution).toBeDefined();
    expect(report.summary).toBeDefined();
    expect(report.summary.successRate).toBe(100);
    expect(report.generatedAt).toBeDefined();
  });

  test('generates wave report without execution data (pre-execution)', async () => {
    await tagger.loadManifest(buildManifest());
    const report = await tagger.generateWaveReport('WAVE-001');

    expect(report.waveId).toBe('WAVE-001');
    expect(report.execution).toBeNull();
    expect(report.summary).toBeUndefined();
  });

  test('throws DFW-8650 when wave is not loaded for report', async () => {
    await expect(
      tagger.generateWaveReport('WAVE-MISSING')
    ).rejects.toThrow(/DFW-8650/);
  });

  // -------------------------------------------------------------------------
  // getMigrationProgress tests
  // -------------------------------------------------------------------------

  test('returns aggregated progress across multiple waves', async () => {
    await tagger.loadManifest(buildManifest({ waveId: 'WAVE-001' }));
    await tagger.loadManifest(buildManifest({ waveId: 'WAVE-002' }));
    await tagger.executeWave('WAVE-001', 'NDCNG');

    const progress = await tagger.getMigrationProgress();

    expect(progress.totalWaves).toBe(2);
    expect(progress.totalVMs).toBe(6);
    expect(progress.totalProcessed).toBe(3);
    expect(progress.totalSucceeded).toBe(3);
    expect(progress.overallProgress).toBe(50);
    expect(progress.waves).toHaveLength(2);
  });

  test('returns zero progress when no waves are loaded', async () => {
    const progress = await tagger.getMigrationProgress();

    expect(progress.totalWaves).toBe(0);
    expect(progress.totalVMs).toBe(0);
    expect(progress.overallProgress).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Static constants
  // -------------------------------------------------------------------------

  test('exports mandatory tag categories', () => {
    expect(MigrationBulkTagger.MANDATORY_TAG_CATEGORIES).toContain('Region');
    expect(MigrationBulkTagger.MANDATORY_TAG_CATEGORIES).toContain('SecurityZone');
    expect(MigrationBulkTagger.MANDATORY_TAG_CATEGORIES).toContain('Environment');
    expect(MigrationBulkTagger.MANDATORY_TAG_CATEGORIES).toContain('AppCI');
    expect(MigrationBulkTagger.MANDATORY_TAG_CATEGORIES).toContain('SystemRole');
  });

  test('exports optional tag categories', () => {
    expect(MigrationBulkTagger.OPTIONAL_TAG_CATEGORIES).toContain('Compliance');
    expect(MigrationBulkTagger.OPTIONAL_TAG_CATEGORIES).toContain('DataClassification');
    expect(MigrationBulkTagger.OPTIONAL_TAG_CATEGORIES).toContain('CostCenter');
  });
});
