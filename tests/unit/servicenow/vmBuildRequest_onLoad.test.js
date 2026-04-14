'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------------------
// Mock ServiceNow globals BEFORE loading the script
// ---------------------------------------------------------------------------

let glideAjaxCallback = null;

global.g_form = {
  setValue: jest.fn(),
  getValue: jest.fn(),
  setMandatory: jest.fn(),
  setDisplay: jest.fn(),
  setReadOnly: jest.fn(),
  addInfoMessage: jest.fn(),
  addErrorMessage: jest.fn(),
  showFieldMsg: jest.fn(),
  hideFieldMsg: jest.fn(),
  clearMessages: jest.fn(),
  getControl: jest.fn(),
  hideAllFieldMsgs: jest.fn(),
};

global.g_user = {
  hasRole: jest.fn().mockReturnValue(true),
  getFullName: jest.fn().mockReturnValue('Test User'),
  userName: 'test.user',
  userID: 'abc123',
  getPreference: jest.fn().mockReturnValue(''),
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
  '../../../src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js'
);
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

// Remove the 'use strict' directive as we run in a controlled context
const cleanedSource = scriptSource.replace(/['"]use strict['"];?\s*/g, '');

// Execute in the current global context to make onLoad available
const scriptFn = new Function(cleanedSource + '\nreturn { onLoad };');
const exported = scriptFn();
const onLoad = exported.onLoad;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vmBuildRequest_onLoad', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    glideAjaxCallback = null;
    mockBannerElement.style.display = '';
    global.g_user.getPreference = jest.fn().mockReturnValue('');
    global.gel = jest.fn().mockReturnValue(mockBannerElement);
  });

  // -- onLoad executes without error ------------------------------------------

  test('onLoad executes without throwing', () => {
    expect(() => onLoad()).not.toThrow();
  });

  // -- Cost center population from preference ---------------------------------

  test('sets cost center from user preference when available', () => {
    global.g_user.getPreference = jest.fn().mockReturnValue('CC-FINANCE-001');

    onLoad();

    expect(global.g_form.setValue).toHaveBeenCalledWith('cost_center', 'CC-FINANCE-001');
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('cost_center', true);
  });

  test('does not invoke GlideAjax when preference is present', () => {
    global.g_user.getPreference = jest.fn().mockReturnValue('CC-FINANCE-001');

    onLoad();

    expect(global.GlideAjax).not.toHaveBeenCalled();
  });

  test('falls back to GlideAjax when preference is empty', () => {
    global.g_user.getPreference = jest.fn().mockReturnValue('');

    onLoad();

    expect(global.GlideAjax).toHaveBeenCalledWith('DFWCatalogUtils');
  });

  test('falls back to GlideAjax when preference is "undefined"', () => {
    global.g_user.getPreference = jest.fn().mockReturnValue('undefined');

    onLoad();

    expect(global.GlideAjax).toHaveBeenCalledWith('DFWCatalogUtils');
  });

  // -- Cost center GlideAjax callback -----------------------------------------

  test('GlideAjax callback sets cost center and read-only on valid answer', () => {
    global.g_user.getPreference = jest.fn().mockReturnValue('');

    onLoad();

    expect(glideAjaxCallback).toBeDefined();
    glideAjaxCallback('CC-DEPT-042');

    expect(global.g_form.setValue).toHaveBeenCalledWith('cost_center', 'CC-DEPT-042');
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('cost_center', true);
  });

  test('GlideAjax callback shows field message when answer is empty', () => {
    global.g_user.getPreference = jest.fn().mockReturnValue('');

    onLoad();

    glideAjaxCallback('');

    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('cost_center', false);
    expect(global.g_form.showFieldMsg).toHaveBeenCalledWith(
      'cost_center',
      expect.stringContaining('could not be determined'),
      'info'
    );
  });

  test('GlideAjax callback shows field message when answer is "null"', () => {
    global.g_user.getPreference = jest.fn().mockReturnValue('');

    onLoad();

    glideAjaxCallback('null');

    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('cost_center', false);
    expect(global.g_form.showFieldMsg).toHaveBeenCalledWith(
      'cost_center',
      expect.stringContaining('manually'),
      'info'
    );
  });

  // -- Form state initialization ----------------------------------------------

  test('sets mandatory fields on form load', () => {
    onLoad();

    expect(global.g_form.setMandatory).toHaveBeenCalledWith('region', true);
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('security_zone', true);
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('environment', true);
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('app_ci', true);
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('system_role', true);
  });

  test('sets compliance as not mandatory initially', () => {
    onLoad();

    expect(global.g_form.setMandatory).toHaveBeenCalledWith('compliance', false);
  });

  test('hides the production warning banner on load', () => {
    onLoad();

    expect(global.gel).toHaveBeenCalledWith('production_warning_banner');
    expect(mockBannerElement.style.display).toBe('none');
  });

  test('clears stale field messages on load', () => {
    onLoad();

    expect(global.g_form.hideAllFieldMsgs).toHaveBeenCalled();
  });

  test('handles missing banner element gracefully', () => {
    global.gel = jest.fn().mockReturnValue(null);

    expect(() => onLoad()).not.toThrow();
  });
});
