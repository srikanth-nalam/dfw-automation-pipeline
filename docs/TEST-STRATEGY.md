# Test Strategy

## NSX DFW Automation Pipeline

**Version:** 1.0
**Date:** 2026-03-21
**Author:** Enterprise Infrastructure & Cloud Security

---

## Table of Contents

1. [Test Levels](#1-test-levels)
2. [Test Cases](#2-test-cases)
3. [Coverage Targets](#3-coverage-targets)
4. [Testing Tools](#4-testing-tools)
5. [Test Data Management](#5-test-data-management)
6. [CI/CD Integration](#6-cicd-integration)
7. [Failure Injection Scenarios](#7-failure-injection-scenarios)

---

## 1. Test Levels

### 1.1 Unit Testing

Unit tests validate individual classes and functions in isolation. All external dependencies (REST clients, NSX API, vCenter API, ServiceNow) are mocked. Unit tests are fast (< 100ms each), deterministic, and run on every commit.

**Tool:** Jest 29.x
**Location:** `tests/unit/`
**Coverage Targets:** 80% line, 70% branch, 80% function, 80% statement

#### Module Coverage

| Module | Test File(s) | Key Test Scenarios |
|--------|-------------|-------------------|
| TagCardinalityEnforcer | `tests/unit/tags/TagCardinalityEnforcer.test.js` | Single-value replacement, multi-value merge, None exclusivity, conflict detection, delta computation |
| TagOperations | `tests/unit/tags/TagOperations.test.js` | Idempotent apply, read-compare-write, tag removal, unchanged category preservation |
| CircuitBreaker | `tests/unit/shared/CircuitBreaker.test.js` | State transitions (CLOSED→OPEN→HALF_OPEN→CLOSED), threshold behavior, reset, getStats |
| RetryHandler | `tests/unit/shared/RetryHandler.test.js` | Retry on 5xx, no retry on 4xx, custom strategy, exhaustion with enriched error |
| SagaCoordinator | `tests/unit/lifecycle/SagaCoordinator.test.js` | Step recording, LIFO compensation, continue on failure, journal inspection |
| ErrorFactory | `tests/unit/shared/ErrorFactory.test.js` | Structured error creation, callback payload, isRetryable classification, taxonomy |
| Logger | `tests/unit/shared/Logger.test.js` | JSON output, level filtering, Error enrichment, circular reference handling |
| CorrelationContext | `tests/unit/shared/CorrelationContext.test.js` | ID format, header propagation, create/clear lifecycle |
| ConfigLoader | `tests/unit/shared/ConfigLoader.test.js` | Site resolution, invalid site rejection, override precedence, vault references |
| DFWPolicyValidator | `tests/unit/dfw/DFWPolicyValidator.test.js` | Coverage validation (true/false), orphaned rule detection, API error handling |
| RuleConflictDetector | `tests/unit/dfw/RuleConflictDetector.test.js` | Shadowed rules, contradictory rules, duplicate rules, unified analysis |

### 1.2 Integration Testing

Integration tests validate interactions between multiple modules within the pipeline. They use mock HTTP servers to simulate NSX Manager and vCenter API responses, testing the full flow from LifecycleOrchestrator through TagOperations to the mock API. No live infrastructure is required.

**Tool:** Jest 29.x with mock HTTP servers
**Location:** `tests/integration/`

#### Integration Test Scenarios

| Scenario | Modules Under Test | Mock Dependencies |
|----------|-------------------|-------------------|
| Day 0 full flow | LifecycleOrchestrator, Day0Orchestrator, TagOperations, TagCardinalityEnforcer, DFWPolicyValidator | Mock NSX API (tag CRUD, realized-state), Mock vCenter API (VM inventory, VMTools status), Mock ServiceNow callback endpoint |
| Day 2 update with rollback | LifecycleOrchestrator, Day2Orchestrator, SagaCoordinator, TagOperations | Mock NSX API (tag read, tag update failure), Mock ServiceNow error callback |
| Circuit breaker trip during batch | CircuitBreaker, TagOperations, LifecycleOrchestrator | Mock NSX API returning 5xx after N calls |
| Tag propagation timeout | TagOperations, TagPropagationVerifier | Mock NSX realized-state API always returning stale state |
| Payload validation rejection | LifecycleOrchestrator, PayloadValidator | No mocks needed (validation is local) |

### 1.3 End-to-End (E2E) Testing

E2E tests validate the complete pipeline flow from ServiceNow payload ingestion through vRO orchestration to NSX API interaction. These tests run against a staging environment with real vCenter and NSX Manager instances (non-production).

**Environment:** Staging VCF cluster with dedicated test VMs
**Frequency:** Pre-release validation

#### E2E Test Scenarios

| Scenario | Entry Point | Exit Criteria |
|----------|------------|---------------|
| VM provisioning (Day 0) | ServiceNow RITM submission | Tags applied, groups updated, DFW rules verified, RITM closed with success |
| Tag update (Day 2) | ServiceNow change request | Tags updated with delta only, groups adjusted, DFW re-verified |
| VM decommission (Day N) | ServiceNow decommission request | Tags removed, group membership cleared, VM deprovisioned, CMDB updated |
| Emergency quarantine | Manual vRO workflow trigger | VM isolated within 60 seconds, management access preserved |
| Batch onboarding | CSV upload via vRO | All VMs tagged, group membership verified, batch report generated |

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

The following table defines all 50 test cases referenced throughout the project documentation. Each test case has a unique ID, description, type, component under test, expected result, and traceability to functional requirements.

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
| TC-018 | Correlation ID format is RITM-{num}-{ts} | Unit | CorrelationContext | create('12345') returns string matching /^RITM-12345-\\d+$/ | FR-021 |
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

### 3.1 Global Thresholds

| Metric | Target | Enforcement |
|--------|--------|-------------|
| Line Coverage | 80% | jest.config.js coverageThresholds; CI fails below threshold |
| Branch Coverage | 70% | jest.config.js coverageThresholds; CI fails below threshold |
| Function Coverage | 80% | jest.config.js coverageThresholds; CI fails below threshold |
| Statement Coverage | 80% | jest.config.js coverageThresholds; CI fails below threshold |

Coverage is collected from all files in `src/` except `src/servicenow/` (ServiceNow client scripts require a ServiceNow runtime and are tested separately).

### 3.2 Per-Module Coverage Expectations

| Module | Expected Line Coverage | Rationale |
|--------|----------------------|-----------|
| `src/vro/actions/shared/CircuitBreaker.js` | > 90% | Critical resilience component; all state transitions must be tested |
| `src/vro/actions/shared/RetryHandler.js` | > 90% | Critical resilience component; retry and exhaustion paths must be tested |
| `src/vro/actions/lifecycle/SagaCoordinator.js` | > 90% | Critical compensation logic; LIFO order and failure handling must be tested |
| `src/vro/actions/tags/TagCardinalityEnforcer.js` | > 85% | Core business logic; all cardinality rules and conflict checks must be tested |
| `src/vro/actions/tags/TagOperations.js` | > 85% | Core CRUD operations; idempotency and delta computation must be tested |
| `src/vro/actions/shared/ErrorFactory.js` | > 85% | Error taxonomy must be complete; isRetryable classification must cover all codes |
| `src/vro/actions/shared/Logger.js` | > 85% | All log levels, Error enrichment, and circular reference handling must be tested |
| `src/vro/actions/shared/ConfigLoader.js` | > 80% | Site resolution, override precedence, and validation must be tested |
| `src/vro/actions/dfw/RuleConflictDetector.js` | > 85% | Pure logic; all detection methods must have positive and negative test cases |
| `src/vro/actions/dfw/DFWPolicyValidator.js` | > 80% | Coverage and orphan detection logic must be tested |
| `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | > 80% | Template method flow, error handling, and factory method must be tested |

### 3.3 Exclusions

The following paths are excluded from coverage collection:

| Path | Reason |
|------|--------|
| `src/servicenow/**` | ServiceNow client scripts require the ServiceNow runtime (g_form, g_user, GlideAjax globals) and are tested separately in the ServiceNow dev instance |
| `tests/**` | Test files are not production code |
| `node_modules/**` | Third-party dependencies |
| `schemas/**` | JSON Schema files (declarative, not executable) |
| `policies/**` | YAML policy files (declarative, not executable) |

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

- **REST Client Mocks:** `jest.fn()` instances that simulate `get()`, `patch()`, `post()` methods returning predetermined response objects. Each mock is configured per test case to return success responses, HTTP error responses, or throw network errors as needed.

- **Logger Mocks:** `jest.fn()` instances for `info()`, `warn()`, `error()`, `debug()` that capture log calls for assertion. Logger mocks verify that the correct log level is used and that structured metadata is included.

- **Timer Mocks:** `jest.useFakeTimers()` for testing circuit breaker timeout transitions and retry delays without real waits. Timer mocks enable testing of time-dependent behavior (OPEN → HALF_OPEN transition after resetTimeout) in milliseconds rather than seconds.

- **Shared Mocks:** Common mock objects stored in `tests/mocks/` for reuse across test files. Includes:
  - `mockNsxClient` — Simulates NSX Manager REST API responses
  - `mockVcenterClient` — Simulates vCenter REST API responses
  - `mockSnowCallback` — Captures ServiceNow callback payloads
  - `mockLogger` — Captures log entries for assertion
  - `mockConfig` — Provides test-specific ConfigLoader overrides

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

# Coverage report only
npx jest --coverage --coverageReporters=text-summary

# Run tests matching a pattern
npx jest --testNamePattern="circuit breaker"
```

### 4.3 Test Configuration

The Jest configuration (`jest.config.js`) defines:

```javascript
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/servicenow/**'
  ],
  coverageThreshold: {
    global: {
      lines: 80,
      branches: 70,
      functions: 80,
      statements: 80
    }
  },
  coverageReporters: ['text', 'lcov', 'clover'],
  verbose: true,
  testTimeout: 10000
};
```

---

## 5. Test Data Management

### 5.1 Test Fixtures

Test fixtures are stored in `tests/mocks/` and represent realistic but synthetic data:

| Fixture | Contents | Used By |
|---------|----------|---------|
| `validDay0Payload.json` | Complete ServiceNow Day 0 provisioning payload | TC-045, integration tests |
| `validDay2Payload.json` | Complete ServiceNow Day 2 update payload | TC-046, integration tests |
| `validDayNPayload.json` | Complete ServiceNow Day N decommission payload | Integration tests |
| `invalidPayload.json` | Payload missing required fields | TC-049 |
| `nsxTagResponse.json` | Mock NSX tag API response | TC-011, TC-016, TC-017 |
| `nsxRealizedStateResponse.json` | Mock NSX realized-state API response | TC-023, TC-024 |
| `dfwRulesActive.json` | Mock DFW rules with active rules | TC-023 |
| `dfwRulesEmpty.json` | Mock DFW rules with empty array | TC-024 |
| `proposedRules.json` | Mock proposed DFW rules for conflict detection | TC-026, TC-027, TC-028 |
| `existingRules.json` | Mock existing DFW rules for conflict detection | TC-026, TC-027, TC-028 |

### 5.2 Test Data Principles

1. **No production data**: Test fixtures contain only synthetic data with no connection to real VMs, applications, or users.
2. **Deterministic**: All test data produces deterministic results. No random values, timestamps, or UUIDs in fixtures (generated values are mocked).
3. **Minimal**: Each fixture contains only the fields required by the test scenario, reducing maintenance burden.
4. **Documented**: Each fixture file includes a header comment explaining its purpose and which test cases use it.

---

## 6. CI/CD Integration

### 6.1 CI Pipeline Test Stages

The GitHub Actions CI pipeline runs tests in the following order:

| Stage | Command | Gate |
|-------|---------|------|
| 1. Lint | `npm run lint` | Zero ESLint errors |
| 2. Unit Tests | `npm run test:unit -- --coverage` | All tests pass; coverage meets thresholds |
| 3. Integration Tests | `npm run test:integration` | All tests pass |
| 4. Schema Validation | `npm run validate-schemas` | All schemas are valid JSON Schema |
| 5. Policy Validation | `npm run validate-policies` | All YAML policies pass schema validation |
| 6. Documentation Check | `docs-check` step | All required documentation files exist |

### 6.2 Branch Protection

The `main` branch requires:
- All CI stages pass (mandatory status checks)
- At least one peer review approval
- No merge conflicts
- Up-to-date with main branch

### 6.3 Test Reporting

Test results are reported through:
- **Console output**: Jest verbose output in CI logs
- **Coverage report**: LCOV report uploaded as CI artifact
- **PR comment**: Coverage summary posted as PR comment (via CI action)

---

## 7. Failure Injection Scenarios

Failure injection tests verify the resilience mechanisms under adversarial conditions. These tests use Jest mocks to simulate failures at specific points in the pipeline.

### 7.1 API Failure Scenarios

| Scenario | Injection Point | Expected Behavior | Verifies |
|----------|----------------|-------------------|----------|
| NSX Manager HTTP 503 | TagOperations.applyTags() REST client | RetryHandler retries 3 times with backoff [5s, 15s, 45s]; if all fail, error propagated with retryCount=3 | NFR-011, FR-042 |
| NSX Manager HTTP 429 (rate limit) | TagOperations.applyTags() REST client | RetryHandler retries with extended backoff; circuit breaker may trip if sustained | NFR-001, FR-042 |
| NSX Manager connection timeout | TagOperations.applyTags() REST client | RetryHandler retries; after exhaustion, circuit breaker failure counter incremented | NFR-010, FR-045 |
| NSX Manager HTTP 401 (auth failure) | TagOperations.applyTags() REST client | RetryHandler does NOT retry (4xx); DFW-2002 error logged; circuit breaker incremented | NFR-017, FR-031 |
| vCenter API unavailable | Day0Orchestrator.provisionVM() | RetryHandler exhaustion; saga compensates (no steps to compensate for Day 0 first step); DLQ entry created | NFR-010, FR-050 |

### 7.2 Partial Failure Scenarios

| Scenario | Injection Point | Expected Behavior | Verifies |
|----------|----------------|-------------------|----------|
| Tags applied but DFW validation fails | Day0Orchestrator after applyTags step | SagaCoordinator compensates by removing applied tags (LIFO); error callback includes compensatingActionTaken=true | FR-050, NFR-034 |
| Tags applied, groups verified, DFW times out | Day0Orchestrator after verifyGroupMembership | SagaCoordinator compensates groups then tags in LIFO order; DLQ entry includes completedSteps list | FR-050, FR-059 |
| Saga compensation itself fails | SagaCoordinator.compensate() compensation function throws | Compensation continues to remaining steps; result includes failed count and error details | FR-050, TC-040 |
| Circuit breaker trips mid-batch | Batch operation after 5th VM | Remaining VMs fail immediately with DFW-6004; batch report shows which VMs succeeded and which were rejected | NFR-010, TC-047 |

### 7.3 Infrastructure Failure Scenarios

| Scenario | Injection Method | Expected Behavior | Verifies |
|----------|-----------------|-------------------|----------|
| vRO node failure during workflow | Quarterly DR test (manual) | Surviving node resumes workflow from last persisted state; saga journal intact | NFR-012 |
| NDCNG site unavailable | Quarterly DR test (manual) | TULNG vRO instance processes new requests; 30-minute RTO | NFR-008 |
| Splunk ingestion delay | Simulated via log buffer | Pipeline continues execution; logs buffered locally until Splunk available | NFR-032 |

---

*End of Test Strategy*
