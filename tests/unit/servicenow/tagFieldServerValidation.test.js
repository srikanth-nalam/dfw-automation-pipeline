'use strict';

// Set up minimal globals so the IIFE can execute without ReferenceError
// when the module is first required for its exported constants.
global.current = { variables: {}, setAbortAction: jest.fn(), getValue: jest.fn() };
global.previous = null;
global.GlideRecord = jest.fn().mockImplementation(() => ({
  addQuery: jest.fn(), setLimit: jest.fn(), query: jest.fn(),
  hasNext: jest.fn(() => false), next: jest.fn(() => false), getValue: jest.fn(() => ''),
}));
global.gs = { addErrorMessage: jest.fn(), log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('tagFieldServerValidation', () => {
  // ---------------------------------------------------------------------------
  // Exported constants (IIFE runs on require but exits early with errors —
  // the module.exports block at the bottom is what we actually test here)
  // ---------------------------------------------------------------------------

  const mod = require('../../../src/servicenow/business-rules/tagFieldServerValidation');

  // -- VALID_ENVIRONMENTS -----------------------------------------------------

  describe('VALID_ENVIRONMENTS', () => {
    test('contains Production', () => {
      expect(mod.VALID_ENVIRONMENTS).toContain('Production');
    });

    test('contains all expected values', () => {
      expect(mod.VALID_ENVIRONMENTS).toEqual(
        expect.arrayContaining([
          'Production', 'Pre-Production', 'UAT', 'Staging',
          'Development', 'Sandbox', 'DR'
        ])
      );
    });
  });

  // -- VALID_REGIONS ----------------------------------------------------------

  describe('VALID_REGIONS', () => {
    test('contains NDCNG', () => {
      expect(mod.VALID_REGIONS).toContain('NDCNG');
    });

    test('contains TULNG', () => {
      expect(mod.VALID_REGIONS).toContain('TULNG');
    });
  });

  // -- VALID_SECURITY_ZONES ---------------------------------------------------

  describe('VALID_SECURITY_ZONES', () => {
    test('contains expected values', () => {
      expect(mod.VALID_SECURITY_ZONES).toEqual(
        expect.arrayContaining(['Greenzone', 'DMZ', 'Restricted', 'Management', 'External'])
      );
    });
  });

  // -- VALID_SYSTEM_ROLES -----------------------------------------------------

  describe('VALID_SYSTEM_ROLES', () => {
    test('contains expected values', () => {
      expect(mod.VALID_SYSTEM_ROLES).toEqual(
        expect.arrayContaining([
          'Web', 'Application', 'Database', 'Middleware', 'Utility', 'SharedServices'
        ])
      );
    });
  });

  // -- VALID_COMPLIANCE -------------------------------------------------------

  describe('VALID_COMPLIANCE', () => {
    test('contains PCI, HIPAA, SOX, None', () => {
      expect(mod.VALID_COMPLIANCE).toEqual(
        expect.arrayContaining(['PCI', 'HIPAA', 'SOX', 'None'])
      );
    });
  });

  // -- VALID_DATA_CLASSIFICATIONS ---------------------------------------------

  describe('VALID_DATA_CLASSIFICATIONS', () => {
    test('contains expected values', () => {
      expect(mod.VALID_DATA_CLASSIFICATIONS).toEqual(
        expect.arrayContaining(['Public', 'Internal', 'Confidential', 'Restricted'])
      );
    });
  });

  // -- VALID_SITES ------------------------------------------------------------

  describe('VALID_SITES', () => {
    test('contains NDCNG and TULNG', () => {
      expect(mod.VALID_SITES).toEqual(expect.arrayContaining(['NDCNG', 'TULNG']));
    });
  });

  // ---------------------------------------------------------------------------
  // IIFE behavioral tests — require a fresh module with mocked ServiceNow globals
  // ---------------------------------------------------------------------------

  function buildMocks(variableOverrides = {}) {
    const variables = {
      region: 'NDCNG',
      security_zone: 'Greenzone',
      environment: 'Production',
      app_ci: 'APP001',
      system_role: 'Web',
      site: 'NDCNG',
      compliance: '',
      data_classification: '',
      ...variableOverrides,
    };

    const current = {
      variables: {},
      setAbortAction: jest.fn(),
      getValue: jest.fn().mockReturnValue('RITM0010001'),
    };

    // Make variable access return wrapped values with toString()
    for (const key of Object.keys(variables)) {
      current.variables[key] = variables[key] !== null
        ? { toString: () => String(variables[key]) }
        : null;
    }

    const dictionaryRows = [];
    const conflictRows = [];

    const gs = {
      addErrorMessage: jest.fn(),
      log: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const makeGlideRecord = () => {
      return jest.fn().mockImplementation((table) => {
        let targetRows = [];
        let rowIndex = -1;
        if (table === 'u_tag_conflict_rules') {
          targetRows = conflictRows;
        }
        return {
          addQuery: jest.fn(),
          setLimit: jest.fn(),
          query: jest.fn(),
          hasNext: jest.fn().mockImplementation(() => {
            // Dictionary lookups: return true by default (value exists)
            if (table === 'u_enterprise_tag_dictionary') {
              return true;
            }
            return rowIndex + 1 < targetRows.length;
          }),
          next: jest.fn().mockImplementation(() => {
            rowIndex++;
            return rowIndex < targetRows.length;
          }),
          getValue: jest.fn().mockImplementation((field) => {
            if (rowIndex >= 0 && rowIndex < targetRows.length) {
              return targetRows[rowIndex][field] || '';
            }
            return '';
          }),
        };
      });
    };

    return { current, gs, GlideRecord: makeGlideRecord(), dictionaryRows, conflictRows };
  }

  function runRule(variableOverrides = {}, opts = {}) {
    const mocks = buildMocks(variableOverrides);
    // Allow dictionary lookups to succeed by default
    if (!opts.dictionaryFails) {
      // GlideRecord for dictionary will return hasNext=true by default (see buildMocks)
    }

    let aborted = false;
    let errorMessage = '';

    jest.isolateModules(() => {
      global.GlideRecord = mocks.GlideRecord;
      global.gs = mocks.gs;
      global.current = mocks.current;
      global.previous = null;

      require('../../../src/servicenow/business-rules/tagFieldServerValidation');

      aborted = mocks.current.setAbortAction.mock.calls.length > 0;
      if (mocks.gs.addErrorMessage.mock.calls.length > 0) {
        errorMessage = mocks.gs.addErrorMessage.mock.calls[0][0];
      }
    });

    // Clean up
    delete global.GlideRecord;
    delete global.gs;
    delete global.current;
    delete global.previous;

    return { aborted, errorMessage, mocks };
  }

  // -- Mandatory field validation ---------------------------------------------

  test('validates all 5 mandatory tag fields present', () => {
    const { aborted } = runRule({
      region: 'NDCNG',
      security_zone: 'Greenzone',
      environment: 'Production',
      app_ci: 'APP001',
      system_role: 'Web',
      site: 'NDCNG',
    });
    expect(aborted).toBe(false);
  });

  test('rejects missing Region field', () => {
    const { aborted, errorMessage } = runRule({ region: '' });
    expect(aborted).toBe(true);
    expect(errorMessage).toMatch(/Region/);
  });

  test('rejects invalid SecurityZone value', () => {
    const { aborted, errorMessage } = runRule({ security_zone: 'InvalidZone' });
    // Since all mandatory fields are present, it proceeds to value validation
    // which will reject InvalidZone
    expect(aborted).toBe(true);
    expect(errorMessage).toMatch(/Security Zone|security_zone/i);
  });

  test('validates Environment enum values', () => {
    const { aborted } = runRule({ environment: 'Production' });
    expect(aborted).toBe(false);
  });

  test('validates SystemRole enum (Web, Application, Database, Middleware, Utility, SharedServices)', () => {
    const roles = ['Web', 'Application', 'Database', 'Middleware', 'Utility', 'SharedServices'];
    for (const role of roles) {
      // Database role requires explicit compliance (not empty/None) per conflict rule 9
      const overrides = role === 'Database'
        ? { system_role: role, compliance: 'PCI' }
        : { system_role: role };
      const { aborted } = runRule(overrides);
      expect(aborted).toBe(false);
    }
  });

  test('validates site field (NDCNG, TULNG)', () => {
    for (const site of ['NDCNG', 'TULNG']) {
      const { aborted } = runRule({ site });
      expect(aborted).toBe(false);
    }
  });

  test('handles empty field values', () => {
    const { aborted, errorMessage } = runRule({ environment: '' });
    expect(aborted).toBe(true);
    expect(errorMessage).toMatch(/required/i);
  });

  test('handles null field values', () => {
    const { aborted } = runRule({ region: null });
    expect(aborted).toBe(true);
  });

  test('Compliance is optional (not required)', () => {
    const { aborted } = runRule({ compliance: '' });
    // compliance is not in MANDATORY_FIELDS, so empty is fine
    expect(aborted).toBe(false);
  });

  test('DataClassification is optional', () => {
    const { aborted } = runRule({ data_classification: '' });
    expect(aborted).toBe(false);
  });

  test('validates cross-field rules exist (PCI + Sandbox check)', () => {
    // PCI compliance in Sandbox should be rejected
    const { aborted, errorMessage } = runRule({
      environment: 'Sandbox',
      compliance: 'PCI',
    });
    expect(aborted).toBe(true);
    expect(errorMessage).toMatch(/PCI/);
  });
});
