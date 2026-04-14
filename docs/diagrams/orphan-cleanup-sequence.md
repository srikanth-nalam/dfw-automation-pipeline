# Orphan Group Cleanup and Stale Rule Reap Sequence

Combined sequence diagram for `OrphanGroupCleaner.sweep()` and
`StaleRuleReaper.reap()`. These two modules run in tandem during the
hygiene sweep to remove empty groups and disable non-active rules.

```mermaid
sequenceDiagram
    participant Caller
    participant OGC as OrphanGroupCleaner
    participant SRR as StaleRuleReaper
    participant NSX as NSX Manager

    Note over OGC: Orphan Group Sweep
    Caller->>OGC: sweep(site)
    OGC->>NSX: GET groups
    loop Each group
        OGC->>NSX: GET members
        alt memberCount == 0
            OGC->>NSX: GET referencing rules
            alt no rules reference group
                OGC->>OGC: archive definition
                OGC->>NSX: DELETE group
            else rules reference group
                OGC->>OGC: mark BLOCKED
            end
        end
    end
    OGC-->>Caller: orphanReport

    Note over SRR: Stale Rule Reap
    Caller->>SRR: reap(site)
    SRR->>NSX: GET security-policies
    loop Each rule
        SRR->>SRR: classify (stale/expired/unmanaged/active)
        alt not ACTIVE
            SRR->>SRR: archive rule
            SRR->>NSX: PATCH rule {disabled: true}
        end
    end
    SRR-->>Caller: reapReport
```
