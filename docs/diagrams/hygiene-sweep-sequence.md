# Hygiene Sweep — Full Orchestration Sequence

End-to-end sequence for `NSXHygieneOrchestrator.runHygieneSweep()`, showing the
coordinated invocation of every hygiene sub-module and the consolidated callback
to ServiceNow.

```mermaid
sequenceDiagram
    participant SN as ServiceNow
    participant HO as NSXHygieneOrchestrator
    participant PD as PhantomVMDetector
    participant OGC as OrphanGroupCleaner
    participant SRR as StaleRuleReaper
    participant PDE as PolicyDeployer
    participant STR as StaleTagRemediator
    participant UVO as UnregisteredVMOnboarder

    SN->>HO: runHygieneSweep(payload)
    HO->>PD: detect(site)
    PD-->>HO: phantomReport
    HO->>OGC: sweep(site)
    OGC-->>HO: orphanReport
    HO->>SRR: reap(site)
    SRR-->>HO: staleReport
    HO->>PDE: cleanupEmptySections(site)
    PDE-->>HO: sectionReport
    HO->>STR: remediate(site)
    STR-->>HO: tagReport
    HO->>UVO: onboard(site)
    UVO-->>HO: onboardReport
    HO->>SN: callback(consolidatedReport)
```
