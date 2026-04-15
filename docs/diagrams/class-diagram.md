# Class Diagram

This diagram shows the complete class hierarchy and relationships for the NSX DFW Automation Pipeline. It includes the abstract LifecycleOrchestrator with its concrete Day0/Day2/DayN implementations, the tag management subsystem, DFW validation components, resilience infrastructure, and shared utilities.

The diagram is split into three sections for readability.

### Core Orchestration Classes

This section covers the abstract LifecycleOrchestrator with its Day0, Day2, and DayN concrete implementations, the SagaCoordinator for distributed transaction compensation, and core validation and error-handling dependencies.

```mermaid
classDiagram
    class LifecycleOrchestrator {
        <<abstract>>
        -restClient: RestClient
        -saga: SagaCoordinator
        -validator: PayloadValidator
        -logger: Logger
        -config: ConfigLoader
        +run(payload) Promise~Result~
        #validate(payload) void
        #resolveEndpoints(site) Endpoints
        #prepare(payload, endpoints)* Promise~void~
        #execute(payload, endpoints)* Promise~Result~
        #verify(payload, endpoints)* Promise~void~
        #callback(payload, result) Promise~void~
        +create(requestType, deps)$ LifecycleOrchestrator
    }

    class Day0Orchestrator {
        +prepare(payload, endpoints) Promise~void~
        +execute(payload, endpoints) Promise~Result~
        +verify(payload, endpoints) Promise~void~
        -provisionVM(payload, endpoints) Promise~string~
        -waitForVMTools(vmId, endpoints) Promise~void~
        -applyInitialTags(vmId, tags, site) Promise~void~
    }

    class Day2Orchestrator {
        +prepare(payload, endpoints) Promise~void~
        +execute(payload, endpoints) Promise~Result~
        +verify(payload, endpoints) Promise~void~
        -runImpactAnalysis(current, new) ImpactReport
        -computeTagDelta(current, desired) TagDelta
        -snapshotCurrentState(vmId, site) StateSnapshot
    }

    class DayNOrchestrator {
        +prepare(payload, endpoints) Promise~void~
        +execute(payload, endpoints) Promise~Result~
        +verify(payload, endpoints) Promise~void~
        -checkDependencies(vmId, site) DependencyReport
        -verifyGroupDrain(vmId, site) Promise~void~
        -deprovisionVM(vmId, site) Promise~void~
    }

    class SagaCoordinator {
        -journal: SagaStep[]
        -correlationId: string
        -active: boolean
        +begin(correlationId) void
        +recordStep(name, compensatingAction) void
        +compensate() Promise~CompensationResult~
        +getJournal() SagaStep[]
        +isActive() boolean
    }

    class SagaStep {
        +name: string
        +compensatingAction: Function
        +timestamp: number
    }

    class PayloadValidator {
        -schemas: Map~string, Schema~
        +validate(payload) ValidationResult
        -validateSchema(payload) void
        -validateBusinessRules(payload) void
        -validateTagValues(tags) void
        -validateSiteCode(site) void
    }

    %% Inheritance
    LifecycleOrchestrator <|-- Day0Orchestrator
    LifecycleOrchestrator <|-- Day2Orchestrator
    LifecycleOrchestrator <|-- DayNOrchestrator

    %% Composition -- Orchestrator dependencies
    LifecycleOrchestrator *-- SagaCoordinator : creates per execution
    LifecycleOrchestrator *-- PayloadValidator : injected
    LifecycleOrchestrator o-- RestClient : shared
    LifecycleOrchestrator o-- Logger : shared
    LifecycleOrchestrator o-- ConfigLoader : shared
    LifecycleOrchestrator --> ErrorFactory : error creation

    %% Saga internals
    SagaCoordinator --> SagaStep : journal entries
```

### Tag Management and DFW Validation

This section covers the tag management subsystem (TagOperations, TagCardinalityEnforcer, CardinalityRule) and the DFW policy validation components (DFWPolicyValidator, RuleConflictDetector). Orchestrator classes are shown minimally to illustrate cross-cutting dependencies.

```mermaid
classDiagram
    class TagOperations {
        -restClient: RestClient
        -cardinalityEnforcer: TagCardinalityEnforcer
        +applyTags(vmId, tags, site) Promise~void~
        +removeTags(vmId, categories, site) Promise~void~
        +getCurrentTags(vmId, site) Promise~Tag[]~
        +updateTags(vmId, newTags, site) Promise~void~
    }

    class TagCardinalityEnforcer {
        -CATEGORIES: Map~string, CardinalityRule~
        -CONFLICT_RULES: ConflictRule[]
        +enforceCardinality(current, desired) Tag[]
        +computeDelta(current, desired) TagDelta
        +validateTagCombinations(tags) ValidationResult
        -checkSingleValueCategories(tags) void
        -checkMultiValueCategories(tags) void
        -checkConflictRules(tags) void
        -checkMutualExclusivity(tags) void
    }

    class CardinalityRule {
        +category: string
        +type: single | multi
        +mandatory: boolean
        +allowedValues: string[]
    }

    class DFWPolicyValidator {
        -restClient: RestClient
        +validateCoverage(vmId, site) Promise~CoverageResult~
        +getEffectiveRules(vmId, site) Promise~Rule[]~
        +checkOrphanedRules(groupId, site) Promise~OrphanResult~
    }

    class RuleConflictDetector {
        +analyze(rules) ConflictReport
        +detectShadowed(rules) ShadowedRule[]
        +detectContradictory(rules) ContradictoryRule[]
        +detectDuplicates(rules) DuplicateRule[]
    }

    %% Cross-cutting -- orchestrators that use these subsystems
    class Day0Orchestrator
    class Day2Orchestrator
    class DayNOrchestrator

    %% Tag subsystem
    Day0Orchestrator --> TagOperations : uses
    Day2Orchestrator --> TagOperations : uses
    DayNOrchestrator --> TagOperations : uses
    TagOperations *-- TagCardinalityEnforcer : composes
    TagCardinalityEnforcer --> CardinalityRule : references

    %% DFW subsystem
    Day0Orchestrator --> DFWPolicyValidator : uses
    Day2Orchestrator --> DFWPolicyValidator : uses
    DayNOrchestrator --> DFWPolicyValidator : uses
    DFWPolicyValidator --> RuleConflictDetector : delegates analysis
```

### Resilience and Infrastructure

This section covers the resilience chain (CircuitBreaker, RetryHandler, RestClient), shared utilities (Logger, ConfigLoader, CorrelationContext), and the ErrorFactory.

```mermaid
classDiagram
    class CircuitBreaker {
        -state: CLOSED | OPEN | HALF_OPEN
        -failureCount: number
        -lastFailureTime: number
        -failureThreshold: number
        -resetTimeout: number
        -windowSize: number
        +execute(fn) Promise~any~
        +getState() string
        +reset() void
        +getStats() BreakerStats
        -trip() void
        -attemptReset() void
        -recordSuccess() void
        -recordFailure() void
    }

    class RetryHandler {
        -maxRetries: number
        -intervals: number[]
        -retryStrategy: Function
        -shouldRetry: Function
        +execute(fn, options) Promise~any~
        -delay(ms) Promise~void~
        -isRetryable(error) boolean
    }

    class RestClient {
        -circuitBreaker: CircuitBreaker
        -retryHandler: RetryHandler
        -logger: Logger
        +get(url, headers) Promise~Response~
        +post(url, body, headers) Promise~Response~
        +patch(url, body, headers) Promise~Response~
        +delete(url, headers) Promise~Response~
        -addCorrelationHeader(headers) Headers
    }

    class Logger {
        -correlationId: string
        -step: string
        -level: string
        +debug(message, data) void
        +info(message, data) void
        +warn(message, data) void
        +error(message, data) void
        +withCorrelation(id) Logger
        +withStep(step) Logger
        -formatEntry(level, message, data) string
        -safeStringify(obj) string
    }

    class ConfigLoader {
        -config: object
        +get(key) any
        +getSiteConfig(site) SiteConfig
        +getEndpoints(site) Endpoints
        -deepMerge(target, source) object
        -deepClone(obj) object
        -resolveVaultRefs(config) object
    }

    class CorrelationContext {
        -correlationId: string
        -stepName: string
        +generate(ritmNumber) string
        +set(correlationId) void
        +get() string
        +setStep(step) void
        +getStep() string
        +getHeader() object
    }

    class ErrorFactory {
        +create(code, message, context)$ Error
        +createCallbackPayload(corrId, error, action)$ CallbackPayload
        -enrichError(error, context)$ Error
    }

    %% Resilience chain
    RestClient --> CircuitBreaker : wraps calls
    RestClient --> RetryHandler : wraps calls

    %% Shared utilities
    RestClient --> CorrelationContext : header injection
    Logger --> CorrelationContext : context enrichment
```

## Design Pattern Mapping

| Pattern | Class(es) | Purpose |
|---------|----------|---------|
| Template Method | `LifecycleOrchestrator` (abstract) + Day0/Day2/DayN | Fixed workflow skeleton with pluggable steps |
| Factory Method | `LifecycleOrchestrator.create()` | Instantiates correct orchestrator by request type |
| Strategy | `RetryHandler` (pluggable `retryStrategy`, `shouldRetry`) | Configurable retry behavior |
| Saga | `SagaCoordinator` + `SagaStep` | Distributed transaction compensation |
| Circuit Breaker | `CircuitBreaker` | Endpoint failure detection and fast-fail |
| Adapter | `RestClient` | Uniform HTTP interface over circuit breaker + retry |
| Repository | `TagOperations` (read-compare-write) | Idempotent tag state management |
| Singleton (module) | `CircuitBreaker._endpointStates`, `CorrelationContext` | Per-endpoint state, per-request context |

## Module Dependency Graph

| Module | Depends On | Depended On By |
|--------|-----------|---------------|
| `LifecycleOrchestrator` | SagaCoordinator, PayloadValidator, RestClient, Logger, ConfigLoader, ErrorFactory | Entry point (none) |
| `Day0/Day2/DayNOrchestrator` | TagOperations, DFWPolicyValidator | LifecycleOrchestrator (via factory) |
| `TagOperations` | RestClient, TagCardinalityEnforcer | Day0, Day2, DayN Orchestrators |
| `TagCardinalityEnforcer` | None (pure logic) | TagOperations |
| `DFWPolicyValidator` | RestClient, RuleConflictDetector | Day0, Day2, DayN Orchestrators |
| `RuleConflictDetector` | None (pure logic) | DFWPolicyValidator |
| `RestClient` | CircuitBreaker, RetryHandler, Logger, CorrelationContext | TagOperations, DFWPolicyValidator |
| `CircuitBreaker` | None (self-contained) | RestClient |
| `RetryHandler` | None (self-contained) | RestClient |
| `ErrorFactory` | None (pure logic) | All orchestrators, SagaCoordinator |
| `Logger` | CorrelationContext | All components |
| `ConfigLoader` | None (reads config) | LifecycleOrchestrator |
| `CorrelationContext` | None (module state) | Logger, RestClient |
