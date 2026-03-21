# Day 0 Provisioning Sequence

This diagram shows the complete Day 0 (new VM provisioning) workflow, from the initial ServiceNow request through VM provisioning, tag application, NSX propagation verification, group membership validation, DFW coverage confirmation, and the final callback to ServiceNow. Error paths including saga compensation and DLQ placement are included.

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

    SNOW->>vRO: POST /trigger (Day0 payload)
    Note over SNOW,vRO: TLS 1.2+ / X-Correlation-ID header

    vRO->>vRO: Generate correlationId<br/>(RITM-{number}-{epoch})
    vRO->>VAL: validate(payload)
    VAL->>VAL: Schema validation (ajv)
    VAL->>VAL: Business rule checks<br/>(mandatory tags, valid site)
    VAL-->>vRO: Validation passed

    vRO->>SAGA: begin(correlationId)
    SAGA-->>vRO: Saga journal initialized

    rect rgb(230, 245, 255)
        Note over vRO,VC: Step 1 — VM Provisioning
        vRO->>CB: execute(provisionVM)
        CB->>VC: POST /rest/vcenter/vm (provision VM)
        VC-->>CB: 201 Created — vmId: vm-123
        CB-->>vRO: vmId: vm-123
        vRO->>SAGA: recordStep("provisionVM",<br/>compensate=deleteVM(vm-123))
    end

    rect rgb(230, 245, 255)
        Note over vRO,VC: Step 2 — Wait for VMware Tools
        loop Poll VMware Tools (5s interval, 300s max)
            vRO->>CB: execute(getToolsStatus)
            CB->>VC: GET /rest/vcenter/vm/{id}/tools
            VC-->>CB: toolsRunningStatus
            CB-->>vRO: status
        end
        Note over vRO: Tools running — proceed
    end

    rect rgb(230, 255, 230)
        Note over vRO,NSX: Step 3 — Apply Tags
        vRO->>TCE: enforceCardinality(current=[], desired=tags)
        TCE->>TCE: Validate single-value categories<br/>(Application, Tier, Environment, etc.)
        TCE->>TCE: Check conflict rules<br/>(PCI+Sandbox, HIPAA+Sandbox, etc.)
        TCE-->>vRO: Validated tag set

        vRO->>CB: execute(getCurrentTags)
        CB->>VC: GET /rest/com/vmware/cis/tagging/tag-association?vm={id}
        VC-->>CB: currentTags (empty for new VM)
        CB-->>vRO: currentTags=[]

        vRO->>CB: execute(applyTags)
        CB->>VC: PATCH /rest/com/vmware/cis/tagging/tag-association (attach tags)
        VC-->>CB: 200 OK — Tags applied
        CB-->>vRO: Tags applied
        vRO->>SAGA: recordStep("applyTags",<br/>compensate=removeTags(vm-123, categories))
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 4 — Verify Tag Propagation to NSX
        loop Poll NSX tag propagation (10s interval, 60s max)
            vRO->>CB: execute(getNsxTags)
            CB->>NSX: GET /api/v1/fabric/virtual-machines?external_id={id}
            NSX-->>CB: VM record with tags
            CB-->>vRO: NSX tags
            vRO->>vRO: Compare vCenter tags ↔ NSX tags
        end
        Note over vRO: Tags propagated — all match
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 5 — Verify Group Membership
        vRO->>CB: execute(getGroupMembership)
        CB->>NSX: GET /policy/api/v1/infra/domains/default/groups?member_id={id}
        NSX-->>CB: Security group list
        CB-->>vRO: groups[]
        vRO->>vRO: Validate expected groups<br/>match actual groups
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 6 — Validate DFW Coverage
        vRO->>CB: execute(getEffectiveRules)
        CB->>NSX: GET /policy/api/v1/infra/realized-state/enforcement-points/default/virtual-machines/{id}/rules
        NSX-->>CB: Effective DFW rules
        CB-->>vRO: rules[]
        vRO->>vRO: Confirm Infrastructure +<br/>Environment rules present
    end

    rect rgb(230, 255, 230)
        Note over vRO,SNOW: Step 7 — Success Callback
        vRO->>SNOW: POST /api/x_dfw/callback
        Note over SNOW: Payload: correlationId, status=SUCCESS,<br/>vmId, tags, groups, dfwRuleCount
        SNOW->>SNOW: Update RITM to Closed Complete
        SNOW->>SNOW: Create/update CMDB CI record
    end

    rect rgb(255, 230, 230)
        Note over vRO,DLQ: Error Path — Saga Compensation
        Note over vRO: If any step fails after retries exhausted:
        vRO->>SAGA: compensate()
        SAGA->>CB: removeTags(vm-123) [LIFO step 2]
        CB->>VC: DELETE tags
        VC-->>CB: Tags removed
        SAGA->>CB: deleteVM(vm-123) [LIFO step 1]
        CB->>VC: DELETE /rest/vcenter/vm/{id}
        VC-->>CB: VM deleted
        SAGA-->>vRO: compensationResult{succeeded:2, failed:0}

        vRO->>DLQ: enqueue(payload, error, completedSteps)
        DLQ-->>vRO: DLQ-entry-id

        vRO->>SNOW: POST /api/x_dfw/callback
        Note over SNOW: Payload: correlationId, status=FAILURE,<br/>error.code, compensationResult
        SNOW->>SNOW: Update RITM to Failed
    end
```

## Step Timing

| Step | Expected Duration | Timeout | Retry Policy |
|------|-------------------|---------|-------------|
| VM Provisioning | 30-120s | 300s | 3 retries, exponential backoff |
| VMware Tools Ready | 30-180s | 300s | Poll every 5s |
| Tag Application | 1-5s | 30s | 3 retries, exponential backoff |
| Tag Propagation | 5-30s | 60s | Poll every 10s |
| Group Verification | 1-5s | 30s | 3 retries |
| DFW Coverage Check | 1-5s | 30s | 3 retries |
| Callback | 1-3s | 15s | 3 retries |
