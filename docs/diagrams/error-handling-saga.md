# Error Handling with Saga Compensation

This diagram illustrates the complete error handling flow in the DFW Automation Pipeline, showing how the Saga pattern coordinates multi-step compensation when a failure occurs. It covers the happy path steps, the failure detection, LIFO compensation execution, partial compensation failure handling, DLQ placement, and the error callback to ServiceNow.

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant S as SagaCoordinator
    participant R as RetryHandler
    participant CB as CircuitBreaker
    participant VC as vCenter
    participant NSX as NSX Manager
    participant EF as ErrorFactory
    participant DLQ as Dead Letter Queue
    participant LOG as Logger
    participant SNOW as ServiceNow

    Note over O,S: === HAPPY PATH STEPS ===

    O->>S: begin(correlationId)
    S->>LOG: log(INFO, "Saga begun", {correlationId})
    S-->>O: journal initialized (empty)

    O->>R: execute(provisionVM, {maxRetries: 3})
    R->>CB: execute(provisionVM)
    CB->>VC: POST /rest/vcenter/vm
    VC-->>CB: 201 Created — vmId: vm-123
    CB-->>R: success
    R-->>O: vmId: vm-123
    O->>S: recordStep("provisionVM", deleteVM(vm-123))
    S->>LOG: log(INFO, "Step recorded", {step: "provisionVM", index: 0})

    O->>R: execute(applyTags, {maxRetries: 3})
    R->>CB: execute(applyTags)
    CB->>VC: PATCH /tags (attach Application, Tier, Environment, etc.)
    VC-->>CB: 200 OK
    CB-->>R: success
    R-->>O: Tags applied
    O->>S: recordStep("applyTags", removeTags(vm-123, categories))
    S->>LOG: log(INFO, "Step recorded", {step: "applyTags", index: 1})

    Note over O,NSX: === FAILURE OCCURS ===

    O->>R: execute(verifyPropagation, {maxRetries: 3})
    R->>CB: execute(verifyPropagation) [attempt 1]
    CB->>NSX: GET /api/v1/fabric/virtual-machines?external_id={id}
    NSX--xCB: 504 Gateway Timeout
    CB--xR: timeout error
    R->>LOG: log(WARN, "Retry 1/3", {operation: "verifyPropagation"})

    R->>CB: execute(verifyPropagation) [attempt 2, +5s backoff]
    CB->>NSX: GET /api/v1/fabric/virtual-machines?external_id={id}
    NSX--xCB: 504 Gateway Timeout
    CB--xR: timeout error
    R->>LOG: log(WARN, "Retry 2/3", {operation: "verifyPropagation"})

    R->>CB: execute(verifyPropagation) [attempt 3, +15s backoff]
    CB->>NSX: GET /api/v1/fabric/virtual-machines?external_id={id}
    NSX--xCB: 504 Gateway Timeout
    CB->>CB: failureCount >= threshold<br/>State: CLOSED → OPEN
    CB->>LOG: log(ERROR, "Circuit breaker OPEN",<br/>{endpoint: "nsx-ndcng"})
    CB--xR: DFW-6004 Circuit breaker open

    R->>EF: createError("DFW-7004", "Tag propagation sync timeout",<br/>{step: "verifyPropagation", retryCount: 3})
    EF-->>R: enrichedError
    R--xO: DFW-7004 after 3 retries

    Note over O,S: === SAGA COMPENSATION (LIFO) ===

    O->>S: compensate()
    S->>LOG: log(WARN, "Beginning compensation",<br/>{steps: 2, correlationId})

    rect rgb(255, 240, 230)
        Note over S,VC: Compensate Step 1 (index 1): Remove Tags
        S->>R: execute(removeTags(vm-123, categories))
        R->>CB: execute(removeTags)
        Note over CB: Using vCenter circuit breaker<br/>(separate from NSX — still CLOSED)
        CB->>VC: PATCH /tags (detach all tags)
        VC-->>CB: 200 OK
        CB-->>R: success
        R-->>S: Tags removed
        S->>LOG: log(INFO, "Compensation succeeded",<br/>{step: "applyTags", index: 1})
    end

    rect rgb(255, 240, 230)
        Note over S,VC: Compensate Step 0 (index 0): Delete VM
        S->>R: execute(deleteVM(vm-123))
        R->>CB: execute(deleteVM)
        CB->>VC: DELETE /rest/vcenter/vm/vm-123
        VC-->>CB: 200 OK
        CB-->>R: success
        R-->>S: VM deleted
        S->>LOG: log(INFO, "Compensation succeeded",<br/>{step: "provisionVM", index: 0})
    end

    S-->>O: compensationResult: {succeeded: 2, failed: 0, details: [...]}

    Note over O,DLQ: === DLQ PLACEMENT ===

    O->>DLQ: enqueue({<br/>  correlationId,<br/>  operation: "day0-provision",<br/>  vmId: "vm-123",<br/>  site: "NDCNG",<br/>  error: {code: "DFW-7004", message: "..."},<br/>  completedSteps: ["provisionVM", "applyTags"],<br/>  compensationResult: {succeeded: 2, failed: 0},<br/>  retryCount: 3<br/>})
    DLQ-->>O: DLQ-entry-id: dlq-456
    DLQ->>LOG: log(ERROR, "DLQ entry created",<br/>{dlqId: "dlq-456", correlationId})

    Note over O,SNOW: === ERROR CALLBACK ===

    O->>EF: createCallbackPayload(correlationId, error, "COMPENSATED")
    EF-->>O: callbackPayload

    O->>SNOW: POST /api/x_dfw/callback
    Note over SNOW: {<br/>  correlationId: "RITM-1234-171...",<br/>  status: "FAILURE",<br/>  error: {<br/>    code: "DFW-7004",<br/>    message: "Tag propagation sync timeout",<br/>    step: "verifyPropagation"<br/>  },<br/>  compensationAction: "COMPENSATED",<br/>  compensationResult: {<br/>    succeeded: 2, failed: 0<br/>  },<br/>  dlqEntryId: "dlq-456"<br/>}
    SNOW->>SNOW: Update RITM status: Failed
    SNOW->>SNOW: Attach error details to work notes
```

## Partial Compensation Failure

When a compensating action itself fails, the saga continues with remaining compensations rather than aborting:

```mermaid
sequenceDiagram
    participant S as SagaCoordinator
    participant R as RetryHandler
    participant VC as vCenter
    participant LOG as Logger

    Note over S: Compensating 3 steps in LIFO order

    S->>R: execute(compensate step 2: removePolicy)
    R-->>S: Success
    S->>LOG: log(INFO, "Compensation succeeded", {step: 2})

    S->>R: execute(compensate step 1: removeTags)
    R--xS: FAILURE (vCenter unavailable)
    S->>LOG: log(ERROR, "Compensation FAILED",<br/>{step: 1, error: "vCenter unreachable"})
    Note over S: Record failure but CONTINUE

    S->>R: execute(compensate step 0: deleteVM)
    R-->>S: Success
    S->>LOG: log(INFO, "Compensation succeeded", {step: 0})

    S-->>S: compensationResult:<br/>{succeeded: 2, failed: 1,<br/>details: [{step: "removeTags", error: "..."}]}

    Note over S,LOG: Failed compensations are flagged<br/>in DLQ for manual remediation
```

## Error Code Reference

| Code | Category | Retryable | Compensation | Description |
|------|----------|-----------|-------------|-------------|
| DFW-1001 | Validation | No | None needed | Invalid payload schema |
| DFW-1002 | Validation | No | None needed | Missing mandatory tags |
| DFW-1003 | Validation | No | None needed | VM not found in inventory |
| DFW-2001 | NSX API | Yes | Saga compensate | NSX Manager API unreachable |
| DFW-2002 | NSX Auth | No | Saga compensate | NSX authentication failure |
| DFW-3001 | Tag | Yes | Saga compensate | Tag application failed |
| DFW-3003 | Tag | No | Saga compensate | Tag cardinality violation |
| DFW-4001 | Group | Yes | Saga compensate | Group membership verification failed |
| DFW-6001 | Saga | No | Manual | Saga not active |
| DFW-6002 | Saga | No | Manual | No steps to compensate |
| DFW-6003 | Saga | No | Manual | Saga already active |
| DFW-6004 | Circuit | No | Saga compensate | Circuit breaker is OPEN |
| DFW-7001 | Timeout | Yes | Saga compensate | Operation timeout |
| DFW-7004 | Timeout | Yes | Saga compensate | Tag propagation sync timeout |
| DFW-7006 | DFW | Yes | Saga compensate | DFW coverage validation failed |
| DFW-7007 | DFW | No | Warning only | Orphaned rule detected |
| DFW-9001 | System | No | Saga compensate | Unexpected internal error |
