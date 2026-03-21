# Functional Requirements Design (FRD)

## NSX DFW Automation Pipeline

**Version:** 1.0
**Date:** 2026-03-21
**Author:** Enterprise Infrastructure & Cloud Security

---

## Traceability Matrix

The following table maps each functional requirement to its implementing design component, source file, test case, and acceptance criteria. Requirements are organized by functional area and reference the BRD requirement IDs FR-001 through FR-065.

---

### FR-001 through FR-010: ServiceNow Catalog Form Enhancements

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-001 | Catalog form shall display tag categories as dropdown fields populated from the Tag Dictionary | ServiceNow Client Script | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-001 | All six tag categories (Application, Tier, Environment, DataClassification, Compliance, CostCenter) render as form fields on load |
| FR-002 | DataClassification field shall default to "Internal" when the form loads | ServiceNow Client Script — `_setDefaultFieldValues()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-002 | DataClassification field value is "Internal" after onLoad completes when no prior value exists |
| FR-003 | Compliance field shall default to "None" when the form loads | ServiceNow Client Script — `_setDefaultFieldValues()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-003 | Compliance field value is "None" after onLoad completes when no prior value exists |
| FR-004 | CostCenter field shall be auto-populated from the user's department record | ServiceNow Client Script — `_populateCostCenter()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-004 | CostCenter is populated via GlideAjax lookup and set to read-only on success |
| FR-005 | CostCenter field shall fall back to user preference if department lookup fails | ServiceNow Client Script — `_populateCostCenter()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-005 | CostCenter populated from g_user.getPreference when available, set read-only |
| FR-006 | Application, Tier, Environment, DataClassification fields shall be mandatory | ServiceNow Client Script — `_initializeFormState()` | `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js` | TC-006 | All four fields have mandatory flag set to true on form load |
| FR-007 | Compliance field shall be conditionally mandatory based on Tier selection | ServiceNow Client Script — onChange handler | `src/servicenow/catalog/client-scripts/vmBuildRequest_onChange.js` | TC-007 | Compliance becomes mandatory when Tier is "Web" or "App" in Production |
| FR-008 | Production environment selection shall display a warning banner | ServiceNow Client Script — onChange handler | `src/servicenow/catalog/client-scripts/vmBuildRequest_onChange.js` | TC-008 | Production warning banner element is shown when Environment = Production |
| FR-009 | Form shall validate tag combinations before submission | ServiceNow Business Rule / Client Script | `src/servicenow/catalog/client-scripts/vmBuildRequest_onSubmit.js` | TC-009 | PCI + Sandbox combination is rejected with user-facing error message |
| FR-010 | Form shall generate a JSON payload with RITM, tags, VM identifier, and site code | ServiceNow REST Message | ServiceNow REST Message configuration | TC-010 | Payload contains all required fields and is valid JSON |

---

### FR-011 through FR-020: Tag Management and Cardinality

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-011 | Tag categories shall enforce single-value cardinality for Application, Tier, Environment, DataClassification, CostCenter | TagCardinalityEnforcer — `enforceCardinality()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-011 | Applying a new single-value tag replaces the existing value for that category |
| FR-012 | Compliance category shall enforce multi-value cardinality allowing multiple simultaneous values | TagCardinalityEnforcer — `_mergeMultiValue()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-012 | Multiple Compliance values (e.g., PCI + HIPAA) coexist after merge |
| FR-013 | Compliance value "None" shall be mutually exclusive with other compliance values | TagCardinalityEnforcer — `_mergeMultiValue()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-013 | Setting "None" removes all other compliance values; adding a real value removes "None" |
| FR-014 | Tag operations shall follow idempotent read-compare-write pattern | TagOperations — `applyTags()` | `src/vro/actions/tags/TagOperations.js` | TC-014 | Calling applyTags twice with same desired state produces no second PATCH call |
| FR-015 | Tag delta computation shall identify minimal add/remove operations | TagCardinalityEnforcer — `computeDelta()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-015 | Delta contains only changed tags, not the full tag set |
| FR-016 | PCI compliance shall be rejected in Sandbox environments | TagCardinalityEnforcer — `validateTagCombinations()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-016 | Validation returns {valid: false} with PCI/Sandbox conflict error |
| FR-017 | HIPAA compliance shall be rejected in Sandbox environments | TagCardinalityEnforcer — `validateTagCombinations()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-017 | Validation returns {valid: false} with HIPAA/Sandbox conflict error |
| FR-018 | Confidential data classification shall require a compliance tag other than "None" | TagCardinalityEnforcer — `validateTagCombinations()` | `src/vro/actions/tags/TagCardinalityEnforcer.js` | TC-018 | Validation returns {valid: false} when DataClassification=Confidential and Compliance=[None] |
| FR-019 | Tag update operations shall preserve unchanged categories | TagOperations — `updateTags()` | `src/vro/actions/tags/TagOperations.js` | TC-019 | Updating Application tag preserves existing Tier, Environment, etc. |
| FR-020 | Tag removal shall accept a list of categories to remove | TagOperations — `removeTags()` | `src/vro/actions/tags/TagOperations.js` | TC-020 | Only specified categories are removed; others are preserved |

---

### FR-021 through FR-030: vRO Orchestration and Lifecycle

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-021 | Pipeline shall generate a unique correlation ID for each execution | CorrelationContext — `create()` | `src/vro/actions/shared/CorrelationContext.js` | TC-021 | Correlation ID matches format RITM-{number}-{timestamp} |
| FR-022 | Correlation ID shall be propagated in all HTTP request headers | CorrelationContext — `getHeaders()` | `src/vro/actions/shared/CorrelationContext.js` | TC-022 | X-Correlation-ID header present in all outbound REST calls |
| FR-023 | Day 0 provisioning shall apply tags, update groups, and verify DFW coverage | LifecycleOrchestrator — `executeDay0()` | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | TC-023 | All three steps execute in order and saga records each step |
| FR-024 | Day 2 updates shall use read-compare-write for tag modifications | TagOperations — `updateTags()` | `src/vro/actions/tags/TagOperations.js` | TC-024 | Current tags are read before computing delta; only changes are written |
| FR-025 | Day N decommission shall remove all tags and verify DFW rule removal | LifecycleOrchestrator — `executeDayN()` | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | TC-025 | All tags removed; DFW validation confirms no active rules |
| FR-026 | Pipeline shall resolve site-specific endpoints from configuration | ConfigLoader — `getEndpointsForSite()` | `src/vro/actions/shared/ConfigLoader.js` | TC-026 | Correct URLs returned for NDCNG and TULNG site codes |
| FR-027 | Invalid site codes shall produce a DFW-4004 error | ConfigLoader — `getEndpointsForSite()` | `src/vro/actions/shared/ConfigLoader.js` | TC-027 | Error thrown with code DFW-4004 for unknown site values |
| FR-028 | Pipeline shall support configuration overrides at construction time | ConfigLoader constructor | `src/vro/actions/shared/ConfigLoader.js` | TC-028 | Override values take precedence over defaults |
| FR-029 | Pipeline shall send a callback to ServiceNow with operation results | LifecycleOrchestrator — `_sendCallback()` | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | TC-029 | Callback payload includes RITM, status, summary, errors, timestamp |
| FR-030 | Callback failures shall be retried with configurable intervals | RetryHandler wrapping callback | `src/vro/actions/shared/RetryHandler.js` | TC-030 | Failed callbacks retried at [2s, 5s, 10s] intervals |

---

### FR-031 through FR-040: Security Groups and DFW

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-031 | DFW coverage validation shall query the NSX realized-state API | DFWPolicyValidator — `validateCoverage()` | `src/vro/actions/dfw/DFWPolicyValidator.js` | TC-031 | Realized-state endpoint is queried with correct VM ID and site |
| FR-032 | DFW validation shall report covered=true when at least one active rule applies | DFWPolicyValidator — `validateCoverage()` | `src/vro/actions/dfw/DFWPolicyValidator.js` | TC-032 | Returns {covered: true} when API returns non-disabled rules |
| FR-033 | DFW validation shall report covered=false when no active rules apply | DFWPolicyValidator — `validateCoverage()` | `src/vro/actions/dfw/DFWPolicyValidator.js` | TC-033 | Returns {covered: false} when API returns empty or all-disabled rules |
| FR-034 | Orphaned rule detection shall identify groups with rules but no members | DFWPolicyValidator — `checkOrphanedRules()` | `src/vro/actions/dfw/DFWPolicyValidator.js` | TC-034 | Throws DFW-7007 when group has expressions but zero members |
| FR-035 | Rule conflict detection shall identify shadowed rules | RuleConflictDetector — `detectShadowed()` | `src/vro/actions/dfw/RuleConflictDetector.js` | TC-035 | Detects rule shadowed by higher-priority rule with broader scope |
| FR-036 | Rule conflict detection shall identify contradictory rules | RuleConflictDetector — `detectContradictory()` | `src/vro/actions/dfw/RuleConflictDetector.js` | TC-036 | Detects rules with same scope but different actions (ALLOW vs DROP) |
| FR-037 | Rule conflict detection shall identify duplicate rules | RuleConflictDetector — `detectDuplicates()` | `src/vro/actions/dfw/RuleConflictDetector.js` | TC-037 | Detects rules with identical scope and identical actions |
| FR-038 | Unified rule analysis shall combine proposed and existing rules | RuleConflictDetector — `analyze()` | `src/vro/actions/dfw/RuleConflictDetector.js` | TC-038 | analyze() returns {shadows, conflicts, duplicates, hasIssues} |
| FR-039 | DFW policies shall be defined as YAML policy-as-code files | Policy YAML files | `policies/dfw-rules/*.yaml` | TC-039 | YAML files parse successfully and contain required fields |
| FR-040 | YAML policies shall include metadata (owner, BRD reference, compliance tags) | Policy YAML metadata section | `policies/dfw-rules/environment-zone-isolation.yaml` | TC-040 | metadata section contains owner, brd_reference, compliance_tags |

---

### FR-041 through FR-050: Error Handling, Retry, Circuit Breaker

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-041 | Errors shall carry structured DFW error codes (DFW-XXXX format) | ErrorFactory — `create()` | `src/vro/actions/shared/ErrorFactory.js` | TC-041 | Created errors have `code` and `context` properties |
| FR-042 | Transient failures shall be retried with configurable backoff intervals | RetryHandler — `run()` | `src/vro/actions/shared/RetryHandler.js` | TC-042 | HTTP 5xx errors retried; 4xx errors failed immediately |
| FR-043 | Retry handler shall support pluggable retry strategies | RetryHandler — `retryStrategy` option | `src/vro/actions/shared/RetryHandler.js` | TC-043 | Custom strategy's getDelay() called for each retry |
| FR-044 | Circuit breaker shall track per-endpoint failure rates | CircuitBreaker constructor, `_endpointStates` Map | `src/vro/actions/shared/CircuitBreaker.js` | TC-044 | Different endpoints maintain independent state |
| FR-045 | Circuit breaker shall transition to OPEN after threshold failures | CircuitBreaker — `_recordFailure()` | `src/vro/actions/shared/CircuitBreaker.js` | TC-045 | State transitions to OPEN after 5 failures within 5-min window |
| FR-046 | Circuit breaker shall reject calls immediately when OPEN | CircuitBreaker — `execute()` | `src/vro/actions/shared/CircuitBreaker.js` | TC-046 | DFW-6004 error thrown without invoking the wrapped function |
| FR-047 | Circuit breaker shall transition to HALF_OPEN after reset timeout | CircuitBreaker — `execute()`, `getState()` | `src/vro/actions/shared/CircuitBreaker.js` | TC-047 | State becomes HALF_OPEN after 60s in OPEN state |
| FR-048 | Successful HALF_OPEN probe shall reset breaker to CLOSED | CircuitBreaker — `_executeProbe()` | `src/vro/actions/shared/CircuitBreaker.js` | TC-048 | State returns to CLOSED and failure counters reset after probe success |
| FR-049 | Saga coordinator shall record steps with compensating actions | SagaCoordinator — `recordStep()` | `src/vro/actions/lifecycle/SagaCoordinator.js` | TC-049 | Journal contains step entry with stepName, timestamp, and compensatingAction |
| FR-050 | Saga compensation shall execute in LIFO order | SagaCoordinator — `compensate()` | `src/vro/actions/lifecycle/SagaCoordinator.js` | TC-050 | Last recorded step is compensated first |

---

### FR-051 through FR-060: Audit, Compliance, Reporting

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-051 | All operations shall produce structured JSON log entries | Logger — `_emit()` | `src/vro/actions/shared/Logger.js` | TC-051 | Log output is valid single-line JSON with all required fields |
| FR-052 | Log entries shall include correlation ID, timestamp, level, step, and message | Logger — `_emit()` | `src/vro/actions/shared/Logger.js` | TC-052 | All five fields present in every log entry |
| FR-053 | Logger shall support minimum level thresholding | Logger — `_emit()` | `src/vro/actions/shared/Logger.js` | TC-053 | DEBUG messages suppressed when minLevel=INFO |
| FR-054 | Logger shall safely serialize Error objects in metadata | Logger — `_enrichErrorMetadata()` | `src/vro/actions/shared/Logger.js` | TC-054 | Error.message and Error.stack appear in serialized output |
| FR-055 | Logger shall handle circular references in metadata | Logger — `_safeStringify()` | `src/vro/actions/shared/Logger.js` | TC-055 | Circular references replaced with "[Circular]" instead of throwing |
| FR-056 | Circuit breaker shall expose statistics for monitoring dashboards | CircuitBreaker — `getStats()` | `src/vro/actions/shared/CircuitBreaker.js` | TC-056 | Stats include name, state, totalSuccesses, totalFailures, recentFailures |
| FR-057 | DFW policy YAML shall include compliance tags for audit mapping | Policy YAML metadata | `policies/dfw-rules/*.yaml` | TC-057 | compliance_tags array present with valid compliance framework identifiers |
| FR-058 | DFW policy YAML shall include change control reference | Policy YAML metadata | `policies/dfw-rules/*.yaml` | TC-058 | change_control field contains CHG number |
| FR-059 | DFW policy YAML shall include last reviewed date and review cadence | Policy YAML metadata | `policies/dfw-rules/*.yaml` | TC-059 | last_reviewed and review_cadence_days fields present and valid |
| FR-060 | Pipeline shall support drift detection by comparing YAML policies to NSX realized state | DFW reconciliation workflow | `src/vro/actions/dfw/DFWPolicyValidator.js` + policies | TC-060 | Discrepancies between YAML policy and NSX state are detected and reported |

---

### FR-061 through FR-065: Multi-Site, Legacy Onboarding, Policy-as-Code

| FR-ID | Requirement | Design Component | Source File | Test Case | Acceptance Criteria |
|-------|------------|-----------------|-------------|-----------|-------------------|
| FR-061 | Pipeline shall support NDCNG and TULNG sites with independent endpoints | ConfigLoader — `sites` configuration | `src/vro/actions/shared/ConfigLoader.js` | TC-061 | Both sites configured with distinct vCenter, NSX, and Global Manager URLs |
| FR-062 | Pipeline shall support NSX Federation for cross-site policy synchronization | NSX Global Manager integration | ConfigLoader + NSX Adapter | TC-062 | Global Manager endpoint is available and reachable per-site |
| FR-063 | Pipeline shall support legacy workload onboarding through batch tag operations | Batch TagOperations wrapper | `src/vro/actions/tags/TagOperations.js` (batch mode) | TC-063 | Multiple VMs can be tagged in a single batch operation |
| FR-064 | DFW rules shall be version-controlled as YAML files in the policies directory | Repository pattern — policy files | `policies/dfw-rules/*.yaml` | TC-064 | Policy files exist in git, are parseable YAML, and pass schema validation |
| FR-065 | YAML policy changes shall be validated in CI before merge | CI pipeline — schema validation | `.github/workflows/ci.yml` (validate step) | TC-065 | CI job fails when YAML policy contains invalid structure |

---

*End of Functional Requirements Design*
