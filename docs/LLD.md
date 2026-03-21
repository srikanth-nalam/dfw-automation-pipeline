# Low Level Design (LLD)

## NSX DFW Automation Pipeline

**Version:** 1.0
**Date:** 2026-03-21
**Author:** Enterprise Infrastructure & Cloud Security
**Status:** Approved

---

## Table of Contents

1. [Module-Level Design](#1-module-level-design)
2. [Class Diagram](#2-class-diagram)
3. [Sequence Diagrams](#3-sequence-diagrams)
4. [Error Handling Flows](#4-error-handling-flows)
5. [Configuration Schema](#5-configuration-schema)
6. [REST API Contracts Summary](#6-rest-api-contracts-summary)
7. [State Machine Diagrams](#7-state-machine-diagrams)

---

## 1. Module-Level Design

### 1.1 Shared Utilities Module (`src/vro/actions/shared/`)

The shared utilities module provides cross-cutting infrastructure services consumed by all domain modules. It contains no business logic; every class in this module is a reusable, domain-agnostic utility.

**Logger** (`Logger.js`): A structured JSON logger that emits single-line JSON objects to the console. Each log entry includes a timestamp, severity level, correlation ID, pipeline step label, message, and arbitrary metadata. The Logger supports four severity levels (DEBUG, INFO, WARN, ERROR) with configurable minimum-level thresholding. Context propagation is achieved through factory methods: `withCorrelation(id)` returns a new Logger bound to a correlation ID, and `withStep(step)` returns a new Logger bound to a pipeline step. This immutable-style API ensures that a Logger instance can be safely shared across async operations without state leakage.

The Logger also handles error enrichment: when an Error object is passed as metadata to the `error()` method, its `message`, `stack`, and `code` properties are automatically extracted into a structured metadata object, avoiding the common problem of Error objects being serialized as `{}` by `JSON.stringify()`.

**ConfigLoader** (`ConfigLoader.js`): Provides centralized, read-only access to pipeline configuration. Configuration is resolved by deep-merging a default configuration template with optional overrides supplied at construction time. In production, the overrides are sourced from a vRO Configuration Element; in tests, they are supplied directly by the test harness. The ConfigLoader supports dot-notation key access (e.g., `get('sites.NDCNG.vcenterUrl')`) with fallback default values.

Key design decisions: (a) The config is deep-cloned at construction time to prevent mutation by callers. (b) Secrets are represented as vault reference patterns (`{{vault:secret/...}}`) that are resolved by an external vault integration at runtime. The ConfigLoader itself never handles actual credentials. (c) Per-site endpoint resolution is provided by `getEndpointsForSite(site)`, which validates the site code and returns the three endpoint URLs (vCenter, NSX Local, NSX Global).

**CorrelationContext** (`CorrelationContext.js`): Manages a module-level (process-global) correlation ID that uniquely identifies a pipeline execution. The correlation ID format is `RITM-{number}-{epochTimestamp}`, linking every log entry, HTTP header, and callback payload to the originating ServiceNow RITM. Because vRO JavaScript actions execute in a single-threaded Rhino runtime, a module-level variable provides thread-local-like semantics without the complexity of `AsyncLocalStorage`.

The CorrelationContext provides `create(ritmNumber)` for generation, `set(correlationId)` for adoption (when the ID arrives via an incoming HTTP header), `get()` for retrieval, `getHeaders()` for propagation as an HTTP header (`X-Correlation-ID`), and `clear()` for cleanup at the end of each pipeline execution. The `isValid(value)` method validates format compliance.

**ErrorFactory** (`ErrorFactory.js`): A factory for creating structured Error instances with DFW error codes. Each error code follows the format `DFW-XXXX` where the first digit indicates the category (1=input, 2=NSX API, 3=tags, 4=groups, 5=DFW policy, 6=ServiceNow, 7=timeout, 8=config, 9=internal). The factory attaches the `code` property and an arbitrary `context` object to each Error, enabling downstream consumers to route errors programmatically. The `getCodes()` method returns the full error code registry for documentation and dashboard configuration.

**RetryHandler** (`RetryHandler.js`): Implements configurable retry logic with two modes: interval-based (array of wait times) and strategy-based (an object with a `getDelay(attempt)` method). The Strategy pattern allows callers to plug in custom backoff algorithms (exponential, jittered, constant) without modifying the handler. The `shouldRetry` predicate function gives callers control over which errors trigger retries; by default, HTTP 5xx and 429 errors are retried while 4xx client errors are not.

The handler enriches the final error (after all retries are exhausted) with `retryCount` and `operationName` properties, enabling monitoring systems to track retry exhaustion rates. The static convenience method `RetryHandler.execute(fn, options)` creates a handler and runs the function in a single call for simple use cases.

**CircuitBreaker** (`CircuitBreaker.js`): Implements the circuit breaker pattern with per-endpoint state tracking. State is maintained in a module-level `Map` keyed by endpoint name, enabling multiple CircuitBreaker instances for the same endpoint to share state. The three states (CLOSED, OPEN, HALF_OPEN) are managed through a sliding-window failure counter, a configurable failure threshold, and a reset timeout.

Key implementation details: (a) Failure timestamps are stored in an array and pruned on each failure event to remove timestamps outside the sliding window. (b) The OPEN-to-HALF_OPEN transition is checked lazily on each `execute()` call rather than using a timer, avoiding the need for background threads. (c) On a successful HALF_OPEN probe, failure counters and timestamps are cleared, providing a clean start. (d) The `getStats()` method returns operational statistics suitable for dashboard display. (e) The static `resetAll()` method clears all endpoint states, primarily used in test setup.

### 1.2 Tag Operations Module (`src/vro/actions/tags/`)

**TagCardinalityEnforcer** (`TagCardinalityEnforcer.js`): Enforces cardinality constraints on NSX tag operations. The category configuration defines six tag categories: five single-value (Application, Tier, Environment, DataClassification, CostCenter) and one multi-value (Compliance). The enforcer provides three core operations:

1. `enforceCardinality(current, desired)`: Merges desired tags into the current tag set. Single-value categories are replaced unconditionally. The multi-value Compliance category follows "None"-exclusivity rules: setting "None" clears all other values; adding a real compliance value removes "None".

2. `computeDelta(current, desired)`: Computes the minimal set of tag additions and removals required to transition from the current to the desired state, after applying cardinality rules. Returns arrays in NSX format (`{tag, scope}`).

3. `validateTagCombinations(tags)`: Checks the merged tag set against conflict rules. Currently enforces three rules: PCI/Sandbox conflict, HIPAA/Sandbox conflict, and Confidential-without-Compliance conflict. Returns a `{valid, errors}` result object.

**TagOperations** (`TagOperations.js`): Provides CRUD methods for NSX tags using the idempotent read-compare-write pattern. Each mutating method (`applyTags`, `updateTags`, `removeTags`) follows the same flow: read current tags from NSX, compute the required changes, validate the result, and apply only the delta via PATCH. The `getCurrentTags` method handles NSX API response normalization, converting the raw `[{tag, scope}]` array into a category-keyed object where single-value categories produce strings and multi-value categories produce arrays.

The class depends on a `restClient` (HTTP client) and a `logger` (structured logger) injected via the constructor, following the Dependency Injection pattern. The `TagCardinalityEnforcer` is instantiated internally as a composition relationship.

### 1.3 Group Operations Module (`src/vro/actions/groups/`)

The group operations module manages NSX security group membership based on tag criteria. Security groups in NSX use tag-based membership expressions (e.g., "all VMs with Environment=Production AND Tier=Web"). When a VM's tags change, its group membership is automatically recalculated by NSX. However, the pipeline explicitly verifies group membership after tag operations to ensure consistency.

Key responsibilities: creating security groups with tag-based criteria, verifying VM membership in expected groups after tag application, reconciling group membership during tag updates (ensuring VMs are removed from old groups and added to new groups), and cleaning up group membership during decommissioning.

### 1.4 DFW Operations Module (`src/vro/actions/dfw/`)

**DFWPolicyValidator** (`DFWPolicyValidator.js`): Validates that VMs are properly covered by DFW policies by querying the NSX realized-state API. The `validateCoverage(vmId, site)` method retrieves effective rules for a VM and checks that at least one active (non-disabled) rule applies. The `checkOrphanedRules(groupId, site)` method detects security groups that have DFW rule criteria but no VM members -- a potential security drift indicator.

The validator depends on ConfigLoader for endpoint resolution, ensuring that the correct NSX Manager URL is used for each site. Error handling uses inline error factory functions (DFW-7006 for validation failures, DFW-7007 for orphaned rules) to produce structured errors.

**RuleConflictDetector** (`RuleConflictDetector.js`): Performs static analysis on DFW rule sets to detect three types of issues:

1. **Shadowed rules**: Rules that are completely covered by a higher-priority rule and will never be evaluated. Detection uses scope subsumption analysis (is the higher-priority rule's source/destination/service scope a superset of the candidate's scope?).

2. **Contradictory rules**: Rules with identical scope but different actions (e.g., one ALLOW and one DROP for the same traffic tuple). These indicate a policy conflict that needs resolution.

3. **Duplicate rules**: Rules with identical scope and identical actions. These add no value and should be consolidated.

The `analyze(proposedRules, existingRules)` method combines both rule sets and runs all three detection algorithms, returning a unified summary with a `hasIssues` boolean.

### 1.5 Lifecycle Module (`src/vro/actions/lifecycle/`)

**SagaCoordinator** (`SagaCoordinator.js`): Manages distributed transactions across the pipeline's multi-step lifecycle operations. The coordinator maintains a journal of completed steps, each with a compensating action (an async function that undoes the step). On failure, `compensate()` executes compensating actions in LIFO order.

Key design decisions: (a) Only one saga can be active at a time per coordinator instance (enforced by the `_active` flag). (b) Compensating actions are executed sequentially, not in parallel, to avoid ordering conflicts. (c) If a compensation fails, the error is logged but the coordinator continues with remaining compensations -- this ensures best-effort rollback. (d) The `compensate()` method returns a summary object with counts of successful and failed compensations plus error details for each failure.

**Lifecycle Orchestrator**: The top-level orchestration class that coordinates Day 0, Day 2, and Day N operations. It initializes the correlation context, starts a saga, executes steps in order (calling Tag Operations, Group Operations, and DFW validation), records each step with the saga, handles errors with retry and compensation, and sends the callback to ServiceNow. This class implements the Template Method pattern, with a common execution skeleton and overridable step implementations for each lifecycle type.

### 1.6 Adapters Module (`src/adapters/`)

The adapters module provides uniform interfaces to external systems. Each adapter wraps a system-specific REST client and translates between the pipeline's internal data model and the external API's request/response format. Adapters handle authentication, request formatting, response parsing, and error mapping (converting HTTP errors to DFW error codes via ErrorFactory).

Three adapter types are planned: VCenterAdapter (VM lookup, metadata retrieval), NSXAdapter (tag CRUD, group management, policy operations), and ServiceNowAdapter (callback delivery, RITM updates).

---

## 2. Class Diagram

```mermaid
classDiagram
    class Logger {
        -_correlationId: string
        -_step: string
        -_minLevel: number
        -_defaultMetadata: Object
        +debug(message, metadata)
        +info(message, metadata)
        +warn(message, metadata)
        +error(message, metadata)
        +withCorrelation(id): Logger
        +withStep(step): Logger
        -_emit(level, message, metadata)
        -_getLevelName(): string
        +LOG_LEVELS$: Object
    }

    class ConfigLoader {
        -_config: Object
        +get(key, defaultValue): any
        +getEndpointsForSite(site): Object
        +getRetryConfig(): Object
        +getCircuitBreakerConfig(): Object
        +getHttpConfig(): Object
        +toJSON(): Object
        -_deepClone(obj)$: any
        -_deepMerge(target, source)$: Object
    }

    class CorrelationContext {
        -_currentCorrelationId$: string
        -_currentRitmNumber$: string
        -_createdAt$: number
        +create(ritmNumber)$: string
        +get()$: string
        +set(correlationId)$: string
        +getHeaders()$: Object
        +clear()$: void
        +getRitmNumber()$: string
        +getCreatedAt()$: number
        +isValid(value)$: boolean
        +CORRELATION_HEADER$: string
    }

    class ErrorFactory {
        +create(code, message, context)$: Error
        +getDefaultMessage(code)$: string
        +getCodes()$: Object
    }

    class RetryHandler {
        -_retryIntervals: number[]
        -_maxRetries: number
        -_shouldRetry: Function
        -_retryStrategy: Object
        -_logger: Logger
        -_operationName: string
        +run(fn): Promise
        -_getDelay(attempt): number
        +execute(fn, options)$: Promise
        +DEFAULT_RETRY_INTERVALS$: number[]
        +DEFAULT_MAX_RETRIES$: number
    }

    class CircuitBreaker {
        -_name: string
        -_failureThreshold: number
        -_resetTimeout: number
        -_windowSize: number
        -_logger: Logger
        +execute(fn): Promise
        +getState(): string
        +reset(): void
        +getStats(): Object
        +resetAll()$: void
        +getTrackedEndpointCount()$: number
        -_initState(): void
        -_getState(): Object
        -_transition(newStatus): void
        -_executeNormal(fn): Promise
        -_executeProbe(fn): Promise
        -_recordSuccess(): void
        -_recordFailure(): void
        +STATE$: Object
        +DEFAULTS$: Object
    }

    class TagOperations {
        +restClient: Object
        +logger: Logger
        +cardinalityEnforcer: TagCardinalityEnforcer
        +applyTags(vmId, tags, site): Promise
        +removeTags(vmId, categories, site): Promise
        +getCurrentTags(vmId, site): Promise
        +updateTags(vmId, newTags, site): Promise
        -_getNsxUrl(site): string
        -_extractTagsFromResponse(response): Array
        -_normalizeNsxTags(nsxTags): Object
        -_buildNsxTagArray(tagMap): Array
        -_patchTags(vmId, site, nsxTagArray): Promise
        -_computeRawDelta(from, to): Object
        -_toArray(value): Array
    }

    class TagCardinalityEnforcer {
        +categoryConfig: Object
        +conflictRules: Array
        +enforceCardinality(current, desired): Object
        +computeDelta(current, desired): Object
        +validateTagCombinations(tags): Object
        +getCategoryType(category): string
        -_mergeMultiValue(current, desired): Array
        -_normalizeToArray(value): Array
    }

    class DFWPolicyValidator {
        -_restClient: Object
        -_logger: Logger
        -_config: ConfigLoader
        +validateCoverage(vmId, site): Promise
        +getEffectiveRules(vmId, site): Promise
        +checkOrphanedRules(groupId, site): Promise
    }

    class RuleConflictDetector {
        +analyze(proposed, existing): Object
        +detectShadowed(rules): Array
        +detectContradictory(rules): Array
        +detectDuplicates(rules): Array
        -_sortByPriority(rules)$: Array
        -_normalizeGroups(arr)$: string
        -_normalizeAction(action)$: string
        -_scopeMatches(ruleA, ruleB)$: boolean
        -_isSubsumedBy(candidate, broader)$: boolean
        -_groupCovers(superset, subset)$: boolean
        -_pairKey(ruleA, ruleB)$: string
    }

    class SagaCoordinator {
        -_logger: Logger
        -_correlationId: string
        -_journal: Array
        -_active: boolean
        +begin(correlationId): void
        +recordStep(stepName, compensatingAction): Promise
        +compensate(): Promise
        +getJournal(): Array
        +isActive(): boolean
    }

    class LifecycleOrchestrator {
        -_config: ConfigLoader
        -_logger: Logger
        -_saga: SagaCoordinator
        -_tagOps: TagOperations
        -_dfwValidator: DFWPolicyValidator
        +executeDay0(params): Promise
        +executeDay2(params): Promise
        +executeDayN(params): Promise
        -_initializeContext(params): Object
        -_sendCallback(result): Promise
    }

    TagOperations --> TagCardinalityEnforcer : composes
    TagOperations --> Logger : uses
    DFWPolicyValidator --> ConfigLoader : uses
    DFWPolicyValidator --> Logger : uses
    SagaCoordinator --> Logger : uses
    RetryHandler --> Logger : uses
    CircuitBreaker --> Logger : uses
    LifecycleOrchestrator --> SagaCoordinator : uses
    LifecycleOrchestrator --> TagOperations : uses
    LifecycleOrchestrator --> DFWPolicyValidator : uses
    LifecycleOrchestrator --> ConfigLoader : uses
    LifecycleOrchestrator --> Logger : uses
```

---

## 3. Sequence Diagrams

### 3.1 Day 0 Provisioning — Detailed Internal Flow

```mermaid
sequenceDiagram
    participant Client as ServiceNow
    participant Orch as LifecycleOrchestrator
    participant Corr as CorrelationContext
    participant Saga as SagaCoordinator
    participant Config as ConfigLoader
    participant CB as CircuitBreaker
    participant Retry as RetryHandler
    participant Tags as TagOperations
    participant TCE as TagCardinalityEnforcer
    participant DFW as DFWPolicyValidator
    participant NSX as NSX Manager REST API
    participant VC as vCenter REST API

    Client->>Orch: executeDay0({ritm, vmId, tags, site})
    Orch->>Corr: create(ritmNumber)
    Corr-->>Orch: RITM-12345-{ts}
    Orch->>Config: getEndpointsForSite(site)
    Config-->>Orch: {vcenterUrl, nsxUrl, nsxGlobalUrl}
    Orch->>Saga: begin(correlationId)

    Note over Orch: Step 1 - VM Verification
    Orch->>CB: execute(() => vcAdapter.getVM(vmId))
    CB->>Retry: run(() => restClient.get(vcenterUrl))
    Retry->>VC: GET /api/vcenter/vm/{vmId}
    VC-->>Retry: 200 {vm details}
    Retry-->>CB: vm details
    CB-->>Orch: vm details

    Note over Orch: Step 2 - Apply Tags
    Orch->>Tags: applyTags(vmId, tags, site)
    Tags->>NSX: GET /fabric/virtual-machines/{vmId}/tags
    NSX-->>Tags: {tags: []}
    Tags->>TCE: enforceCardinality({}, desiredTags)
    TCE-->>Tags: mergedTags
    Tags->>TCE: validateTagCombinations(mergedTags)
    TCE-->>Tags: {valid: true}
    Tags->>TCE: computeDelta({}, desiredTags)
    TCE-->>Tags: {toAdd: [...], toRemove: []}
    Tags->>NSX: PATCH /fabric/virtual-machines/{vmId}/tags
    NSX-->>Tags: 200 OK
    Tags-->>Orch: {applied: true}
    Orch->>Saga: recordStep('applyTags', undoFn)

    Note over Orch: Step 3 - Verify DFW Coverage
    Orch->>DFW: validateCoverage(vmId, site)
    DFW->>NSX: GET /realized-state/.../rules
    NSX-->>DFW: [rule1, rule2, ...]
    DFW-->>Orch: {covered: true}

    Note over Orch: Step 4 - Callback
    Orch->>Client: POST /dfw_callback {success}
    Orch->>Corr: clear()
```

### 3.2 Day 2 Update — Detailed Internal Flow

```mermaid
sequenceDiagram
    participant Client as ServiceNow
    participant Orch as LifecycleOrchestrator
    participant Saga as SagaCoordinator
    participant Tags as TagOperations
    participant TCE as TagCardinalityEnforcer
    participant NSX as NSX Manager

    Client->>Orch: executeDay2({ritm, vmId, newTags, site})
    Orch->>Saga: begin(correlationId)

    Orch->>Tags: updateTags(vmId, newTags, site)
    Tags->>NSX: GET /fabric/virtual-machines/{vmId}/tags
    NSX-->>Tags: currentTags {Application: APP001, Tier: Web}

    Note over Tags: Prepare base: remove old values<br/>for single-value categories in newTags
    Tags->>TCE: enforceCardinality(preparedBase, newTags)
    TCE-->>Tags: mergedTags
    Tags->>TCE: validateTagCombinations(mergedTags)
    TCE-->>Tags: {valid: true}

    Note over Tags: computeRawDelta(previousTags, mergedTags)
    Tags->>NSX: PATCH /fabric/virtual-machines/{vmId}/tags
    NSX-->>Tags: 200 OK
    Tags-->>Orch: {updated: true, delta: {toAdd: [...], toRemove: [...]}}
    Orch->>Saga: recordStep('updateTags', undoFn)

    Orch->>Client: POST /dfw_callback {success}
```

### 3.3 Day N Decommission — Detailed Internal Flow

```mermaid
sequenceDiagram
    participant Client as ServiceNow
    participant Orch as LifecycleOrchestrator
    participant Saga as SagaCoordinator
    participant Tags as TagOperations
    participant DFW as DFWPolicyValidator
    participant NSX as NSX Manager

    Client->>Orch: executeDayN({ritm, vmId, site})
    Orch->>Saga: begin(correlationId)

    Note over Orch: Snapshot current state for compensation
    Orch->>Tags: getCurrentTags(vmId, site)
    Tags->>NSX: GET /fabric/virtual-machines/{vmId}/tags
    NSX-->>Tags: allCurrentTags
    Tags-->>Orch: tagSnapshot

    Note over Orch: Remove all tags
    Orch->>Tags: removeTags(vmId, allCategories, site)
    Tags->>NSX: PATCH /fabric/virtual-machines/{vmId}/tags (empty)
    NSX-->>Tags: 200 OK
    Orch->>Saga: recordStep('removeTags', restoreTagsFn)

    Note over Orch: Verify DFW removal
    Orch->>DFW: validateCoverage(vmId, site)
    DFW->>NSX: GET /realized-state/.../rules
    NSX-->>DFW: [] (no rules)
    DFW-->>Orch: {covered: false}

    Orch->>Client: POST /dfw_callback {success, decommissioned}
```

---

## 4. Error Handling Flows

### 4.1 Saga Compensation Flow

```mermaid
sequenceDiagram
    participant Orch as LifecycleOrchestrator
    participant Saga as SagaCoordinator
    participant Step3 as DFW Policy Apply
    participant Step2 as Group Membership
    participant Step1 as Tag Apply
    participant DLQ as Dead Letter Queue

    Note over Orch: Step 1 succeeds
    Orch->>Saga: recordStep('applyTags', undoTagsFn)

    Note over Orch: Step 2 succeeds
    Orch->>Saga: recordStep('updateGroups', undoGroupsFn)

    Note over Orch: Step 3 FAILS
    Step3-->>Orch: Error: DFW-5002 Policy validation failed

    Orch->>Saga: compensate()

    Note over Saga: LIFO compensation order
    Saga->>Step2: Execute compensating action (undo groups)
    Step2-->>Saga: Compensation succeeded

    Saga->>Step1: Execute compensating action (undo tags)
    Step1-->>Saga: Compensation succeeded

    Saga-->>Orch: {compensated: 2, failed: 0}

    alt Compensation had failures
        Saga->>DLQ: Write failed compensation to DLQ
    end

    Orch->>Orch: Send error callback to ServiceNow
```

### 4.2 Retry with Circuit Breaker Flow

```mermaid
sequenceDiagram
    participant Caller as TagOperations
    participant CB as CircuitBreaker
    participant Retry as RetryHandler
    participant NSX as NSX Manager

    Caller->>CB: execute(fn)
    Note over CB: State: CLOSED

    CB->>Retry: run(fn)
    Retry->>NSX: Attempt 1 — GET /tags
    NSX-->>Retry: 503 Service Unavailable
    Note over Retry: shouldRetry(503) → true
    Note over Retry: Wait 5000ms

    Retry->>NSX: Attempt 2 — GET /tags
    NSX-->>Retry: 503 Service Unavailable
    Note over Retry: Wait 15000ms

    Retry->>NSX: Attempt 3 — GET /tags
    NSX-->>Retry: 503 Service Unavailable
    Note over Retry: Wait 45000ms

    Retry->>NSX: Attempt 4 — GET /tags
    NSX-->>Retry: 503 Service Unavailable
    Note over Retry: All retries exhausted

    Retry-->>CB: Throw error (enriched with retryCount)
    Note over CB: Record failure #N
    Note over CB: If failures >= threshold → OPEN

    CB-->>Caller: Throw error

    Note over CB: Next call while OPEN:
    Caller->>CB: execute(fn)
    CB-->>Caller: Immediate reject DFW-6004
```

---

## 5. Configuration Schema

The ConfigLoader resolves the following configuration tree. In production, this is loaded from a vRO Configuration Element; in tests, it is supplied as a JavaScript object.

```json
{
  "sites": {
    "NDCNG": {
      "vcenterUrl": "https://vcenter-ndcng.company.internal",
      "nsxUrl": "https://nsx-manager-ndcng.company.internal",
      "nsxGlobalUrl": "https://nsx-global-ndcng.company.internal"
    },
    "TULNG": {
      "vcenterUrl": "https://vcenter-tulng.company.internal",
      "nsxUrl": "https://nsx-manager-tulng.company.internal",
      "nsxGlobalUrl": "https://nsx-global-tulng.company.internal"
    }
  },
  "auth": {
    "vcenterUsername": "{{vault:secret/vro/vcenter/username}}",
    "vcenterPassword": "{{vault:secret/vro/vcenter/password}}",
    "nsxUsername": "{{vault:secret/vro/nsx/username}}",
    "nsxPassword": "{{vault:secret/vro/nsx/password}}",
    "nsxGlobalUsername": "{{vault:secret/vro/nsx-global/username}}",
    "nsxGlobalPassword": "{{vault:secret/vro/nsx-global/password}}"
  },
  "retry": {
    "intervals": [5000, 15000, 45000],
    "maxRetries": 3
  },
  "circuitBreaker": {
    "failureThreshold": 5,
    "resetTimeout": 60000,
    "windowSize": 300000
  },
  "http": {
    "timeout": 30000,
    "followRedirects": true,
    "maxRedirects": 5
  },
  "callback": {
    "maxRetries": 3,
    "retryIntervals": [2000, 5000, 10000]
  },
  "logging": {
    "minLevel": "INFO"
  }
}
```

### 5.1 Configuration Key Reference

| Key Path | Type | Default | Description |
|----------|------|---------|-------------|
| `sites.{SITE}.vcenterUrl` | string | (per-site) | vCenter REST API base URL |
| `sites.{SITE}.nsxUrl` | string | (per-site) | NSX Local Manager REST API base URL |
| `sites.{SITE}.nsxGlobalUrl` | string | (per-site) | NSX Global Manager REST API base URL |
| `auth.vcenterUsername` | string | vault ref | vCenter service account username |
| `auth.vcenterPassword` | string | vault ref | vCenter service account password |
| `auth.nsxUsername` | string | vault ref | NSX Manager service account username |
| `auth.nsxPassword` | string | vault ref | NSX Manager service account password |
| `retry.intervals` | number[] | [5000,15000,45000] | Wait times (ms) between retry attempts |
| `retry.maxRetries` | number | 3 | Maximum retry attempts |
| `circuitBreaker.failureThreshold` | number | 5 | Failures to trip the breaker |
| `circuitBreaker.resetTimeout` | number | 60000 | Milliseconds before OPEN to HALF_OPEN |
| `circuitBreaker.windowSize` | number | 300000 | Sliding window for failure counting (ms) |
| `http.timeout` | number | 30000 | HTTP request timeout (ms) |
| `callback.maxRetries` | number | 3 | ServiceNow callback retry limit |
| `callback.retryIntervals` | number[] | [2000,5000,10000] | Callback retry wait times (ms) |
| `logging.minLevel` | string | "INFO" | Minimum log severity to emit |

---

## 6. REST API Contracts Summary

### 6.1 NSX Manager — Tag Operations

**Read Tags:**
```
GET {nsxUrl}/api/v1/fabric/virtual-machines/{vmId}/tags
Accept: application/json
X-Correlation-ID: RITM-12345-{ts}

Response 200:
{
  "results": [
    { "tag": "APP001", "scope": "Application" },
    { "tag": "Web", "scope": "Tier" },
    { "tag": "Production", "scope": "Environment" }
  ]
}
```

**Write Tags:**
```
PATCH {nsxUrl}/api/v1/fabric/virtual-machines/{vmId}/tags
Content-Type: application/json
X-Correlation-ID: RITM-12345-{ts}

Body:
{
  "tags": [
    { "tag": "APP001", "scope": "Application" },
    { "tag": "Web", "scope": "Tier" },
    { "tag": "Production", "scope": "Environment" },
    { "tag": "PCI", "scope": "Compliance" }
  ]
}

Response 200: (empty body)
```

### 6.2 NSX Manager — Realized State

**Get Effective Rules:**
```
GET {nsxUrl}/policy/api/v1/infra/realized-state/enforcement-points/default/virtual-machines/{vmId}/rules
Accept: application/json

Response 200:
{
  "results": [
    {
      "id": "rule-001",
      "display_name": "Allow-DNS-UDP",
      "action": "ALLOW",
      "disabled": false,
      "source_groups": ["ANY"],
      "destination_groups": ["/infra/domains/default/groups/DNS-Servers"],
      "services": ["UDP/53"]
    }
  ]
}
```

### 6.3 NSX Manager — Security Groups

**Get Group Members:**
```
GET {nsxUrl}/policy/api/v1/infra/domains/default/groups/{groupId}/members/virtual-machines
Accept: application/json

Response 200:
{
  "results": [
    { "external_id": "vm-42", "display_name": "srv-web-01" }
  ],
  "result_count": 1
}
```

### 6.4 ServiceNow — Callback

**Operation Callback:**
```
POST {snowUrl}/api/x_company/dfw_callback
Content-Type: application/json
Authorization: Bearer {oauth_token}
X-Correlation-ID: RITM-12345-{ts}

Body:
{
  "ritmNumber": "RITM0012345",
  "correlationId": "RITM-12345-1679000000000",
  "status": "success|failure",
  "operation": "day0-provision|day2-update|dayn-decommission",
  "summary": {
    "tagsApplied": 6,
    "groupsUpdated": 3,
    "dfwPoliciesVerified": 2
  },
  "errors": [],
  "compensationResult": null,
  "timestamp": "2026-03-21T12:00:00.000Z"
}
```

---

## 7. State Machine Diagrams

### 7.1 Circuit Breaker State Machine

```mermaid
stateDiagram-v2
    [*] --> CLOSED

    CLOSED --> CLOSED : Success (reset consecutive failures)
    CLOSED --> CLOSED : Failure (below threshold)
    CLOSED --> OPEN : Failure count >= threshold within window

    OPEN --> OPEN : Call rejected immediately (DFW-6004)
    OPEN --> HALF_OPEN : resetTimeout elapsed

    HALF_OPEN --> CLOSED : Probe call succeeds<br/>(clear failure counters)
    HALF_OPEN --> OPEN : Probe call fails<br/>(reset timer)

    note right of CLOSED
        Normal operation.
        Track failures in sliding window.
        failureThreshold: 5
        windowSize: 300000ms
    end note

    note right of OPEN
        All calls rejected.
        Protecting downstream service.
        resetTimeout: 60000ms
    end note

    note right of HALF_OPEN
        Single probe call permitted.
        Determines recovery.
    end note
```

### 7.2 Saga State Machine

```mermaid
stateDiagram-v2
    [*] --> Inactive

    Inactive --> Active : begin(correlationId)

    Active --> Active : recordStep(name, compensate_fn)

    Active --> Compensating : Failure detected → compensate()

    Compensating --> Compensating : Execute next compensation (LIFO)

    Compensating --> Inactive : All compensations attempted

    Active --> Inactive : All steps complete (success)

    note right of Active
        Journal records steps in order.
        Each step has a compensating action.
        Only one saga active at a time.
    end note

    note right of Compensating
        Compensations run in REVERSE order.
        Failed compensations logged but
        do not halt remaining compensations.
        Best-effort rollback guarantee.
    end note
```

### 7.3 Pipeline Operation State Machine

```mermaid
stateDiagram-v2
    [*] --> Received

    Received --> Validating : Parse and validate inputs
    Validating --> Rejected : Validation failure (DFW-1xxx)
    Validating --> Executing : Validation passed

    Executing --> Executing : Step N completes → Step N+1
    Executing --> Compensating : Step failure (after retries exhausted)

    Compensating --> CompensationComplete : All compensations attempted
    CompensationComplete --> Failed : Report failure to ServiceNow

    Executing --> Verifying : All steps complete
    Verifying --> Succeeded : DFW coverage verified
    Verifying --> Compensating : Verification failed

    Succeeded --> [*] : Callback sent to ServiceNow
    Failed --> [*] : Error callback sent to ServiceNow
    Rejected --> [*] : Rejection callback sent to ServiceNow

    note right of Executing
        Saga records each step.
        CircuitBreaker protects API calls.
        RetryHandler wraps transient failures.
    end note
```

---

*End of Low Level Design*
