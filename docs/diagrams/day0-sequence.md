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
    vRO->>vRO: Generate correlationId
    vRO->>VAL: validate(payload)
    VAL->>VAL: Schema + business rule checks
    VAL-->>vRO: Validation passed
    vRO->>SAGA: begin(correlationId)

    rect rgb(230, 245, 255)
        Note over vRO,VC: Step 1 -- VM Provisioning
        vRO->>CB: execute(provisionVM)
        CB->>VC: POST /rest/vcenter/vm
        VC-->>CB: 201 Created -- vm-123
        vRO->>SAGA: recordStep("provisionVM", compensate=deleteVM)
    end

    rect rgb(230, 245, 255)
        Note over vRO,VC: Step 2 -- Wait for VMware Tools
        loop Poll Tools (5s interval, 300s max)
            vRO->>CB: execute(getToolsStatus)
            CB->>VC: GET vm tools status
            VC-->>CB: toolsRunningStatus
        end
    end

    rect rgb(230, 255, 230)
        Note over vRO,NSX: Step 3 -- Apply Tags
        vRO->>TCE: enforceCardinality(current=[], desired=tags)
        TCE->>TCE: Validate categories + conflict rules
        TCE-->>vRO: Validated tag set
        vRO->>CB: execute(applyTags)
        CB->>VC: PATCH tag-association (attach tags)
        VC-->>CB: 200 OK -- Tags applied
        vRO->>SAGA: recordStep("applyTags", compensate=removeTags)
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 4 -- Verify Tag Propagation to NSX
        loop Poll NSX tags (10s interval, 60s max)
            vRO->>CB: execute(getNsxTags)
            CB->>NSX: GET fabric VM tags
            vRO->>vRO: Compare vCenter vs NSX tags
        end
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 5 -- Verify Group Membership
        vRO->>CB: execute(getGroupMembership)
        CB->>NSX: GET groups by member
        vRO->>vRO: Validate expected vs actual groups
    end

    rect rgb(255, 250, 230)
        Note over vRO,NSX: Step 6 -- Validate DFW Coverage
        vRO->>CB: execute(getEffectiveRules)
        CB->>NSX: GET effective DFW rules for VM
        NSX-->>CB: rules[]
        vRO->>vRO: Confirm Infra + Env rules present
    end

    rect rgb(230, 255, 230)
        Note over vRO,SNOW: Step 7 -- Success Callback
        vRO->>SNOW: POST callback (SUCCESS, vmId, tags, groups)
        SNOW->>SNOW: Close RITM + update CMDB CI
    end

    rect rgb(255, 230, 230)
        Note over vRO,DLQ: Error Path -- Saga Compensation
        vRO->>SAGA: compensate()
        SAGA->>CB: removeTags [LIFO step 2]
        CB->>VC: DELETE tags
        SAGA->>CB: deleteVM [LIFO step 1]
        CB->>VC: DELETE VM
        SAGA-->>vRO: compensationResult
        vRO->>DLQ: enqueue(payload, error)
        vRO->>SNOW: POST callback (FAILURE)
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
