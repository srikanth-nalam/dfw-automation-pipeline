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
    Note over SNOW,vRO: requestType=day2-update vmId, site, newTags{}

    vRO->>vRO: Generate correlationId
    vRO->>VAL: validate(payload)
    VAL->>VAL: Schema + business rule checks
    VAL->>VAL: Verify vmId exists in inventory
    VAL-->>vRO: Validation passed

    vRO->>SAGA: begin(correlationId)
    SAGA-->>vRO: Saga journal initialized

    rect rgb(230, 245, 255)
        Note over vRO,NSX: Step 1 — Read Current State (Snapshot)
        vRO->>CB: execute(getCurrentTags)
        CB->>VC: GET /rest/com/vmware/cis/tagging/tag-association?vm={id}
        VC-->>CB: currentVcTags[]
        CB-->>vRO: currentVcTags

        vRO->>CB: execute(getNsxTags)
        CB->>NSX: GET /api/v1/fabric/virtual-machines?external_id={id}
        NSX-->>CB: currentNsxTags[]
        CB-->>vRO: currentNsxTags

        vRO->>CB: execute(getGroupMembership)
        CB->>NSX: GET /policy/api/v1/infra/domains/default/groups?member_id={id}
        NSX-->>CB: currentGroups[]
        CB-->>vRO: currentGroups (pre-change snapshot)
    end

    rect rgb(255, 250, 230)
        Note over vRO,TCE: Step 2 — Impact Analysis
        vRO->>TCE: enforceCardinality(currentVcTags, newTags)
        TCE->>TCE: Validate single-value categories (no duplicate Environment, Tier, etc.)
        TCE->>TCE: Check conflict rules (PCI+Sandbox, HIPAA+Sandbox)
        TCE->>TCE: Validate "None" mutual exclusivity in Compliance category
        TCE-->>vRO: Validated merged tag set

        vRO->>vRO: computeDelta(currentVcTags, mergedTags)
        Note over vRO: Delta: {add: [...], remove: [...], unchanged: [...]}

        vRO->>vRO: Predict group membership changes
        Note over vRO: Compare tag-based group criteria against new tag set to predict groups to be added/removed
    end

    rect rgb(230, 255, 230)
        Note over vRO,VC: Step 3 — Apply Tag Deltas (Read-Compare-Write)
        vRO->>CB: execute(getCurrentTags) [re-read for freshness]
        CB->>VC: GET /rest/com/vmware/cis/tagging/tag-association?vm={id}
        VC-->>CB: freshTags[]
        CB-->>vRO: freshTags

        vRO->>vRO: Compare freshTags with original snapshot
        Note over vRO: If tags changed since snapshot, recompute delta to avoid conflicts

        vRO->>CB: execute(updateTags)
        CB->>VC: PATCH /rest/com/vmware/cis/tagging/tag-association (detach removed, attach added)
        VC-->>CB: 200 OK — Tags updated
        CB-->>vRO: Tags updated
        vRO->>SAGA: recordStep("applyTagDeltas", compensate=revertTags(vm-123, snapshot))
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 4 — Verify Tag Propagation
        loop Poll NSX tag propagation (10s interval, 60s max)
            vRO->>CB: execute(getNsxTags)
            CB->>NSX: GET /api/v1/fabric/virtual-machines?external_id={id}
            NSX-->>CB: VM record with updated tags
            CB-->>vRO: NSX tags
            vRO->>vRO: Compare expected tags ↔ NSX tags
        end
        Note over vRO: All tags propagated to NSX
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 5 — Verify Group Membership Changes
        vRO->>CB: execute(getGroupMembership)
        CB->>NSX: GET /policy/api/v1/infra/domains/default/groups?member_id={id}
        NSX-->>CB: updatedGroups[]
        CB-->>vRO: updatedGroups

        vRO->>vRO: Compare predicted groups ↔ actual groups
        Note over vRO: Verify VM was added to expected new groups and removed from groups no longer matching
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 6 — Validate DFW Coverage
        vRO->>CB: execute(getEffectiveRules)
        CB->>NSX: GET /policy/api/v1/infra/realized-state/enforcement-points/default/virtual-machines/{id}/rules
        NSX-->>CB: Effective DFW rules
        CB-->>vRO: rules[]
        vRO->>vRO: Confirm rule set matches new group membership
    end

    rect rgb(230, 255, 230)
        Note over vRO,SNOW: Step 7 — Success Callback
        vRO->>SNOW: POST /api/x_dfw/callback
        Note over SNOW: Payload: correlationId, status=SUCCESS, vmId, previousTags, newTags, groupsAdded[], groupsRemoved[]
        SNOW->>SNOW: Update RITM to Closed Complete
        SNOW->>SNOW: Update CMDB CI tags attribute
    end

    rect rgb(255, 230, 230)
        Note over vRO,DLQ: Error Path — Revert Tags
        Note over vRO: If any step fails after retries exhausted:
        vRO->>SAGA: compensate()
        SAGA->>CB: revertTags(vm-123, snapshot) [LIFO]
        CB->>VC: PATCH tags (restore previous state)
        VC-->>CB: Tags reverted
        SAGA-->>vRO: compensationResult

        vRO->>DLQ: enqueue(payload, error, completedSteps)
        DLQ-->>vRO: DLQ-entry-id

        vRO->>SNOW: POST /api/x_dfw/callback (FAILURE)
        SNOW->>SNOW: Update RITM with error + compensation
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
