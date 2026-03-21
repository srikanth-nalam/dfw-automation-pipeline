'use strict';

const TagCardinalityEnforcer = require('../../../src/vro/actions/tags/TagCardinalityEnforcer');

describe('TagCardinalityEnforcer', () => {
  let enforcer;

  beforeEach(() => {
    enforcer = new TagCardinalityEnforcer();
  });

  // ---------------------------------------------------------------------------
  // Single-value enforcement
  // ---------------------------------------------------------------------------
  describe('single-value enforcement', () => {
    it('replaces existing single-value tag: Application APP001 -> APP002', () => {
      const current = { Application: 'APP001', Tier: 'Web' };
      const desired = { Application: 'APP002' };

      const merged = enforcer.enforceCardinality(current, desired);

      expect(merged.Application).toBe('APP002');
      expect(merged.Tier).toBe('Web'); // unchanged
    });

    it('replaces Environment when setting a new value', () => {
      const current = { Environment: 'Production' };
      const desired = { Environment: 'Staging' };

      const merged = enforcer.enforceCardinality(current, desired);
      expect(merged.Environment).toBe('Staging');
    });

    it('sets single-value tag on empty current', () => {
      const current = {};
      const desired = { Application: 'APP001' };

      const merged = enforcer.enforceCardinality(current, desired);
      expect(merged.Application).toBe('APP001');
    });

    it('takes first element if array is passed for single-value category', () => {
      const current = {};
      const desired = { Application: ['APP001', 'APP002'] };

      const merged = enforcer.enforceCardinality(current, desired);
      expect(merged.Application).toBe('APP001');
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-value Compliance enforcement
  // ---------------------------------------------------------------------------
  describe('multi-value Compliance enforcement', () => {
    it('adds PCI to existing HIPAA — keeps both', () => {
      const current = { Compliance: ['HIPAA'] };
      const desired = { Compliance: ['PCI'] };

      const merged = enforcer.enforceCardinality(current, desired);
      expect(merged.Compliance).toEqual(expect.arrayContaining(['HIPAA', 'PCI']));
      expect(merged.Compliance).toHaveLength(2);
    });

    it('adds SOX to existing PCI+HIPAA — keeps all three', () => {
      const current = { Compliance: ['PCI', 'HIPAA'] };
      const desired = { Compliance: ['SOX'] };

      const merged = enforcer.enforceCardinality(current, desired);
      expect(merged.Compliance).toEqual(expect.arrayContaining(['PCI', 'HIPAA', 'SOX']));
      expect(merged.Compliance).toHaveLength(3);
    });

    it('deduplicates when adding PCI that already exists', () => {
      const current = { Compliance: ['PCI', 'HIPAA'] };
      const desired = { Compliance: ['PCI'] };

      const merged = enforcer.enforceCardinality(current, desired);
      expect(merged.Compliance).toEqual(expect.arrayContaining(['PCI', 'HIPAA']));
      expect(merged.Compliance).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Compliance "None" exclusivity
  // ---------------------------------------------------------------------------
  describe('Compliance "None" exclusivity', () => {
    it('setting None removes PCI/HIPAA/SOX', () => {
      const current = { Compliance: ['PCI', 'HIPAA', 'SOX'] };
      const desired = { Compliance: ['None'] };

      const merged = enforcer.enforceCardinality(current, desired);
      expect(merged.Compliance).toEqual(['None']);
    });

    it('setting None when already None keeps just None', () => {
      const current = { Compliance: ['None'] };
      const desired = { Compliance: ['None'] };

      const merged = enforcer.enforceCardinality(current, desired);
      expect(merged.Compliance).toEqual(['None']);
    });

    it('adding PCI when None exists removes None', () => {
      const current = { Compliance: ['None'] };
      const desired = { Compliance: ['PCI'] };

      const merged = enforcer.enforceCardinality(current, desired);
      expect(merged.Compliance).toEqual(['PCI']);
      expect(merged.Compliance).not.toContain('None');
    });

    it('adding HIPAA when None exists removes None and keeps only HIPAA', () => {
      const current = { Compliance: ['None'] };
      const desired = { Compliance: ['HIPAA'] };

      const merged = enforcer.enforceCardinality(current, desired);
      expect(merged.Compliance).toEqual(['HIPAA']);
    });
  });

  // ---------------------------------------------------------------------------
  // computeDelta
  // ---------------------------------------------------------------------------
  describe('computeDelta', () => {
    it('returns correct toAdd/toRemove for Application change', () => {
      const current = { Application: 'APP001', Tier: 'Web' };
      const desired = { Application: 'APP002' };

      const delta = enforcer.computeDelta(current, desired);

      expect(delta.toAdd).toEqual(
        expect.arrayContaining([{ tag: 'APP002', scope: 'Application' }])
      );
      expect(delta.toRemove).toEqual(
        expect.arrayContaining([{ tag: 'APP001', scope: 'Application' }])
      );
    });

    it('returns empty arrays when current matches desired', () => {
      const current = { Application: 'APP001', Tier: 'Web' };
      const desired = { Application: 'APP001', Tier: 'Web' };

      const delta = enforcer.computeDelta(current, desired);
      expect(delta.toAdd).toEqual([]);
      expect(delta.toRemove).toEqual([]);
    });

    it('computes delta for multi-value Compliance addition', () => {
      const current = { Compliance: ['PCI'] };
      const desired = { Compliance: ['HIPAA'] };

      const delta = enforcer.computeDelta(current, desired);
      expect(delta.toAdd).toEqual(
        expect.arrayContaining([{ tag: 'HIPAA', scope: 'Compliance' }])
      );
      // PCI should remain (not removed) because merge keeps both
      expect(delta.toRemove).toEqual([]);
    });

    it('computes delta for None exclusivity', () => {
      const current = { Compliance: ['PCI', 'HIPAA'] };
      const desired = { Compliance: ['None'] };

      const delta = enforcer.computeDelta(current, desired);
      expect(delta.toAdd).toEqual(
        expect.arrayContaining([{ tag: 'None', scope: 'Compliance' }])
      );
      expect(delta.toRemove).toEqual(
        expect.arrayContaining([
          { tag: 'PCI', scope: 'Compliance' },
          { tag: 'HIPAA', scope: 'Compliance' }
        ])
      );
    });
  });

  // ---------------------------------------------------------------------------
  // validateTagCombinations
  // ---------------------------------------------------------------------------
  describe('validateTagCombinations', () => {
    it('catches PCI + Sandbox conflict', () => {
      const tags = {
        Compliance: ['PCI'],
        Environment: 'Sandbox'
      };

      const result = enforcer.validateTagCombinations(tags);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('PCI compliance is not permitted in a Sandbox environment')
        ])
      );
    });

    it('catches HIPAA + Sandbox conflict', () => {
      const tags = {
        Compliance: ['HIPAA'],
        Environment: 'Sandbox'
      };

      const result = enforcer.validateTagCombinations(tags);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('HIPAA compliance is not permitted in a Sandbox environment')
        ])
      );
    });

    it('catches Confidential + no compliance conflict', () => {
      const tags = {
        DataClassification: 'Confidential'
        // No Compliance tag
      };

      const result = enforcer.validateTagCombinations(tags);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Confidential data classification requires a compliance tag other than None')
        ])
      );
    });

    it('catches Confidential + Compliance=None conflict', () => {
      const tags = {
        DataClassification: 'Confidential',
        Compliance: ['None']
      };

      const result = enforcer.validateTagCombinations(tags);
      expect(result.valid).toBe(false);
    });

    it('passes for valid PCI + Production combination', () => {
      const tags = {
        Application: 'APP001',
        Tier: 'Web',
        Environment: 'Production',
        Compliance: ['PCI'],
        DataClassification: 'Confidential'
      };

      const result = enforcer.validateTagCombinations(tags);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('passes for Sandbox with no compliance', () => {
      const tags = {
        Application: 'APP001',
        Environment: 'Sandbox',
        DataClassification: 'Public'
      };

      const result = enforcer.validateTagCombinations(tags);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('passes for empty tags', () => {
      const result = enforcer.validateTagCombinations({});
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getCategoryType
  // ---------------------------------------------------------------------------
  describe('getCategoryType', () => {
    it('returns "single" for Application', () => {
      expect(enforcer.getCategoryType('Application')).toBe('single');
    });

    it('returns "multi" for Compliance', () => {
      expect(enforcer.getCategoryType('Compliance')).toBe('multi');
    });

    it('returns "unknown" for unrecognized category', () => {
      expect(enforcer.getCategoryType('SomethingRandom')).toBe('unknown');
    });
  });
});
