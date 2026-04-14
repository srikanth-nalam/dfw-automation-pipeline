'use strict';

const VcenterApiAdapter = require('../../../src/adapters/VcenterApiAdapter');

describe('VcenterApiAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new VcenterApiAdapter();
  });

  test('constructor creates an instance', () => {
    expect(adapter).toBeInstanceOf(VcenterApiAdapter);
  });

  describe('toVapiTagAssignment', () => {
    test('converts single-value tags with a VM MOID', () => {
      const result = adapter.toVapiTagAssignment(
        { Application: 'APP001', Tier: 'Web' },
        'vm-42'
      );

      expect(result).toHaveLength(2);
      expect(result[0].object_id).toEqual({ id: 'vm-42', type: 'VirtualMachine' });
      expect(result[0].tag_id).toContain('application-app001');
      expect(result[1].object_id).toEqual({ id: 'vm-42', type: 'VirtualMachine' });
      expect(result[1].tag_id).toContain('tier-web');
    });

    test('expands multi-value tags into separate assignments', () => {
      const result = adapter.toVapiTagAssignment(
        { Compliance: ['PCI', 'HIPAA'] },
        'vm-100'
      );

      expect(result).toHaveLength(2);
      expect(result[0].tag_id).toContain('compliance-pci');
      expect(result[1].tag_id).toContain('compliance-hipaa');
    });

    test('uses tagIdResolver when provided', () => {
      const resolver = {
        'Application:APP001': 'tag-id-12345',
        'Tier:Web': 'tag-id-67890'
      };

      const result = adapter.toVapiTagAssignment(
        { Application: 'APP001', Tier: 'Web' },
        'vm-42',
        resolver
      );

      expect(result[0].tag_id).toBe('tag-id-12345');
      expect(result[1].tag_id).toBe('tag-id-67890');
    });

    test('falls back to synthetic ID when resolver has no match', () => {
      const resolver = { 'Application:APP001': 'tag-id-12345' };

      const result = adapter.toVapiTagAssignment(
        { Application: 'APP001', Tier: 'Web' },
        'vm-42',
        resolver
      );

      expect(result[0].tag_id).toBe('tag-id-12345');
      expect(result[1].tag_id).toMatch(/^urn:vmomi:InventoryServiceTag:/);
    });

    test('returns empty array for empty tags object', () => {
      const result = adapter.toVapiTagAssignment({}, 'vm-42');
      expect(result).toEqual([]);
    });

    test('throws when tags is null', () => {
      expect(() => adapter.toVapiTagAssignment(null, 'vm-42')).toThrow('[DFW-2010]');
    });

    test('throws when vmMoid is empty', () => {
      expect(() => adapter.toVapiTagAssignment({ App: 'X' }, '')).toThrow('[DFW-2010]');
    });

    test('skips null and undefined values within the tag map', () => {
      const result = adapter.toVapiTagAssignment(
        { Application: 'APP001', Ignored: null, AlsoIgnored: undefined },
        'vm-42'
      );

      expect(result).toHaveLength(1);
      expect(result[0].tag_id).toContain('application-app001');
    });
  });

  describe('fromVapiTagList', () => {
    test('converts tag descriptors to internal model', () => {
      const result = adapter.fromVapiTagList([
        { category_name: 'Application', tag_name: 'APP001' },
        { category_name: 'Tier', tag_name: 'Web' }
      ]);

      expect(result).toEqual({
        Application: 'APP001',
        Tier: 'Web'
      });
    });

    test('collects multiple tags in the same category into an array', () => {
      const result = adapter.fromVapiTagList([
        { category_name: 'Compliance', tag_name: 'PCI' },
        { category_name: 'Compliance', tag_name: 'HIPAA' }
      ]);

      expect(result).toEqual({ Compliance: ['PCI', 'HIPAA'] });
    });

    test('returns empty object for empty array', () => {
      expect(adapter.fromVapiTagList([])).toEqual({});
    });

    test('returns empty object for null input', () => {
      expect(adapter.fromVapiTagList(null)).toEqual({});
    });

    test('returns empty object for undefined input', () => {
      expect(adapter.fromVapiTagList(undefined)).toEqual({});
    });

    test('falls back to category_id and tag_id when names are absent', () => {
      const result = adapter.fromVapiTagList([
        { category_id: 'cat-123', tag_id: 'tag-456' }
      ]);

      expect(result).toEqual({ 'cat-123': 'tag-456' });
    });
  });

  describe('toCategorySpec', () => {
    test('generates a category create spec with defaults', () => {
      const result = adapter.toCategorySpec('Application');

      expect(result).toEqual({
        create_spec: {
          name: 'Application',
          description: 'Tag category: Application',
          cardinality: 'SINGLE',
          associable_types: ['VirtualMachine']
        }
      });
    });

    test('accepts MULTIPLE cardinality', () => {
      const result = adapter.toCategorySpec('Compliance', 'MULTIPLE');

      expect(result.create_spec.cardinality).toBe('MULTIPLE');
    });

    test('normalizes cardinality to uppercase', () => {
      const result = adapter.toCategorySpec('Compliance', 'multiple');

      expect(result.create_spec.cardinality).toBe('MULTIPLE');
    });

    test('throws on invalid cardinality value', () => {
      expect(() => adapter.toCategorySpec('App', 'MANY')).toThrow('[DFW-2011]');
    });

    test('throws on empty category name', () => {
      expect(() => adapter.toCategorySpec('')).toThrow('[DFW-2011]');
    });

    test('throws on null category name', () => {
      expect(() => adapter.toCategorySpec(null)).toThrow('[DFW-2011]');
    });

    test('includes custom description from options', () => {
      const result = adapter.toCategorySpec('Compliance', 'MULTIPLE', {
        description: 'Regulatory compliance tags'
      });

      expect(result.create_spec.description).toBe('Regulatory compliance tags');
    });

    test('includes custom associableTypes from options', () => {
      const result = adapter.toCategorySpec('Scope', 'SINGLE', {
        associableTypes: ['VirtualMachine', 'Datastore']
      });

      expect(result.create_spec.associable_types).toEqual([
        'VirtualMachine',
        'Datastore'
      ]);
    });
  });
});
