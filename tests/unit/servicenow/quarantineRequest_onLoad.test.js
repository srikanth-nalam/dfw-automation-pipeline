'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Mock ServiceNow globals BEFORE loading the script
// ---------------------------------------------------------------------------

let glideAjaxCallback = null;

global.g_form = {
  setValue: jest.fn(),
  getValue: jest.fn().mockReturnValue(''),
  setMandatory: jest.fn(),
  setDisplay: jest.fn(),
  setReadOnly: jest.fn(),
  addInfoMessage: jest.fn(),
  addErrorMessage: jest.fn(),
  addWarningMessage: jest.fn(),
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
  getXMLAnswer: jest.fn((cb) => {
    glideAjaxCallback = cb;
  }),
}));

const mockBannerElement = { style: { display: '' } };
global.gel = jest.fn().mockReturnValue(mockBannerElement);

// ---------------------------------------------------------------------------
// Load the client script and capture the onLoad function
// ---------------------------------------------------------------------------

const scriptPath = path.resolve(
  __dirname,
  '../../../src/servicenow/catalog/client-scripts/quarantineRequest_onLoad.js'
);
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

const cleanedSource = scriptSource.replace(/['"]use strict['"];?\s*/g, '');

const scriptFn = new Function(cleanedSource + '\nreturn { onLoad };');
const exported = scriptFn();
const onLoad = exported.onLoad;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('quarantineRequest_onLoad', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    glideAjaxCallback = null;
    mockBannerElement.style.display = '';
    global.g_form.getValue = jest.fn().mockReturnValue('');
    global.g_user.hasRole = jest.fn().mockReturnValue(true);
    global.g_user.getFullName = jest.fn().mockReturnValue('Test User');
    global.gel = jest.fn().mockReturnValue(mockBannerElement);
  });

  // -- Basic load behavior ----------------------------------------------------

  test('onLoad executes without throwing for authorized user', () => {
    expect(() => onLoad()).not.toThrow();
  });

  // -- Role-based access control ----------------------------------------------

  test('shows unauthorized message when user lacks quarantine roles', () => {
    global.g_user.hasRole = jest.fn().mockReturnValue(false);

    onLoad();

    expect(global.g_form.addErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('ACCESS DENIED')
    );
  });

  test('disables form fields when user is unauthorized', () => {
    global.g_user.hasRole = jest.fn().mockReturnValue(false);

    onLoad();

    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('vm_ci', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('justification', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('duration_minutes', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('severity_level', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('initiated_by', true);
  });

  test('returns early and does not configure fields when unauthorized', () => {
    global.g_user.hasRole = jest.fn().mockReturnValue(false);

    onLoad();

    expect(global.g_form.setValue).not.toHaveBeenCalledWith('duration_minutes', '60');
  });

  // -- VM context population --------------------------------------------------

  test('shows info message when no VM CI is selected', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('');

    onLoad();

    expect(global.g_form.addInfoMessage).toHaveBeenCalledWith(
      expect.stringContaining('Please select a VM')
    );
  });

  test('calls GlideAjax to fetch VM tags when CI is selected', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('vm-sys-id-001');

    onLoad();

    expect(global.GlideAjax).toHaveBeenCalledWith('DFWTagLookup');
  });

  test('populates VM context fields from GlideAjax response', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('vm-sys-id-001');

    onLoad();

    const tagData = JSON.stringify({
      app_ci: 'APP001',
      environment: 'Development',
      system_role: 'Web',
      region: 'NDCNG',
      security_zone: 'Greenzone',
      compliance: 'None',
    });

    glideAjaxCallback(tagData);

    expect(global.g_form.setValue).toHaveBeenCalledWith('current_app_ci', 'APP001');
    expect(global.g_form.setValue).toHaveBeenCalledWith('current_environment', 'Development');
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('current_app_ci', true);
  });

  // -- Production warning -----------------------------------------------------

  test('shows critical warning for production VMs', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('vm-sys-id-001');

    onLoad();

    const tagData = JSON.stringify({ environment: 'Production' });
    glideAjaxCallback(tagData);

    expect(global.g_form.addWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('CRITICAL')
    );
  });

  test('auto-sets severity to critical for production VMs', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('vm-sys-id-001');

    onLoad();

    const tagData = JSON.stringify({ environment: 'Production' });
    glideAjaxCallback(tagData);

    expect(global.g_form.setValue).toHaveBeenCalledWith('severity_level', 'critical');
  });

  // -- Duration and justification configuration -------------------------------

  test('sets default duration to 60 minutes', () => {
    onLoad();

    expect(global.g_form.setValue).toHaveBeenCalledWith('duration_minutes', '60');
  });

  test('makes justification field mandatory', () => {
    onLoad();

    expect(global.g_form.setMandatory).toHaveBeenCalledWith('justification', true);
  });

  // -- Initiated by auto-population -------------------------------------------

  test('sets initiated_by to current user full name', () => {
    onLoad();

    expect(global.g_form.setValue).toHaveBeenCalledWith('initiated_by', 'Test User');
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('initiated_by', true);
  });
});
