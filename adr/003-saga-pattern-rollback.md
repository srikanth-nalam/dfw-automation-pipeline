# ADR-003: Saga Pattern for Multi-Step Rollback

**Status:** Accepted

**Date:** 2026-03-21

## Context

The DFW automation pipeline executes a series of distributed operations across multiple systems (vCenter, NSX Manager, ServiceNow) that must be treated as a logical transaction. A typical Day 0 flow involves: provisioning a VM, applying tags via VAPI, waiting for tag propagation to NSX, verifying security group membership, and validating DFW rule application. A failure at any step leaves the system in a partially completed state that must be cleaned up.

Traditional two-phase commit (2PC) is not feasible because:

- The participating systems (vCenter, NSX, ServiceNow) do not support distributed transaction protocols.
- Operations are long-running (tag propagation can take up to 60 seconds).
- Some operations are inherently non-transactional (e.g., VM provisioning).

The system needs a mechanism to track completed steps and execute compensating actions in reverse order when a failure occurs, ensuring the environment is returned to a consistent state.

Options considered:

- **Saga pattern with compensating transactions:** Each step records a compensating action; on failure, compensations execute in reverse order.
- **Manual cleanup procedures:** Document rollback steps and require operators to execute them.
- **Idempotent retry-only approach:** Retry failed operations indefinitely without rollback.
- **Event sourcing with replay:** Record all events and rebuild state from the event log.

## Decision

We will implement the **Saga pattern** using a `SagaCoordinator` component that maintains an in-memory journal of completed steps and their corresponding compensating actions. When a failure is detected, the coordinator executes compensating actions in reverse chronological order to restore the system to its pre-transaction state.

Each workflow step registers with the saga coordinator by providing:
- A step name for logging and traceability.
- A compensating action (function reference) that undoes the step's effect.

The saga journal is persisted to the vRO workflow token for durability across workflow suspensions. On failure, the coordinator iterates the journal in reverse, executing each compensating action. If a compensating action itself fails, it is logged and the next compensation is attempted (best-effort compensation). The failed payload and compensation results are written to the Dead Letter Queue for manual review.

## Consequences

**Positive:**
- Provides automatic, structured rollback for multi-step distributed operations without requiring distributed transaction support.
- Reverse-order compensation ensures dependencies are cleaned up correctly (e.g., tags removed before VM deleted).
- Journal-based tracking provides full auditability of what was done and what was undone.
- Dead Letter Queue captures unrecoverable failures for manual intervention.
- Pattern is well-understood and testable in isolation.

**Negative:**
- Compensating actions must be carefully designed to be idempotent (a compensation may be retried).
- Some operations may not be fully reversible (e.g., if a VM was partially configured by external systems between provisioning and rollback).
- In-memory journal is lost if the vRO node crashes mid-workflow (mitigated by workflow token persistence).
- Adds complexity to each workflow step, which must define its compensating action.
- Best-effort compensation means the system may not always return to a perfectly clean state — DLQ review is required for edge cases.
