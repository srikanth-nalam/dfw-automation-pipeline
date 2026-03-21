# ADR-003: Saga Pattern for Multi-Step Rollback

**Status:** Accepted
**Date:** 2026-03-21
**Deciders:** Senior Cloud Security Architect, vRO Developer, Platform Engineering Lead

## Context

The DFW automation pipeline executes multi-step distributed transactions across vCenter and NSX Manager. A Day 0 provisioning workflow, for example, provisions a VM, applies tags, waits for propagation, verifies group membership, and validates DFW coverage. If any step fails after previous steps have completed, the system must undo the already-completed work to maintain consistency.

### The Distributed Transaction Problem

Traditional database transactions (ACID) are not possible across independent REST APIs. Each step in the pipeline calls a different service (vCenter VAPI, NSX Manager REST API) with no shared transaction coordinator:

1. **Provision VM** (vCenter) — Creates a VM resource
2. **Apply Tags** (vCenter VAPI) — Attaches tags to the VM
3. **Verify Propagation** (NSX REST) — Confirms tags propagated to NSX fabric
4. **Verify Groups** (NSX REST) — Confirms dynamic security group membership
5. **Validate DFW** (NSX REST) — Confirms DFW rule coverage

If Step 3 fails (NSX Manager timeout), the VM exists with tags applied but is not yet in the correct security groups. Leaving the VM in this partial state creates a security risk — the VM has network access but is not protected by the intended DFW rules.

### Requirements

- Track completed steps as an ordered journal with timestamps
- Provide compensating actions for each forward step
- Execute compensations in reverse order (LIFO) on failure
- Handle partial compensation failures gracefully (continue compensating remaining steps)
- Integrate with the correlation ID for full traceability in logs
- Support all three lifecycle operations (Day 0, Day 2, Day N)
- Provide the full compensation result to the ServiceNow callback

### Alternatives Considered

**Two-Phase Commit (2PC):** Not feasible across REST APIs with no distributed transaction coordinator. Neither vCenter nor NSX Manager supports XA-style prepared transactions.

**Eventual Consistency with Retry:** Retry the failing step indefinitely until it succeeds. This approach is too slow for user-facing provisioning workflows (ServiceNow SLA requires a response within 15 minutes) and may leave VMs in an insecure partial state during the retry window.

**Manual Rollback:** On failure, log the partial state and rely on operators to manually clean up. This is error-prone, violates the automation goal, introduces human latency into the failure recovery path, and does not scale.

**Event Sourcing with Replay:** Record all events and rebuild state from the event log. Architecturally elegant but introduces significant complexity (event store, projection engine, snapshot management) beyond what the use case requires.

## Decision

We implement the **Saga pattern** using a `SagaCoordinator` that maintains an in-memory journal of completed steps and their compensating actions. The saga follows the **orchestration** variant (not choreography) — the lifecycle orchestrator serves as the saga coordinator, directing both forward steps and compensations.

### SagaCoordinator Design

```
SagaCoordinator
  - journal: SagaStep[]        // Ordered list of completed steps
  - correlationId: string       // Links to pipeline execution
  - active: boolean             // Guard against misuse

  + begin(correlationId)        // Initialize new saga
  + recordStep(name, compensatingAction)  // Log step + compensation function
  + compensate()                // Execute compensations in LIFO order
  + getJournal()                // Return current journal for debugging
  + isActive()                  // Check if saga is in progress
```

### Compensation Execution

On failure, `compensate()` traverses the journal in **reverse order** (LIFO — Last In, First Out):

1. The most recently completed step is compensated first
2. Each compensating action is executed with retry (the RetryHandler wraps compensations)
3. **If a compensation fails, it is logged but does not halt remaining compensations**
4. The full result (succeeded count, failed count, details per step) is included in the error callback to ServiceNow
5. Failed compensations are flagged in the DLQ entry for manual remediation

### Compensating Actions by Operation

**Day 0 (Provision):**

| Step | Forward Action | Compensating Action |
|------|---------------|-------------------|
| provisionVM | POST /vm (create VM) | DELETE /vm/{id} (delete VM) |
| applyTags | PATCH /tags (attach tags) | PATCH /tags (detach all tags) |
| verifyPropagation | GET /tags (poll NSX) | No compensation (read-only) |
| verifyGroups | GET /groups (check membership) | No compensation (read-only) |
| validateDFW | GET /rules (check coverage) | No compensation (read-only) |

**Day 2 (Update):**

| Step | Forward Action | Compensating Action |
|------|---------------|-------------------|
| snapshotState | GET current tags + groups | No compensation (read-only) |
| applyTagDeltas | PATCH /tags (update tags) | PATCH /tags (revert to snapshot) |
| verifyPropagation | GET /tags (poll NSX) | No compensation (read-only) |
| verifyGroups | GET /groups (check membership) | No compensation (read-only) |
| validateDFW | GET /rules (check coverage) | No compensation (read-only) |

**Day N (Decommission):**

| Step | Forward Action | Compensating Action |
|------|---------------|-------------------|
| captureState | GET current tags + groups | No compensation (read-only) |
| checkDependencies | Analyze group membership | No compensation (read-only) |
| removeTags | PATCH /tags (detach all) | PATCH /tags (re-apply from snapshot) |
| verifyRemoval | GET /tags + /groups (confirm) | No compensation (read-only) |
| deprovisionVM | DELETE /vm/{id} | **Not reversible** — VM deletion is final |

### Error Codes

| Code | Description |
|------|-------------|
| DFW-6001 | Saga not active (begin() not called) |
| DFW-6002 | No steps to compensate (journal empty) |
| DFW-6003 | Saga already active (begin() called twice) |
| DFW-6004 | Compensation failed for one or more steps |

## Consequences

### Positive

- **Automated, consistent rollback** on any failure — no manual intervention required for the common case.
- **Full audit trail** of completed steps, compensations, and outcomes via structured logging with correlation ID.
- **Failed compensations are isolated** — one failed compensation does not prevent remaining compensations from executing.
- **Observable compensation results** — the ServiceNow callback includes the full compensation result, enabling support teams to understand what was cleaned up and what requires manual attention.
- **DLQ integration** — entries that fail after saga compensation are placed in the DLQ with full context (original payload, completed steps, compensation result) for manual reprocessing.
- **Reverse-order compensation** ensures dependencies are cleaned up correctly (e.g., tags removed before VM deleted).
- **Pattern is well-understood** and testable in isolation with Jest mock functions.

### Negative

- **In-memory journal is volatile:** If the vRO process crashes mid-workflow, the saga journal is lost. The partially-completed operation will have no automatic compensation. This is mitigated by DLQ placement on workflow failure detection and vRO workflow token persistence.
- **Compensation latency:** Executing compensations adds time to the failure path. A Day 0 failure with 2 compensations (delete tags, delete VM) adds 10-30 seconds to the callback time.
- **Compensation may fail:** If the same infrastructure issue that caused the forward step to fail also affects the compensating call (e.g., vCenter is completely down), compensations will also fail. This results in a partial state that requires manual remediation via DLQ.
- **Each new step requires a compensating action:** Adding new steps to the pipeline requires defining and testing the corresponding compensating action. This adds development overhead but ensures rollback coverage.
- **Not all operations are reversible:** VM deletion in Day N is a one-way operation. The saga can only compensate steps up to the point of irreversible actions.

### Mitigations

- **Volatile journal** is mitigated by the DLQ catching workflow-level failures and preserving the last known state.
- **Compensation failures** are mitigated by the DLQ's manual reprocessing capability and the runbook's manual rollback procedures (Section 4).
- **Idempotency** is ensured by using the read-compare-write pattern in TagOperations — compensating actions read current state before writing, making them safe to repeat.

## Related Decisions

- ADR-001 (vRO Selection) provides the JavaScript runtime for SagaCoordinator implementation.
- ADR-004 (Circuit Breaker) protects compensating actions from cascade failures during recovery.
- ADR-002 (Tag Governance) ensures compensating tag operations use the validated tag set.
