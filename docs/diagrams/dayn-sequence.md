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
    Note over SNOW,vRO: requestType=dayn-decommission<br/>vmId, site

    vRO->>vRO: Generate correlationId
    vRO->>VAL: validate(payload)
    VAL->>VAL: Schema validation
    VAL->>VAL: Verify vmId exists in inventory
    VAL->>VAL: Verify VM is powered off or<br/>decommission is authorized
    VAL-->>vRO: Validation passed

    vRO->>SAGA: begin(correlationId)
    SAGA-->>vRO: Saga journal initialized

    rect rgb(230, 245, 255)
        Note over vRO,NSX: Step 1 — Capture Current State
        vRO->>CB: execute(getCurrentTags)
        CB->>VC: GET /rest/com/vmware/cis/tagging/tag-association?vm={id}
        VC-->>CB: currentTags[]
        CB-->>vRO: currentTags (snapshot for rollback)

        vRO->>CB: execute(getGroupMembership)
        CB->>NSX: GET /policy/api/v1/infra/domains/default/groups?member_id={id}
        NSX-->>CB: currentGroups[]
        CB-->>vRO: currentGroups (snapshot)
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 2 — Dependency Analysis
        vRO->>vRO: checkDependencies(vmId, site)

        loop For each group in currentGroups
            vRO->>CB: execute(getGroupMembers)
            CB->>NSX: GET /policy/api/v1/infra/domains/default/groups/{groupId}/members/virtual-machines
            NSX-->>CB: memberCount
            CB-->>vRO: memberCount

            alt memberCount == 1 (this is the last VM)
                vRO->>DFW: checkOrphanedRules(groupId, site)
                DFW->>CB: execute(getRulesForGroup)
                CB->>NSX: GET /policy/api/v1/search?query=resource_type:Rule AND source_groups:{groupId}
                NSX-->>CB: rules referencing this group
                CB-->>DFW: rules[]
                DFW-->>vRO: orphanedRules[] (if any)
                Note over vRO: Log warning DFW-7007 if rules<br/>will become orphaned after removal
            end
        end

        vRO->>vRO: Generate dependency report
        Note over vRO: Report: groupsAffected, orphanRisk,<br/>safe to proceed (yes/no)
    end

    rect rgb(230, 255, 230)
        Note over vRO,VC: Step 3 — Remove All Tags
        vRO->>CB: execute(removeTags)
        CB->>VC: PATCH /rest/com/vmware/cis/tagging/tag-association<br/>(detach all tags from VM)
        VC-->>CB: 200 OK — Tags removed
        CB-->>vRO: Tags removed
        vRO->>SAGA: recordStep("removeTags",<br/>compensate=reApplyTags(vm-123, snapshot))
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 4 — Verify Tag Removal Propagation
        loop Poll NSX tag removal (10s interval, 60s max)
            vRO->>CB: execute(getNsxTags)
            CB->>NSX: GET /api/v1/fabric/virtual-machines?external_id={id}
            NSX-->>CB: VM record with tags
            CB-->>vRO: NSX tags
            vRO->>vRO: Confirm all tags removed from NSX
        end
        Note over vRO: Tags fully removed from NSX
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 5 — Verify Group Membership Drain
        vRO->>CB: execute(getGroupMembership)
        CB->>NSX: GET /policy/api/v1/infra/domains/default/groups?member_id={id}
        NSX-->>CB: groups[]
        CB-->>vRO: groups (should be empty)
        vRO->>vRO: Confirm VM removed from<br/>all dynamic security groups
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 6 — Verify DFW Rule Detachment
        vRO->>CB: execute(getEffectiveRules)
        CB->>NSX: GET /policy/api/v1/infra/realized-state/enforcement-points/default/virtual-machines/{id}/rules
        NSX-->>CB: Effective DFW rules
        CB-->>vRO: rules[] (should be minimal/default only)
        vRO->>vRO: Confirm no application or<br/>environment rules remain
    end

    rect rgb(230, 255, 230)
        Note over vRO,VC: Step 7 — Deprovision VM
        vRO->>CB: execute(deleteVM)
        CB->>VC: DELETE /rest/vcenter/vm/{id}
        VC-->>CB: 200 OK — VM deleted
        CB-->>vRO: VM deleted
        Note over vRO: No saga step recorded —<br/>VM deletion is final and<br/>not automatically reversible
    end

    rect rgb(230, 255, 230)
        Note over vRO,SNOW: Step 8 — Success Callback
        vRO->>SNOW: POST /api/x_dfw/callback
        Note over SNOW: Payload: correlationId, status=SUCCESS,<br/>vmId, tagsRemoved, groupsRemoved,<br/>orphanedRulesWarning (if any)
        SNOW->>SNOW: Update RITM to Closed Complete
        SNOW->>SNOW: Update CMDB CI status:<br/>Decommissioned
    end

    rect rgb(255, 230, 230)
        Note over vRO,DLQ: Error Path — Restore Tags
        Note over vRO: If tag removal or verification fails:
        vRO->>SAGA: compensate()
        SAGA->>CB: reApplyTags(vm-123, snapshot) [LIFO]
        CB->>VC: PATCH tags (restore all tags)
        VC-->>CB: Tags restored
        SAGA-->>vRO: compensationResult

        vRO->>DLQ: enqueue(payload, error, completedSteps)
        DLQ-->>vRO: DLQ-entry-id

        vRO->>SNOW: POST /api/x_dfw/callback (FAILURE)
        Note over SNOW: VM preserved — tags restored<br/>Manual intervention required
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
