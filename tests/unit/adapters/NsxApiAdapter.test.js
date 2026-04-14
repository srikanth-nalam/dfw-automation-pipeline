'use strict';

const NsxApiAdapter = require('../../../src/adapters/NsxApiAdapter');

describe('NsxApiAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new NsxApiAdapter();
  });

  test('constructor creates an instance', () => {
    expect(adapter).toBeInstanceOf(NsxApiAdapter);
  });

  describe('toNsxTagPayload', () => {
    test('converts a single-value tag map to NSX format', () => {
      const result = adapter.toNsxTagPayload({
        Application: 'APP001',
        Tier: 'Web'
      });

      expect(result).toEqual({
        tags: [
          { tag: 'APP001', scope: 'Application' },
          { tag: 'Web', scope: 'Tier' }
        ]
      });
    });

    test('converts multi-value (array) tags to one entry per value', () => {
      const result = adapter.toNsxTagPayload({
        Compliance: ['PCI', 'HIPAA']
      });

      expect(result).toEqual({
        tags: [
          { tag: 'PCI', scope: 'Compliance' },
          { tag: 'HIPAA', scope: 'Compliance' }
        ]
      });
    });

    test('handles a mix of single and multi-value tags', () => {
      const result = adapter.toNsxTagPayload({
        Application: 'APP001',
        Compliance: ['PCI', 'SOX']
      });

      expect(result.tags).toHaveLength(3);
      expect(result.tags[0]).toEqual({ tag: 'APP001', scope: 'Application' });
      expect(result.tags[1]).toEqual({ tag: 'PCI', scope: 'Compliance' });
      expect(result.tags[2]).toEqual({ tag: 'SOX', scope: 'Compliance' });
    });

    test('returns empty tags array for an empty object', () => {
      const result = adapter.toNsxTagPayload({});
      expect(result).toEqual({ tags: [] });
    });

    test('throws on null input', () => {
      expect(() => adapter.toNsxTagPayload(null)).toThrow('[DFW-2001]');
    });

    test('throws on undefined input', () => {
      expect(() => adapter.toNsxTagPayload(undefined)).toThrow('[DFW-2001]');
    });

    test('throws on array input', () => {
      expect(() => adapter.toNsxTagPayload(['a', 'b'])).toThrow('[DFW-2001]');
    });

    test('skips null and empty-string values in arrays', () => {
      const result = adapter.toNsxTagPayload({
        Compliance: ['PCI', null, '', 'HIPAA']
      });

      expect(result.tags).toEqual([
        { tag: 'PCI', scope: 'Compliance' },
        { tag: 'HIPAA', scope: 'Compliance' }
      ]);
    });

    test('trims whitespace from scopes and values', () => {
      const result = adapter.toNsxTagPayload({
        '  Application  ': '  APP001  '
      });

      expect(result.tags).toEqual([
        { tag: 'APP001', scope: 'Application' }
      ]);
    });
  });

  describe('fromNsxTagResponse', () => {
    test('converts an NSX response object with tags array to internal model', () => {
      const result = adapter.fromNsxTagResponse({
        tags: [
          { tag: 'APP001', scope: 'Application' },
          { tag: 'Web', scope: 'Tier' }
        ]
      });

      expect(result).toEqual({
        Application: 'APP001',
        Tier: 'Web'
      });
    });

    test('converts a bare array of tag objects', () => {
      const result = adapter.fromNsxTagResponse([
        { tag: 'APP001', scope: 'Application' }
      ]);

      expect(result).toEqual({ Application: 'APP001' });
    });

    test('collects multiple tags with the same scope into an array', () => {
      const result = adapter.fromNsxTagResponse({
        tags: [
          { tag: 'PCI', scope: 'Compliance' },
          { tag: 'HIPAA', scope: 'Compliance' }
        ]
      });

      expect(result).toEqual({ Compliance: ['PCI', 'HIPAA'] });
    });

    test('returns empty object for empty tags array', () => {
      expect(adapter.fromNsxTagResponse({ tags: [] })).toEqual({});
    });

    test('returns empty object for null input', () => {
      expect(adapter.fromNsxTagResponse(null)).toEqual({});
    });

    test('returns empty object for undefined input', () => {
      expect(adapter.fromNsxTagResponse(undefined)).toEqual({});
    });

    test('skips entries with missing scope or tag', () => {
      const result = adapter.fromNsxTagResponse({
        tags: [
          { tag: 'APP001', scope: 'Application' },
          { tag: '', scope: 'Empty' },
          { scope: 'NoTag' },
          { tag: 'NoScope' }
        ]
      });

      expect(result).toEqual({ Application: 'APP001' });
    });

    test('deduplicates identical tag values within the same scope', () => {
      const result = adapter.fromNsxTagResponse({
        tags: [
          { tag: 'PCI', scope: 'Compliance' },
          { tag: 'PCI', scope: 'Compliance' }
        ]
      });

      expect(result).toEqual({ Compliance: 'PCI' });
    });
  });

  describe('toGroupCriteria', () => {
    test('generates a single Condition for one tag', () => {
      const result = adapter.toGroupCriteria({ Application: 'APP001' });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        resource_type: 'Condition',
        key: 'Tag',
        member_type: 'VirtualMachine',
        value: 'Application|APP001',
        operator: 'EQUALS',
        scope_operator: 'EQUALS'
      });
    });

    test('joins multiple tags with AND conjunction operators', () => {
      const result = adapter.toGroupCriteria({
        Application: 'APP001',
        Tier: 'Web'
      });

      expect(result).toHaveLength(3);
      expect(result[0].resource_type).toBe('Condition');
      expect(result[0].value).toBe('Application|APP001');
      expect(result[1]).toEqual({
        resource_type: 'ConjunctionOperator',
        conjunction_operator: 'AND'
      });
      expect(result[2].resource_type).toBe('Condition');
      expect(result[2].value).toBe('Tier|Web');
    });

    test('wraps multi-value category in a NestedExpression with OR', () => {
      const result = adapter.toGroupCriteria({
        Compliance: ['PCI', 'HIPAA']
      });

      expect(result).toHaveLength(1);
      expect(result[0].resource_type).toBe('NestedExpression');

      const nested = result[0].expressions;
      expect(nested).toHaveLength(3);
      expect(nested[0].value).toBe('Compliance|PCI');
      expect(nested[1]).toEqual({
        resource_type: 'ConjunctionOperator',
        conjunction_operator: 'OR'
      });
      expect(nested[2].value).toBe('Compliance|HIPAA');
    });

    test('returns empty array for empty tags object', () => {
      expect(adapter.toGroupCriteria({})).toEqual([]);
    });

    test('throws on null input', () => {
      expect(() => adapter.toGroupCriteria(null)).toThrow('[DFW-2002]');
    });

    test('throws on array input', () => {
      expect(() => adapter.toGroupCriteria([1, 2])).toThrow('[DFW-2002]');
    });

    test('handles single-element array as a plain Condition (not nested)', () => {
      const result = adapter.toGroupCriteria({
        Compliance: ['PCI']
      });

      expect(result).toHaveLength(1);
      expect(result[0].resource_type).toBe('Condition');
      expect(result[0].value).toBe('Compliance|PCI');
    });
  });
});
