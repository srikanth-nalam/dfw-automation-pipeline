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
  addDecoration: jest.fn(),
};

global.g_user = {
  hasRole: jest.fn().mockReturnValue(true),
  getFullName: jest.fn().mockReturnValue('Test User'),
  userName: 'test.user',
  userID: 'abc123',
};

global.GlideAjax = jest.fn().mockImplementation(() => ({
  addParam: jest.fn(),
  getXMLAnswer: jest.fn(),
}));

const mockHelpContainer = { innerHTML: '', style: { display: '' } };
global.gel = jest.fn().mockReturnValue(mockHelpContainer);

// ---------------------------------------------------------------------------
// Load the client script and capture the onLoad function
// ---------------------------------------------------------------------------

const scriptPath = path.resolve(
  __dirname,
  '../../../src/servicenow/catalog/client-scripts/bulkTagRequest_onLoad.js'
);
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

const cleanedSource = scriptSource.replace(/['"]use strict['"];?\s*/g, '');

const scriptFn = new Function(cleanedSource + '\nreturn { onLoad };');
const exported = scriptFn();
const onLoad = exported.onLoad;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bulkTagRequest_onLoad', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHelpContainer.innerHTML = '';
    mockHelpContainer.style.display = '';
    global.g_user.hasRole = jest.fn().mockReturnValue(true);
    global.gel = jest.fn().mockReturnValue(mockHelpContainer);
  });

  // -- Basic load behavior ----------------------------------------------------

  test('onLoad executes without throwing for authorized user', () => {
    expect(() => onLoad()).not.toThrow();
  });

  // -- Role-based access control ----------------------------------------------

  test('shows unauthorized message when user lacks bulk tag roles', () => {
    global.g_user.hasRole = jest.fn().mockReturnValue(false);

    onLoad();

    expect(global.g_form.addErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('ACCESS DENIED')
    );
  });

  test('disables form fields when user is unauthorized', () => {
    global.g_user.hasRole = jest.fn().mockReturnValue(false);

    onLoad();

    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('csv_attachment', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('operation_type', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('batch_size', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('dry_run', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('justification', true);
  });

  test('does not configure fields when user is unauthorized', () => {
    global.g_user.hasRole = jest.fn().mockReturnValue(false);

    onLoad();

    expect(global.g_form.setValue).not.toHaveBeenCalledWith('operation_type', 'apply');
  });

  // -- Operation type configuration -------------------------------------------

  test('sets default operation type to apply', () => {
    onLoad();

    expect(global.g_form.setValue).toHaveBeenCalledWith('operation_type', 'apply');
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('operation_type', true);
  });

  // -- Batch size configuration -----------------------------------------------

  test('sets default batch size to 10', () => {
    onLoad();

    expect(global.g_form.setValue).toHaveBeenCalledWith('batch_size', '10');
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('batch_size', true);
  });

  test('adds batch size decoration with range info', () => {
    onLoad();

    expect(global.g_form.addDecoration).toHaveBeenCalledWith(
      'batch_size',
      'icon-info',
      expect.stringContaining('1-50')
    );
  });

  // -- CSV help display -------------------------------------------------------

  test('populates CSV format help container when element exists', () => {
    onLoad();

    expect(global.gel).toHaveBeenCalledWith('csv_format_help');
    expect(mockHelpContainer.innerHTML).toContain('CSV Format Requirements');
    expect(mockHelpContainer.style.display).toBe('block');
  });

  // -- Dry-run configuration --------------------------------------------------

  test('sets dry-run checkbox to true by default', () => {
    onLoad();

    expect(global.g_form.setValue).toHaveBeenCalledWith('dry_run', 'true');
  });

  // -- Approval notification --------------------------------------------------

  test('shows dual-approval notification for authorized users', () => {
    onLoad();

    expect(global.g_form.addInfoMessage).toHaveBeenCalledWith(
      expect.stringContaining('dual approval')
    );
  });

  // -- Site selector configuration --------------------------------------------

  test('makes target_site mandatory', () => {
    onLoad();

    expect(global.g_form.setMandatory).toHaveBeenCalledWith('target_site', true);
  });
});
