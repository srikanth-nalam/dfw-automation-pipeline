# CMDB Validation Sequence Diagram

## Overview

This diagram shows the end-to-end flow of the CMDBValidator scheduled validation process, from VM inventory extraction through gap report generation and remediation task creation.

```mermaid
sequenceDiagram
    participant Scheduler as Scheduled Job
    participant CV as CMDBValidator
    participant CMDB as ServiceNow CMDB
    participant NSX as NSX Manager
    participant SNOW as ServiceNow

    Scheduler->>CV: generateGapReport(site)
    CV->>CMDB: extractVMInventory(site)
    CMDB-->>CV: VM inventory list
    CV->>CV: validateCoverage(inventory)
    Note over CV: Check 5-tag completeness\nRegion, SecurityZone,\nEnvironment, AppCI, SystemRole
    CV->>NSX: Verify NSX fabric VM mapping
    NSX-->>CV: NSX VM external IDs
    CV->>CV: validateQuality(inventory)
    Note over CV: Check tag value consistency\nRegion matches physical site\nAppCI matches CMDB CI ref\nStaleness detection
    CV->>CV: Compile gap report with KPIs
    CV->>SNOW: generateRemediationTasks(gapReport)
    SNOW-->>CV: Remediation tasks created
    Note over SNOW: Tasks assigned to\nVM owner or group
    CV->>SNOW: Update KPI dashboard
    CV-->>Scheduler: Gap report with KPIs
    Note over Scheduler: Coverage percentage\nQuality score\nTrend comparison
```

## Participants

| Participant | Description |
|-------------|-------------|
| Scheduled Job | vRO scheduled workflow triggering daily CMDB validation |
| CMDBValidator | Core validation engine that orchestrates extraction, validation, and reporting |
| ServiceNow CMDB | Source of truth for VM inventory and application CI relationships |
| NSX Manager | Provides NSX fabric VM inventory for cross-reference validation |
| ServiceNow | Target for remediation task creation and KPI dashboard updates |
