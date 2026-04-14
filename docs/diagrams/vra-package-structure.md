# VRA Package Structure and Deployment Flow

## Overview

This diagram shows the VRA package directory structure and the deployment flow for importing the DFW automation pipeline into VMware Aria Automation Orchestrator and ServiceNow.

```mermaid
flowchart TB
    subgraph Package ["package/ Directory"]
        subgraph VRO ["com.dfw.automation/"]
            A1["actions/\nshared/ tags/ groups/\ndfw/ lifecycle/ cmdb/"]
            W1["workflows/\nDFW-Day0-Provision\nDFW-Day2-TagUpdate\nDFW-DayN-Decommission\nDFW-CMDBValidation\nDFW-RuleLifecycle\nDFW-RuleReview\nDFW-MigrationBulkTag"]
            C1["config-elements/\nDFW-Pipeline-Config"]
        end

        subgraph Scripts ["scripts/"]
            S1["import-package.sh"]
            S2["export-package.sh"]
        end

        subgraph SNOW ["servicenow/"]
            T1["tables/\nx_dfw_rule_registry\nu_enterprise_tag_dictionary"]
            BR1["business-rules/\ncmdbTagSyncRule\ntagFieldServerValidation"]
            CAT1["catalog-items/\nVM Build, Tag Update,\nDecommission, Quarantine,\nRule Request, Bulk Tag"]
            CS1["client-scripts/\n*_onLoad.js\n*_onChange.js\nruleRequest_onLoad.js"]
            SS1["server-scripts/\ncatalogItemValidation\ntagDictionaryLookup"]
            SJ1["scheduled-jobs/\nCMDB Validation\nRule Review\nDrift Detection"]
        end
    end

    subgraph Deploy ["Deployment Targets"]
        VRO_TARGET["Aria Automation\nOrchestrator"]
        SNOW_TARGET["ServiceNow\nInstance"]
    end

    A1 --> VRO_TARGET
    W1 --> VRO_TARGET
    C1 --> VRO_TARGET
    S1 -.->|Automates| VRO_TARGET

    T1 --> SNOW_TARGET
    BR1 --> SNOW_TARGET
    CAT1 --> SNOW_TARGET
    CS1 --> SNOW_TARGET
    SS1 --> SNOW_TARGET
    SJ1 --> SNOW_TARGET
```

## Deployment Sequence

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant CLI as import-package.sh
    participant VRO as Aria Automation Orchestrator
    participant SNOW as ServiceNow

    Dev->>CLI: ./import-package.sh --host vro-host
    CLI->>VRO: Import shared actions\n(Logger, ErrorFactory,\nConfigLoader, etc.)
    VRO-->>CLI: Shared module imported
    CLI->>VRO: Import domain actions\n(tags, groups, dfw,\ncmdb, lifecycle)
    VRO-->>CLI: Domain modules imported
    CLI->>VRO: Import workflows\n(Day0, Day2, DayN,\nCMDBValidation,\nRuleLifecycle,\nRuleReview,\nMigrationBulkTag)
    VRO-->>CLI: Workflows imported
    CLI->>VRO: Import config elements\n(DFW-Pipeline-Config)
    VRO-->>CLI: Configuration imported
    CLI-->>Dev: vRO import complete

    Dev->>SNOW: Import table update sets
    Note over SNOW: x_dfw_rule_registry\nu_enterprise_tag_dictionary
    Dev->>SNOW: Import business rules
    Note over SNOW: cmdbTagSyncRule\ntagFieldServerValidation
    Dev->>SNOW: Import catalog items
    Note over SNOW: VM Build, Tag Update,\nDecommission, Quarantine,\nRule Request, Bulk Tag
    Dev->>SNOW: Import client/server scripts
    Dev->>SNOW: Configure scheduled jobs
    SNOW-->>Dev: ServiceNow deployment complete

    Dev->>VRO: Configure DFW-Pipeline-Config\nwith environment endpoints
    Dev->>VRO: Configure credential store\nwith vault references
    Dev->>VRO: Test connectivity to all endpoints
    VRO-->>Dev: Deployment verified
```

## Package Contents Summary

| Component | Count | Location |
|-----------|-------|----------|
| vRO Actions | 36+ | `com.dfw.automation/actions/` |
| vRO Workflows | 7 | `com.dfw.automation/workflows/` |
| Configuration Elements | 1 | `com.dfw.automation/config-elements/` |
| ServiceNow Tables | 2 | `servicenow/tables/` |
| Business Rules | 2 | `servicenow/business-rules/` |
| Catalog Items | 6 | `servicenow/catalog-items/` |
| Client Scripts | 6 | `servicenow/client-scripts/` |
| Server Scripts | 2 | `servicenow/server-scripts/` |
| Scheduled Jobs | 5 | `servicenow/scheduled-jobs/` |
| Import Scripts | 2 | `scripts/` |
