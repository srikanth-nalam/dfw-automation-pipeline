# Non-Functional Requirements Mapping (NFR-MAPPING)

## NSX DFW Automation Pipeline

**Version:** 1.0
**Date:** 2026-03-21
**Author:** Enterprise Infrastructure & Cloud Security

---

## Table of Contents

1. [Overview](#1-overview)
2. [NFR Categories](#2-nfr-categories)
3. [Performance Requirements (NFR-001 through NFR-003)](#3-performance-requirements-nfr-001-through-nfr-003)
4. [Scalability Requirements (NFR-004 through NFR-007)](#4-scalability-requirements-nfr-004-through-nfr-007)
5. [Availability Requirements (NFR-008 through NFR-012)](#5-availability-requirements-nfr-008-through-nfr-012)
6. [Security Requirements (NFR-013 through NFR-019)](#6-security-requirements-nfr-013-through-nfr-019)
7. [Compliance Requirements (NFR-020 through NFR-025)](#7-compliance-requirements-nfr-020-through-nfr-025)
8. [Maintainability Requirements (NFR-026 through NFR-031)](#8-maintainability-requirements-nfr-026-through-nfr-031)
9. [Observability Requirements (NFR-032 through NFR-038)](#9-observability-requirements-nfr-032-through-nfr-038)
10. [Operability Requirements (NFR-039 through NFR-045)](#10-operability-requirements-nfr-039-through-nfr-045)
11. [Validation and Standards (NFR-046 through NFR-050)](#11-validation-and-standards-nfr-046-through-nfr-050)
12. [Complete Traceability Matrix](#12-complete-traceability-matrix)

---

## 1. Overview

This document maps all 50 non-functional requirements (NFR-001 through NFR-050) from the Business Requirements Document to their implementing architecture components, source files, and verification methods. Each NFR is categorized by quality attribute and traced to the specific design decisions, code modules, and configuration settings that address it.

The NFRs are organized into the following categories:

| Category | NFR Range | Count |
|----------|-----------|-------|
| Performance | NFR-001 — NFR-003 | 3 |
| Scalability | NFR-004 — NFR-007 | 4 |
| Availability | NFR-008 — NFR-012 | 5 |
| Security | NFR-013 — NFR-019 | 7 |
| Compliance | NFR-020 — NFR-025 | 6 |
| Maintainability | NFR-026 — NFR-031 | 6 |
| Observability | NFR-032 — NFR-038 | 7 |
| Operability | NFR-039 — NFR-045 | 7 |
| Validation & Standards | NFR-046 — NFR-050 | 5 |
| **Total** | **NFR-001 — NFR-050** | **50** |

---

## 2. NFR Categories

### Category Definitions

| Category | Definition | Key Stakeholders |
|----------|-----------|-----------------|
| **Performance** | Response times, throughput, and latency targets for pipeline operations and API calls | Operations team, end users, platform engineering |
| **Scalability** | Capacity targets for concurrent operations, managed VMs, tag values, and cluster state | Platform engineering, capacity planning |
| **Availability** | Uptime targets, failover capabilities, and degradation handling | Operations, SRE, management |
| **Security** | Data protection, authentication, authorization, and input validation | Security operations, compliance |
| **Compliance** | Audit trail, regulatory traceability, policy review enforcement | Compliance officers, auditors |
| **Maintainability** | Code quality, modularity, testing standards, and documentation | Development team, code reviewers |
| **Observability** | Logging, metrics, dashboards, and alerting | Operations, SRE, on-call engineers |
| **Operability** | Manual intervention capabilities, configuration management, emergency procedures | Operations, on-call engineers |
| **Validation & Standards** | Schema validation, runtime requirements, dependency management | Development team, CI/CD pipeline |

---

## 3. Performance Requirements (NFR-001 through NFR-003)

| NFR-ID | Title | Requirement | Component(s) | Source File(s) | How Addressed | Verification Method |
|--------|-------|-------------|--------------|----------------|---------------|---------------------|
| NFR-001 | API call latency under 5 seconds | Each individual API call to NSX Manager or vCenter must complete within 5 seconds under normal conditions | RetryHandler, CircuitBreaker, RestClient | `src/vro/actions/shared/RetryHandler.js`, `src/vro/actions/shared/CircuitBreaker.js` | HTTP timeout set to 30s (configurable); circuit breaker immediately rejects calls to degraded endpoints, preventing latency accumulation; retry intervals [5s, 15s, 45s] are tuned to avoid compounding latency on already-slow endpoints | Splunk query on API call duration histogram; p99 latency panel on monitoring dashboard; integration test with mock server measures response time |
| NFR-002 | End-to-end pipeline execution under 5 minutes | A complete Day 0, Day 2, or Day N pipeline execution must finish within 5 minutes from ServiceNow trigger to callback | LifecycleOrchestrator, all pipeline modules | `src/vro/actions/lifecycle/LifecycleOrchestrator.js`, `src/vro/actions/lifecycle/Day0Orchestrator.js` | Parallel-where-possible execution within each orchestrator step; idempotent operations skip unnecessary writes (applyTags returns immediately if no delta); tag propagation polling uses efficient intervals (10s); monitoring dashboard tracks p50/p90/p99 execution time | Monitoring dashboard latency panel; integration test TC-045 verifies Day 0 completes without timeout; Splunk query for p90 pipeline duration |
| NFR-003 | Tag propagation verification within 120 seconds | After tag application, the pipeline must verify that tags are realized in NSX within 120 seconds | TagOperations, TagPropagationVerifier, DFWPolicyValidator | `src/vro/actions/tags/TagOperations.js`, `src/vro/actions/dfw/DFWPolicyValidator.js` | Polling loop with 10-second interval checks NSX realized-state API; maximum 30 attempts at 10s = 300s theoretical maximum, but practical propagation typically completes in 30-60s; DFW-7004 timeout error raised if propagation exceeds configured threshold (120s default) | Unit test TC-011 (idempotent skip); integration test TC-045 (full propagation); Splunk alert on DFW-7004 timeout events |

---

## 4. Scalability Requirements (NFR-004 through NFR-007)

| NFR-ID | Title | Requirement | Component(s) | Source File(s) | How Addressed | Verification Method |
|--------|-------|-------------|--------------|----------------|---------------|---------------------|
| NFR-004 | Support 100+ concurrent pipeline executions | The platform must handle at least 100 simultaneous pipeline executions without degradation | vRO Cluster, CircuitBreaker | `src/vro/actions/shared/CircuitBreaker.js` | vRO cluster provides horizontal capacity across 2+ nodes with shared PostgreSQL state; circuit breaker prevents overloading downstream NSX/vCenter APIs during high concurrency by failing fast when endpoints are degraded; per-endpoint state isolation prevents one failing endpoint from blocking operations on healthy endpoints | Load testing in staging environment; circuit breaker statistics via getStats(); vRO cluster metrics for active workflow count |
| NFR-005 | Support 10,000+ managed VMs across both sites | The system must manage at least 10,000 VMs (combined NDCNG and TULNG) without API throttling or data structure limitations | TagOperations, NSX Manager | `src/vro/actions/tags/TagOperations.js` | Read-compare-write pattern minimizes API calls (one GET + conditional PATCH per VM); per-VM operations avoid bulk API limitations; delta computation reduces payload size to only changed categories; no in-memory collection of all VM state (each operation is independent) | Batch onboarding test with 500+ VMs; API call count monitoring per operation; NSX Manager API rate limit monitoring |
| NFR-006 | Tag dictionary supports 50+ category values per category | Each tag category must support at least 50 distinct values without performance degradation | TagCardinalityEnforcer | `src/vro/actions/tags/TagCardinalityEnforcer.js` | Category configuration is extensible with dynamic iteration over configured categories; validation logic uses O(n) set operations for conflict detection; tag dictionary is defined in YAML (`policies/tag-categories/categories.yaml`) with no hard-coded value limits; enforcer iterates over configured categories dynamically | Unit test with 50+ values per category; YAML validation of categories.yaml; no hardcoded array limits in enforcer logic |
| NFR-007 | Circuit breaker state shared across vRO cluster nodes | Circuit breaker state must be consistent across all vRO cluster nodes to prevent split-brain decisions | CircuitBreaker | `src/vro/actions/shared/CircuitBreaker.js` | In-memory `Map` implementation is backed by vRO Configuration Element in production, providing cluster-wide visibility via shared PostgreSQL storage; state transitions are atomic at the Configuration Element level; getStats() method enables external monitoring of per-endpoint state | vRO cluster failover test; verify breaker state consistency after node failover; monitoring dashboard shows consistent state across nodes |

---

## 5. Availability Requirements (NFR-008 through NFR-012)

| NFR-ID | Title | Requirement | Component(s) | Source File(s) | How Addressed | Verification Method |
|--------|-------|-------------|--------------|----------------|---------------|---------------------|
| NFR-008 | Pipeline available 99.9% during business hours | The pipeline must maintain 99.9% availability during business hours (Mon-Fri 08:00-20:00 local time) | vRO Cluster, DR topology | `src/vro/actions/shared/ConfigLoader.js` (site resolution) | 2-node active vRO cluster at NDCNG with load balancing; standby vRO cluster at TULNG for DR; 30-minute RTO for site failover; shared PostgreSQL database for workflow state persistence | Monthly availability calculation from Splunk uptime metrics; quarterly DR test validates failover within RTO |
| NFR-009 | No single point of failure in orchestration layer | Every component in the orchestration layer must have redundancy to prevent single-point failures | vRO Cluster, ConfigLoader | `src/vro/actions/shared/ConfigLoader.js` | Clustered vRO with shared database eliminates orchestrator SPOF; configuration externalized from code via ConfigLoader (no hardcoded endpoints); dual-site deployment (NDCNG + TULNG) provides geographic redundancy; NSX Global Manager provides federation-level redundancy | Architecture review; DR failover test; dependency mapping analysis |
| NFR-010 | Graceful degradation when NSX Manager unavailable | The pipeline must degrade gracefully (not crash) when NSX Manager is temporarily unavailable | CircuitBreaker | `src/vro/actions/shared/CircuitBreaker.js` | Circuit breaker OPEN state rejects calls immediately with descriptive DFW-6004 error; saga compensates any completed steps before the failure; error callback to ServiceNow includes clear failure context; DLQ captures the operation for later reprocessing | Unit tests TC-034, TC-035, TC-036; integration test TC-047 (circuit breaker trips during batch operations) |
| NFR-011 | Automatic recovery from transient API failures | The pipeline must automatically retry and recover from transient API failures (HTTP 5xx, network timeouts) | RetryHandler | `src/vro/actions/shared/RetryHandler.js` | Exponential backoff retry with configurable intervals [5s, 15s, 45s]; `shouldRetry` predicate filters non-retryable errors (4xx); retry count enriched on final error for observability; maximum 3 retries by default (configurable) | Unit tests TC-030 (retries on 5xx), TC-031 (no retry on 4xx); Splunk query for retry success rate |
| NFR-012 | In-flight workflows survive single vRO node failure | Workflows in progress must resume on a surviving cluster node if one node fails | vRO Cluster | N/A (infrastructure configuration) | vRO persists workflow state (including saga journal) to shared PostgreSQL database at each step boundary; surviving cluster node detects orphaned workflows and resumes execution from the last persisted state; correlation ID preserved across node failover | Quarterly node failover test during active workflow execution; verify saga journal integrity after failover |

---

## 6. Security Requirements (NFR-013 through NFR-019)

| NFR-ID | Title | Requirement | Component(s) | Source File(s) | How Addressed | Verification Method |
|--------|-------|-------------|--------------|----------------|---------------|---------------------|
| NFR-013 | All API communication over TLS 1.2+ | Every REST API call between pipeline components and NSX/vCenter must use TLS 1.2 or higher | REST client configuration | `src/vro/actions/shared/ConfigLoader.js` | All endpoint URLs use `https://` scheme; vRO REST hosts configured with TLS 1.2 minimum protocol version; certificate validation enabled (no self-signed cert bypass); cipher suite restricted to strong algorithms | Network capture analysis during integration testing; TLS configuration audit of vRO REST host definitions |
| NFR-014 | No credentials stored in code or configuration files | Secrets must never appear in source code, configuration files, or log output | ConfigLoader, vault references | `src/vro/actions/shared/ConfigLoader.js` | All credential fields in DEFAULT_CONFIG use `{{vault:secret/...}}` patterns (e.g., `{{vault:secret/vro/nsx/username}}`); vault references are resolved at runtime by the vRO credential management system; Logger sanitizes output to prevent credential leakage | Source code scan for hardcoded credentials; grep for plaintext passwords; review of ConfigLoader DEFAULT_CONFIG |
| NFR-015 | Service accounts follow principle of least privilege | Service accounts used by the pipeline must have only the minimum permissions required | vRO RBAC, NSX RBAC | N/A (operational configuration) | vRO service account has only `NsxTagOperator` and `NsxSecurityEngineer` roles in NSX; no admin privileges; vCenter account limited to VM inventory read and custom attribute write; ServiceNow integration account limited to RITM read/update | Quarterly RBAC audit; NSX role assignment review; principle of least privilege assessment |
| NFR-016 | All operations carry correlation ID for traceability | Every pipeline operation must be traceable through a unique correlation ID from ServiceNow to NSX | CorrelationContext | `src/vro/actions/shared/CorrelationContext.js` | Correlation ID generated at pipeline entry in format `RITM-{number}-{timestamp}`; propagated via `X-Correlation-ID` HTTP header to all downstream API calls; included in every log entry; included in ServiceNow callback payload | Unit tests TC-018, TC-019; integration test TC-045 verifies correlation ID present in callback; Splunk query by correlation ID returns complete trace |
| NFR-017 | Failed authentication attempts logged and alerted | Authentication failures against NSX or vCenter must be logged and trigger alerts | Logger, NSX Adapter | `src/vro/actions/shared/ErrorFactory.js`, `src/vro/actions/shared/Logger.js` | DFW-2002 error code assigned to authentication failures; logged with full context (endpoint, timestamp, correlation ID); circuit breaker trips on repeated auth failures (contributing to failure threshold); Splunk alert rule on DFW-2002 error code frequency | Splunk alert configuration for DFW-2002; circuit breaker trip verification on auth failure injection |
| NFR-018 | Input validation at pipeline entry point | All inputs from ServiceNow must be validated against schema before any API operations begin | LifecycleOrchestrator, TagCardinalityEnforcer | `src/vro/actions/lifecycle/LifecycleOrchestrator.js`, `schemas/snow-vro-payload.schema.json` | `LifecycleOrchestrator.validate()` runs AJV JSON Schema validation on the incoming payload as the first step of `run()`; tag values validated against tag dictionary; site code validated against known sites (NDCNG, TULNG); invalid input rejected with DFW-4001 before any API calls | Unit test TC-049 (missing required field fails); integration test validates full payload acceptance/rejection |
| NFR-019 | Tag combination conflicts detected before application | Invalid tag combinations must be caught before tags are applied to VMs | TagCardinalityEnforcer — `validateTagCombinations()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | Three conflict rules checked against the merged tag set: (1) PCI not in Sandbox, (2) HIPAA not in Sandbox, (3) Confidential/Restricted requires non-None compliance; violations rejected with descriptive error messages before any PATCH operation | Unit tests TC-013, TC-014, TC-015; client-side enforcement in onChange script provides first line of defense |

---

## 7. Compliance Requirements (NFR-020 through NFR-025)

| NFR-ID | Title | Requirement | Component(s) | Source File(s) | How Addressed | Verification Method |
|--------|-------|-------------|--------------|----------------|---------------|---------------------|
| NFR-020 | DFW policy changes auditable to originating RITM | Every DFW policy change must be traceable to the ServiceNow RITM that initiated it | CorrelationContext, Logger | `src/vro/actions/shared/CorrelationContext.js`, `src/vro/actions/shared/Logger.js` | Every log entry includes RITM-derived correlation ID; ServiceNow callback links result to originating RITM; saga journal records each step with correlation ID; Splunk index enables audit queries by RITM number | Audit test: submit RITM, trace through Splunk to NSX API call, verify bidirectional linkage |
| NFR-021 | Audit logs retained for 7+ years | All pipeline execution logs must be retained for at least 7 years for regulatory compliance | Logger, Splunk/ELK configuration | `src/vro/actions/shared/Logger.js` | Structured JSON logs shipped to Splunk with 7-year retention policy on `dfw_pipeline` index; log entries include all required audit fields (timestamp, correlationId, user, action, target, result); no PII in log metadata | Splunk retention policy verification; annual audit of log completeness |
| NFR-022 | YAML policies include compliance framework references | Each YAML policy file must reference the compliance frameworks it addresses | Policy YAML metadata | `policies/dfw-rules/*.yaml` | Each policy file contains `compliance_tags` array listing applicable frameworks (PCI, SOX, HIPAA); enables automated compliance reporting and audit scoping | CI validation that `compliance_tags` field exists in all policy YAML files; unit test TC-048 validates schema |
| NFR-023 | Policy changes require peer review before deployment | YAML policy changes must go through a pull request review process before being deployed | Git workflow, CI pipeline | `.github/workflows/ci.yml`, `policies/dfw-rules/*.yaml` | YAML policies stored in git repository; changes require pull request with at least one reviewer approval; CI pipeline validates YAML schema, runs conflict detection, and checks for policy regressions before merge is permitted | GitHub branch protection rules; CI pipeline status check requirement; PR review audit log |
| NFR-024 | DFW rules traceable to BRD requirements | Each DFW policy rule must link to the specific BRD section that mandates it | Policy YAML metadata | `policies/dfw-rules/*.yaml` | Each policy file contains `brd_reference` field linking to specific BRD appendix section (e.g., "Appendix B — Three-Tier Micro-Segmentation"); enables traceability from deployed rule to business requirement | CI validation that `brd_reference` field exists; quarterly audit of BRD-to-policy mapping completeness |
| NFR-025 | Quarterly policy review enforced | YAML policies must be reviewed at least quarterly, with review dates tracked | Policy YAML metadata | `policies/dfw-rules/*.yaml` | `review_cadence_days` field (default: 90) in each policy file enables automated review reminders; `last_reviewed` date field tracks most recent review; monitoring rule alerts when `last_reviewed + review_cadence_days < current_date` | Automated Splunk alert on overdue reviews; quarterly review meeting calendar integration |

---

## 8. Maintainability Requirements (NFR-026 through NFR-031)

| NFR-ID | Title | Requirement | Component(s) | Source File(s) | How Addressed | Verification Method |
|--------|-------|-------------|--------------|----------------|---------------|---------------------|
| NFR-026 | Modular code architecture with clear separation of concerns | Each module must handle one functional domain with no circular dependencies | All modules | `src/vro/actions/shared/`, `src/vro/actions/tags/`, `src/vro/actions/groups/`, `src/vro/actions/dfw/`, `src/vro/actions/lifecycle/` | Five module directories with clear domain boundaries: `shared/` (cross-cutting utilities), `tags/` (tag operations), `groups/` (group operations), `dfw/` (DFW policy operations), `lifecycle/` (orchestration); dependency direction is lifecycle → tags/groups/dfw → shared (acyclic) | Architecture review; dependency graph analysis; ESLint import rules |
| NFR-027 | 80% line coverage, 70% branch coverage | Unit test coverage must meet minimum thresholds enforced in CI | Jest test suite | `jest.config.js` | `jest.config.js` defines `coverageThreshold.global` with `lines: 80, branches: 70, functions: 80, statements: 80`; CI pipeline fails if any threshold is not met; coverage collected from all files in `src/` except `src/servicenow/` | `npm test` with coverage report; CI pipeline coverage gate; coverage trend tracking |
| NFR-028 | Consistent error code taxonomy across all modules | All errors must use the centralized DFW-XXXX error code system | ErrorFactory | `src/vro/actions/shared/ErrorFactory.js` | Centralized error code registry in ErrorFactory with taxonomy: DFW-1xxx (ServiceNow), DFW-2xxx (NSX API), DFW-3xxx (tag operations), DFW-4xxx (validation), DFW-5xxx (group operations), DFW-6xxx (circuit breaker), DFW-7xxx (DFW/timeout), DFW-8xxx (saga), DFW-9xxx (system); `isRetryable()` method classifies each error code | Unit test TC-029; code review for direct Error construction (should use ErrorFactory); error code documentation |
| NFR-029 | Configuration externalized from business logic | All configurable values (endpoints, timeouts, thresholds) must be loaded from configuration, not hardcoded | ConfigLoader | `src/vro/actions/shared/ConfigLoader.js` | All endpoints, retry intervals, circuit breaker thresholds, timeout values, and feature flags loaded from ConfigLoader; DEFAULT_CONFIG provides documented fallbacks; constructor overrides enable testing and environment-specific values; no magic numbers in business logic | Code review for hardcoded URLs, ports, or timeout values; ConfigLoader usage audit; unit test TC-020, TC-021, TC-022 |
| NFR-030 | Design patterns documented with rationale | Each design pattern used must be documented with WHERE it is used and WHY it was chosen | SDD, LLD, ADRs | `docs/SDD.md`, `docs/LLD.md`, `adr/*.md` | Eight design patterns documented in SDD (Template Method, Saga, Circuit Breaker, Strategy, Factory, Adapter, Read-Compare-Write, Policy-as-Code); each with problem statement, solution description, implementation location, and trade-offs; ADRs capture key architectural decisions with context and consequences | Documentation review; ADR completeness check; SDD pattern inventory |
| NFR-031 | Code follows ESLint rules enforced in CI | ESLint must run in CI with zero tolerance for errors | .eslintrc.json, CI pipeline | `.eslintrc.json`, `.github/workflows/ci.yml` | ESLint configured with rules including `no-var`, `prefer-const`, `eqeqeq`, `no-unused-vars`; CI pipeline runs `npm run lint` and fails on any ESLint error; consistent code style across all modules | `npm run lint` in CI; zero-error exit code requirement; ESLint configuration review |

---

## 9. Observability Requirements (NFR-032 through NFR-038)

| NFR-ID | Title | Requirement | Component(s) | Source File(s) | How Addressed | Verification Method |
|--------|-------|-------------|--------------|----------------|---------------|---------------------|
| NFR-032 | Structured JSON logging for all operations | Every log entry must be a single-line JSON object with standardized fields | Logger | `src/vro/actions/shared/Logger.js` | Every log entry is single-line JSON with fields: `timestamp` (ISO 8601), `level` (DEBUG/INFO/WARN/ERROR), `correlationId`, `step`, `message`, `metadata`; circular reference safety via custom JSON replacer; Error objects enriched with `errorMessage` and `stack` | Unit tests TC-041, TC-043, TC-044; Splunk parsing validation; log format audit |
| NFR-033 | Circuit breaker statistics exposed for dashboards | Circuit breaker state and metrics must be queryable for dashboard consumption | CircuitBreaker — `getStats()` | `src/vro/actions/shared/CircuitBreaker.js` | `getStats()` returns `{name, state, totalSuccesses, totalFailures, recentFailures, thresholds: {failureThreshold, resetTimeout, windowSize}}`; stats per endpoint enable granular dashboard panels; state transitions logged as WARN events | Unit test verifies getStats() output structure; monitoring dashboard panel configuration |
| NFR-034 | Saga compensation outcomes tracked and reported | Every saga compensation must produce a structured result with success/failure counts | SagaCoordinator — `compensate()` return value | `src/vro/actions/lifecycle/SagaCoordinator.js` | `compensate()` returns `{compensated: N, failed: M, errors: [...]}` where `compensated` is the count of successful compensations, `failed` is the count of failed compensations, and `errors` contains error details for each failure; result included in ServiceNow error callback | Unit tests TC-039, TC-040; Splunk query for compensation outcome statistics |
| NFR-035 | Real-time pipeline health dashboard | A monitoring dashboard must display circuit breaker state, throughput, error rate, latency, and DLQ depth | Logger + Splunk/ELK | `src/vro/actions/shared/Logger.js` | Dashboard panels: Circuit Breaker State (green/yellow/red per endpoint), Throughput (operations/hour by type), Error Rate (% over rolling 1-hour window), Latency (p50/p90/p99), DLQ Depth (current count); all panels driven by structured log queries | Dashboard review; panel data verification; RUNBOOK Section 8 interpretation guide |
| NFR-036 | Alerting on circuit breaker state changes | Circuit breaker transitions to OPEN must trigger an alert to the on-call engineer | Logger + monitoring rules | `src/vro/actions/shared/CircuitBreaker.js`, `src/vro/actions/shared/Logger.js` | WARN log emitted on OPEN transition with `{component: 'CircuitBreaker', event: 'transitioned', previousState, newState, endpoint}`; Splunk monitoring rule triggers PagerDuty alert on `newState='OPEN'`; alert includes endpoint name and failure context | Alert rule configuration review; alert firing test during circuit breaker trip injection |
| NFR-037 | DLQ depth monitoring with threshold alerting | DLQ depth must be monitored with alerts when entries exist | DLQ + monitoring | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | DLQ depth metric exposed through structured logging (DLQ entry creation logged with `{event: 'DLQ entry created', depth: N}`); Splunk alert when depth > 0; escalation thresholds: 1-5 entries (P3), 5-20 entries (P2), >20 entries (P1) | Alert rule test with mock DLQ entry; RUNBOOK Section 8.5 thresholds |
| NFR-038 | Retry exhaustion rate tracking | The rate of retry exhaustions must be queryable for trend analysis | RetryHandler enriched errors | `src/vro/actions/shared/RetryHandler.js` | `retryCount` property on final error enables Splunk query: `index=dfw_pipeline "failed after" "attempts" | stats count by operationName`; retry exhaustion rate calculated as exhaustions / total operations; alert when rate exceeds 20% for 1+ hour | Splunk query validation; alert rule for elevated retry exhaustion rate |

---

## 10. Operability Requirements (NFR-039 through NFR-045)

| NFR-ID | Title | Requirement | Component(s) | Source File(s) | How Addressed | Verification Method |
|--------|-------|-------------|--------------|----------------|---------------|---------------------|
| NFR-039 | Saga compensation can be manually triggered | Operators must be able to invoke saga compensation manually for a specific pipeline execution | SagaCoordinator — `compensate()` | `src/vro/actions/lifecycle/SagaCoordinator.js` | `compensate()` method is callable from vRO workflow console; operator provides correlation ID to identify the saga journal; compensation executes in LIFO order with best-effort semantics; result returned to operator | RUNBOOK Section 4.1 (Tag Rollback); vRO workflow test |
| NFR-040 | Circuit breaker can be manually reset | Operators must be able to reset a circuit breaker to CLOSED state without waiting for the automatic timeout | CircuitBreaker — `reset()` | `src/vro/actions/shared/CircuitBreaker.js` | `reset()` method clears all failure counters and sets state to CLOSED; callable from vRO workflow console; operator provides endpoint name; transition logged for audit trail | RUNBOOK Section 2.2 (Manual Reset); unit test verifies reset clears counters |
| NFR-041 | DLQ entries can be inspected and reprocessed | Operators must be able to list, inspect, and resubmit DLQ entries through vRO workflows | DLQ management workflow | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | DLQ management workflows: List DLQ Entries, Inspect DLQ Entry, Reprocess DLQ Entry, Batch Reprocess by Error Code, Purge DLQ Entries; each entry contains full context for investigation and reprocessing | RUNBOOK Section 1 (DLQ Handling); workflow execution test |
| NFR-042 | Configuration changes do not require code deployment | Endpoint URLs, timeouts, and thresholds must be configurable without redeploying code | ConfigLoader, vRO Configuration Elements | `src/vro/actions/shared/ConfigLoader.js` | All configurable values stored in vRO Configuration Element `DFW-Pipeline-Config`; changes take effect on next pipeline execution; no code redeployment required; configuration validated at load time | Configuration change test (modify threshold, verify new value used in next execution) |
| NFR-043 | Emergency quarantine can isolate a VM immediately | A compromised VM must be isolatable within 60 seconds through an emergency workflow | Emergency quarantine workflow | `policies/dfw-rules/emergency-quarantine.yaml` | Dedicated quarantine workflow: applies `Quarantine=Active` tag → security group membership updates automatically → high-priority DFW DROP-all rule takes effect → management access preserved via higher-priority ALLOW rule → ServiceNow callback confirms isolation; target: < 60 seconds | RUNBOOK Section 6 (Emergency Quarantine); quarterly quarantine drill with timing measurement |
| NFR-044 | Rollback supported via git revert for YAML policies | YAML policy changes must be revertible through standard git revert operations | Git workflow, CI pipeline | `policies/dfw-rules/*.yaml`, `.github/workflows/ci.yml` | `git revert <commit>` on a policy change produces a valid YAML state; CI validates the reverted files; policy reconciliation workflow reads reverted YAML and applies to NSX Manager; each revert is a new commit preserving full audit history | Rollback test: deploy policy change, revert commit, verify NSX state matches reverted YAML; RUNBOOK Section 4.2 |
| NFR-045 | Batch operations supported for legacy workload onboarding | The pipeline must support batch tag operations for onboarding existing VMs not originally provisioned through the pipeline | TagOperations batch wrapper | `src/vro/actions/tags/TagOperations.js` | Batch mode processes CSV file of VMs sequentially: validate batch → process each VM (applyTags → verifyGroups → validateDFW) → generate batch report; per-VM error isolation prevents one failure from blocking the batch; failed VMs written to error report (not DLQ) to avoid flooding | RUNBOOK Section 7 (Legacy Workload Onboarding); batch execution test with mixed success/failure VMs |

---

## 11. Validation and Standards (NFR-046 through NFR-050)

| NFR-ID | Title | Requirement | Component(s) | Source File(s) | How Addressed | Verification Method |
|--------|-------|-------------|--------------|----------------|---------------|---------------------|
| NFR-046 | JSON schema validation for all API payloads | All API payloads (ServiceNow to vRO, vRO to ServiceNow) must be validated against JSON Schema | PayloadValidator, ajv | `schemas/snow-vro-payload.schema.json`, `schemas/vro-snow-callback.schema.json` | AJV 8.12.x validates incoming payloads against `snow-vro-payload.schema.json` at pipeline entry; callback payloads validated against `vro-snow-callback.schema.json` before sending to ServiceNow; CI runs `npm run validate-schemas` to verify schema files themselves are valid | Unit test TC-049 (invalid payload fails); CI schema validation job; integration test payload acceptance |
| NFR-047 | YAML policy schema validation in CI | Invalid YAML structure must fail the CI build before merge | CI pipeline — validate-policies job | `.github/workflows/ci.yml`, `policies/**/*.yaml` | CI pipeline includes `validate-policies` step that runs `npm run validate-policies`; validates all YAML files against their expected structure; missing required fields, invalid values, or malformed YAML cause CI failure; prevents invalid policies from reaching production | CI pipeline test with intentionally invalid YAML; unit test TC-048 |
| NFR-048 | Node.js 18+ runtime requirement enforced | The pipeline must require Node.js 18 or later and reject older runtimes | package.json engines field | `package.json` | `engines.node` field set to `>= 18.0.0`; CI pipeline runs on Node.js 18; npm install warns when Node version does not match; runtime features (optional chaining, nullish coalescing) require Node 18+ | CI pipeline Node.js version verification; package.json engines field review |
| NFR-049 | No external runtime dependencies beyond ajv | Production runtime must depend only on ajv to minimize supply chain risk | package.json dependencies | `package.json` | Only `ajv` and `ajv-formats` listed as production `dependencies`; all other packages (jest, eslint) are `devDependencies` only; minimizes attack surface and reduces vulnerability scanning scope | `npm ls --production` audit; package.json dependency review; periodic `npm audit` |
| NFR-050 | Documentation completeness verified in CI | CI must verify that all required documentation files exist | CI pipeline — docs-check job | `.github/workflows/ci.yml` | CI pipeline includes docs-check step that verifies existence of: `docs/SDD.md`, `docs/HLD.md`, `docs/LLD.md`, `docs/FRD.md`, `docs/RUNBOOK.md`, `docs/NFR-MAPPING.md`, `docs/TEST-STRATEGY.md`; missing documentation fails the build | CI pipeline test; docs-check step verification |

---

## 12. Complete Traceability Matrix

The following condensed matrix maps every NFR to its primary category, implementing component(s), and related functional requirements.

| NFR-ID | Category | Primary Component | Related FRs |
|--------|----------|------------------|-------------|
| NFR-001 | Performance | RetryHandler, CircuitBreaker | FR-042, FR-044 |
| NFR-002 | Performance | LifecycleOrchestrator | FR-023, FR-024, FR-025 |
| NFR-003 | Performance | TagOperations, DFWPolicyValidator | FR-014, FR-031 |
| NFR-004 | Scalability | vRO Cluster, CircuitBreaker | FR-044, FR-045 |
| NFR-005 | Scalability | TagOperations | FR-014, FR-019, FR-020 |
| NFR-006 | Scalability | TagCardinalityEnforcer | FR-011, FR-012 |
| NFR-007 | Scalability | CircuitBreaker | FR-044, FR-045, FR-048 |
| NFR-008 | Availability | vRO Cluster | FR-029 |
| NFR-009 | Availability | ConfigLoader | FR-026, FR-027, FR-028 |
| NFR-010 | Availability | CircuitBreaker | FR-045, FR-046 |
| NFR-011 | Availability | RetryHandler | FR-042, FR-043 |
| NFR-012 | Availability | vRO Cluster | FR-049 |
| NFR-013 | Security | REST client | FR-026 |
| NFR-014 | Security | ConfigLoader | FR-028 |
| NFR-015 | Security | RBAC | FR-019 |
| NFR-016 | Security | CorrelationContext | FR-021, FR-022 |
| NFR-017 | Security | Logger, ErrorFactory | FR-041, FR-051 |
| NFR-018 | Security | LifecycleOrchestrator, TagCardinalityEnforcer | FR-029, FR-065 |
| NFR-019 | Security | TagCardinalityEnforcer | FR-016, FR-017, FR-018 |
| NFR-020 | Compliance | CorrelationContext, Logger | FR-021, FR-056 |
| NFR-021 | Compliance | Logger, Splunk | FR-051, FR-052 |
| NFR-022 | Compliance | Policy YAML | FR-061 |
| NFR-023 | Compliance | Git workflow, CI | FR-064 |
| NFR-024 | Compliance | Policy YAML | FR-061 |
| NFR-025 | Compliance | Policy YAML | FR-061 |
| NFR-026 | Maintainability | All modules | FR-029 |
| NFR-027 | Maintainability | Jest test suite | All TCs |
| NFR-028 | Maintainability | ErrorFactory | FR-041 |
| NFR-029 | Maintainability | ConfigLoader | FR-026, FR-027, FR-028 |
| NFR-030 | Maintainability | SDD, LLD, ADRs | All FRs |
| NFR-031 | Maintainability | ESLint, CI | FR-064 |
| NFR-032 | Observability | Logger | FR-051, FR-052 |
| NFR-033 | Observability | CircuitBreaker | FR-044, FR-045 |
| NFR-034 | Observability | SagaCoordinator | FR-050 |
| NFR-035 | Observability | Logger, Splunk | FR-051 |
| NFR-036 | Observability | CircuitBreaker, Logger | FR-045 |
| NFR-037 | Observability | DLQ, Logger | FR-059, FR-060 |
| NFR-038 | Observability | RetryHandler | FR-042 |
| NFR-039 | Operability | SagaCoordinator | FR-049, FR-050 |
| NFR-040 | Operability | CircuitBreaker | FR-044, FR-048 |
| NFR-041 | Operability | DLQ workflows | FR-059, FR-060 |
| NFR-042 | Operability | ConfigLoader | FR-026, FR-028 |
| NFR-043 | Operability | Quarantine workflow | FR-061 |
| NFR-044 | Operability | Git workflow | FR-061, FR-064 |
| NFR-045 | Operability | TagOperations | FR-014, FR-019 |
| NFR-046 | Validation | PayloadValidator, ajv | FR-064, FR-065 |
| NFR-047 | Validation | CI pipeline | FR-064 |
| NFR-048 | Validation | package.json | FR-065 |
| NFR-049 | Validation | package.json | FR-065 |
| NFR-050 | Validation | CI pipeline | FR-064 |

### Coverage Summary

| Metric | Value |
|--------|-------|
| Total NFRs | 50 |
| NFRs with identified component | 50 (100%) |
| NFRs with source file reference | 47 (94%) — 3 are infrastructure-only |
| NFRs with verification method | 50 (100%) |
| NFR categories covered | 9 |
| Unique components referenced | 22 |

---

*End of Non-Functional Requirements Mapping*
