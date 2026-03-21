# Test Strategy

## NSX DFW Automation Pipeline

**Version:** 1.0
**Date:** 2026-03-21
**Author:** Enterprise Infrastructure & Cloud Security

---

## 1. Test Levels

### 1.1 Unit Testing

Unit tests validate individual classes and functions in isolation. All external dependencies (REST clients, NSX API, vCenter API, ServiceNow) are mocked. Unit tests are fast (< 100ms each), deterministic, and run on every commit.

**Tool:** Jest 29.x
**Location:** `tests/unit/`
**Coverage Targets:** 80% line, 70% branch, 80% function, 80% statement

### 1.2 Integration Testing

Integration tests validate interactions between multiple modules within the pipeline. They use mock HTTP servers to simulate NSX Manager and vCenter API responses, testing the full flow from LifecycleOrchestrator through TagOperations to the mock API. No live infrastructure is required.

**Tool:** Jest 29.x with mock HTTP servers
**Location:** `tests/integration/`

### 1.3 End-to-End (E2E) Testing

E2E tests validate the complete pipeline flow from ServiceNow payload ingestion through vRO orchestration to NSX API interaction. These tests run against a staging environment with real vCenter and NSX Manager instances (non-production).

**Environment:** Staging VCF cluster with dedicated test VMs
**Frequency:** Pre-release validation

### 1.4 Regression Testing

Regression tests ensure that bug fixes and new features do not break existing functionality. The full unit and integration test suites serve as the regression test suite. Any reported bug must have a corresponding regression test added before the fix is merged.

**Tool:** Jest 29.x (full test suite)
**Trigger:** Every PR to main

### 1.5 Failure Injection Testing

Failure injection tests validate the resilience mechanisms (circuit breaker, retry, saga compensation) under adverse conditions. Tests simulate API timeouts, HTTP 5xx responses, network errors, and partial failures to verify correct error handling, compensation, and recovery.

**Tool:** Jest 29.x with mock failures
**Location:** `tests/unit/` (resilience-specific test files)

### 1.6 Disaster Recovery Testing

DR tests validate the cross-site failover capability by simulating NDCNG site unavailability and verifying that the TULNG vRO instance can process requests. These tests are manual, conducted quarterly, and documented in the DR test plan.

**Frequency:** Quarterly
**Environment:** DR test window with coordinated failover

---

## 2. Test Cases

| Test ID | Description | Type | Component | Expected Result | Traceability |
|---------|------------|------|-----------|----------------|--------------|
| TC-001 | Form loads with all six tag category fields rendered | Unit | ServiceNow Client Script | All fields exist in g_form after onLoad | FR-001 |
| TC-002 | DataClassification defaults to "Internal" on form load | Unit | `vmBuildRequest_onLoad.js` | g_form.getValue('data_classification') === 'Internal' | FR-002 |
| TC-003 | Compliance defaults to "None" on form load | Unit | `vmBuildRequest_onLoad.js` | g_form.getValue('compliance') === 'None' | FR-003 |
| TC-004 | CostCenter auto-populated from GlideAjax department lookup | Unit | `vmBuildRequest_onLoad.js` | g_form.setValue('cost_center', answer) called with valid CC | FR-004 |
| TC-005 | CostCenter falls back to user preference | Unit | `vmBuildRequest_onLoad.js` | g_form.setValue called with preference value when GlideAjax returns empty | FR-005 |
| TC-006 | Mandatory fields set on form load | Unit | `vmBuildRequest_onLoad.js` | Application, Tier, Environment, DataClassification set mandatory=true | FR-006 |
| TC-007 | Single-value cardinality replaces existing tag | Unit | TagCardinalityEnforcer | enforceCardinality({App: 'A'}, {App: 'B'}) => {App: 'B'} | FR-011 |
| TC-008 | Multi-value cardinality merges compliance values | Unit | TagCardinalityEnforcer | enforceCardinality({Compliance: ['PCI']}, {Compliance: ['HIPAA']}) => {Compliance: ['PCI','HIPAA']} | FR-012 |
| TC-009 | Compliance "None" clears other values | Unit | TagCardinalityEnforcer | enforceCardinality({Compliance: ['PCI']}, {Compliance: ['None']}) => {Compliance: ['None']} | FR-013 |
| TC-010 | Adding real compliance removes "None" | Unit | TagCardinalityEnforcer | enforceCardinality({Compliance: ['None']}, {Compliance: ['PCI']}) => {Compliance: ['PCI']} | FR-013 |
| TC-011 | Idempotent applyTags skips PATCH when no delta | Unit | TagOperations | applyTags returns {applied: false} when current matches desired | FR-014 |
| TC-012 | Delta computation identifies minimal changes | Unit | TagCardinalityEnforcer | computeDelta identifies only changed tags, not full set | FR-015 |
| TC-013 | PCI + Sandbox combination rejected | Unit | TagCardinalityEnforcer | validateTagCombinations returns {valid: false} with PCI/Sandbox error | FR-016 |
| TC-014 | HIPAA + Sandbox combination rejected | Unit | TagCardinalityEnforcer | validateTagCombinations returns {valid: false} with HIPAA/Sandbox error | FR-017 |
| TC-015 | Confidential without compliance rejected | Unit | TagCardinalityEnforcer | validateTagCombinations returns {valid: false} for Confidential + Compliance=[None] | FR-018 |
| TC-016 | Tag update preserves unchanged categories | Unit | TagOperations | updateTags changes only specified categories; others unchanged | FR-019 |
| TC-017 | Tag removal removes only specified categories | Unit | TagOperations | removeTags removes specified categories; others preserved | FR-020 |
| TC-018 | Correlation ID format is RITM-{num}-{ts} | Unit | CorrelationContext | create('12345') returns string matching /^RITM-12345-\d+$/ | FR-021 |
| TC-019 | Correlation ID propagated in HTTP headers | Unit | CorrelationContext | getHeaders() returns {'X-Correlation-ID': expectedId} | FR-022 |
| TC-020 | ConfigLoader resolves NDCNG endpoints | Unit | ConfigLoader | getEndpointsForSite('NDCNG') returns valid URLs | FR-026 |
| TC-021 | ConfigLoader rejects invalid site code | Unit | ConfigLoader | getEndpointsForSite('INVALID') throws DFW-4004 error | FR-027 |
| TC-022 | ConfigLoader overrides take precedence | Unit | ConfigLoader | Constructor override value returned by get() | FR-028 |
| TC-023 | DFW coverage returns true with active rules | Unit | DFWPolicyValidator | validateCoverage returns {covered: true} when API returns non-disabled rules | FR-032 |
| TC-024 | DFW coverage returns false with no rules | Unit | DFWPolicyValidator | validateCoverage returns {covered: false} when API returns empty array | FR-033 |
| TC-025 | Orphaned rules detected for empty groups | Unit | DFWPolicyValidator | checkOrphanedRules throws DFW-7007 for group with expressions but 0 members | FR-034 |
| TC-026 | Shadowed rules detected | Unit | RuleConflictDetector | detectShadowed identifies rule covered by higher-priority broader rule | FR-035 |
| TC-027 | Contradictory rules detected | Unit | RuleConflictDetector | detectContradictory identifies same-scope rules with ALLOW vs DROP actions | FR-036 |
| TC-028 | Duplicate rules detected | Unit | RuleConflictDetector | detectDuplicates identifies same-scope rules with same action | FR-037 |
| TC-029 | ErrorFactory creates structured errors | Unit | ErrorFactory | create('DFW-3003', msg, ctx) produces Error with code and context properties | FR-041 |
| TC-030 | RetryHandler retries on 5xx errors | Unit | RetryHandler | Function called 4 times (1 initial + 3 retries) for HTTP 503 errors | FR-042 |
| TC-031 | RetryHandler does not retry 4xx errors | Unit | RetryHandler | Function called once for HTTP 400 error; no retries | FR-042 |
| TC-032 | Custom retry strategy used when provided | Unit | RetryHandler | Custom strategy.getDelay() called for each retry attempt | FR-043 |
| TC-033 | Circuit breaker starts CLOSED | Unit | CircuitBreaker | getState() returns 'CLOSED' on new instance | FR-044 |
| TC-034 | Circuit breaker opens after threshold failures | Unit | CircuitBreaker | getState() returns 'OPEN' after 5 failures within window | FR-045 |
| TC-035 | Circuit breaker rejects calls when OPEN | Unit | CircuitBreaker | execute() throws DFW-6004 without calling wrapped function | FR-046 |
| TC-036 | Circuit breaker transitions to HALF_OPEN | Unit | CircuitBreaker | getState() returns 'HALF_OPEN' after resetTimeout elapses | FR-047 |
| TC-037 | Successful probe resets breaker to CLOSED | Unit | CircuitBreaker | execute() succeeds in HALF_OPEN; getState() returns 'CLOSED' | FR-048 |
| TC-038 | Saga records steps in order | Unit | SagaCoordinator | getJournal() returns steps in recording order | FR-049 |
| TC-039 | Saga compensates in LIFO order | Unit | SagaCoordinator | Compensation functions called in reverse order of recording | FR-050 |
| TC-040 | Saga continues on compensation failure | Unit | SagaCoordinator | Failed compensation logged; remaining compensations still executed | FR-050 |
| TC-041 | Logger produces valid JSON output | Unit | Logger | JSON.parse succeeds on captured console output | FR-051 |
| TC-042 | Logger respects minimum level threshold | Unit | Logger | DEBUG messages suppressed when minLevel='INFO' | FR-053 |
| TC-043 | Logger enriches Error objects in metadata | Unit | Logger | error() with Error metadata produces {errorMessage, stack} in output | FR-054 |
| TC-044 | Logger handles circular references | Unit | Logger | No exception thrown when metadata contains circular reference | FR-055 |
| TC-045 | Integration: Day 0 full flow succeeds | Integration | LifecycleOrchestrator + all modules | Tags applied, groups updated, DFW verified, callback sent | FR-023 |
| TC-046 | Integration: Day 2 update with rollback on failure | Integration | LifecycleOrchestrator + SagaCoordinator | Saga compensates when DFW validation fails after tags applied | FR-024, FR-050 |
| TC-047 | Integration: Circuit breaker trips during batch operations | Integration | CircuitBreaker + TagOperations | Operations stop after breaker opens; remaining VMs fail fast | FR-045, NFR-010 |
| TC-048 | YAML policy schema validation passes | Unit | Schema validator | environment-zone-isolation.yaml validates against policy schema | FR-064 |
| TC-049 | YAML policy with missing required field fails validation | Unit | Schema validator | YAML missing policy_name field fails schema validation | FR-065 |
| TC-050 | Analyze returns unified conflict summary | Unit | RuleConflictDetector | analyze() returns {conflicts, shadows, duplicates, hasIssues} | FR-038 |

---

## 3. Coverage Targets

| Metric | Target | Enforcement |
|--------|--------|-------------|
| Line Coverage | 80% | jest.config.js coverageThresholds; CI fails below threshold |
| Branch Coverage | 70% | jest.config.js coverageThresholds; CI fails below threshold |
| Function Coverage | 80% | jest.config.js coverageThresholds; CI fails below threshold |
| Statement Coverage | 80% | jest.config.js coverageThresholds; CI fails below threshold |

Coverage is collected from all files in `src/` except `src/servicenow/` (ServiceNow client scripts require a ServiceNow runtime and are tested separately).

---

## 4. Testing Tools

| Tool | Version | Purpose |
|------|---------|---------|
| Jest | 29.7.x | Unit and integration test runner, assertion library, mocking framework |
| ESLint | 8.56.x | Static code analysis (linting) |
| ajv | 8.12.x | JSON Schema validation for API payloads and YAML policies |
| Node.js | 18.x | Runtime environment for all tests |

### 4.1 Mock Strategy

Tests use Jest's built-in mocking capabilities:

- **REST Client Mocks:** `jest.fn()` instances that simulate `get()`, `patch()`, `post()` methods returning predetermined response objects.
- **Logger Mocks:** `jest.fn()` instances for `info()`, `warn()`, `error()`, `debug()` that capture log calls for assertion.
- **Timer Mocks:** `jest.useFakeTimers()` for testing circuit breaker timeout transitions and retry delays without real waits.
- **Shared Mocks:** Common mock objects stored in `tests/mocks/` for reuse across test files.

### 4.2 Test Execution

```bash
# Full suite with coverage
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Single file
npx jest tests/unit/shared/CircuitBreaker.test.js

# Watch mode during development
npx jest --watch
```

---

*End of Test Strategy*
