# Day N Decommission Sequence

This diagram shows the complete Day N (VM decommission) workflow. It includes dependency checking to prevent orphaned DFW rules, tag removal with propagation verification, group membership drain confirmation, and safe VM deprovisioning with full saga compensation support.

```mermaid
sequenceDiagram
    participant SNOW as ServiceNow
    participant vRO as vRO Orchestrator
    participant VAL as PayloadValidator
    participant SAGA as SagaCoordinator
    participant DFW as DFWPolicyValidator
    participant CB as CircuitBreaker
    participant VC as vCenter (Site)
    participant NSX as NSX Manager (Site)
    participant DLQ as Dead Letter Queue

    SNOW->>vRO: POST /trigger (DayN payload)
    vRO->>vRO: Generate correlationId
    vRO->>VAL: validate(payload)
    VAL->>VAL: Schema + vmId exists + power-off check
    VAL-->>vRO: Validation passed
    vRO->>SAGA: begin(correlationId)

    rect rgb(230, 245, 255)
        Note over vRO,NSX: Step 1 -- Capture Current State
        vRO->>CB: getCurrentTags + getGroupMembership
        CB->>VC: GET tag-association(vm)
        VC-->>CB: currentTags[]
        CB->>NSX: GET groups by member
        NSX-->>CB: currentGroups[]
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 2 -- Dependency Analysis
        loop For each group in currentGroups
            vRO->>CB: execute(getGroupMembers)
            CB->>NSX: GET group members
            alt memberCount == 1 (last VM in group)
                vRO->>DFW: checkOrphanedRules(groupId)
                DFW->>NSX: GET rules referencing group
                DFW-->>vRO: orphanedRules[]
            end
        end
    end

    rect rgb(230, 255, 230)
        Note over vRO,VC: Step 3 -- Remove All Tags
        vRO->>CB: execute(removeTags)
        CB->>VC: PATCH tag-association (detach all tags)
        VC-->>CB: 200 OK -- Tags removed
        vRO->>SAGA: recordStep("removeTags", compensate=reApplyTags)
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 4 -- Verify Tag Removal Propagation
        loop Poll NSX tags (10s interval, 60s max)
            vRO->>CB: execute(getNsxTags)
            CB->>NSX: GET fabric VM tags
            vRO->>vRO: Confirm all tags removed from NSX
        end
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Steps 5-6 -- Verify Group Drain + DFW Detachment
        vRO->>CB: execute(getGroupMembership)
        CB->>NSX: GET groups by member
        vRO->>vRO: Confirm VM removed from all security groups
        vRO->>CB: execute(getEffectiveRules)
        CB->>NSX: GET effective DFW rules for VM
        vRO->>vRO: Confirm no app or env rules remain
    end

    rect rgb(230, 255, 230)
        Note over vRO,VC: Step 7 -- Deprovision VM (final, not reversible)
        vRO->>CB: execute(deleteVM)
        CB->>VC: DELETE VM
        VC-->>CB: 200 OK -- VM deleted
    end

    rect rgb(230, 255, 230)
        Note over vRO,SNOW: Step 8 -- Success Callback
        vRO->>SNOW: POST callback (SUCCESS, tags removed, groups removed)
        SNOW->>SNOW: Close RITM + mark CMDB CI Decommissioned
    end

    rect rgb(255, 230, 230)
        Note over vRO,DLQ: Error Path -- Restore Tags
        vRO->>SAGA: compensate()
        SAGA->>CB: reApplyTags(snapshot) [LIFO]
        CB->>VC: PATCH tags (restore all tags)
        vRO->>DLQ: enqueue(payload, error)
        vRO->>SNOW: POST callback (FAILURE, manual intervention required)
    end
```

## Dependency Check Logic

The dependency analysis in Step 2 prevents data integrity issues by detecting situations where removing a VM would leave DFW rules referencing empty security groups:

| Condition | Action | Error Code |
|-----------|--------|-----------|
| Group has multiple members | Safe to proceed | N/A |
| Group has 1 member (this VM), no rules reference group | Safe to proceed, log info | N/A |
| Group has 1 member (this VM), rules reference group | Proceed with warning | DFW-7007 (logged) |
| VM not found in inventory | Fail validation | DFW-1003 |

## Key Differences from Day 0 / Day 2

| Aspect | Day 0 | Day 2 | Day N |
|--------|-------|-------|-------|
| Direction | Add tags | Modify tags | Remove all tags |
| Dependency Check | None | Impact analysis | Orphan rule detection |
| VM Outcome | Created | Unchanged | Deleted |
| Reversibility | Full (delete VM + remove tags) | Full (revert to snapshot) | Partial (restore tags only, VM deletion is final) |
| CMDB Impact | Create CI | Update CI | Mark Decommissioned |
