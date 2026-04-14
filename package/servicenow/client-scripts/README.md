# Client Scripts — DFW Automation Catalog Items

Catalog Client Scripts that execute in the user's browser when interacting with
DFW Automation catalog item forms.

## Scripts

| Script                              | Type      | Catalog Item         | Source File                                                  |
|-------------------------------------|-----------|----------------------|--------------------------------------------------------------|
| vmBuildRequest_onLoad               | onLoad    | VM Build Request     | src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js    |
| vmBuildRequest_onChange             | onChange  | VM Build Request     | src/servicenow/catalog/client-scripts/vmBuildRequest_onChange.js   |
| tagUpdateRequest_onLoad            | onLoad    | Tag Update Request   | src/servicenow/catalog/client-scripts/tagUpdateRequest_onLoad.js  |
| bulkTagRequest_onLoad              | onLoad    | Bulk Tag Request     | src/servicenow/catalog/client-scripts/bulkTagRequest_onLoad.js    |
| quarantineRequest_onLoad           | onLoad    | Quarantine Request   | src/servicenow/catalog/client-scripts/quarantineRequest_onLoad.js |
| ruleRequest_onLoad                 | onLoad    | Rule Request         | src/servicenow/catalog/client-scripts/ruleRequest_onLoad.js       |

## Responsibilities

- **onLoad scripts**: Auto-populate form fields (e.g., Cost Center from user department), set default values (DataClassification, Compliance), and initialize form state (visibility, mandatory flags).
- **onChange scripts**: React to field changes (e.g., SecurityZone selection drives Compliance field requirements), perform client-side validation, and update dependent field choices via GlideAjax lookups against the Enterprise Tag Dictionary.

## ServiceNow APIs Used

- `g_form` — GlideForm API for field manipulation
- `g_user` — GlideUser API for current user context
- `GlideAjax` — Asynchronous server-side script include invocation

## Deployment

Client scripts are included in the Update Set (`update-set.xml`). They can also
be deployed individually via the ServiceNow REST API or manually through the
ServiceNow Studio IDE.
