# Server Scripts — DFW Automation Script Includes

Server-side Script Includes that provide reusable business logic for catalog item
processing, tag dictionary validation, and vRO integration.

## Scripts

| Script                       | Type             | Source File                                                        |
|------------------------------|------------------|--------------------------------------------------------------------|
| catalogItemValidation        | Script Include   | src/servicenow/catalog/server-scripts/catalogItemValidation.js     |
| tagDictionaryLookup          | Script Include   | src/servicenow/catalog/server-scripts/tagDictionaryLookup.js       |
| vroTrigger                   | Script Include   | src/servicenow/integration/vroTrigger.js                           |
| vroCallbackHandler           | Script Include   | src/servicenow/integration/vroCallbackHandler.js                   |
| correlationIdGenerator       | Script Include   | src/servicenow/integration/correlationIdGenerator.js               |
| RuleRequestPipeline          | Script Include   | src/servicenow/integration/RuleRequestPipeline.js                  |

## Responsibilities

- **catalogItemValidation** — Server-side validation of catalog item variables before workflow execution. Validates tag values against the Enterprise Tag Dictionary and enforces business rules.
- **tagDictionaryLookup** — GlideAjax-callable Script Include that queries the Enterprise Tag Dictionary (`u_enterprise_tag_dictionary`) for valid tag values per category. Used by client scripts for dynamic choice lists.
- **vroTrigger** — Constructs the SNOW-to-vRO payload (per `snow-vro-payload.schema.json`), generates correlation IDs, and invokes the vRO REST endpoint via Mid Server.
- **vroCallbackHandler** — Processes vRO callback responses, updates RITM state, and logs execution results.
- **correlationIdGenerator** — Generates unique correlation IDs in `RITM-{number}-{epochTimestamp}` format for end-to-end request tracing.
- **RuleRequestPipeline** — Orchestrates the rule request workflow within ServiceNow, including conflict pre-checks and approval routing.

## Deployment

Server scripts are included in the Update Set (`update-set.xml`). They can also
be deployed individually via the ServiceNow REST API.
