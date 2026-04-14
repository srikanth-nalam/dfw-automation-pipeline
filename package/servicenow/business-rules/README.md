# Business Rules — DFW Automation CMDB Integration

Business Rules that trigger automated DFW tag synchronization when CMDB CI
records are updated.

## Rules

| Rule                        | Table                  | When         | Source File                                                      |
|-----------------------------|------------------------|--------------|------------------------------------------------------------------|
| cmdbTagSyncRule             | cmdb_ci_vm_instance    | After Update | src/servicenow/business-rules/cmdbTagSyncRule.js                 |
| tagFieldServerValidation    | cmdb_ci_vm_instance    | Before Update| src/servicenow/business-rules/tagFieldServerValidation.js        |

## cmdbTagSyncRule

Monitors changes to the 5 security-relevant CMDB fields on `cmdb_ci_vm_instance` records:

| CMDB Field        | Tag Category   | NSX Scope      |
|-------------------|----------------|----------------|
| u_region          | Region         | Region         |
| u_security_zone   | SecurityZone   | SecurityZone   |
| u_environment     | Environment    | Environment    |
| u_app_ci          | AppCI          | AppCI          |
| u_system_role     | SystemRole     | SystemRole     |

When any of these fields change:

1. Detects which tag-relevant fields changed (current vs. previous values).
2. Builds a changed-tags payload with old and new values.
3. Validates that the change was approved (approval state check).
4. Triggers the vRO Day-2 tag sync workflow via REST.
5. Logs the sync trigger event to the DFW audit log.

**Configuration**: Table: `cmdb_ci_vm_instance` | When: After Update | Order: 200

## tagFieldServerValidation

Server-side validation rule that ensures tag field values on CMDB CI records
are valid according to the Enterprise Tag Dictionary before the record is saved.

**Configuration**: Table: `cmdb_ci_vm_instance` | When: Before Update | Order: 100

## Deployment

Business rules are included in the Update Set (`update-set.xml`). They can also
be deployed individually via the ServiceNow REST API.
