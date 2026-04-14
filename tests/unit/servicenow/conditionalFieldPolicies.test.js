'use strict';

const {
  UI_POLICIES,
  getActivePolicies,
  getPoliciesForCatalogItem,
  getPolicyByName,
  validatePolicyDefinitions,
} = require('../../../src/servicenow/catalog/ui-policies/conditionalFieldPolicies');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('conditionalFieldPolicies', () => {

  // -- UI_POLICIES array structure --------------------------------------------

  test('UI_POLICIES is an array with 8 policy definitions', () => {
    expect(Array.isArray(UI_POLICIES)).toBe(true);
    expect(UI_POLICIES).toHaveLength(8);
  });

  test('every policy has required fields', () => {
    const requiredFields = ['name', 'table', 'catalogItem', 'order', 'actions'];

    UI_POLICIES.forEach((policy) => {
      requiredFields.forEach((field) => {
        expect(policy).toHaveProperty(field);
      });
    });
  });

  test('every policy action has a field property', () => {
    UI_POLICIES.forEach((policy) => {
      policy.actions.forEach((action) => {
        expect(action).toHaveProperty('field');
        expect(typeof action.field).toBe('string');
        expect(action.field.length).toBeGreaterThan(0);
      });
    });
  });

  // -- getActivePolicies ------------------------------------------------------

  test('getActivePolicies returns only active policies', () => {
    const active = getActivePolicies();

    active.forEach((policy) => {
      expect(policy.active).toBe(true);
    });
  });

  test('getActivePolicies returns all policies when all are active', () => {
    const active = getActivePolicies();

    expect(active.length).toBe(UI_POLICIES.filter((p) => p.active).length);
  });

  // -- getPoliciesForCatalogItem ----------------------------------------------

  test('getPoliciesForCatalogItem filters by VM Build Request', () => {
    const vmBuildPolicies = getPoliciesForCatalogItem('VM Build Request');

    expect(vmBuildPolicies.length).toBeGreaterThan(0);
    vmBuildPolicies.forEach((policy) => {
      expect(policy.catalogItem).toBe('VM Build Request');
    });
  });

  test('getPoliciesForCatalogItem filters by Tag Update Request', () => {
    const tagUpdatePolicies = getPoliciesForCatalogItem('Tag Update Request');

    expect(tagUpdatePolicies.length).toBeGreaterThan(0);
    tagUpdatePolicies.forEach((policy) => {
      expect(policy.catalogItem).toBe('Tag Update Request');
    });
  });

  test('getPoliciesForCatalogItem returns empty array for unknown item', () => {
    const result = getPoliciesForCatalogItem('Nonexistent Item');

    expect(result).toEqual([]);
  });

  // -- getPolicyByName --------------------------------------------------------

  test('getPolicyByName returns correct policy for known name', () => {
    const policy = getPolicyByName('DFW - Compliance Required for Database Tier');

    expect(policy).not.toBeNull();
    expect(policy.name).toBe('DFW - Compliance Required for Database Tier');
    expect(policy.condition).toBe('variables.tier=Database');
  });

  test('getPolicyByName returns null for unknown name', () => {
    const result = getPolicyByName('Nonexistent Policy');

    expect(result).toBeNull();
  });

  // -- validatePolicyDefinitions ----------------------------------------------

  test('validatePolicyDefinitions returns valid for current policies', () => {
    const result = validatePolicyDefinitions();

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // -- Specific policy content ------------------------------------------------

  test('Cost Center policy is always read-only with empty condition', () => {
    const policy = getPolicyByName('DFW - Cost Center Read Only');

    expect(policy).not.toBeNull();
    expect(policy.condition).toBe('');
    expect(policy.actions[0].readOnly).toBe(true);
    expect(policy.order).toBe(50);
  });

  test('Production warning banner policy has correct condition', () => {
    const policy = getPolicyByName('DFW - Production Environment Warning Banner');

    expect(policy).not.toBeNull();
    expect(policy.condition).toBe('variables.environment=Production');
    expect(policy.reverseCondition).toBe(true);
  });
});
