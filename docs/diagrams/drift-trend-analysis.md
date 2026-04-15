# Drift Trend Analysis Sequence

## Overview

This diagram shows the drift trend analysis workflow, where scheduled scans detect tag and policy drift across VMs, store historical results, analyze trends over time, and generate executive summary reports delivered to the ServiceNow dashboard.

```mermaid
sequenceDiagram
    participant Sched as Scheduler
    participant DDW as DriftDetectionWorkflow
    participant NSX as NSX Manager
    participant CMDB as CMDB
    participant SNOW as ServiceNow

    Sched->>DDW: triggerDriftScan()

    rect rgb(230, 245, 255)
        Note over DDW,NSX: Phase 1 -- Run Drift Scan
        DDW->>DDW: runDriftScan(scanConfig)
        DDW->>NSX: GET /api/v1/fabric/virtual-machines
        NSX-->>DDW: VM inventory with current tags
        DDW->>CMDB: GET /api/now/table/cmdb_ci_vm_instance
        CMDB-->>DDW: Expected tag assignments\nfrom CMDB records
        DDW->>DDW: Compare actual tags\nagainst expected tags\nper VM
        DDW->>DDW: Identify drifted VMs\n(missing, extra, or\nmismatched tags)
    end

    rect rgb(230, 255, 230)
        Note over DDW: Phase 2 -- Store Scan History
        DDW->>DDW: storeScanHistory(scanResult)
        Note over DDW: Persists scan timestamp,\ntotal VMs scanned,\ndrifted VM count,\nand per-VM drift details
    end

    rect rgb(255, 250, 230)
        Note over DDW: Phase 3 -- Analyze Drift Trend
        DDW->>DDW: analyzeDriftTrend(currentScan)
        DDW->>DDW: Retrieve previous scan results\nfrom scan history
        DDW->>DDW: Compare drift counts\nacross scan windows
        alt Drift count decreasing
            Note over DDW: Trend: IMPROVING
        else Drift count increasing
            Note over DDW: Trend: WORSENING
        else Drift count unchanged
            Note over DDW: Trend: STABLE
        end
    end

    rect rgb(230, 245, 255)
        Note over DDW,SNOW: Phase 4 -- Generate and Deliver Report
        DDW->>DDW: generateDriftSummary(\ncurrentScan, trend)
        Note over DDW: Executive report includes:\ntotal VMs scanned,\ndrift percentage,\ntrend direction,\ntop drifted applications,\nremediation recommendations
        DDW->>SNOW: POST /api/now/table/u_drift_report\n(driftSummary)
        SNOW-->>DDW: 201 Created -- Report ID
        DDW->>SNOW: Update dashboard widget\n(trend chart data,\ncurrent drift metrics)
        SNOW-->>DDW: Dashboard updated
    end

    DDW-->>Sched: Scan complete\n(scannedVMs, driftedVMs,\ntrend, reportId)
```

## Trend Classification

| Trend | Condition | Implication |
|-------|-----------|-------------|
| IMPROVING | Drift count decreased compared to previous scans | Remediation efforts are effective |
| WORSENING | Drift count increased compared to previous scans | New drift sources or failed remediation |
| STABLE | Drift count unchanged across scan windows | No significant change in compliance posture |

## Scan Cadence

| Schedule | Frequency | Retention |
|----------|-----------|-----------|
| Standard scan | Every 6 hours | 30 days of scan history |
| Trend analysis window | Compares last 5 scans | Rolling comparison |
| Executive report | Generated per scan | Delivered to ServiceNow dashboard |
