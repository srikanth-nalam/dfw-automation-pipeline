# ServiceNow Components — DFW Automation Pipeline

This directory contains all ServiceNow artifacts required for the DFW Automation
Pipeline integration. Components are organized by type and designed for import
via Update Sets or the ServiceNow REST API.

## Directory Structure

```
servicenow/
├── update-set.xml              # Master Update Set for bulk import
├── catalog-items/              # Service Catalog item definitions
├── client-scripts/             # Catalog Client Scripts (onLoad, onChange)
├── server-scripts/             # Server-side Script Includes
├── business-rules/             # Business Rules for CMDB sync
├── ui-policies/                # UI Policy definitions
├── scheduled-jobs/             # Scheduled Job definitions
└── custom-tables/              # Custom table schemas
```

## Deployment Order

1. **Custom Tables** — Create the `x_dfw_rule_registry` table first (dependency for other components).
2. **Update Set** — Import `update-set.xml` which contains catalog items, client scripts, server scripts, business rules, and UI policies.
3. **Scheduled Jobs** — Configure scheduled jobs using the JSON definitions.
4. **Verification** — Run the deploy checklist from `scripts/deploy-checklist.md`.

## Catalog Items

| Catalog Item            | Purpose                                         | vRO Workflow                    |
|-------------------------|--------------------------------------------------|--------------------------------|
| VM Build Request        | Day-0 provisioning with full tag assignment      | DFW-Day0-Provision             |
| Tag Update Request      | Day-2 tag modification for existing VMs          | DFW-Day2-TagUpdate             |
| Bulk Tag Request        | Bulk tag remediation for multiple VMs            | DFW-BulkTag-Remediation        |
| Quarantine Request      | Emergency VM quarantine via DFW isolation         | DFW-Quarantine                 |
| Rule Request            | DFW rule creation, modification, or renewal      | DFW-RuleLifecycle              |

## Tag Model Integration

All catalog items enforce the 5-tag model through client-side and server-side validation:

| Tag Category   | CMDB Field        | Catalog Variable    | NSX Scope      |
|----------------|-------------------|---------------------|----------------|
| Region         | u_region          | region              | Region         |
| SecurityZone   | u_security_zone   | security_zone       | SecurityZone   |
| Environment    | u_environment     | environment         | Environment    |
| AppCI          | u_app_ci          | app_ci              | AppCI          |
| SystemRole     | u_system_role     | system_role         | SystemRole     |

## Prerequisites

- ServiceNow instance with scoped app: `x_dfw` (DFW Automation)
- Mid Server configured for vRO REST integration
- Enterprise Tag Dictionary table (`u_enterprise_tag_dictionary`) populated
- vRO REST endpoint registered as a REST Message
