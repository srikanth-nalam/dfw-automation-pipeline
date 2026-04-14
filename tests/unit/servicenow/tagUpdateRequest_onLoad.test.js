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
  '../../../src/servicenow/catalog/client-scripts/tagUpdateRequest_onLoad.js'
);
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

const cleanedSource = scriptSource.replace(/['"]use strict['"];?\s*/g, '');

const scriptFn = new Function(cleanedSource + '\nreturn { onLoad };');
const exported = scriptFn();
const onLoad = exported.onLoad;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tagUpdateRequest_onLoad', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    glideAjaxCallback = null;
    mockBannerElement.style.display = '';
    global.g_form.getValue = jest.fn().mockReturnValue('');
    global.g_user.hasRole = jest.fn().mockReturnValue(true);
    global.gel = jest.fn().mockReturnValue(mockBannerElement);
  });

  // -- Basic load behavior ----------------------------------------------------

  test('onLoad executes without throwing', () => {
    expect(() => onLoad()).not.toThrow();
  });

  test('shows info message when no VM CI is selected', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('');

    onLoad();

    expect(global.g_form.addInfoMessage).toHaveBeenCalledWith(
      expect.stringContaining('Please select a VM')
    );
  });

  // -- Tag population via GlideAjax ------------------------------------------

  test('calls GlideAjax to fetch tags when VM CI is selected', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('vm-sys-id-001');

    onLoad();

    expect(global.GlideAjax).toHaveBeenCalledWith('DFWTagLookup');
  });

  test('populates current tag fields from GlideAjax response', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('vm-sys-id-001');

    onLoad();

    const tagData = JSON.stringify({
      region: 'NDCNG',
      security_zone: 'Greenzone',
      environment: 'Development',
      app_ci: 'APP001',
      system_role: 'Web',
      compliance: 'None',
      data_classification: 'Internal',
      cost_center: 'CC-1234',
    });

    glideAjaxCallback(tagData);

    expect(global.g_form.setValue).toHaveBeenCalledWith('current_region', 'NDCNG');
    expect(global.g_form.setValue).toHaveBeenCalledWith('current_environment', 'Development');
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('current_region', true);
  });

  test('pre-populates editable fields with current tag values', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('vm-sys-id-001');

    onLoad();

    const tagData = JSON.stringify({
      region: 'TULNG',
      environment: 'Staging',
    });

    glideAjaxCallback(tagData);

    expect(global.g_form.setValue).toHaveBeenCalledWith('region', 'TULNG');
    expect(global.g_form.setValue).toHaveBeenCalledWith('environment', 'Staging');
  });

  test('shows info message when GlideAjax returns empty answer', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('vm-sys-id-001');

    onLoad();

    glideAjaxCallback('');

    expect(global.g_form.addInfoMessage).toHaveBeenCalledWith(
      expect.stringContaining('No existing tags')
    );
  });

  test('shows error message when GlideAjax returns invalid JSON', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('vm-sys-id-001');

    onLoad();

    glideAjaxCallback('not-valid-json');

    expect(global.g_form.addErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse')
    );
  });

  // -- Production warning -----------------------------------------------------

  test('shows warning message for production environment VMs', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('vm-sys-id-001');

    onLoad();

    const tagData = JSON.stringify({ environment: 'Production' });
    glideAjaxCallback(tagData);

    expect(global.g_form.addWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('PRODUCTION')
    );
  });

  test('displays production banner for production VMs', () => {
    global.g_form.getValue = jest.fn().mockReturnValue('vm-sys-id-001');

    onLoad();

    const tagData = JSON.stringify({ environment: 'Production' });
    glideAjaxCallback(tagData);

    expect(global.gel).toHaveBeenCalledWith('production_warning_banner');
    expect(mockBannerElement.style.display).toBe('block');
  });

  // -- Role-based restrictions ------------------------------------------------

  test('admin users have no field restrictions', () => {
    global.g_user.hasRole = jest.fn().mockImplementation((role) => {
      return role === 'x_dfw_tag_admin';
    });

    onLoad();

    // Admin should not have any setReadOnly calls for admin-only fields
    expect(global.g_form.setReadOnly).not.toHaveBeenCalledWith('cost_center', true);
  });

  test('standard ITIL users get all tag fields read-only', () => {
    global.g_user.hasRole = jest.fn().mockReturnValue(false);

    onLoad();

    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('cost_center', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('app_ci', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('system_role', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('environment', true);
    expect(global.g_form.addInfoMessage).toHaveBeenCalledWith(
      expect.stringContaining('does not permit')
    );
  });
});
