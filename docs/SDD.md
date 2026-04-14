# Solution Design Document (SDD)

## NSX DFW Automation Pipeline

**Version:** 1.0
**Date:** 2026-03-21
**Author:** Enterprise Infrastructure & Cloud Security
**Status:** Approved

---

## Table of Contents

1. [Executive Overview](#1-executive-overview)
2. [Architecture Decisions and Tradeoffs](#2-architecture-decisions-and-tradeoffs)
3. [Design Patterns Applied](#3-design-patterns-applied)
4. [Integration Architecture](#4-integration-architecture)
5. [Security Model](#5-security-model)
6. [Multi-Site Considerations](#6-multi-site-considerations)
7. [Error Handling Strategy](#7-error-handling-strategy)
8. [Tag Governance Model](#8-tag-governance-model)
9. [Module Inventory](#9-module-inventory)

---

## 1. Executive Overview

The NSX DFW Automation Pipeline delivers automated lifecycle management for VMware NSX-T Distributed Firewall policies through a tag-driven approach. The solution replaces manual, ticket-driven firewall rule management with a fully orchestrated pipeline that spans ServiceNow catalog requests through to realized DFW policy enforcement on the NSX data plane.

The core value proposition is threefold. First, it eliminates the operational bottleneck of manual firewall rule provisioning by automating the entire workflow from request submission through policy application. Second, it enforces security governance through a centralized tag dictionary with cardinality constraints, conflict detection, and compliance validation -- ensuring that every workload receives the correct micro-segmentation posture based on its declared attributes. Third, it provides end-to-end auditability by correlating every operation back to a ServiceNow RITM number, enabling security and compliance teams to trace any DFW rule to its originating business request.

The pipeline supports three lifecycle operations: Day 0 provisioning (initial tag assignment, group membership, and DFW policy application for newly built VMs), Day 2 updates (tag modifications, group reconciliation, and policy adjustments for configuration changes), and Day N decommissioning (tag removal, group cleanup, and policy verification for retired workloads). Each operation is orchestrated as a saga -- a series of compensable steps that can be rolled back in reverse order if any step fails -- ensuring that partial failures never leave the environment in an inconsistent state.

The solution targets two production data center sites (NDCNG and TULNG) running VMware Cloud Foundation with NSX-T Federation, enabling consistent policy enforcement across geographically distributed infrastructure. By treating DFW policies as code (version-controlled YAML definitions), the pipeline supports GitOps-style change management with peer review, diff-based auditing, and automated drift detection.

---

## 2. Architecture Decisions and Tradeoffs

### 2.1 Orchestration Engine: vRealize Orchestrator (vRO)

The decision to use VMware vRealize Orchestrator as the central orchestration engine was driven by several factors. vRO provides native integration with vCenter and NSX-T through built-in plug-ins, reducing the development effort for API authentication, session management, and object model mapping. It offers a visual workflow designer that enables operations teams to understand and modify orchestration flows without deep coding expertise. vRO also supports JavaScript (Rhino engine) for scriptable tasks, providing sufficient expressiveness for complex business logic while remaining accessible to infrastructure engineers.

The tradeoff is that vRO imposes certain constraints: the Rhino JS engine does not support ES6+ features natively (though the code is written to be compatible), the debugging experience is less sophisticated than modern IDE environments, and horizontal scaling requires vRO cluster configuration. These limitations are mitigated by externalizing business logic into testable JavaScript modules that run independently of vRO during development and testing.

### 2.2 Tag-Driven Security Model

Rather than managing firewall rules directly (IP-based or VM-based), the pipeline uses NSX tags as the primary abstraction for security policy assignment. VMs are tagged with attributes (Application, Tier, Environment, DataClassification, Compliance, CostCenter) and NSX security groups use tag-based membership criteria. DFW rules reference these groups, not individual VMs.

This design decouples policy definition from infrastructure topology. When a new VM is provisioned and tagged, it automatically inherits the correct security posture through group membership -- no rule modification is required. Conversely, when a VM's role changes (e.g., promotion from Development to Production), updating its Environment tag automatically adjusts its security group membership and DFW rule coverage.

The tradeoff is increased complexity in tag governance: cardinality rules must be enforced, tag values must be validated against a controlled dictionary, and conflicting tag combinations must be detected before application. The TagCardinalityEnforcer and conflict validation subsystem address this complexity.

### 2.3 Policy-as-Code with YAML

DFW policies are defined as declarative YAML files stored in version control rather than managed through the NSX Manager UI. This enables peer review of policy changes, diff-based auditing of what changed and when, automated validation through CI/CD pipelines, and rollback via git revert.

The tradeoff is that operators must interact with policies through text files and pull requests rather than a visual rule editor. This is mitigated by comprehensive YAML schema validation and clear naming conventions that make policies human-readable.

### 2.4 Eventual Consistency Model

The pipeline operates on an eventual consistency model: after a tag is applied to a VM, there is a propagation delay before NSX security groups update their membership and DFW rules take effect on the data plane. The pipeline addresses this with polling-based verification (checking realized state until convergence) rather than assuming instantaneous consistency.

This design accepts higher latency in exchange for reliability. The alternative -- relying on synchronous API responses as confirmation of enforcement -- would be fragile because the NSX data plane updates asynchronously from the management plane.

### 2.5 Saga Pattern Extended for Quarantine Rollback

The quarantine workflow extends the existing saga pattern to handle emergency VM isolation scenarios where rollback correctness is safety-critical. When a VM is quarantined, the QuarantineOrchestrator records each isolation step (tag application, group membership change, DFW rule enforcement) as a compensable saga entry. If quarantine fails partway through -- or when the quarantine expires -- the saga coordinator executes the inverse operations in strict reverse order: DFW rules are relaxed before group memberships are restored, and group memberships are restored before quarantine tags are removed.

The tradeoff is that quarantine rollback is more conservative than standard saga compensation. Standard compensations use best-effort semantics (continue on failure), but quarantine rollback uses fail-stop semantics: if any compensation step fails, the rollback halts and the VM remains in its current isolation state rather than risk leaving a partially de-isolated VM. This prioritizes security over availability -- a VM that stays quarantined longer than necessary is preferable to a VM that is accidentally exposed during a partial rollback.

### 2.6 Semaphore-Based Concurrency Control for Bulk Operations

Bulk tag operations (applying or modifying tags across tens or hundreds of VMs) require concurrency control to avoid overwhelming NSX Manager with simultaneous API calls. The BulkTagOrchestrator uses a counting semaphore to limit the number of concurrent tag operations to a configurable maximum (default: 5). Each VM operation acquires a semaphore permit before executing and releases it upon completion, regardless of success or failure.

This approach was chosen over a simple serial loop because bulk operations on large VM sets would take unacceptably long if processed one at a time. It was chosen over unthrottled parallelism because NSX Manager has internal concurrency limits that, when exceeded, produce HTTP 429 responses or degraded performance. The semaphore provides a middle ground: predictable throughput without overloading the target system. The concurrency limit is tunable per deployment, allowing operators to increase throughput during maintenance windows or decrease it during peak business hours.

### 2.7 Read-Compare-Write Pattern for Idempotent Tag Operations

Tag operations across the pipeline use a read-compare-write pattern to ensure idempotency and prevent race conditions. Before applying any tag change, the operation reads the VM's current tag set from NSX, computes a minimal diff against the desired state, and writes only the changes. If the desired state already matches the current state, no write is issued.

This pattern is critical for bulk operations and retry scenarios. When the RetryHandler re-executes a failed tag operation, the read-compare-write ensures that tags successfully applied before the failure are not re-applied or duplicated. It also prevents conflicting concurrent operations from silently overwriting each other's changes -- if the current state has diverged from expectations (due to a concurrent modification), the operation can detect the conflict and either merge or abort.

The tradeoff is an additional API read before every write, which increases per-operation latency by one round trip. This is acceptable because the read cost is small relative to the write cost, and the correctness guarantees are essential for maintaining tag consistency across distributed operations.

### 2.8 Token Bucket Rate Limiting for NSX API Protection

The pipeline employs a token bucket rate limiter to protect NSX Manager from excessive API call volume during bulk operations, drift scans, and other high-throughput workflows. The RateLimiter maintains a bucket of tokens that refill at a fixed rate (configurable, default: 20 tokens per second). Each API call consumes one token. When the bucket is empty, callers block until a token becomes available.

This approach was chosen over a simple fixed-window rate limiter because the token bucket algorithm handles burst traffic more gracefully. A fixed-window limiter allows all permitted calls at the start of the window, creating a thundering-herd pattern. The token bucket smooths request distribution over time while still permitting short bursts up to the bucket capacity.

The tradeoff is that callers may experience variable latency when the token bucket is depleted, which complicates timeout calculations. The pipeline addresses this by excluding rate-limiter wait time from the operation timeout budget -- the timeout clock starts when the API call is actually dispatched, not when it is submitted to the rate limiter.

### 2.9 Monitor-Mode Deployment Pattern

New DFW policies are deployed in monitor mode (ALLOW action with logging enabled) before being promoted to full enforcement. This two-phase deployment approach addresses the fundamental tension between security policy correctness and operational availability.

**Why monitor-first**: DFW policies operate at the data plane level, and an incorrect DROP or REJECT rule can immediately sever legitimate application communication paths, causing outages that are difficult to diagnose under pressure. By deploying in ALLOW+logging mode first, operators can observe the traffic that matches each rule without affecting production traffic. This observation period (typically 48-72 hours) captures enough business-cycle variation to identify false positives -- legitimate traffic that would be blocked under enforcement.

**How it works**: The PolicyDeployer rewrites all rule actions to ALLOW and enables logging, while preserving the original intended actions as metadata tags on each rule. When promoted to enforcement, the original actions are restored atomically across all rules in the policy. The deployment mode (MONITOR, ENFORCE, DISABLED) is queryable at any time via `getDeploymentMode()`.

**Tradeoffs**:
- **Pro**: Eliminates blind enforcement of untested policies, reducing the risk of production outages caused by overly restrictive rules.
- **Pro**: Provides empirical traffic data for policy validation rather than relying solely on documentation-based review.
- **Con**: During the monitor period, the security posture is weaker because traffic that should be blocked is allowed. This window must be kept as short as practical.
- **Con**: Adds operational complexity -- operators must remember to promote policies after the observation period. The pipeline mitigates this with configurable expiry alerts.

**Alternatives considered**:
- **Direct enforcement with rollback**: Deploy rules in enforcement mode and roll back if issues are detected. Rejected because the detection-to-rollback window exposes the environment to outages, and partial rollback of complex policies is error-prone.
- **Shadow mode at NSX level**: NSX-T does not natively support a shadow/audit mode for DFW rules. The monitor-mode pattern implements this capability at the orchestration layer.
- **Pre-deployment simulation**: Static analysis of rule definitions against known traffic flows. This was deemed insufficient because it relies on accurate documentation of all communication paths, which is rarely complete in brownfield environments.

### 2.10 Drift Trend Tracking

Drift scan results are stored both locally (on the vRO filesystem or configuration element) and in a ServiceNow custom table (`u_dfw_drift_history`) to enable historical trend analysis. This dual-storage approach supports both operational and analytical use cases.

**Why track trends**: Individual drift events are useful for immediate remediation, but they do not answer systemic questions: Is drift increasing over time? Are certain VMs or tag categories more prone to drift? Do drift events correlate with maintenance windows or vMotion activity? Trend tracking provides the historical data needed to answer these questions and move from reactive remediation to proactive prevention.

**Why dual storage (local + ServiceNow)**:
- **Local storage** provides fast, low-latency access to recent scan history for trend computation without requiring a network round-trip to ServiceNow. The local store is optimized for time-series queries (lookback by days) and is pruned automatically when it exceeds the configured retention limit.
- **ServiceNow storage** provides long-term persistence, cross-site visibility (both NDCNG and TULNG results in a single view), integration with ServiceNow reporting and dashboards, and compliance audit trail. ServiceNow records survive vRO restarts and redeployments.

**Tradeoffs**:
- **Pro**: Enables detection of recurring drift patterns that would be invisible from individual scan results.
- **Pro**: ServiceNow integration provides a single pane of glass for operations teams already using ServiceNow for incident management.
- **Con**: Dual storage introduces consistency risk -- local and ServiceNow records may temporarily diverge if one write succeeds and the other fails. The pipeline treats local storage as authoritative for trend computation and ServiceNow as a best-effort sync target.
- **Con**: Storage growth must be managed. The `scanRetentionCount` configuration (default: 100 scans per VM) and `lookbackDays` (default: 30 days) limit local storage consumption. ServiceNow records follow standard CMDB retention policies.

**Alternatives considered**:
- **ServiceNow-only storage**: Rejected because round-trip latency to ServiceNow (200-500ms per query) makes real-time trend computation during scan execution impractical, and vRO-to-ServiceNow connectivity failures would block drift detection entirely.
- **External time-series database (e.g., InfluxDB)**: Rejected because it introduces an additional infrastructure dependency that must be provisioned, secured, and maintained. The local+ServiceNow approach leverages existing infrastructure.

### 2.11 Disable Rules Instead of Delete

The StaleRuleReaper disables stale DFW rules by setting `disabled: true` via PATCH rather than deleting them from NSX Manager. This design decision prioritizes safety, auditability, and reversibility over a clean policy table.

**Why disable**: Deleting a DFW rule is an irreversible operation in NSX Manager. Once deleted, the rule's configuration, metadata, and position within the policy evaluation order are permanently lost. If the deletion was incorrect -- for example, a rule that appeared stale because its referenced group temporarily had zero members during a maintenance window -- restoring the rule requires manual reconstruction from audit logs or backups, which is error-prone and time-consuming.

Disabling a rule preserves the complete rule definition in the NSX policy table. The rule remains visible to operators and auditors, its position in the evaluation order is maintained, and it can be re-enabled with a single PATCH operation. This makes the cleanup operation fully reversible within seconds rather than requiring a multi-step restoration process.

**Tradeoffs**:
- **Pro**: Safer -- incorrect classifications can be corrected by re-enabling the rule without any data loss or policy reordering.
- **Pro**: Auditable -- disabled rules are visible in NSX Manager UI and API queries, providing a clear record of what the hygiene sweep touched.
- **Pro**: Reversible -- operators can re-enable a disabled rule immediately if monitoring reveals that disabling it caused unexpected traffic drops.
- **Con**: Disabled rules accumulate in the policy table over time, potentially degrading NSX Manager UI performance for operators managing large rule sets. This is mitigated by periodic archival and eventual deletion of rules that have remained disabled beyond a configurable retention period.
- **Con**: Disabled rules still consume NSX Manager storage and count toward per-policy rule limits. In practice, these limits are large enough that accumulated disabled rules do not pose a capacity risk.

**Alternatives considered**:
- **Immediate deletion**: Rejected because deletion is irreversible and the cost of an incorrect deletion (reconstructing a rule manually) far outweighs the cost of accumulating disabled rules.
- **Move to staging policy**: Rejected because NSX Manager does not support atomic rule movement between policies, and the intermediate state (rule deleted from source, not yet created in staging) creates a window of inconsistency.

### 2.12 Archive Before Cleanup

The OrphanGroupCleaner and StaleRuleReaper archive the full JSON definition of every object before modifying or removing it. The archive is stored both locally on the vRO filesystem and as an attachment on the associated ServiceNow incident for long-term retention.

**Why archive**: Automated cleanup operations inherently carry the risk of false positives -- an object classified as stale or orphaned may in fact be required by a process that was temporarily inactive. By capturing the complete object definition before any mutation, the pipeline creates a restoration point that enables fast recovery without relying on NSX Manager backups or manual reconstruction.

The archive also serves a compliance purpose. SOX and PCI DSS require that changes to security controls (including DFW rules and security groups) be traceable and auditable. The pre-cleanup archive provides a before-state record that, combined with the structured log entries for the cleanup operation itself, creates a complete audit trail of what changed, when, and why.

**Tradeoffs**:
- **Pro**: Enables rapid rollback -- archived definitions can be re-applied via the NSX Policy API to restore deleted groups or re-enable modified rules.
- **Pro**: Satisfies compliance audit requirements for before/after state documentation on security control changes.
- **Pro**: Provides forensic evidence if a cleanup operation is later found to have caused a security policy gap.
- **Con**: Archive storage grows over time. Mitigated by configurable retention periods and automatic pruning of archives older than the retention threshold.
- **Con**: The archive step adds latency to each cleanup operation (one additional API read + one file write per object). This is acceptable because hygiene sweeps run during maintenance windows and are not latency-sensitive.

**Alternatives considered**:
- **Rely on NSX Manager backups**: Rejected because backup restoration is a coarse-grained operation that restores all objects, not just the ones affected by the cleanup. Restoring a single group from a full NSX backup is operationally impractical.
- **Log the object ID only**: Rejected because the ID alone is insufficient for restoration -- the full definition (membership criteria, rule conditions, metadata) is required to recreate the object.

### 2.13 Phantom Detection Cross-References Both NSX and vCenter

The PhantomVMDetector queries both the NSX fabric VM inventory and the vCenter compute VM inventory, then computes the set difference to identify phantom VMs. This dual-source approach addresses the fundamental single-source-of-truth problem in environments where no single system provides a complete and accurate view of all virtual workloads.

**Why cross-reference**: In a production VMware environment, VM lifecycle events (provisioning, migration, decommissioning) are managed by vCenter, while NSX maintains its own fabric inventory derived from vCenter events. These two inventories can diverge due to several failure modes:

- **Failed decommissions**: A VM is deleted from vCenter but the NSX fabric entry persists because the deletion event was not propagated (network partition, NSX Manager restart during deletion, or manual NSX cleanup skipped).
- **Partial migrations**: A VM is migrated via vMotion but the NSX fabric inventory at the source site retains a stale entry while the destination site creates a new entry.
- **Manual interventions**: An operator creates or deletes VMs directly in vCenter without going through the automated pipeline, causing the NSX inventory to be unaware of the change.
- **NSX fabric sync delays**: NSX Manager's periodic fabric inventory sync may lag behind real-time vCenter state, creating temporary phantoms during high-churn periods.

Relying on a single source would miss an entire category of phantoms. NSX-only phantoms (VMs in NSX but not vCenter) indicate stale fabric entries that waste NSX resources and may trigger false positive alerts. vCenter-only phantoms (VMs in vCenter but not NSX) indicate VMs that lack security coverage -- a direct security risk because they are not subject to DFW policy enforcement.

**Tradeoffs**:
- **Pro**: Catches discrepancies that would be invisible when querying a single source.
- **Pro**: Identifies both security risks (unprotected VMs) and operational noise (stale NSX entries).
- **Con**: Requires API calls to two systems, increasing the detection latency and the blast radius if either system is unavailable. Mitigated by circuit breakers on both endpoints and graceful degradation (partial results are reported with a warning).
- **Con**: Temporary phantoms may appear during normal vMotion operations due to inventory sync delays. Mitigated by the minimum age threshold -- VMs that have been phantom for less than the threshold (default: 1 hour) are excluded from the report.

**Alternatives considered**:
- **NSX-only inventory**: Rejected because it cannot detect vCenter-only phantoms (unprotected VMs), which represent the more serious security concern.
- **vCenter-only inventory**: Rejected because it cannot detect NSX-only phantoms (stale fabric entries), which contribute to false positive alerts and waste NSX resources.
- **CMDB as single source of truth**: Rejected because the CMDB is a declared-state system that may itself be out of sync with the actual state of both NSX and vCenter. The CMDB is better suited for drift detection (comparing declared vs. actual) than for phantom detection (comparing actual vs. actual across systems).

### 2.14 Hygiene Tasks Run in Sequence Not Parallel

The NSXHygieneOrchestrator executes all cleanup tasks in a fixed sequential order rather than running them concurrently. The execution order is: phantom VM detection, orphan group cleanup, stale rule reaping, empty policy section cleanup, stale tag remediation, and unregistered VM onboarding.

**Why sequential**: Two factors drive this decision: resource contention and dependency ordering.

**Resource contention**: Each hygiene task makes multiple API calls to NSX Manager (group queries, rule queries, membership checks, PATCH operations). Running all tasks in parallel would multiply the concurrent API call volume by the number of tasks, risking NSX Manager throttling (HTTP 429 responses) or performance degradation. The RateLimiter provides some protection, but it is designed for single-task throughput control, not multi-task concurrency. Sequential execution keeps the API call pattern predictable and within the rate limiter's capacity.

**Dependency ordering**: Certain cleanup tasks depend on the results or side effects of earlier tasks. For example, the StaleRuleReaper's rule classification depends on group membership counts -- if the OrphanGroupCleaner has not yet removed empty groups, the reaper may misclassify rules referencing those groups. Similarly, the PolicyDeployer's empty section cleanup depends on stale rules having been disabled first -- a section that contains only disabled rules should be cleaned up, but this determination requires the reaping step to have completed. Running tasks out of order would produce incorrect classifications and incomplete cleanup.

**Tradeoffs**:
- **Pro**: Predictable NSX Manager API load that stays within rate limiter capacity.
- **Pro**: Each task operates on a consistent view of the environment that reflects the changes made by preceding tasks.
- **Pro**: Simpler error handling -- if a task fails, subsequent tasks are skipped and the orchestrator reports partial completion rather than dealing with concurrent failure modes.
- **Con**: Total sweep duration is the sum of all task durations rather than the maximum. In practice, a full hygiene sweep takes 10-30 minutes depending on environment size, which is acceptable for a scheduled maintenance operation.
- **Con**: A failure in an early task blocks all subsequent tasks. Mitigated by per-task error handling that allows the orchestrator to skip a failed task and continue with the remaining tasks if configured with `continueOnError: true`.

**Alternatives considered**:
- **Full parallelism**: Rejected due to resource contention and dependency ordering concerns described above.
- **Partial parallelism (independent tasks concurrent, dependent tasks sequential)**: Rejected because the dependency analysis is fragile -- what appears independent today may become dependent when new cleanup logic is added. Sequential execution is more maintainable and the performance cost is acceptable for a scheduled operation.

---

## 3. Design Patterns Applied

### 3.1 Factory Pattern -- ErrorFactory

**Where:** `src/vro/actions/shared/ErrorFactory.js`

**Why:** The pipeline produces errors across many modules, and downstream consumers (ServiceNow callbacks, monitoring systems, operator dashboards) require structured, machine-readable error information. The ErrorFactory creates Error instances with a standardized `code` property (e.g., `DFW-3003` for tag cardinality violations, `DFW-6004` for circuit breaker open) and a `context` property carrying operation-specific metadata.

This centralization ensures that error codes are unique across the codebase, default messages are consistent, and new error types can be added in one place. Without the factory, error creation would be scattered across modules with inconsistent formatting, making automated error routing impossible.

### 3.2 Strategy Pattern -- RetryHandler

**Where:** `src/vro/actions/shared/RetryHandler.js`

**Why:** Different API operations require different retry behaviors. NSX tag writes might use aggressive retries with short intervals, while ServiceNow callback failures might use longer intervals with fewer attempts. The RetryHandler accepts a pluggable `retryStrategy` object (with a `getDelay(attempt)` method) or a `shouldRetry` predicate function, allowing callers to customize retry behavior without modifying the handler itself.

The Strategy pattern was chosen over a simple configuration object because retry logic sometimes requires runtime computation (e.g., exponential backoff with jitter) that cannot be expressed as static configuration values.

### 3.3 Adapter Pattern -- External System Adapters

**Where:** `src/adapters/`

**Why:** The pipeline communicates with three external systems (vCenter, NSX Manager, ServiceNow) that have different API conventions, authentication mechanisms, and response formats. The Adapter pattern wraps each system's REST client behind a uniform interface, enabling the core business logic to operate against a consistent API contract regardless of the underlying system.

This abstraction is critical for testability: unit tests use mock adapters that return predetermined responses, avoiding the need for live API connections during development. It also isolates API version changes -- when NSX Manager upgrades from v3 to v4, only the NSX adapter needs modification.

### 3.4 Template Method Pattern -- Lifecycle Workflows

**Where:** Lifecycle orchestration (Day0, Day2, DayN workflows)

**Why:** All three lifecycle operations (provision, update, decommission) share a common structure: initialize context, validate inputs, execute steps, verify results, send callback. The Template Method pattern defines this skeleton in a base class, while each lifecycle type overrides the specific steps (which tags to apply, which groups to modify, which policies to verify).

This prevents code duplication across lifecycle types and ensures that cross-cutting concerns (logging, correlation ID propagation, saga management) are handled uniformly. New lifecycle types (e.g., "Day 1.5 -- compliance remediation") can be added by implementing only the variant steps.

### 3.5 Saga Pattern -- SagaCoordinator

**Where:** `src/vro/actions/lifecycle/SagaCoordinator.js`

**Why:** A single lifecycle operation may span multiple API calls across vCenter, NSX Manager, and ServiceNow. If step 3 of 5 fails, the first two steps have already produced side effects (tags applied, groups modified) that must be undone to maintain consistency. Traditional database transactions are not available across these distributed systems.

The Saga pattern addresses this by recording each completed step along with a compensating action (an async function that undoes the step). On failure, the SagaCoordinator executes compensating actions in LIFO (reverse) order, ensuring the most recent changes are rolled back first. If a compensation itself fails, the error is logged but the coordinator continues with remaining compensations, providing best-effort rollback under partial failure conditions.

This design was chosen over a two-phase commit protocol because the external systems (vCenter, NSX) do not support distributed transaction protocols, and the latency of two-phase commit would be unacceptable for an operations pipeline.

### 3.6 Circuit Breaker Pattern -- CircuitBreaker

**Where:** `src/vro/actions/shared/CircuitBreaker.js`

**Why:** The pipeline makes frequent REST calls to NSX Manager and vCenter. If one of these services experiences degraded performance or an outage, continuing to send requests would compound the problem (cascading failure) and exhaust vRO thread pools. The Circuit Breaker pattern addresses this by tracking per-endpoint failure rates within a sliding time window.

The breaker has three states: CLOSED (normal operation, failures counted), OPEN (all calls rejected immediately, protecting the downstream service), and HALF_OPEN (a single probe call is permitted after a timeout; success returns to CLOSED, failure returns to OPEN). This prevents cascading failures, provides fast feedback to callers, and enables automatic recovery when the downstream service stabilizes.

The per-endpoint design (keyed by endpoint name string) ensures that a failure on the NSX Manager at site NDCNG does not affect calls to the NSX Manager at site TULNG.

### 3.7 Idempotent Read-Compare-Write -- TagOperations

**Where:** `src/vro/actions/tags/TagOperations.js`

**Why:** Tag operations are inherently prone to race conditions: if two concurrent workflows attempt to tag the same VM, one might overwrite the other's changes. The idempotent read-compare-write pattern eliminates this risk by always reading the current state first, computing a minimal delta (what needs to change), and applying only the delta. If the desired state already matches the current state, no write occurs.

This pattern also prevents unnecessary API calls (reducing load on NSX Manager) and makes operations naturally idempotent -- calling `applyTags()` twice with the same desired state produces the same result without side effects.

### 3.8 Repository Pattern -- Policy-as-Code YAML

**Where:** `policies/` directory (YAML files)

**Why:** DFW rules, security group definitions, and tag dictionaries are stored as declarative YAML files in version control, forming a repository of infrastructure policy. This enables standard software engineering practices: code review for policy changes, branch-based development for complex policy updates, automated validation in CI pipelines, and git-based auditing of every change.

The Repository pattern abstracts the storage mechanism (git + YAML files) from the policy consumption logic. The validation engine reads policies from the file system during CI and from NSX Manager during runtime reconciliation, using the same validation logic regardless of the source.

---

## 4. Integration Architecture

### 4.1 ServiceNow to vRO

The integration between ServiceNow and vRO follows a request-callback pattern. When a VM Build Request catalog item is submitted, ServiceNow assembles a JSON payload containing the RITM number, requested tags (Application, Tier, Environment, DataClassification, Compliance, CostCenter), site code, and VM identifier. This payload is sent to vRO via a REST API call that triggers the appropriate lifecycle workflow.

The payload includes a callback URL that vRO uses to report completion or failure back to ServiceNow. The callback updates the RITM work notes with the operation result, including any errors, the correlation ID, and a summary of changes made. If the callback fails, it is retried using the RetryHandler with ServiceNow-specific intervals.

Client scripts on the ServiceNow catalog form (`vmBuildRequest_onLoad.js`) auto-populate defaults, enforce mandatory fields, and validate tag values before submission. This front-end validation reduces the number of requests that fail during vRO processing.

### 4.2 vRO to vCenter

vRO communicates with vCenter to resolve VM identifiers (MoRef to NSX external ID mapping), verify VM existence, and retrieve VM metadata (cluster, resource pool, folder) used in tag governance rules. The vRO vCenter plug-in provides native session management, but the pipeline wraps calls through the Adapter and CircuitBreaker for resilience.

### 4.3 vRO to NSX Manager

The majority of pipeline operations target the NSX-T Manager REST API (Policy API v1). Key API endpoints include:

- `GET/PATCH /api/v1/fabric/virtual-machines/{vmId}/tags` -- Tag CRUD operations
- `GET /policy/api/v1/infra/domains/default/groups/{groupId}/members` -- Group membership queries
- `GET /policy/api/v1/infra/realized-state/enforcement-points/default/virtual-machines/{vmId}/rules` -- Realized DFW rules
- `PATCH /policy/api/v1/infra/domains/default/security-policies/{policyId}` -- Policy updates

All NSX API calls are wrapped in CircuitBreaker and RetryHandler, with correlation IDs propagated via the `X-Correlation-ID` HTTP header.

### 4.4 NSX Manager to NSX Global Manager

For multi-site deployments with NSX Federation, local NSX Managers synchronize policy objects (groups, policies, rules) with the NSX Global Manager. The pipeline writes to the local NSX Manager, and federation handles cross-site replication. The pipeline verifies federation sync status by querying the Global Manager's realization state endpoint.

---

## 5. Security Model

### 5.1 Role-Based Access Control (RBAC)

The pipeline operates under the principle of least privilege:

- **vRO Service Account**: Granted `NsxTagOperator` and `NsxSecurityEngineer` roles on NSX Manager (scoped to tag and group operations). Granted `VirtualMachineUser.Inventory` on vCenter (read-only VM inventory). No administrative privileges.
- **ServiceNow Integration User**: OAuth 2.0 client credentials with scope limited to RITM read/update and catalog item execution.
- **Operator Access**: vRO console access restricted to the `DFW-Pipeline-Operators` group. Read-only access to workflow run history; execute access for manual circuit breaker resets and DLQ reprocessing.

### 5.2 Secrets Management

No credentials are stored in code, configuration files, or vRO action scripts. All secrets use vault reference patterns (`{{vault:secret/vro/nsx/password}}`) that are resolved at runtime by the vRO credential store or HashiCorp Vault integration. The ConfigLoader module demonstrates this pattern; in production, the vault resolver intercepts these references and injects the actual credential value.

### 5.3 Transport Security

All REST API communication uses TLS 1.2+ with certificate validation. vRO REST hosts are configured with the trusted CA certificates for vCenter and NSX Manager endpoints. Certificate pinning is recommended for production deployments to prevent man-in-the-middle attacks.

### 5.4 Audit Trail

Every pipeline operation generates a structured JSON log entry containing the correlation ID, timestamp, operation type, target VM, requesting user, and outcome. These logs are forwarded to Splunk or ELK for centralized audit. The correlation ID (format: `RITM-{number}-{epochTimestamp}`) links every log entry, HTTP request header, and ServiceNow callback to the original business request.

Immutable audit records are retained for a minimum of 7 years to satisfy SOX, PCI DSS, and HIPAA retention requirements. The Logger module formats every entry as single-line JSON for efficient ingestion by log aggregation platforms.

---

## 6. Multi-Site Considerations

### 6.1 Site Architecture: NDCNG and TULNG

The pipeline supports two VMware Cloud Foundation sites with independent vCenter and NSX Manager instances:

- **NDCNG** (Primary Data Center): vCenter, NSX Local Manager, NSX Global Manager
- **TULNG** (Secondary Data Center): vCenter, NSX Local Manager

Each site has its own REST endpoints configured in the ConfigLoader. The `getEndpointsForSite(site)` method resolves the correct URLs based on the site code.

### 6.2 NSX-T Federation

NSX-T Federation enables centralized policy management through the Global Manager at NDCNG while allowing local enforcement at each site's Local Manager. The pipeline leverages federation for:

- **Cross-site security groups**: Groups created at the Global Manager scope are replicated to both Local Managers, enabling DFW rules to reference workloads at either site.
- **Consistent policy enforcement**: DFW policies pushed to the Global Manager are enforced identically at both sites.
- **Active-Standby failover**: If the NDCNG Global Manager becomes unavailable, the TULNG Local Manager continues enforcing locally cached policies.

The pipeline writes to the Local Manager for site-specific operations (tag application, local group membership) and to the Global Manager for cross-site policy definitions. The circuit breaker tracks each endpoint independently, so a failure at one site does not affect operations at the other.

### 6.3 Site Affinity and Routing

The lifecycle orchestrator determines the target site from the VM's location (vCenter cluster membership) or from the site code specified in the ServiceNow request. Operations are routed to the correct site's endpoints automatically. Cross-site operations (e.g., DR failover tag updates) are supported by specifying the target site explicitly.

---

## 7. Error Handling Strategy

### 7.1 Error Classification

Errors are classified by their DFW error code prefix into categories that determine the handling strategy:

| Code Range | Category | Strategy |
|-----------|----------|----------|
| DFW-1xxx | Input validation | Reject immediately, return to ServiceNow |
| DFW-2xxx | NSX API errors | Retry with circuit breaker |
| DFW-3xxx | Tag operations | Retry, then compensate via saga |
| DFW-4xxx | Group operations | Retry, then compensate via saga |
| DFW-5xxx | DFW policy errors | Retry, then compensate via saga |
| DFW-6xxx | ServiceNow integration | Retry callback, then DLQ |
| DFW-7xxx | Timeout / polling | Retry with extended intervals |
| DFW-8xxx | Configuration | Reject immediately, alert operator |
| DFW-9xxx | Internal / unexpected | Log, compensate, alert operator |

### 7.2 Retry with Exponential Backoff

Transient failures (HTTP 5xx, 429 rate limiting, network timeouts) are retried using the RetryHandler with configurable intervals. The default schedule is [5s, 15s, 45s] (three retries after the initial attempt). The `shouldRetry` predicate ensures that client errors (4xx except 429) and non-retryable errors are failed immediately without wasting retry budget.

### 7.3 Circuit Breaker Protection

Per-endpoint circuit breakers prevent cascading failures. When 5 failures occur within a 5-minute sliding window, the breaker transitions from CLOSED to OPEN, immediately rejecting all subsequent calls with a DFW-6004 error. After 60 seconds, the breaker transitions to HALF_OPEN and permits one probe call. A successful probe resets the breaker to CLOSED; a failed probe returns to OPEN.

### 7.4 Saga-Based Compensation

When a multi-step lifecycle operation fails after one or more steps have completed, the SagaCoordinator executes compensating actions in reverse order. For example, if Day 0 provisioning fails at step 3 (DFW policy application) after steps 1 (tag assignment) and 2 (group membership) succeeded, the saga coordinator will:

1. Remove the group membership added in step 2
2. Remove the tags applied in step 1

This ensures the environment returns to a consistent state. If a compensation action itself fails, the error is logged, the entry is marked as failed, and the coordinator continues with remaining compensations. Failed compensations are written to the Dead Letter Queue for manual intervention.

### 7.5 Dead Letter Queue (DLQ)

Operations that fail all retry attempts and cannot be compensated are written to the DLQ (a persistent store in vRO or an external queue). Each DLQ entry contains the full operation context (correlation ID, input parameters, error details, partially completed steps, compensation results). Operators can inspect DLQ entries, fix the root cause, and reprocess them using the DLQ management workflow.

---

## 8. Tag Governance Model

### 8.1 Tag Dictionary

The pipeline enforces a centralized tag dictionary that defines the permitted categories and values:

| Category | Cardinality | Example Values | Governance |
|----------|------------|----------------|------------|
| Application | Single | APP001, APP002, ... | Auto-assigned from CMDB |
| Tier | Single | Web, App, DB, Messaging | ServiceNow dropdown |
| Environment | Single | Production, Pre-Production, Development, Sandbox | ServiceNow dropdown |
| DataClassification | Single | Public, Internal, Confidential, Restricted | Default: Internal |
| CostCenter | Single | CC-1234, CC-5678 | Auto-populated from department |
| Compliance | Multi | PCI, HIPAA, SOX, None | Default: None; multi-select |

### 8.2 Cardinality Enforcement

Single-value categories allow exactly one tag value per VM. Applying a new value replaces any existing value for that category. This prevents ambiguous configurations (e.g., a VM being simultaneously "Production" and "Development").

The Compliance category uses multi-value cardinality: a VM can be tagged with multiple compliance frameworks (e.g., PCI + HIPAA). The special value "None" is mutually exclusive: selecting "None" removes all other compliance tags, and adding a real compliance value removes "None".

### 8.3 Conflict Detection

The TagCardinalityEnforcer validates tag combinations against business rules:

- PCI compliance is not permitted in Sandbox environments (regulatory violation)
- HIPAA compliance is not permitted in Sandbox environments (regulatory violation)
- Confidential data classification requires a compliance tag other than "None" (governance policy)

These conflict rules are evaluated before any tag write operation. If a conflict is detected, the operation is rejected with a descriptive error message identifying the specific violated rule.

### 8.4 Tag Propagation and Verification

After tags are applied to a VM, the pipeline verifies that NSX has propagated the tags to the data plane by polling the NSX realized-state API. This ensures that security group membership has been updated and DFW rules are actively enforced before the operation is reported as complete to ServiceNow.

The propagation timeout is configurable (default: 120 seconds) with a polling interval of 10 seconds. If propagation does not complete within the timeout, a DFW-7004 error is raised and the operation is subject to the standard retry-then-compensate error handling flow.

### 8.5 Tag Lifecycle

Tags follow the VM lifecycle:

- **Day 0**: All required tags are applied during provisioning based on the ServiceNow catalog form values.
- **Day 2**: Tags are updated using the idempotent read-compare-write pattern. Only changed values are modified; unchanged tags are preserved.
- **Day N**: All tags are removed during decommissioning. The pipeline verifies that the VM has been removed from all security groups before reporting completion.

Tag changes are always correlated with a ServiceNow RITM, providing full traceability from the business request through to the NSX tag operation.

---

## 9. Module Inventory

The following table lists the pipeline modules, their responsibilities, and key design characteristics.

| Module | Responsibility | Pattern(s) | Error Handling |
|--------|---------------|------------|----------------|
| ImpactAnalysisAction | Pre-approval read-only impact analysis for proposed tag changes. Evaluates what security groups, DFW rules, and compliance postures would be affected by a tag change without applying any modifications. Returns a structured impact report for review before execution. | Read-only query; no side effects | Returns validation errors for unresolvable VMs or invalid tag combinations; does not trigger saga compensation since no mutations occur |
| QuarantineOrchestrator | Emergency VM quarantine with auto-expiry and DFW isolation. Applies quarantine tags, forces membership in a dedicated quarantine security group, and enforces deny-all DFW rules. Supports configurable auto-expiry timers that trigger automatic de-quarantine via saga rollback. | Saga (extended with fail-stop rollback), Template Method | Fail-stop compensation: if any rollback step fails, the VM remains quarantined and an operator alert is raised. Quarantine application failures trigger immediate saga compensation to prevent partial isolation. |
| BulkTagOrchestrator | Bulk tag operations with batching, concurrency control, and per-VM error isolation. Processes large VM sets in configurable batch sizes with semaphore-controlled parallelism. Individual VM failures are isolated and do not abort the overall batch. | Semaphore-based concurrency, Per-item error isolation, Read-compare-write | Per-VM error isolation: failures on individual VMs are recorded and reported but do not halt the batch. A summary report lists succeeded, failed, and skipped VMs. Failed VMs can be retried independently. |
| DriftDetectionWorkflow | Scheduled tag drift scanning with optional auto-remediation. Compares current NSX tag state against the declared desired state (from policy YAML or ServiceNow CMDB) and reports discrepancies. When auto-remediation is enabled, applies corrective tag operations using the standard read-compare-write pattern. | Repository (policy-as-code), Read-compare-write, Scheduled execution | Drift reports are generated regardless of remediation outcome. Remediation failures are logged per VM and do not block reporting. Auto-remediation respects circuit breaker state -- if NSX Manager is unhealthy, remediation is deferred. |
| LegacyOnboardingOrchestrator | CSV-based legacy and brownfield VM onboarding with dictionary validation. Ingests CSV files containing VM identifiers and desired tag assignments, validates every entry against the tag dictionary and cardinality rules, and orchestrates tag application for valid entries. Invalid entries are rejected with per-row error details. | Factory (error generation), Adapter (CSV parsing), Saga | Row-level validation errors are collected and returned in a structured report. Valid rows are processed independently; invalid rows do not block valid ones. Tag application uses saga compensation for rollback on failure. |
| MigrationVerifier | Post-vMotion tag preservation verification and re-application. After a VM migrates between clusters or sites, verifies that all NSX tags survived the migration. If tags were lost (a known issue with certain vMotion scenarios), re-applies them from the last known desired state. | Read-compare-write, Adapter (vCenter event listener) | Verification failures trigger automatic re-application using the idempotent read-compare-write pattern. If re-application fails after retries, the VM is flagged for manual intervention and an alert is raised. |
| UntaggedVMScanner | vCenter inventory scan for untagged VMs with classification suggestions. Queries vCenter for all VMs, identifies those lacking required NSX tags, and generates classification suggestions based on VM metadata (name conventions, cluster placement, resource pool membership, folder hierarchy). | Adapter (vCenter), Repository (tag dictionary) | Scanner errors (e.g., vCenter API failures) are handled by circuit breaker. Partial scan results are reported with a warning indicating incomplete coverage. Classification suggestions are advisory only and require operator approval before application. |
| RateLimiter | Token bucket rate limiter for NSX API protection during bulk operations. Maintains a configurable token bucket that controls the rate of outbound NSX API calls. Callers acquire a token before each API call; when tokens are exhausted, callers block until the bucket refills. Supports configurable bucket capacity and refill rate. | Token bucket algorithm | Timeout on token acquisition raises a DFW-7xxx timeout error. The rate limiter itself does not retry -- it delegates retry decisions to the calling module's RetryHandler. Bucket state is monitored and exposed via metrics for capacity planning. |

---

## 10. CMDBValidator Design Pattern

### 10.1 Overview

The CMDBValidator implements a scheduled validation engine pattern that operates against the ServiceNow CMDB to ensure all managed VMs maintain complete 5-tag coverage. The module runs on a configurable schedule (default: daily) and produces structured gap reports with actionable remediation tasks.

### 10.2 Validation Pipeline

The CMDBValidator follows a three-stage validation pipeline:

1. **Extraction**: `extractVMInventory(site)` queries the ServiceNow CMDB for all `cmdb_ci_vm_instance` records at the specified site with `operational_status=1`. The query joins against the NSX fabric inventory to correlate CMDB CIs with NSX VM external IDs.

2. **Coverage Validation**: `validateCoverage(inventory)` checks each VM against the 5-tag mandatory taxonomy (Region, SecurityZone, Environment, AppCI, SystemRole). VMs missing any mandatory tag are flagged as non-compliant with specific gap details.

3. **Quality Validation**: `validateQuality(inventory)` performs deeper validation including tag value consistency (e.g., Region tag matches the VM's physical site), CMDB field alignment (e.g., AppCI tag matches the CMDB application CI reference), and staleness detection (tags not updated within the configured threshold).

### 10.3 Gap Report Generation

`generateGapReport(site)` orchestrates the full pipeline and produces a structured report containing:
- **KPI Metrics**: Coverage percentage, quality score, trend comparison against previous scan
- **Gap Inventory**: Per-VM list of missing or invalid tags
- **Remediation Tasks**: Automatically created ServiceNow tasks assigned to the VM owner or assignment group
- **Summary Statistics**: Total VMs scanned, compliant count, non-compliant count, breakdown by gap type

### 10.4 Design Decisions

- The validator is read-only with respect to NSX -- it does not apply corrective tags. Remediation is handled through the standard tag update pipeline to maintain audit trail integrity.
- Gap reports are stored as ServiceNow report records for historical trending and compliance dashboard consumption.
- The extraction phase uses pagination to handle large inventories (10,000+ VMs) without exceeding ServiceNow query limits.

---

## 11. RuleLifecycleManager State Machine Design

### 11.1 Overview

The RuleLifecycleManager implements a formal finite state machine governing the lifecycle of every DFW rule from initial request through enforcement to periodic review and eventual retirement. The state machine enforces legal transition paths, preventing unauthorized state changes and ensuring every rule passes through required governance checkpoints.

### 11.2 State Definitions

| State | Description | Entry Criteria | Exit Criteria |
|-------|-------------|---------------|---------------|
| REQUESTED | Initial state when a rule is submitted through the Rule Request Pipeline | Rule request submitted via catalog, onboarding, emergency, or audit channel | Impact analysis completed |
| IMPACT_ANALYZED | Impact analysis has been performed showing affected VMs, groups, and policies | Impact analysis report generated and attached to rule record | Approver reviews and approves/rejects |
| APPROVED | Rule has been approved by the designated authority | Approval workflow completed with all required sign-offs | Rule deployed in monitor mode |
| MONITOR_MODE | Rule is deployed in NSX with action=ALLOW/LOG (no enforcement) for validation period | Rule applied to NSX in monitoring configuration | Validation period elapsed with no incidents |
| VALIDATED | Monitoring period completed with no adverse effects observed | Traffic analysis confirms expected behavior during monitoring | Rule promoted to enforcement |
| ENFORCED | Rule is actively enforced on the NSX data plane | Rule action changed from monitor to enforce | Certification period reached or expiry triggered |
| CERTIFIED | Rule has been reviewed and re-certified by the rule owner | Rule owner completed periodic review attestation | Next review cycle begins |
| REVIEW_DUE | Rule's certification period is approaching expiry | Scheduled scan detected rule within notification window | Owner re-certifies or rule expires |
| EXPIRED | Rule has not been re-certified within the grace period and is disabled | Auto-expiry triggered after grace period elapsed | Rule is removed or re-certified |
| ROLLED_BACK | Rule has been rolled back due to an incident or failed validation | Emergency rollback or validation failure detected | Rule is re-submitted or permanently retired |

### 11.3 Transition Rules

| From State | To State | Trigger | Required Actor |
|-----------|----------|---------|----------------|
| REQUESTED | IMPACT_ANALYZED | `analyzeImpact(ruleId)` completes | System (automated) |
| IMPACT_ANALYZED | APPROVED | `approveRule(ruleId, approverId)` | Security Architect or designated approver |
| IMPACT_ANALYZED | ROLLED_BACK | `rejectRule(ruleId, reason)` | Approver |
| APPROVED | MONITOR_MODE | `deployMonitor(ruleId)` | System (automated) |
| MONITOR_MODE | VALIDATED | `validateRule(ruleId)` after monitoring period | System (automated) |
| MONITOR_MODE | ROLLED_BACK | `rollbackRule(ruleId, reason)` | Operator or system |
| VALIDATED | ENFORCED | `enforceRule(ruleId)` | System (automated) |
| ENFORCED | CERTIFIED | `certifyRule(ruleId, ownerId)` | Rule owner |
| ENFORCED | REVIEW_DUE | Scheduled scan detects approaching expiry | System (automated) |
| ENFORCED | ROLLED_BACK | `rollbackRule(ruleId, reason)` | Operator or system |
| CERTIFIED | ENFORCED | Certification recorded, returns to enforced | System (automated) |
| REVIEW_DUE | CERTIFIED | `certifyRule(ruleId, ownerId)` | Rule owner |
| REVIEW_DUE | EXPIRED | Grace period elapsed without certification | System (automated) |
| EXPIRED | REQUESTED | `resubmitRule(ruleId)` | Rule owner |
| ROLLED_BACK | REQUESTED | `resubmitRule(ruleId)` | Rule owner |

### 11.4 Design Decisions

- Transition enforcement is implemented as a whitelist: only explicitly defined transitions are permitted. Any attempt to transition to a state not in the whitelist for the current state throws DFW-10001.
- Every state transition writes an immutable audit record to the rule's history, including timestamp, actor identity, source state, target state, and justification text.
- The MONITOR_MODE state uses NSX DFW rule action=ALLOW with logging enabled, providing traffic visibility without enforcement risk. This allows teams to validate rule behavior against real traffic before committing to enforcement.
- The ROLLED_BACK state preserves the full rule configuration for forensic analysis and enables re-submission without re-entering all rule details.

---

## 12. 5-Tag Taxonomy Architectural Decision

### 12.1 Decision Context

The original pipeline used a 6-tag model (Application, Tier, Environment, DataClassification, Compliance, CostCenter) aligned with general-purpose workload classification. Client security architecture review identified the need for a taxonomy that directly maps to NSX DFW policy constructs and aligns with the client's network security zone model.

### 12.2 Decision

Adopt a 5-tag mandatory model (Region, SecurityZone, Environment, AppCI, SystemRole) with 3 optional tags (Compliance, DataClassification, CostCenter). This model:

- **Region** replaces implicit site-based routing with an explicit geographic tag, enabling cross-site policy decisions based on VM location.
- **SecurityZone** introduces a network security zone dimension (DMZ, Internal, Restricted, Management) that maps directly to NSX security group membership criteria for zone-based isolation policies.
- **Environment** is retained as the deployment lifecycle stage indicator.
- **AppCI** replaces the generic Application tag with a direct CMDB CI reference, enabling automated CMDB-to-NSX synchronization.
- **SystemRole** replaces the Tier tag with a broader workload function indicator that supports infrastructure roles (DNS, NTP, Monitoring) in addition to application tiers.

### 12.3 NSX Scope Mapping

Each mandatory tag maps to an NSX scope (tag category) with a 1:1 relationship:

| Tag | NSX Scope | Security Group Pattern | DFW Policy Usage |
|-----|-----------|----------------------|-----------------|
| Region | Region | SG-Region-{value} | Cross-site isolation rules |
| SecurityZone | SecurityZone | SG-Zone-{value} | Zone-based access control |
| Environment | Environment | SG-Env-{value} | Environment isolation rules |
| AppCI | AppCI | SG-App-{value} | Application micro-segmentation |
| SystemRole | SystemRole | SG-Role-{value} | Role-based access control |

### 12.4 Tradeoffs

- The mandatory 5-tag model increases the minimum tagging burden per VM from 4 tags (Application, Tier, Environment, DataClassification) to 5, but provides richer policy granularity.
- The optional Compliance and DataClassification tags remain available for organizations that require regulatory framework tagging.
- Backward compatibility with the original 6-tag model is maintained through a migration mapping in the CMDBValidator that translates legacy tags to the new taxonomy.

---

## 13. VRA Packaging Model

### 13.1 Overview

The VRA packaging model provides a standardized directory structure at `package/` for importing the complete DFW automation pipeline into VMware Aria Automation Orchestrator. The package follows the vRO package specification and contains all actions, workflows, configuration elements, and resource elements needed for a complete deployment.

### 13.2 Package Structure

```
package/
  com.dfw.automation/
    actions/
      shared/           # Cross-cutting utility actions
      tags/             # Tag management actions
      groups/           # Group management actions
      dfw/              # DFW policy actions
      lifecycle/        # Lifecycle orchestrator actions
      cmdb/             # CMDB validation actions
    workflows/
      DFW-Day0-Provision.xml
      DFW-Day2-TagUpdate.xml
      DFW-DayN-Decommission.xml
      DFW-CMDBValidation.xml
      DFW-RuleLifecycle.xml
      DFW-RuleReview.xml
      DFW-MigrationBulkTag.xml
    config-elements/
      DFW-Pipeline-Config.xml
    resource-elements/
      schemas/
      policies/
  scripts/
    import-package.sh
    export-package.sh
  servicenow/
    tables/
    business-rules/
    catalog-items/
    client-scripts/
    server-scripts/
    scheduled-jobs/
    ui-policies/
    scripted-rest-apis/
```

### 13.3 Deployment Flow

The VRA package is deployed through a two-phase process:

1. **vRO Import**: The `package/com.dfw.automation/` directory is imported into Aria Automation Orchestrator using the package import wizard or `vro-cli package import`. This installs all actions, workflows, and configuration elements in a single operation.

2. **ServiceNow Deployment**: The `package/servicenow/` directory contains update set XML files and deployment scripts for the ServiceNow components (tables, business rules, catalog items, client scripts, server scripts, scheduled jobs, UI policies, and scripted REST APIs).

### 13.4 Design Decisions

- The package uses a flat action structure (one file per action) rather than bundled archives to enable selective updates without full package redeployment.
- Configuration elements use vault references for all credentials, ensuring no secrets are embedded in the package.
- The `scripts/import-package.sh` script provides an automated import path for CI/CD pipeline integration.

---

*End of Solution Design Document*
