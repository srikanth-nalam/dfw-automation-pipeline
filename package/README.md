# DFW Automation Pipeline — Packaging Guide

This directory contains all artifacts required to package and deploy the DFW
Automation Pipeline to vRealize Orchestrator (vRO) / Aria Automation Orchestrator
and ServiceNow.

## Overview

The DFW Automation Pipeline provides tag-driven NSX Distributed Firewall lifecycle
management. It integrates ServiceNow (ITSM), vRealize Orchestrator (workflow engine),
NSX-T (DFW policy enforcement), and vCenter (VM inventory) to automate Day-0
provisioning, Day-2 tag updates, Day-N decommissioning, bulk tag remediation,
drift detection, quarantine, and DFW rule lifecycle management.

## Directory Structure

```
package/
├── README.md                        # This file
├── com.dfw.automation/              # vRO package contents
│   ├── package.json                 # Package manifest
│   ├── elements/
│   │   ├── actions/                 # vRO actions organized by module
│   │   │   ├── com.dfw.shared/      # Shared utilities (9 actions)
│   │   │   ├── com.dfw.tags/        # Tag management (4 actions)
│   │   │   ├── com.dfw.groups/      # Security groups (2 actions)
│   │   │   ├── com.dfw.dfw/         # DFW policy/rules (6 actions)
│   │   │   ├── com.dfw.cmdb/        # CMDB validation (1 action)
│   │   │   ├── com.dfw.lifecycle/   # Lifecycle orchestrators (13 actions)
│   │   │   └── com.dfw.adapters/    # External system adapters (3 actions)
│   │   ├── workflows/               # vRO workflow definitions (10 workflows)
│   │   └── config/                  # Configuration templates
│   └── certificates/                # TLS certificate placeholder
├── servicenow/                      # ServiceNow components
│   ├── update-set.xml               # Master Update Set
│   ├── catalog-items/               # Service Catalog definitions (5 items)
│   ├── client-scripts/              # Catalog Client Scripts
│   ├── server-scripts/              # Server-side Script Includes
│   ├── business-rules/              # CMDB Business Rules
│   ├── ui-policies/                 # Conditional UI Policies
│   ├── scheduled-jobs/              # Scheduled job definitions (3 jobs)
│   └── custom-tables/               # Custom table schemas
└── scripts/                         # Build and deployment tools
    ├── package-vro.sh               # Build script (creates ZIP)
    ├── validate-package.sh          # Validation script
    └── deploy-checklist.md          # Deployment checklist
```

## Quick Start

### 1. Validate the Package

```bash
cd package/scripts
chmod +x validate-package.sh
./validate-package.sh
```

This checks:
- Package manifest (`package.json`) is valid JSON with all required fields
- All 38 action source files exist in `src/`
- All 10 workflow XML files are well-formed
- Configuration files are present and valid
- ServiceNow catalog items, scheduled jobs, and custom tables are valid JSON

### 2. Build the vRO Package

```bash
cd package/scripts
chmod +x package-vro.sh
./package-vro.sh 2.0.0
```

This:
1. Copies all JS action files from `src/` into the package action directories
2. Updates the package manifest version
3. Creates `dist/com.dfw.automation-2.0.0.zip` for vRO import
4. Cleans up copied JS files from the package directory

### 3. Deploy

Follow the step-by-step instructions in `scripts/deploy-checklist.md`.

## Platform Requirements

| Component              | Version  | Purpose                                |
|------------------------|----------|----------------------------------------|
| vRealize Orchestrator  | 8.x+     | Workflow engine and action runtime     |
| VMware Cloud Foundation| 9.x+     | Infrastructure platform                |
| NSX-T Data Center      | 4.x+     | Distributed Firewall policy engine     |
| vCenter Server         | 8.x+     | VM inventory and tag management        |
| ServiceNow             | Utah+    | ITSM, catalog, and CMDB               |

## Package Manifest

The `com.dfw.automation/package.json` manifest defines:

- **Package metadata** — name, version, vendor, platform compatibility
- **Action inventory** — all 38 actions organized across 7 modules
- **Dependencies** — none (self-contained package)

## Action Modules

| Module              | Actions | Description                                     |
|---------------------|---------|--------------------------------------------------|
| com.dfw.shared      | 9       | Cross-cutting utilities: config, logging, retry  |
| com.dfw.tags        | 4       | NSX-T tag CRUD, cardinality, propagation         |
| com.dfw.groups      | 2       | Security group membership verification           |
| com.dfw.dfw         | 6       | DFW policy validation, deployment, rules         |
| com.dfw.cmdb        | 1       | CMDB-to-NSX cross-reference validation           |
| com.dfw.lifecycle   | 13      | Lifecycle orchestrators (Day-0/2/N, bulk, drift) |
| com.dfw.adapters    | 3       | NSX, vCenter, and ServiceNow API adapters        |
| **Total**           | **38**  |                                                  |

## Workflows

| Workflow                     | Trigger                              | Purpose                                  |
|------------------------------|--------------------------------------|------------------------------------------|
| DFW - Day 0 Provision       | SNOW VM Build Request                | New VM tag assignment and policy push    |
| DFW - Day 2 Tag Update      | SNOW Tag Update / CMDB change        | Existing VM tag modification             |
| DFW - Day N Decommission    | SNOW Decommission Request            | VM teardown and tag cleanup              |
| DFW - Bulk Tag Remediation  | SNOW Bulk Tag Request                | Multi-VM tag corrections                 |
| DFW - Drift Scan            | Scheduled (daily)                    | CMDB vs. NSX-T tag drift detection       |
| DFW - Migration Bulk Tag    | Migration tooling                    | Cross-site VM migration re-tagging       |
| DFW - Quarantine            | SNOW Quarantine Request              | Emergency VM isolation via DFW           |
| DFW - CMDB Validation       | Scheduled (weekly)                   | CMDB CI cross-reference validation       |
| DFW - Rule Lifecycle        | SNOW Rule Request                    | DFW rule creation/modification           |
| DFW - Rule Review           | Scheduled (weekly)                   | Rule expiration and governance review    |

## Configuration

### vRO Configuration

- **dfw-config.properties** — Main configuration file with endpoint URLs, retry settings, circuit breaker parameters, rate limiter settings, and vault references for credentials.
- **site-config.json** — Per-site configuration with endpoint details, cluster/datastore/network mappings, and tag defaults.

### Credential Management

All credentials use vault references (`{{vault:secret/...}}`) and are resolved at
runtime by the vRO secrets manager. Plain-text credentials are never stored in
configuration files or source code.

### ServiceNow Configuration

- **vRO REST Message** — `vRO_DFW_Automation` — outbound REST integration to vRO
- **Enterprise Tag Dictionary** — `u_enterprise_tag_dictionary` table with valid tag values
- **Custom Table** — `x_dfw_rule_registry` for DFW rule tracking and governance
- **Scheduled Jobs** — CMDB validation, drift detection, and rule review scans

## Tag Model

The pipeline enforces a 5-tag model on all managed VMs:

| # | Category      | NSX Scope      | Cardinality  | Source of Truth         |
|---|---------------|----------------|--------------|------------------------|
| 1 | Region        | Region         | single-value | Site Registry           |
| 2 | SecurityZone  | SecurityZone   | single-value | Network Security        |
| 3 | Environment   | Environment    | single-value | ITSM Environment Reg.   |
| 4 | AppCI         | AppCI          | single-value | CMDB App Portfolio      |
| 5 | SystemRole    | SystemRole     | single-value | Enterprise Architecture |

Optional categories: Compliance, DataClassification, CostCenter.

## Troubleshooting

### Common Issues

1. **vRO import fails with "duplicate element"**
   - Export and remove the existing package before importing the new version.

2. **Workflow execution fails with "connection refused"**
   - Verify TLS certificates are imported into the vRO trust store.
   - Verify site endpoint URLs in `dfw-config.properties`.

3. **ServiceNow callback not received**
   - Verify the callback URL and token in the vRO configuration.
   - Check Mid Server connectivity and REST message configuration.

4. **Tag validation errors**
   - Verify the Enterprise Tag Dictionary is populated with current values.
   - Run the CMDB Validation workflow to identify mismatches.

5. **Scheduled jobs not firing**
   - Verify the `x_dfw.service_account` user is active.
   - Verify scheduled job records are set to Active in ServiceNow.
