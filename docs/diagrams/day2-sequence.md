# Day 2 Tag Update Sequence

This diagram shows the complete Day 2 (tag modification) workflow for an existing VM. It includes the impact analysis phase that predicts security group changes before applying tag deltas, the read-compare-write pattern for idempotent tag updates, and the post-update verification cycle.

```mermaid
sequenceDiagram
    participant SNOW as ServiceNow
    participant vRO as vRO Orchestrator
    participant VAL as PayloadValidator
    participant SAGA as SagaCoordinator
    participant TCE as TagCardinalityEnforcer
    participant CB as CircuitBreaker
    participant VC as vCenter (Site)
    participant NSX as NSX Manager (Site)
    participant DLQ as Dead Letter Queue

    SNOW->>vRO: POST /trigger (Day2 payload)
    vRO->>vRO: Generate correlationId
    vRO->>VAL: validate(payload)
    VAL->>VAL: Schema + business rules + vmId exists
    VAL-->>vRO: Validation passed
    vRO->>SAGA: begin(correlationId)

    rect rgb(230, 245, 255)
        Note over vRO,NSX: Step 1 -- Read Current State (Snapshot)
        vRO->>CB: execute(getCurrentTags)
        CB->>VC: GET tag-association(vm)
        VC-->>CB: currentVcTags[]
        vRO->>CB: execute(getNsxTags)
        CB->>NSX: GET fabric VM tags
        vRO->>CB: execute(getGroupMembership)
        CB->>NSX: GET groups by member
    end

    rect rgb(255, 250, 230)
        Note over vRO,TCE: Step 2 -- Impact Analysis
        vRO->>TCE: enforceCardinality(currentVcTags, newTags)
        TCE->>TCE: Validate categories + conflict rules
        TCE-->>vRO: Validated merged tag set
        vRO->>vRO: computeDelta(currentVcTags, mergedTags)
        vRO->>vRO: Predict group membership changes
    end

    rect rgb(230, 255, 230)
        Note over vRO,VC: Step 3 -- Apply Tag Deltas (Read-Compare-Write)
        vRO->>CB: re-read getCurrentTags for freshness
        CB->>VC: GET tag-association(vm)
        vRO->>vRO: Compare freshTags with snapshot, recompute if changed
        vRO->>CB: execute(updateTags)
        CB->>VC: PATCH tag-association (detach removed, attach added)
        VC-->>CB: 200 OK -- Tags updated
        vRO->>SAGA: recordStep("applyTagDeltas", compensate=revertTags)
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 4 -- Verify Tag Propagation
        loop Poll NSX tags (10s interval, 60s max)
            vRO->>CB: execute(getNsxTags)
            CB->>NSX: GET fabric VM tags
            vRO->>vRO: Compare expected vs NSX tags
        end
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 5 -- Verify Group Membership Changes
        vRO->>CB: execute(getGroupMembership)
        CB->>NSX: GET groups by member
        vRO->>vRO: Compare predicted vs actual groups
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 6 -- Validate DFW Coverage
        vRO->>CB: execute(getEffectiveRules)
        CB->>NSX: GET effective DFW rules for VM
        vRO->>vRO: Confirm rules match new group membership
    end

    rect rgb(230, 255, 230)
        Note over vRO,SNOW: Step 7 -- Success Callback
        vRO->>SNOW: POST callback (SUCCESS, tags, groups changed)
        SNOW->>SNOW: Close RITM + update CMDB CI tags
    end

    rect rgb(255, 230, 230)
        Note over vRO,DLQ: Error Path -- Revert Tags
        vRO->>SAGA: compensate()
        SAGA->>CB: revertTags(snapshot) [LIFO]
        CB->>VC: PATCH tags (restore previous state)
        SAGA-->>vRO: compensationResult
        vRO->>DLQ: enqueue(payload, error)
        vRO->>SNOW: POST callback (FAILURE)
        SNOW->>SNOW: Update RITM with error
    end
```

## Key Differences from Day 0

| Aspect | Day 0 | Day 2 |
|--------|-------|-------|
| VM State | New (being provisioned) | Existing (already running) |
| Tag State | Empty (no prior tags) | Populated (has current tags) |
| Operation | Full tag application | Delta-based tag update |
| Impact Analysis | Not needed | Required (predicts group changes) |
| Read-Compare-Write | Single write | Re-read before write for freshness |
| Compensation | Remove all tags + delete VM | Revert to pre-change tag snapshot |
| CMDB Impact | Create CI record | Update CI record |
