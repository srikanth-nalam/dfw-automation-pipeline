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

*End of Solution Design Document*
