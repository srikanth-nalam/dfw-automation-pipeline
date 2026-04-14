'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Mock ServiceNow globals BEFORE loading the script
// ---------------------------------------------------------------------------

global.g_form = {
  setValue: jest.fn(),
  getValue: jest.fn().mockReturnValue(''),
  setMandatory: jest.fn(),
  setDisplay: jest.fn(),
  setReadOnly: jest.fn(),
  addInfoMessage: jest.fn(),
  addErrorMessage: jest.fn(),
  showFieldMsg: jest.fn(),
  hideFieldMsg: jest.fn(),
  clearMessages: jest.fn(),
  getControl: jest.fn(),
  clearOptions: jest.fn(),
  addOption: jest.fn(),
};

const mockBannerElement = { style: { display: '' } };
global.gel = jest.fn().mockReturnValue(mockBannerElement);

// ---------------------------------------------------------------------------
// Load the client script and capture the onChange function
// ---------------------------------------------------------------------------

const scriptPath = path.resolve(
  __dirname,
  '../../../src/servicenow/catalog/client-scripts/vmBuildRequest_onChange.js'
);
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

const cleanedSource = scriptSource.replace(/['"]use strict['"];?\s*/g, '');

const scriptFn = new Function(cleanedSource + '\nreturn { onChange };');
const exported = scriptFn();
const onChange = exported.onChange;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vmBuildRequest_onChange', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBannerElement.style.display = '';
    global.g_form.getValue = jest.fn().mockReturnValue('');
    global.gel = jest.fn().mockReturnValue(mockBannerElement);
  });

  // -- isLoading guard --------------------------------------------------------

  test('does nothing when isLoading is true', () => {
    onChange('system_role', '', 'Database', true);

    expect(global.g_form.setMandatory).not.toHaveBeenCalled();
    expect(global.g_form.showFieldMsg).not.toHaveBeenCalled();
  });

  // -- System role change: Database -------------------------------------------

  test('makes compliance mandatory when system role is Database', () => {
    onChange('system_role', 'Web', 'Database', false);

    expect(global.g_form.setMandatory).toHaveBeenCalledWith('compliance', true);
  });

  test('shows compliance info message for Database system role', () => {
    onChange('system_role', 'Web', 'Database', false);

    expect(global.g_form.showFieldMsg).toHaveBeenCalledWith(
      'compliance',
      expect.stringContaining('required for Database'),
      'info'
    );
  });

  test('makes compliance not mandatory for non-Database system role', () => {
    onChange('system_role', 'Database', 'Web', false);

    expect(global.g_form.setMandatory).toHaveBeenCalledWith('compliance', false);
    expect(global.g_form.hideFieldMsg).toHaveBeenCalledWith('compliance');
  });

  // -- System role change: DataClassification filtering -----------------------

  test('filters data classification options based on system role', () => {
    onChange('system_role', '', 'Web', false);

    expect(global.g_form.clearOptions).toHaveBeenCalledWith('data_classification');
    expect(global.g_form.addOption).toHaveBeenCalledWith('data_classification', '', '-- Select --');
    expect(global.g_form.addOption).toHaveBeenCalledWith('data_classification', 'Public', 'Public');
    expect(global.g_form.addOption).toHaveBeenCalledWith('data_classification', 'Internal', 'Internal');
  });

  test('clears data classification when previous value is no longer valid', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('Restricted');

    onChange('system_role', '', 'Web', false);

    expect(global.g_form.setValue).toHaveBeenCalledWith('data_classification', '');
    expect(global.g_form.showFieldMsg).toHaveBeenCalledWith(
      'data_classification',
      expect.stringContaining('not valid'),
      'warning'
    );
  });

  test('preserves data classification when still valid for new role', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('Internal');

    onChange('system_role', '', 'Web', false);

    expect(global.g_form.setValue).toHaveBeenCalledWith('data_classification', 'Internal');
  });

  // -- Environment change: Production -----------------------------------------

  test('shows production banner when environment changes to Production', () => {
    onChange('environment', 'Development', 'Production', false);

    expect(global.gel).toHaveBeenCalledWith('production_warning_banner');
    expect(mockBannerElement.style.display).toBe('block');
  });

  test('makes data classification mandatory for Production', () => {
    onChange('environment', 'Development', 'Production', false);

    expect(global.g_form.setMandatory).toHaveBeenCalledWith('data_classification', true);
  });

  test('shows CAB approval message for Production', () => {
    onChange('environment', 'Development', 'Production', false);

    expect(global.g_form.showFieldMsg).toHaveBeenCalledWith(
      'environment',
      expect.stringContaining('CAB'),
      'info'
    );
  });

  // -- Environment change: Sandbox --------------------------------------------

  test('filters compliance to only None for Sandbox environment', () => {
    onChange('environment', 'Development', 'Sandbox', false);

    expect(global.g_form.clearOptions).toHaveBeenCalledWith('compliance');
    expect(global.g_form.addOption).toHaveBeenCalledWith('compliance', 'None', 'None');
    expect(global.g_form.setValue).toHaveBeenCalledWith('compliance', 'None');
  });

  // -- Compliance change: PCI in Sandbox (DFW-4003) ---------------------------

  test('blocks PCI compliance in Sandbox environment with DFW-4003', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('Sandbox');

    onChange('compliance', 'None', 'PCI', false);

    expect(global.g_form.showFieldMsg).toHaveBeenCalledWith(
      'compliance',
      expect.stringContaining('DFW-4003'),
      'error'
    );
    expect(global.g_form.setValue).toHaveBeenCalledWith('compliance', 'None');
  });

  test('allows PCI compliance in Production environment', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('Production');

    onChange('compliance', 'None', 'PCI', false);

    expect(global.g_form.showFieldMsg).not.toHaveBeenCalledWith(
      'compliance',
      expect.stringContaining('DFW-4003'),
      'error'
    );
  });
});
