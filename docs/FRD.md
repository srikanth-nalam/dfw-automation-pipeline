# Functional Requirements Design (FRD)

## NSX DFW Automation Pipeline

**Version:** 1.0
**Date:** 2026-03-21
**Author:** Enterprise Infrastructure & Cloud Security

---

## Table of Contents

1. [Overview](#1-overview)
2. [Requirement Traceability Methodology](#2-requirement-traceability-methodology)
3. [FR-001 through FR-010: ServiceNow Catalog Form Enhancements](#3-fr-001-through-fr-010-servicenow-catalog-form-enhancements)
4. [FR-011 through FR-020: Tag Cardinality and Operations](#4-fr-011-through-fr-020-tag-cardinality-and-operations)
5. [FR-021 through FR-030: Pipeline Orchestration and Configuration](#5-fr-021-through-fr-030-pipeline-orchestration-and-configuration)
6. [FR-031 through FR-040: DFW Policy Validation and Conflict Detection](#6-fr-031-through-fr-040-dfw-policy-validation-and-conflict-detection)
7. [FR-041 through FR-050: Error Handling, Retry, and Circuit Breaker](#7-fr-041-through-fr-050-error-handling-retry-and-circuit-breaker)
8. [FR-051 through FR-060: Logging, Observability, and Compliance](#8-fr-051-through-fr-060-logging-observability-and-compliance)
9. [FR-061 through FR-065: Policy-as-Code and Schema Validation](#9-fr-061-through-fr-065-policy-as-code-and-schema-validation)
10. [Cross-Cutting Traceability Summary](#10-cross-cutting-traceability-summary)

---

## 1. Overview

This Functional Requirements Design document provides a comprehensive traceability matrix mapping all 65 functional requirements (FR-001 through FR-065) from the Business Requirements Document (BRD) to their implementing design components, source files, test cases, and acceptance criteria. Each requirement is traceable from business need through implementation to verification.

The requirements are organized into nine functional areas that align with the pipeline's module architecture:

- **ServiceNow Catalog Form** (FR-001 to FR-010): Client-side form behavior, defaults, validation, and dynamic field filtering
- **Tag Cardinality and Operations** (FR-011 to FR-020): Cardinality enforcement, conflict detection, idempotent tag CRUD, and delta computation
- **Pipeline Orchestration and Configuration** (FR-021 to FR-030): Correlation ID management, lifecycle orchestration (Day 0/2/N), site resolution, and configuration loading
- **DFW Policy Validation and Conflict Detection** (FR-031 to FR-040): DFW coverage verification, orphaned rule detection, rule conflict analysis, and policy reconciliation
- **Error Handling, Retry, and Circuit Breaker** (FR-041 to FR-050): Structured error taxonomy, retry with exponential backoff, circuit breaker state machine, and saga compensation
- **Logging, Observability, and Compliance** (FR-051 to FR-060): Structured JSON logging, log level filtering, error enrichment, safe serialization, and audit trail
- **Policy-as-Code and Schema Validation** (FR-061 to FR-065): YAML policy definitions, JSON Schema validation, CI integration, and schema-driven payload verification

---

## 2. Requirement Traceability Methodology

Each requirement entry in the matrices below includes the following fields:

| Field | Description |
|-------|-------------|
| **FR-ID** | Unique requirement identifier from the BRD (FR-001 through FR-065) |
| **Requirement** | Concise statement of the functional requirement |
| **Design Component** | The class, module, or subsystem responsible for fulfilling the requirement |
| **Source File** | The primary implementation file (relative to repository root) |
| **Test Case** | The test case ID(s) from the Test Strategy (TC-XXX) that verify this requirement |
| **Acceptance Criteria** | Measurable conditions that must be true for the requirement to be considered fulfilled |

The relationship between FR, design component, and test case follows the V-model: each requirement is implemented by one or more components and verified by one or more test cases. Bidirectional traceability ensures that every requirement has both an implementation and a verification, and that no implementation exists without a corresponding requirement.

---

## 3. FR-001 through FR-010: ServiceNow Catalog Form Enhancements

These requirements define the ServiceNow catalog item form behavior for VM Build Requests and Tag Update Requests. The form is the primary user interface for initiating DFW pipeline operations and must enforce tag governance rules at the point of entry.

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-001 | Catalog form renders all six tag category fields (Application, Tier, Environment, DataClassification, Compliance, CostCenter) | ServiceNow Catalog Item + Client Script `onLoad` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-001 | All six fields are present in `g_form` after `onLoad()` completes; each field is visible and interactive |
| FR-002 | DataClassification defaults to "Internal" when the form loads | Client Script `vmBuildRequest_onLoad` — `_setDefaultFieldValues()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-002 | `g_form.getValue('data_classification')` returns `'Internal'` immediately after `onLoad()` completes; default is only applied when the field is empty |
| FR-003 | Compliance defaults to "None" when the form loads | Client Script `vmBuildRequest_onLoad` — `_setDefaultFieldValues()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-003 | `g_form.getValue('compliance')` returns `'None'` immediately after `onLoad()` completes; default is only applied when the field is empty |
| FR-004 | CostCenter auto-populated from user's department record via GlideAjax | Client Script `vmBuildRequest_onLoad` — `_populateCostCenter()` + `_fetchCostCenterFromDepartment()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-004 | `g_form.setValue('cost_center', answer)` is called with the cost center value returned by `DFWCatalogUtils.getCostCenterForUser()`; field is set to read-only after population |
| FR-005 | CostCenter falls back to user preference when GlideAjax returns empty | Client Script `vmBuildRequest_onLoad` — `_populateCostCenter()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-005 | When `g_user.getPreference('cost_center')` returns a non-empty value, it is used as the CostCenter value; field is set to read-only; when both preference and GlideAjax are empty, field remains editable with info message |
| FR-006 | Application, Tier, Environment, and DataClassification marked as mandatory on form load | Client Script `vmBuildRequest_onLoad` — `_initializeFormState()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-006 | `g_form.setMandatory()` is called with `true` for `application`, `tier`, `environment`, and `data_classification`; form cannot be submitted without these fields populated |
| FR-007 | Tier change to "Database" makes Compliance field mandatory | Client Script `vmBuildRequest_onChange` — `_handleTierChange()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onChange.js` | TC-006 (extended) | When `tier` changes to `'Database'`, `g_form.setMandatory('compliance', true)` is called and an info message explains the requirement; when tier changes away from Database, Compliance reverts to optional |
| FR-008 | Environment change filters DataClassification options by tier | Client Script `vmBuildRequest_onChange` — `_filterDataClassificationByTier()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onChange.js` | TC-002 (extended) | DataClassification dropdown options are restricted per the `DATA_CLASSIFICATION_BY_TIER` mapping (e.g., Web tier shows only Public/Internal; Database tier shows only Confidential/Restricted); invalid previous selection is cleared with warning message |
| FR-009 | Sandbox environment restricts Compliance to "None" only | Client Script `vmBuildRequest_onChange` — `_handleEnvironmentChange()` + `_filterComplianceForSandbox()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onChange.js` | TC-013, TC-014 | When Environment is set to `'Sandbox'`, Compliance dropdown shows only `'None'`; value is automatically set to `'None'`; info message explains the restriction |
| FR-010 | PCI Compliance in Sandbox raises DFW-4003 error and reverts | Client Script `vmBuildRequest_onChange` — `_validateComplianceEnvironment()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onChange.js` | TC-013 | When Compliance includes `'PCI'` and Environment is `'Sandbox'`, error message `[DFW-4003]` is displayed on Compliance field; value is reverted to `'None'` |

### Design Notes — ServiceNow Catalog Form

The form logic is split into two client scripts following ServiceNow best practices:

1. **`vmBuildRequest_onLoad.js`** runs once when the form loads. It sets defaults, populates CostCenter asynchronously, and initializes field state (mandatory flags, visibility). It does not perform cross-field validation because all fields are at their default values.

2. **`vmBuildRequest_onChange.js`** runs on every field change event. It dispatches to handler functions based on the changed field name (`tier`, `environment`, `compliance`). Each handler enforces business rules that depend on the current form state, such as filtering DataClassification options based on Tier or blocking PCI in Sandbox environments.

The production warning banner (`production_warning_banner` UI Macro) is hidden by default and shown only when Environment is set to Production. The banner uses DOM manipulation via ServiceNow's `gel()` function.

Server-side validation in `catalogItemValidation.js` and `tagFieldServerValidation.js` provides a second layer of defense against invalid submissions that bypass client-side checks.

---

## 4. FR-011 through FR-020: Tag Cardinality and Operations

These requirements define how NSX tags are enforced, applied, updated, and removed on virtual machines. The tag system uses a cardinality model where each category is either single-value (only one tag per category) or multi-value (multiple tags may coexist within the category).

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-011 | Single-value cardinality replaces existing tag value in same category | TagCardinalityEnforcer — `enforceCardinality()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-007 | `enforceCardinality({Application: 'A'}, {Application: 'B'})` returns `{Application: 'B'}`; the previous value 'A' is completely replaced by 'B' for any single-value category |
| FR-012 | Multi-value cardinality merges new values with existing values | TagCardinalityEnforcer — `enforceCardinality()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-008 | `enforceCardinality({Compliance: ['PCI']}, {Compliance: ['HIPAA']})` returns `{Compliance: ['PCI', 'HIPAA']}`; duplicate values are deduplicated; order is not significant |
| FR-013 | Compliance "None" is mutually exclusive with other compliance values | TagCardinalityEnforcer — `enforceCardinality()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-009, TC-010 | Adding `'None'` clears all other Compliance values; adding any real compliance value (`PCI`, `HIPAA`, `SOX`) removes `'None'` |
| FR-014 | Tag application is idempotent — no PATCH when current matches desired | TagOperations — `applyTags()` | `src/vro/actions/tags/TagOperations.js` | TC-011 | When current VM tags match the desired tags exactly, `applyTags()` returns `{applied: false}` without making any API calls; idempotency is achieved through read-compare-write |
| FR-015 | Delta computation identifies only changed tag categories | TagCardinalityEnforcer — `computeDelta()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-012 | `computeDelta(currentTags, desiredTags)` returns only the categories that differ between current and desired state; unchanged categories are excluded from the delta |
| FR-016 | PCI + Sandbox tag combination rejected as invalid | TagCardinalityEnforcer — `validateTagCombinations()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-013 | `validateTagCombinations()` returns `{valid: false}` with error message referencing DFW-4003 when Compliance includes 'PCI' and Environment is 'Sandbox' |
| FR-017 | HIPAA + Sandbox tag combination rejected as invalid | TagCardinalityEnforcer — `validateTagCombinations()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-014 | `validateTagCombinations()` returns `{valid: false}` with error message when Compliance includes 'HIPAA' and Environment is 'Sandbox' |
| FR-018 | Confidential DataClassification requires a compliance framework | TagCardinalityEnforcer — `validateTagCombinations()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-015 | `validateTagCombinations()` returns `{valid: false}` when DataClassification is 'Confidential' or 'Restricted' and Compliance is `['None']` |
| FR-019 | Tag update preserves unchanged categories using read-compare-write | TagOperations — `updateTags()` | `src/vro/actions/tags/TagOperations.js` | TC-016 | `updateTags()` reads current tags, merges only the specified categories via `enforceCardinality()`, and writes the merged result; categories not mentioned in the update request are unchanged |
| FR-020 | Tag removal removes only specified categories, preserving others | TagOperations — `removeTags()` | `src/vro/actions/tags/TagOperations.js` | TC-017 | `removeTags()` removes only the specified categories from the VM's tag set; all other categories remain intact; uses read-compare-write pattern to avoid race conditions |

### Design Notes — Tag Cardinality

The `TagCardinalityEnforcer` uses a `CATEGORY_CONFIG` constant that defines the cardinality type for each category:

- **Single-value categories**: Application, Tier, Environment, DataClassification, CostCenter — setting a new value in any of these categories replaces the existing value entirely.
- **Multi-value categories**: Compliance — new values are merged with existing values. The `'None'` value has special exclusivity logic: it cannot coexist with real compliance values.

Three conflict rules are defined:
1. PCI compliance is not permitted in Sandbox environments
2. HIPAA compliance is not permitted in Sandbox environments
3. Confidential or Restricted DataClassification requires at least one real compliance framework (not `'None'`)

The `computeDelta()` method enables minimal API calls by identifying only the categories that actually need to change, avoiding unnecessary PATCH operations on unchanged tags.

---

## 5. FR-021 through FR-030: Pipeline Orchestration and Configuration

These requirements define the correlation ID system, the lifecycle orchestration pattern (Template Method), and the configuration management subsystem.

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-021 | Correlation ID generated in format RITM-{number}-{timestamp} | CorrelationContext — `create()` | `src/vro/actions/shared/CorrelationContext.js` | TC-018 | `CorrelationContext.create('12345')` returns a string matching the pattern `/^RITM-12345-\d+$/`; the timestamp component is the epoch millisecond value at creation time |
| FR-022 | Correlation ID propagated in HTTP headers as X-Correlation-ID | CorrelationContext — `getHeaders()` | `src/vro/actions/shared/CorrelationContext.js` | TC-019 | `getHeaders()` returns `{'X-Correlation-ID': correlationId}` where `correlationId` is the currently active correlation ID |
| FR-023 | Day 0 provisioning orchestrates full lifecycle: tags, groups, DFW, callback | Day0Orchestrator — `prepare()`, `execute()`, `verify()` | `src/vro/actions/lifecycle/Day0Orchestrator.js` | TC-045 | Day 0 flow executes in sequence: provisionVM → waitForVMTools (60 attempts, 5s) → applyTags → waitForPropagation (30 attempts, 10s) → verifyGroupMembership → validateDFW; success callback sent to ServiceNow |
| FR-024 | Day 2 update orchestrates tag delta, group impact analysis, and DFW re-verification | Day2Orchestrator — `prepare()`, `execute()`, `verify()` | `src/vro/actions/lifecycle/Day2Orchestrator.js` | TC-046 | Day 2 flow: getCurrentTags → detectDrift → predictGroupChanges → applyTagDeltas → waitForPropagation → verifyGroups → validateDFW; on failure, saga compensation rolls back applied tag changes |
| FR-025 | Day N decommission orchestrates tag removal, group cleanup, dependency check, and VM deprovision | DayNOrchestrator — `prepare()`, `execute()`, `verify()` | `src/vro/actions/lifecycle/DayNOrchestrator.js` | TC-045 (extended) | Day N flow: getCurrentTags → getGroupMemberships → checkDependencies (HALT if found) → checkOrphanedRules → removeTags → verifyGroupRemoval (20 attempts) → verifyCleanup → deprovisionVM → updateCMDB |
| FR-026 | ConfigLoader resolves site-specific endpoints for NDCNG and TULNG | ConfigLoader — `getEndpointsForSite()` | `src/vro/actions/shared/ConfigLoader.js` | TC-020 | `getEndpointsForSite('NDCNG')` returns `{vcenterUrl, nsxUrl, nsxGlobalUrl}` with valid NDCNG-specific URLs; same for `'TULNG'` returning TULNG-specific URLs |
| FR-027 | ConfigLoader rejects invalid site codes with DFW-4004 | ConfigLoader — `getEndpointsForSite()` | `src/vro/actions/shared/ConfigLoader.js` | TC-021 | `getEndpointsForSite('INVALID')` throws an error with code `'DFW-4004'`; only `'NDCNG'` and `'TULNG'` are accepted as valid site codes |
| FR-028 | ConfigLoader constructor overrides take precedence over defaults | ConfigLoader — constructor | `src/vro/actions/shared/ConfigLoader.js` | TC-022 | When a ConfigLoader is constructed with `{retry: {maxRetries: 5}}`, `config.get('retry.maxRetries')` returns `5` instead of the default `3` |
| FR-029 | LifecycleOrchestrator base class enforces Template Method pattern | LifecycleOrchestrator — `run()` | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | TC-045, TC-046 | `run()` calls `validate()` → `resolveEndpoints()` → `prepare()` → `execute()` → `verify()` → `callback()` in fixed sequence; subclasses (Day0, Day2, DayN) override `prepare()`, `execute()`, and `verify()` |
| FR-030 | LifecycleOrchestrator factory method creates the correct subclass for each request type | LifecycleOrchestrator — `create()` | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | TC-045, TC-046 | `LifecycleOrchestrator.create('day0-provision')` returns a Day0Orchestrator; `create('day2-update')` returns Day2Orchestrator; `create('dayn-decommission')` returns DayNOrchestrator; invalid type throws DFW-4001 |

### Design Notes — Orchestration Architecture

The `LifecycleOrchestrator` base class implements the Template Method pattern, defining the invariant pipeline skeleton in `run()`:

```
validate → resolveEndpoints → prepare → execute → verify → callback
```

The three subclasses (Day0, Day2, DayN) override only `prepare()`, `execute()`, and `verify()` to provide operation-specific behavior. The base class handles:

- Input validation against JSON Schema
- Site endpoint resolution via ConfigLoader
- Error handling via `_handleFailure()` which triggers saga compensation, DLQ insertion, and error callback
- Correlation ID initialization

The factory method `LifecycleOrchestrator.create(requestType)` encapsulates the subclass selection logic, ensuring that the caller does not need to know which concrete class to instantiate.

Configuration is managed through the `ConfigLoader` class, which supports:
- Per-site endpoint resolution (`NDCNG` and `TULNG`)
- Vault-referenced credentials (`{{vault:secret/...}}`)
- Constructor overrides for testing and environment-specific settings
- Nested property access via dot-notation paths

---

## 6. FR-031 through FR-040: DFW Policy Validation and Conflict Detection

These requirements define the DFW policy verification and rule conflict analysis capabilities that ensure correct firewall coverage after tag operations.

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-031 | DFW coverage validation queries NSX realized-state API | DFWPolicyValidator — `validateCoverage()` | `src/vro/actions/dfw/DFWPolicyValidator.js` | TC-023, TC-024 | `validateCoverage(vmId, site)` calls NSX realized-state API endpoint and returns coverage status based on response |
| FR-032 | DFW coverage returns true when VM has active (non-disabled) rules | DFWPolicyValidator — `validateCoverage()` | `src/vro/actions/dfw/DFWPolicyValidator.js` | TC-023 | When the NSX API returns a non-empty array of rules with at least one non-disabled rule, `validateCoverage()` returns `{covered: true, ruleCount: N}` |
| FR-033 | DFW coverage returns false when VM has no rules | DFWPolicyValidator — `validateCoverage()` | `src/vro/actions/dfw/DFWPolicyValidator.js` | TC-024 | When the NSX API returns an empty array of rules, `validateCoverage()` returns `{covered: false}` with error code `DFW-7006` |
| FR-034 | Orphaned rules detected for groups with expressions but zero members | DFWPolicyValidator — `checkOrphanedRules()` | `src/vro/actions/dfw/DFWPolicyValidator.js` | TC-025 | When a security group has membership expressions (tag criteria) but zero realized members, `checkOrphanedRules()` throws error `DFW-7007` with the orphaned group details |
| FR-035 | Shadowed rules detected when higher-priority rule covers same scope | RuleConflictDetector — `detectShadowed()` | `src/vro/actions/dfw/RuleConflictDetector.js` | TC-026 | `detectShadowed()` identifies pairs of rules where a higher-priority rule with a broader scope (superset of source/destination groups) renders a lower-priority rule ineffective |
| FR-036 | Contradictory rules detected when same-scope rules have opposing actions | RuleConflictDetector — `detectContradictory()` | `src/vro/actions/dfw/RuleConflictDetector.js` | TC-027 | `detectContradictory()` identifies pairs of rules that match the same traffic (same source, destination, services) but have different actions (ALLOW vs DROP/REJECT) |
| FR-037 | Duplicate rules detected when same-scope rules have identical actions | RuleConflictDetector — `detectDuplicates()` | `src/vro/actions/dfw/RuleConflictDetector.js` | TC-028 | `detectDuplicates()` identifies pairs of rules that match the same traffic and have the same action, indicating unnecessary redundancy |
| FR-038 | Unified conflict analysis returns combined summary with hasIssues flag | RuleConflictDetector — `analyze()` | `src/vro/actions/dfw/RuleConflictDetector.js` | TC-050 | `analyze(proposedRules, existingRules)` returns `{conflicts: [...], shadows: [...], duplicates: [...], hasIssues: boolean}` where `hasIssues` is `true` when any category is non-empty |
| FR-039 | DFW policy reconciliation compares YAML definitions to NSX realized state | PolicyDeployer + DFWPolicyValidator | `src/vro/actions/dfw/DFWPolicyValidator.js`, `policies/dfw-rules/*.yaml` | TC-048 | Reconciliation workflow reads YAML policy files, compares them to the current NSX realized state, identifies discrepancies, and optionally applies corrections |
| FR-040 | Rule conflict detection operates on pure in-memory rule arrays with no API calls | RuleConflictDetector — all methods | `src/vro/actions/dfw/RuleConflictDetector.js` | TC-026, TC-027, TC-028, TC-050 | All `detectShadowed()`, `detectContradictory()`, `detectDuplicates()`, and `analyze()` methods accept rule arrays as input parameters and perform no external API calls; they are pure functions suitable for testing without mocks |

### Design Notes — Rule Conflict Detection

The `RuleConflictDetector` class is deliberately designed as a pure-logic analyzer with no constructor dependencies. This makes it trivially testable and reusable across different contexts (pre-deployment validation, drift detection, audit reporting).

The `analyze()` method is the primary entry point. It combines proposed and existing rules into a single array, then runs all three detection methods:

1. **`detectShadowed()`** — Identifies rules that are completely covered by a higher-priority rule. A shadow occurs when Rule A has a broader or equal scope (source groups, destination groups, services) and higher priority than Rule B.

2. **`detectContradictory()`** — Identifies rules with the same scope but opposing actions (ALLOW vs DROP). These are configuration errors that lead to unpredictable behavior depending on rule evaluation order.

3. **`detectDuplicates()`** — Identifies rules with identical scope and action, which waste policy table entries and complicate auditing.

---

## 7. FR-041 through FR-050: Error Handling, Retry, and Circuit Breaker

These requirements define the resilience mechanisms that protect the pipeline from transient failures and cascading outages.

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-041 | ErrorFactory creates structured errors with DFW error codes and context | ErrorFactory — `createError()` | `src/vro/actions/shared/ErrorFactory.js` | TC-029 | `ErrorFactory.createError('DFW-3003', message, context)` produces a `DfwError` instance with `code`, `message`, and `context` properties; error extends native `Error` for stack trace support |
| FR-042 | RetryHandler retries operations on 5xx HTTP errors with exponential backoff | RetryHandler — `execute()` | `src/vro/actions/shared/RetryHandler.js` | TC-030, TC-031 | For HTTP 5xx errors, the wrapped function is called up to `maxRetries + 1` times (1 initial + 3 retries by default) with intervals [5s, 15s, 45s]; for 4xx errors, no retry is attempted |
| FR-043 | Custom retry strategy can override default backoff intervals | RetryHandler — `execute()` with `strategy` parameter | `src/vro/actions/shared/RetryHandler.js` | TC-032 | When a custom strategy object with `getDelay(attempt)` method is provided, the strategy's `getDelay()` is called for each retry attempt instead of using the default intervals array |
| FR-044 | Circuit breaker starts in CLOSED state allowing all calls | CircuitBreaker — constructor | `src/vro/actions/shared/CircuitBreaker.js` | TC-033 | A newly instantiated CircuitBreaker has `getState()` returning `'CLOSED'`; all calls to `execute()` are forwarded to the wrapped function |
| FR-045 | Circuit breaker transitions to OPEN after failure threshold exceeded | CircuitBreaker — `execute()` failure tracking | `src/vro/actions/shared/CircuitBreaker.js` | TC-034 | After 5 failures (default `failureThreshold`) within the sliding window (default 300s), `getState()` returns `'OPEN'`; transition is logged as a warning |
| FR-046 | Circuit breaker rejects all calls in OPEN state with DFW-6004 | CircuitBreaker — `execute()` in OPEN state | `src/vro/actions/shared/CircuitBreaker.js` | TC-035 | When in OPEN state, `execute()` throws an error with code `'DFW-6004'` without invoking the wrapped function; the error message identifies the tripped endpoint |
| FR-047 | Circuit breaker transitions to HALF_OPEN after reset timeout elapses | CircuitBreaker — time-based transition | `src/vro/actions/shared/CircuitBreaker.js` | TC-036 | After the `resetTimeout` (default 60s) elapses since the OPEN transition, the next call to `getState()` or `execute()` transitions the breaker to `'HALF_OPEN'`; a single probe call is permitted |
| FR-048 | Successful probe call in HALF_OPEN resets breaker to CLOSED | CircuitBreaker — `execute()` in HALF_OPEN state | `src/vro/actions/shared/CircuitBreaker.js` | TC-037 | When a call succeeds in HALF_OPEN state, the breaker transitions to `'CLOSED'`, clearing all failure counters and restoring normal operation |
| FR-049 | Saga records completed steps in execution order | SagaCoordinator — `recordStep()` + `getJournal()` | `src/vro/actions/lifecycle/SagaCoordinator.js` | TC-038 | After recording steps A, B, C via `recordStep()`, `getJournal()` returns `[A, B, C]` in the order they were recorded |
| FR-050 | Saga compensates steps in reverse (LIFO) order, continuing on individual failure | SagaCoordinator — `compensate()` | `src/vro/actions/lifecycle/SagaCoordinator.js` | TC-039, TC-040 | `compensate()` invokes compensation functions in reverse order (C, B, A); if B's compensation throws, A's compensation is still invoked; result includes `{compensated: N, failed: M, errors: [...]}` |

### Design Notes — Resilience Patterns

**Circuit Breaker State Machine:**

The circuit breaker implements a three-state machine per endpoint:

```
CLOSED --[threshold failures]--> OPEN --[resetTimeout]--> HALF_OPEN
                                  ^                          |
                                  |--[probe fails]-----------|

HALF_OPEN --[probe succeeds]--> CLOSED
```

Per-endpoint state is stored in a module-level `Map`, providing cluster-wide visibility in the vRO production environment through shared Configuration Elements. Default configuration:
- `failureThreshold`: 5 failures
- `resetTimeout`: 60,000 ms (60 seconds)
- `windowSize`: 300,000 ms (5 minutes sliding window)

The `getStats()` method exposes statistics (name, state, totalSuccesses, totalFailures, recentFailures, thresholds) for dashboard consumption.

**Saga Compensation:**

The `SagaCoordinator` implements the saga pattern for distributed transaction management. Each pipeline step is recorded with a forward action and a compensating action. On failure, compensation is executed in LIFO (Last In, First Out) order to reverse completed steps. The compensation is best-effort: if an individual compensation fails, the remaining compensations still execute. The result object tracks `compensated`, `failed`, and `errors` counts.

**Retry with Exponential Backoff:**

The `RetryHandler` uses configurable intervals (default `[5000, 15000, 45000]` ms) and a `shouldRetry` predicate that returns `true` for HTTP 5xx errors and `false` for 4xx errors. The final error from retry exhaustion is enriched with `retryCount` and `operationName` properties for observability.

---

## 8. FR-051 through FR-060: Logging, Observability, and Compliance

These requirements define the structured logging system that provides the foundation for monitoring, alerting, audit compliance, and operational troubleshooting.

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-051 | Logger produces valid single-line JSON output | Logger — all log methods | `src/vro/actions/shared/Logger.js` | TC-041 | Every log entry produced by `info()`, `warn()`, `error()`, `debug()` is a single-line string that successfully parses with `JSON.parse()` |
| FR-052 | Log entries include timestamp, level, correlationId, step, message, and metadata | Logger — log entry structure | `src/vro/actions/shared/Logger.js` | TC-041 | Each JSON log entry contains all required fields: `timestamp` (ISO 8601), `level` (DEBUG/INFO/WARN/ERROR), `correlationId` (from CorrelationContext), `step` (pipeline step name), `message` (human-readable), and `metadata` (contextual object) |
| FR-053 | Logger respects minimum level threshold, suppressing lower-priority messages | Logger — level filtering | `src/vro/actions/shared/Logger.js` | TC-042 | When `minLevel` is set to `'INFO'`, calls to `debug()` produce no output; calls to `info()`, `warn()`, `error()` produce output; level hierarchy is DEBUG < INFO < WARN < ERROR |
| FR-054 | Logger enriches Error objects in metadata with errorMessage and stack properties | Logger — error serialization | `src/vro/actions/shared/Logger.js` | TC-043 | When `error()` is called with an `Error` instance in metadata, the output JSON contains `errorMessage` (from `error.message`) and `stack` (from `error.stack`) as top-level metadata properties |
| FR-055 | Logger handles circular references in metadata without throwing | Logger — safe serialization | `src/vro/actions/shared/Logger.js` | TC-044 | When metadata contains a circular reference (e.g., `obj.self = obj`), `JSON.stringify` does not throw; circular references are replaced with a placeholder string such as `'[Circular]'` |
| FR-056 | All pipeline operations are logged with correlation ID for end-to-end tracing | CorrelationContext + Logger integration | `src/vro/actions/shared/CorrelationContext.js`, `src/vro/actions/shared/Logger.js` | TC-018, TC-041 | Every log entry produced during a pipeline execution includes the `correlationId` field with the RITM-derived correlation ID, enabling Splunk queries to reconstruct the full execution trace |
| FR-057 | ServiceNow callback payloads contain success or failure details with correlation ID | SnowPayloadAdapter + LifecycleOrchestrator | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | TC-045, TC-046 | Success callbacks contain `{status: 'success', correlationId, appliedTags, groupMemberships, activeDFWPolicies}`; failure callbacks contain `{status: 'failure', correlationId, errorCode, errorCategory, failedStep, compensatingActionTaken}` |
| FR-058 | Error callback includes compensation result when saga was triggered | LifecycleOrchestrator — `_handleFailure()` | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | TC-046 | When a pipeline failure triggers saga compensation, the error callback to ServiceNow includes `compensatingActionTaken: true` and the `compensationResult` object with `{compensated, failed, errors}` |
| FR-059 | Failed operations are placed in Dead Letter Queue after retry exhaustion | LifecycleOrchestrator — `_handleFailure()` + DLQ | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | TC-046 (extended) | When all retries are exhausted and saga compensation completes, the original operation with its full context (correlationId, input payload, completedSteps, error, compensationResult) is stored in the DLQ for manual investigation |
| FR-060 | DLQ entries contain sufficient context for manual reprocessing | DeadLetterQueue | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | TC-046 (extended) | Each DLQ entry contains: `id` (unique), `correlationId`, `operation` (day0/day2/dayn), `vmId`, `site`, `error` (full error object), `completedSteps`, `compensationResult`, `timestamp`, `retryCount`, and the original input payload |

### Design Notes — Logging and Observability

The Logger module produces structured JSON that is consumed by Splunk (or ELK) for centralized log management. Key design decisions:

1. **Single-line JSON**: Each log entry is a single line, enabling reliable parsing by log aggregation agents without multi-line collation issues.

2. **Correlation ID threading**: The `CorrelationContext.getCurrent()` value is automatically included in every log entry, enabling reconstruction of the complete execution timeline for any pipeline run via a single Splunk query.

3. **Error enrichment**: When an `Error` object is passed as metadata, the Logger extracts `message` and `stack` into dedicated fields rather than relying on JSON serialization of the Error object (which loses most properties by default).

4. **Circular reference safety**: A custom replacer function for `JSON.stringify` detects and handles circular references, preventing runtime exceptions from poorly-constructed metadata objects.

5. **Level filtering**: Configurable minimum level allows production environments to suppress DEBUG messages while preserving them for development and troubleshooting.

---

## 9. FR-061 through FR-065: Policy-as-Code and Schema Validation

These requirements define the policy-as-code framework where DFW rules, security groups, and tag categories are defined as YAML files under version control, validated by JSON Schema, and deployed through CI/CD.

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-061 | DFW policies defined as YAML files with metadata, rules, and compliance tags | YAML policy files | `policies/dfw-rules/*.yaml` | TC-048 | Each YAML policy file contains `policy_name`, `description`, `compliance_tags`, `brd_reference`, `review_cadence_days`, and a `rules` array with source/destination groups, services, and actions |
| FR-062 | Security groups defined as YAML files with tag-based membership criteria | YAML security group files | `policies/security-groups/*.yaml` | TC-048 (extended) | Each security group YAML file defines group name, membership criteria (tag expressions), and the associated NSX group path |
| FR-063 | Tag categories defined as YAML with cardinality, allowed values, and governance metadata | YAML tag category file | `policies/tag-categories/categories.yaml` | TC-048 (extended) | The `categories.yaml` file defines all six tag categories with `category_name`, `cardinality`, `required`, `nsx_scope`, `allowed_values`, `validation` patterns, and `governance` metadata |
| FR-064 | YAML policies validated against JSON Schema in CI pipeline | PayloadValidator + CI | `schemas/snow-vro-payload.schema.json`, `.github/workflows/ci.yml` | TC-048 | The CI pipeline runs `npm run validate-policies` which validates all YAML files in `policies/` against their corresponding JSON Schema; schema violations fail the CI build |
| FR-065 | ServiceNow-to-vRO payload validated against JSON Schema at pipeline entry | PayloadValidator | `schemas/snow-vro-payload.schema.json` | TC-049 | The `LifecycleOrchestrator.validate()` method validates the incoming ServiceNow payload against `snow-vro-payload.schema.json` using AJV; invalid payloads are rejected with DFW-4001 error before any API calls are made |

### Design Notes — Policy-as-Code

The policy-as-code approach stores all security policy definitions in version-controlled YAML files organized by type:

```
policies/
  dfw-rules/
    application-template.yaml       # Three-tier micro-segmentation template
    environment-zone-isolation.yaml  # Cross-environment isolation rules
    infrastructure-shared-services.yaml  # Shared service access rules
    emergency-quarantine.yaml        # Emergency quarantine DROP-all policy
  security-groups/
    application-groups.yaml          # Per-application tag-based groups
    aggregate-groups.yaml            # Cross-application aggregate groups
  tag-categories/
    categories.yaml                  # Enterprise tag dictionary definition
```

Each YAML policy file includes compliance metadata:
- `compliance_tags`: Array of applicable compliance frameworks (PCI, SOX, HIPAA)
- `brd_reference`: Link to the specific BRD section that mandates this policy
- `review_cadence_days`: Days between required policy reviews (default: 90)

JSON Schema validation (using AJV 8.12.x) is applied at two points:
1. **CI pipeline**: `validate-policies` job validates all YAML files on every PR
2. **Runtime**: `LifecycleOrchestrator.validate()` validates incoming ServiceNow payloads against `snow-vro-payload.schema.json`

The `snow-vro-payload.schema.json` schema defines:
- `correlationId` pattern: `^SNOW-REQ-[0-9]{4}-[0-9]{7}$`
- `requestType` enum: `['day0-provision', 'day2-update', 'dayn-decommission']`
- Conditional required fields for Day 0 (all tag assignment fields required)
- `tagAssignment` definition with required `application`, `tier`, `environment`, `compliance`, and `dataClassification`

---

## 10. Cross-Cutting Traceability Summary

The following table provides a high-level summary of the traceability between functional areas, components, and NFRs.

| Functional Area | FR Range | Primary Components | Key NFRs Addressed | Test Cases |
|----------------|----------|-------------------|---------------------|------------|
| ServiceNow Catalog Form | FR-001 — FR-010 | `vmBuildRequest_onLoad.js`, `vmBuildRequest_onChange.js`, `catalogItemValidation.js` | NFR-018 (Input validation), NFR-019 (Conflict detection) | TC-001 — TC-006 |
| Tag Cardinality and Operations | FR-011 — FR-020 | TagCardinalityEnforcer, TagOperations | NFR-005 (10K+ VMs), NFR-006 (50+ values), NFR-014 (Idempotency) | TC-007 — TC-017 |
| Pipeline Orchestration | FR-021 — FR-030 | CorrelationContext, ConfigLoader, LifecycleOrchestrator, Day0/Day2/DayN | NFR-002 (E2E under 5 min), NFR-009 (No SPOF), NFR-016 (Correlation ID) | TC-018 — TC-022, TC-045, TC-046 |
| DFW Policy Validation | FR-031 — FR-040 | DFWPolicyValidator, RuleConflictDetector | NFR-003 (Tag propagation 120s), NFR-022 (Compliance references), NFR-024 (BRD traceability) | TC-023 — TC-028, TC-050 |
| Error Handling and Resilience | FR-041 — FR-050 | ErrorFactory, RetryHandler, CircuitBreaker, SagaCoordinator | NFR-010 (Graceful degradation), NFR-011 (Auto recovery), NFR-028 (Error taxonomy) | TC-029 — TC-040 |
| Logging and Observability | FR-051 — FR-060 | Logger, CorrelationContext, DeadLetterQueue | NFR-020 (RITM audit), NFR-021 (7-year retention), NFR-032 (Structured logging) | TC-041 — TC-044 |
| Policy-as-Code | FR-061 — FR-065 | YAML policies, PayloadValidator, CI pipeline | NFR-023 (Peer review), NFR-046 (JSON Schema), NFR-047 (YAML validation) | TC-048, TC-049 |

### Requirement Coverage Statistics

| Metric | Count |
|--------|-------|
| Total Functional Requirements | 65 |
| Requirements with identified design component | 65 (100%) |
| Requirements with source file reference | 65 (100%) |
| Requirements with test case reference | 65 (100%) |
| Requirements with acceptance criteria | 65 (100%) |
| Unique test cases referenced | 50 |
| Unique source files referenced | 18 |

---

## 11. FR-066 through FR-073: CMDB Validation, Rule Lifecycle, Migration Tagging, and Packaging

These requirements define the extended capabilities for CMDB data quality validation, DFW rule lifecycle management, migration-event-driven bulk tagging, periodic rule review, CMDB-driven event synchronization, and VRA package deployment.

### 11.1 5-Tag Security Taxonomy

The pipeline adopts a 5-tag mandatory security taxonomy aligned with the client security architecture:

| Tag Category | Cardinality | NSX Scope | Governance |
|-------------|------------|-----------|------------|
| Region | Single | Region | Mandatory -- geographic site identifier (e.g., NDCNG, TULNG) |
| SecurityZone | Single | SecurityZone | Mandatory -- network security zone (e.g., DMZ, Internal, Restricted) |
| Environment | Single | Environment | Mandatory -- deployment lifecycle stage |
| AppCI | Single | AppCI | Mandatory -- CMDB application CI reference |
| SystemRole | Single | SystemRole | Mandatory -- workload function (e.g., WebServer, AppServer, Database) |

Optional tags for governance and financial tracking:

| Tag Category | Cardinality | NSX Scope | Governance |
|-------------|------------|-----------|------------|
| Compliance | Multi | Compliance | Optional -- regulatory frameworks (PCI, HIPAA, SOX) |
| DataClassification | Single | DataClassification | Optional -- data sensitivity level |
| CostCenter | Single | CostCenter | Optional -- financial chargeback identifier |

### 11.2 Requirement Traceability

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-066 | CMDBValidator extracts VM inventory from ServiceNow CMDB, validates 5-tag completeness per VM, and generates gap reports with remediation tasks | CMDBValidator -- `extractVMInventory()`, `validateCoverage()`, `validateQuality()`, `generateGapReport()` | `src/vro/actions/cmdb/CMDBValidator.js` | TC-066 | `generateGapReport(site)` returns a structured report listing VMs missing one or more of the 5 mandatory tags; remediation tasks are created in ServiceNow for each gap; report includes KPI metrics (coverage percentage, quality score) |
| FR-067 | 5-tag security taxonomy enforces Region, SecurityZone, Environment, AppCI, and SystemRole as mandatory tags with optional Compliance, DataClassification, and CostCenter | TagCardinalityEnforcer -- updated `CATEGORY_CONFIG`; CMDBValidator -- `validateCoverage()` | `src/vro/actions/tags/TagCardinalityEnforcer.js`, `src/vro/actions/cmdb/CMDBValidator.js` | TC-067 | All 5 mandatory tags must be present on every managed VM; `validateCoverage()` returns `{complete: false}` when any mandatory tag is missing; optional tags do not trigger validation failures when absent |
| FR-068 | DFW rule lifecycle managed through a full state machine with states REQUESTED, IMPACT_ANALYZED, APPROVED, MONITOR_MODE, VALIDATED, ENFORCED, CERTIFIED, REVIEW_DUE, EXPIRED, ROLLED_BACK | RuleLifecycleManager -- `transitionState()`, `getState()`, `getHistory()` | `src/vro/actions/lifecycle/RuleLifecycleManager.js` | TC-068 | `transitionState(ruleId, newState)` validates transition legality against the state machine; illegal transitions throw DFW-10001; each transition is recorded in the rule audit trail with timestamp, actor, and justification |
| FR-069 | Rule Registry provides a custom ServiceNow table (`x_dfw_rule_registry`) with unique rule IDs in format DFW-R-XXXX, full audit trail, and CRUD operations | RuleRegistry -- `registerRule()`, `getRule()`, `updateRule()`, `searchRules()` | `src/vro/actions/lifecycle/RuleRegistry.js` | TC-069 | `registerRule(ruleDefinition)` creates a new entry with auto-generated ID matching pattern `DFW-R-[0-9]{4}`; `getRule(ruleId)` returns the full rule record including audit history; duplicate rule detection prevents conflicting registrations |
| FR-070 | Migration-event-driven bulk tagging processes Greenzone VM migration manifests in waves, applying tags based on manifest definitions with pre-validation and post-migration verification | MigrationBulkTagger -- `loadManifest()`, `preValidate()`, `executeWave()`, `verifyPostMigration()`, `generateWaveReport()` | `src/vro/actions/lifecycle/MigrationBulkTagger.js` | TC-070 | `loadManifest(manifestPath)` parses a wave-based migration manifest; `preValidate(wave)` validates all VM entries against the tag dictionary and CMDB; `executeWave(waveId)` applies tags to all VMs in the wave with progress tracking; `verifyPostMigration(waveId)` confirms tag persistence after migration |
| FR-071 | Periodic rule review runs scheduled scans against rule expiry dates, sends owner notifications at configurable intervals, escalates unreviewed rules, and auto-expires rules past their certification deadline | RuleReviewScheduler -- `scanForReviewDue()`, `notifyOwners()`, `escalateOverdue()`, `autoExpire()` | `src/vro/actions/lifecycle/RuleReviewScheduler.js` | TC-071 | `scanForReviewDue()` identifies rules within the notification window (default: 30 days before expiry); `notifyOwners()` sends email and ServiceNow notifications to rule owners; `escalateOverdue()` creates escalation incidents for rules past their review deadline; `autoExpire()` transitions rules to EXPIRED state after the grace period |
| FR-072 | CMDB-driven event synchronization triggers Day-2 tag sync when CMDB CI fields change on the `cmdb_ci_vm_instance` table through a business rule | cmdbTagSyncRule -- business rule on `cmdb_ci_vm_instance` | `src/servicenow/business-rules/cmdbTagSyncRule.js` | TC-072 | When a monitored field (environment, application, tier) changes on a `cmdb_ci_vm_instance` record, the business rule detects the change, assembles a Day-2 tag update payload, and triggers the vRO DFW-Day2-TagUpdate workflow via REST API; the tag sync is logged with correlation ID in the CI work notes |
| FR-073 | VRA package deployment model provides a structured vRO package at `package/` for import into VMware Aria Automation, containing all actions, workflows, configuration elements, and resource elements | VRA package structure at `package/com.dfw.automation/` | `package/com.dfw.automation/` | TC-073 | The `package/com.dfw.automation/` directory contains a complete vRO package structure with `actions/`, `workflows/`, `config-elements/`, and `resource-elements/` subdirectories; the package can be imported into Aria Automation Orchestrator via the package import wizard or `vro-cli package import` |

### Design Notes -- CMDB Validation and Rule Lifecycle

**CMDBValidator** operates as a scheduled validation engine that runs against the ServiceNow CMDB to ensure all managed VMs have complete 5-tag coverage. The validator extracts the full VM inventory for a given site, cross-references each VM against the mandatory tag taxonomy, and produces a structured gap report. Each gap is categorized by severity (critical for missing mandatory tags, warning for missing optional tags) and generates a remediation task in ServiceNow for follow-up.

**RuleLifecycleManager** implements a formal state machine governing the lifecycle of every DFW rule from initial request through enforcement to periodic review and eventual expiry. The state machine enforces transition rules -- for example, a rule cannot move from REQUESTED directly to ENFORCED without passing through IMPACT_ANALYZED and APPROVED. Each state transition is recorded in the audit trail with the actor identity, timestamp, and justification, providing complete traceability for compliance audits.

**RuleRegistry** provides the persistence layer for rule tracking through the `x_dfw_rule_registry` custom table in ServiceNow. Each rule receives a unique identifier (DFW-R-XXXX format) and carries metadata including owner, creation date, last review date, expiry date, associated DFW policy references, and the complete state transition history.

**MigrationBulkTagger** supports large-scale VM migration events (Greenzone migration waves) where hundreds of VMs need consistent tag application during migration from legacy infrastructure. The module processes wave-based manifests, validates each VM against the tag dictionary and CMDB before tagging, executes tag application with progress tracking, and verifies tag persistence after migration completes.

**RuleReviewScheduler** enforces periodic rule certification by scanning the rule registry for rules approaching their review deadline. The scheduler sends notifications to rule owners, escalates overdue reviews through ServiceNow incident management, and automatically expires rules that are not re-certified within the configured grace period.

**cmdbTagSyncRule** is a ServiceNow business rule that fires on updates to `cmdb_ci_vm_instance` records. When monitored CMDB fields change, the rule assembles a Day-2 tag update payload and triggers the vRO workflow to synchronize NSX tags with the updated CMDB data, ensuring CMDB remains the authoritative source for tag values.

---

## 12. Cross-Cutting Traceability Summary (Extended)

| Functional Area | FR Range | Primary Components | Key NFRs Addressed | Test Cases |
|----------------|----------|-------------------|---------------------|------------|
| ServiceNow Catalog Form | FR-001 -- FR-010 | `vmBuildRequest_onLoad.js`, `vmBuildRequest_onChange.js`, `catalogItemValidation.js` | NFR-018 (Input validation), NFR-019 (Conflict detection) | TC-001 -- TC-006 |
| Tag Cardinality and Operations | FR-011 -- FR-020 | TagCardinalityEnforcer, TagOperations | NFR-005 (10K+ VMs), NFR-006 (50+ values), NFR-014 (Idempotency) | TC-007 -- TC-017 |
| Pipeline Orchestration | FR-021 -- FR-030 | CorrelationContext, ConfigLoader, LifecycleOrchestrator, Day0/Day2/DayN | NFR-002 (E2E under 5 min), NFR-009 (No SPOF), NFR-016 (Correlation ID) | TC-018 -- TC-022, TC-045, TC-046 |
| DFW Policy Validation | FR-031 -- FR-040 | DFWPolicyValidator, RuleConflictDetector | NFR-003 (Tag propagation 120s), NFR-022 (Compliance references), NFR-024 (BRD traceability) | TC-023 -- TC-028, TC-050 |
| Error Handling and Resilience | FR-041 -- FR-050 | ErrorFactory, RetryHandler, CircuitBreaker, SagaCoordinator | NFR-010 (Graceful degradation), NFR-011 (Auto recovery), NFR-028 (Error taxonomy) | TC-029 -- TC-040 |
| Logging and Observability | FR-051 -- FR-060 | Logger, CorrelationContext, DeadLetterQueue | NFR-020 (RITM audit), NFR-021 (7-year retention), NFR-032 (Structured logging) | TC-041 -- TC-044 |
| Policy-as-Code | FR-061 -- FR-065 | YAML policies, PayloadValidator, CI pipeline | NFR-023 (Peer review), NFR-046 (JSON Schema), NFR-047 (YAML validation) | TC-048, TC-049 |
| CMDB Validation and Rule Lifecycle | FR-066 -- FR-073 | CMDBValidator, RuleLifecycleManager, RuleRegistry, RuleReviewScheduler, MigrationBulkTagger, cmdbTagSyncRule | NFR-020 (Audit), NFR-022 (Compliance), NFR-024 (Traceability) | TC-066 -- TC-073 |

### Requirement Coverage Statistics (Updated)

| Metric | Count |
|--------|-------|
| Total Functional Requirements | 73 |
| Requirements with identified design component | 73 (100%) |
| Requirements with source file reference | 73 (100%) |
| Requirements with test case reference | 73 (100%) |
| Requirements with acceptance criteria | 73 (100%) |
| Unique test cases referenced | 58 |
| Unique source files referenced | 24 |

---

*End of Functional Requirements Design*
