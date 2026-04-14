'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Mock ServiceNow globals BEFORE loading the script
// ---------------------------------------------------------------------------

let glideAjaxCallbacks = {};

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
  clearValue: jest.fn(),
  addOption: jest.fn(),
  clearOptions: jest.fn(),
};

global.g_user = {
  hasRole: jest.fn().mockReturnValue(true),
  getFullName: jest.fn().mockReturnValue('Test User'),
  userName: 'test.user',
  userID: 'abc123',
};

global.GlideAjax = jest.fn().mockImplementation(() => {
  const instance = {
    _params: {},
    addParam: jest.fn((key, value) => {
      instance._params[key] = value;
    }),
    getXMLAnswer: jest.fn((cb) => {
      const method = instance._params['sysparm_name'] || 'default';
      glideAjaxCallbacks[method] = cb;
    }),
  };
  return instance;
});

const mockSubmitBtn = { disabled: false, style: { opacity: '' } };
const mockWarningBanner = { style: { display: '' } };
global.gel = jest.fn().mockImplementation((id) => {
  if (id === 'dfw_rule_submit_btn') {return mockSubmitBtn;}
  if (id === 'rule_expiration_warning') {return mockWarningBanner;}
  return null;
});

// ---------------------------------------------------------------------------
// Load the client script and capture the onLoad function
// ---------------------------------------------------------------------------

const scriptPath = path.resolve(
  __dirname,
  '../../../src/servicenow/catalog/client-scripts/ruleRequest_onLoad.js'
);
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

const cleanedSource = scriptSource.replace(/['"]use strict['"];?\s*/g, '');

const scriptFn = new Function(cleanedSource + '\nreturn { onLoad };');
const exported = scriptFn();
const onLoad = exported.onLoad;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ruleRequest_onLoad', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    glideAjaxCallbacks = {};
    mockSubmitBtn.disabled = false;
    mockSubmitBtn.style.opacity = '';
    mockWarningBanner.style.display = '';
    global.g_form.getValue = jest.fn().mockReturnValue('');
    global.g_user.hasRole = jest.fn().mockReturnValue(true);
    global.gel = jest.fn().mockImplementation((id) => {
      if (id === 'dfw_rule_submit_btn') {return mockSubmitBtn;}
      if (id === 'rule_expiration_warning') {return mockWarningBanner;}
      return null;
    });
  });

  // -- Basic load behavior ----------------------------------------------------

  test('onLoad executes without throwing for authorized user', () => {
    expect(() => onLoad()).not.toThrow();
  });

  // -- Permission check -------------------------------------------------------

  test('shows error when user has no authorized role', () => {
    global.g_user.hasRole = jest.fn().mockReturnValue(false);

    onLoad();

    expect(global.g_form.addErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('do not have permission')
    );
  });

  test('sets fields read-only when user is unauthorized', () => {
    global.g_user.hasRole = jest.fn().mockReturnValue(false);

    onLoad();

    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('source_group', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('destination_group', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('action', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('protocol', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('port', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('justification', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('rule_template', true);
    expect(global.g_form.setReadOnly).toHaveBeenCalledWith('expiration_date', true);
  });

  test('disables submit button when user is unauthorized', () => {
    global.g_user.hasRole = jest.fn().mockReturnValue(false);

    onLoad();

    expect(mockSubmitBtn.disabled).toBe(true);
    expect(mockSubmitBtn.style.opacity).toBe('0.5');
  });

  // -- Form state initialization ----------------------------------------------

  test('sets core fields as mandatory', () => {
    onLoad();

    expect(global.g_form.setMandatory).toHaveBeenCalledWith('source_group', true);
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('destination_group', true);
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('action', true);
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('protocol', true);
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('justification', true);
  });

  test('sets optional fields as not mandatory', () => {
    onLoad();

    expect(global.g_form.setMandatory).toHaveBeenCalledWith('port', false);
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('expiration_date', false);
    expect(global.g_form.setMandatory).toHaveBeenCalledWith('rule_template', false);
  });

  test('makes port field visible', () => {
    onLoad();

    expect(global.g_form.setDisplay).toHaveBeenCalledWith('port', true);
  });

  test('shows port format advisory message', () => {
    onLoad();

    expect(global.g_form.showFieldMsg).toHaveBeenCalledWith(
      'port',
      expect.stringContaining('single port'),
      'info'
    );
  });

  test('shows justification guidance message', () => {
    onLoad();

    expect(global.g_form.showFieldMsg).toHaveBeenCalledWith(
      'justification',
      expect.stringContaining('business reason'),
      'info'
    );
  });

  // -- Rule template loading --------------------------------------------------

  test('hides rule_template field when no templates returned', () => {
    onLoad();

    expect(glideAjaxCallbacks).toHaveProperty('getRuleTemplates');
    glideAjaxCallbacks['getRuleTemplates']('');

    expect(global.g_form.setDisplay).toHaveBeenCalledWith('rule_template', false);
  });

  test('populates rule template dropdown with valid templates', () => {
    onLoad();

    const templates = JSON.stringify([
      { sys_id: 'tmpl-001', name: 'Web-to-App HTTPS' },
      { sys_id: 'tmpl-002', name: 'App-to-DB PostgreSQL' },
    ]);

    glideAjaxCallbacks['getRuleTemplates'](templates);

    expect(global.g_form.addOption).toHaveBeenCalledWith(
      'rule_template', 'tmpl-001', 'Web-to-App HTTPS'
    );
    expect(global.g_form.addOption).toHaveBeenCalledWith(
      'rule_template', 'tmpl-002', 'App-to-DB PostgreSQL'
    );
  });

  // -- Source/destination group loading ---------------------------------------

  test('shows error when no security groups are available', () => {
    onLoad();

    expect(glideAjaxCallbacks).toHaveProperty('getSecurityGroupsForUser');
    glideAjaxCallbacks['getSecurityGroupsForUser']('');

    expect(global.g_form.showFieldMsg).toHaveBeenCalledWith(
      'source_group',
      expect.stringContaining('No security groups'),
      'error'
    );
  });

  test('populates source and destination group dropdowns', () => {
    onLoad();

    const groups = JSON.stringify([
      { sys_id: 'grp-001', name: 'Web-SG', description: 'Web tier' },
      { sys_id: 'grp-002', name: 'App-SG', description: 'App tier' },
    ]);

    glideAjaxCallbacks['getSecurityGroupsForUser'](groups);

    expect(global.g_form.addOption).toHaveBeenCalledWith(
      'source_group', 'grp-001', 'Web-SG (Web tier)'
    );
    expect(global.g_form.addOption).toHaveBeenCalledWith(
      'destination_group', 'grp-002', 'App-SG (App tier)'
    );
  });

  // -- Expiration warning banner hidden on load -------------------------------

  test('hides expiration warning banner on load', () => {
    onLoad();

    expect(global.gel).toHaveBeenCalledWith('rule_expiration_warning');
    expect(mockWarningBanner.style.display).toBe('none');
  });
});
