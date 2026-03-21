'use strict';

const RuleConflictDetector = require('../../../src/vro/actions/dfw/RuleConflictDetector');

describe('RuleConflictDetector', () => {
  let detector;

  beforeEach(() => {
    detector = new RuleConflictDetector();
  });

  // ---------------------------------------------------------------------------
  // detectDuplicates
  // ---------------------------------------------------------------------------
  describe('detectDuplicates', () => {
    it('finds identical rules with same source/dest/service/action', () => {
      const rules = [
        {
          name: 'allow-web-1',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'ALLOW',
          priority: 10
        },
        {
          name: 'allow-web-2',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'ALLOW',
          priority: 20
        }
      ];

      const duplicates = detector.detectDuplicates(rules);

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].ruleA).toBe('allow-web-1');
      expect(duplicates[0].ruleB).toBe('allow-web-2');
      expect(duplicates[0].reason).toContain('identical');
    });

    it('does not flag rules with different actions as duplicates', () => {
      const rules = [
        {
          name: 'allow-web',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'ALLOW',
          priority: 10
        },
        {
          name: 'deny-web',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'DROP',
          priority: 20
        }
      ];

      const duplicates = detector.detectDuplicates(rules);
      expect(duplicates).toHaveLength(0);
    });

    it('returns empty array for a single rule', () => {
      const rules = [
        {
          name: 'only-rule',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/443'],
          action: 'ALLOW',
          priority: 10
        }
      ];

      expect(detector.detectDuplicates(rules)).toEqual([]);
    });

    it('returns empty array for empty rules', () => {
      expect(detector.detectDuplicates([])).toEqual([]);
    });

    it('handles case-insensitive group comparison', () => {
      const rules = [
        {
          name: 'rule-upper',
          source_groups: ['Web-Servers'],
          destination_groups: ['DB-Servers'],
          services: ['TCP/3306'],
          action: 'ALLOW',
          priority: 10
        },
        {
          name: 'rule-lower',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'ALLOW',
          priority: 20
        }
      ];

      const duplicates = detector.detectDuplicates(rules);
      expect(duplicates).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // detectShadowed
  // ---------------------------------------------------------------------------
  describe('detectShadowed', () => {
    it('finds rules overshadowed by broader higher-priority rules', () => {
      const rules = [
        {
          name: 'allow-all-traffic',
          source_groups: [],     // ANY
          destination_groups: [], // ANY
          services: [],          // ANY
          action: 'ALLOW',
          priority: 1            // higher priority (lower number)
        },
        {
          name: 'allow-specific-web',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/443'],
          action: 'ALLOW',
          priority: 100          // lower priority (higher number) — shadowed
        }
      ];

      const shadows = detector.detectShadowed(rules);

      expect(shadows).toHaveLength(1);
      expect(shadows[0].shadowedRule).toBe('allow-specific-web');
      expect(shadows[0].shadowedBy).toBe('allow-all-traffic');
      expect(shadows[0].reason).toContain('covered by');
    });

    it('does not flag when specific rule has higher priority than broad rule', () => {
      const rules = [
        {
          name: 'specific-first',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/443'],
          action: 'ALLOW',
          priority: 1
        },
        {
          name: 'broad-second',
          source_groups: [],
          destination_groups: [],
          services: [],
          action: 'DROP',
          priority: 100
        }
      ];

      const shadows = detector.detectShadowed(rules);
      // The broad rule cannot shadow the specific one because it has lower priority
      // But the broad rule can shadow the specific one in reverse IF the broad is evaluated first.
      // Since broad has priority 100 and specific has 1, specific is higher priority.
      // So broad does NOT shadow specific.
      const specificShadowed = shadows.find(s => s.shadowedRule === 'specific-first');
      expect(specificShadowed).toBeUndefined();
    });

    it('returns empty array for single rule', () => {
      expect(detector.detectShadowed([{ name: 'only', priority: 1 }])).toEqual([]);
    });

    it('returns empty for non-overlapping rules', () => {
      const rules = [
        {
          name: 'web-rule',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/443'],
          action: 'ALLOW',
          priority: 10
        },
        {
          name: 'app-rule',
          source_groups: ['app-servers'],
          destination_groups: ['cache-servers'],
          services: ['TCP/6379'],
          action: 'ALLOW',
          priority: 20
        }
      ];

      const shadows = detector.detectShadowed(rules);
      expect(shadows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // detectContradictory
  // ---------------------------------------------------------------------------
  describe('detectContradictory', () => {
    it('finds ALLOW vs DROP for same source/dest/service', () => {
      const rules = [
        {
          name: 'allow-web',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'ALLOW',
          priority: 10
        },
        {
          name: 'deny-web',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'DROP',
          priority: 20
        }
      ];

      const conflicts = detector.detectContradictory(rules);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].ruleA).toBe('allow-web');
      expect(conflicts[0].ruleB).toBe('deny-web');
      expect(conflicts[0].reason).toContain('contradictory actions');
    });

    it('finds ALLOW vs REJECT contradiction', () => {
      const rules = [
        {
          name: 'allow-smtp',
          source_groups: ['mail-servers'],
          destination_groups: ['external'],
          services: ['TCP/25'],
          action: 'ALLOW',
          priority: 10
        },
        {
          name: 'reject-smtp',
          source_groups: ['mail-servers'],
          destination_groups: ['external'],
          services: ['TCP/25'],
          action: 'REJECT',
          priority: 20
        }
      ];

      const conflicts = detector.detectContradictory(rules);
      expect(conflicts).toHaveLength(1);
    });

    it('does not flag same-action rules as contradictory', () => {
      const rules = [
        {
          name: 'allow-web-1',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'ALLOW',
          priority: 10
        },
        {
          name: 'allow-web-2',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'ALLOW',
          priority: 20
        }
      ];

      const conflicts = detector.detectContradictory(rules);
      expect(conflicts).toEqual([]);
    });

    it('does not flag rules with different scopes as contradictory', () => {
      const rules = [
        {
          name: 'allow-web-db',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'ALLOW',
          priority: 10
        },
        {
          name: 'deny-app-cache',
          source_groups: ['app-servers'],
          destination_groups: ['cache-servers'],
          services: ['TCP/6379'],
          action: 'DROP',
          priority: 20
        }
      ];

      const conflicts = detector.detectContradictory(rules);
      expect(conflicts).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // analyze — combined summary
  // ---------------------------------------------------------------------------
  describe('analyze', () => {
    it('returns combined summary with hasIssues=true when conflicts exist', () => {
      const proposed = [
        {
          name: 'allow-web',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'ALLOW',
          priority: 10
        }
      ];

      const existing = [
        {
          name: 'deny-web',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/3306'],
          action: 'DROP',
          priority: 20
        }
      ];

      const result = detector.analyze(proposed, existing);

      expect(result.hasIssues).toBe(true);
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result).toHaveProperty('shadows');
      expect(result).toHaveProperty('duplicates');
    });

    it('returns hasIssues=false with empty arrays when no conflicts', () => {
      const proposed = [
        {
          name: 'allow-web',
          source_groups: ['web-servers'],
          destination_groups: ['db-servers'],
          services: ['TCP/443'],
          action: 'ALLOW',
          priority: 10
        }
      ];

      const existing = [
        {
          name: 'allow-app',
          source_groups: ['app-servers'],
          destination_groups: ['cache-servers'],
          services: ['TCP/6379'],
          action: 'ALLOW',
          priority: 20
        }
      ];

      const result = detector.analyze(proposed, existing);

      expect(result.hasIssues).toBe(false);
      expect(result.conflicts).toEqual([]);
      expect(result.shadows).toEqual([]);
      expect(result.duplicates).toEqual([]);
    });

    it('detects duplicates between proposed and existing rules', () => {
      const sharedRule = {
        name: 'allow-web-v1',
        source_groups: ['web-servers'],
        destination_groups: ['db-servers'],
        services: ['TCP/3306'],
        action: 'ALLOW',
        priority: 10
      };

      const proposed = [{ ...sharedRule, name: 'allow-web-proposed' }];
      const existing = [{ ...sharedRule, name: 'allow-web-existing' }];

      const result = detector.analyze(proposed, existing);

      expect(result.hasIssues).toBe(true);
      expect(result.duplicates.length).toBeGreaterThan(0);
    });

    it('handles empty proposed and existing rules', () => {
      const result = detector.analyze([], []);

      expect(result.hasIssues).toBe(false);
      expect(result.conflicts).toEqual([]);
      expect(result.shadows).toEqual([]);
      expect(result.duplicates).toEqual([]);
    });

    it('handles null/undefined inputs gracefully', () => {
      const result = detector.analyze(null, undefined);

      expect(result.hasIssues).toBe(false);
      expect(result.conflicts).toEqual([]);
    });
  });
});
