# Non-Functional Requirements Mapping (NFR-MAPPING)

## NSX DFW Automation Pipeline

**Version:** 1.0
**Date:** 2026-03-21
**Author:** Enterprise Infrastructure & Cloud Security

---

## NFR Traceability Matrix

| NFR-ID | Title | Category | Component(s) | How Addressed |
|--------|-------|----------|--------------|---------------|
| NFR-001 | API call latency under 5 seconds | Performance | RetryHandler, CircuitBreaker, NSX Adapter | HTTP timeout set to 30s; circuit breaker rejects calls to degraded endpoints immediately; retry intervals are tuned to avoid compounding latency |
| NFR-002 | End-to-end pipeline execution under 5 minutes | Performance | LifecycleOrchestrator, all modules | Parallel-where-possible execution; idempotent operations skip unnecessary writes; monitoring dashboard tracks p90 latency |
| NFR-003 | Tag propagation verification within 120 seconds | Performance | TagOperations, DFWPolicyValidator | Polling loop with 10s interval checks NSX realized-state; DFW-7004 timeout raised after 120s |
| NFR-004 | Support 100+ concurrent pipeline executions | Scalability | vRO Cluster, CircuitBreaker | vRO cluster provides horizontal capacity; circuit breaker prevents overloading downstream APIs during high concurrency |
| NFR-005 | Support 10,000+ managed VMs across both sites | Scalability | TagOperations, NSX Manager | Read-compare-write pattern minimizes API calls; per-VM operations avoid bulk API limitations |
| NFR-006 | Tag dictionary supports 50+ category values per category | Scalability | TagCardinalityEnforcer | Category config is extensible; enforcer iterates over configured categories dynamically |
| NFR-007 | Circuit breaker state shared across vRO cluster nodes | Scalability | CircuitBreaker | In-memory Map backed by vRO Configuration Element in production; cluster-wide visibility via shared storage |
| NFR-008 | Pipeline available 99.9% during business hours | Availability | vRO Cluster, DR topology | 2-node active cluster at NDCNG; standby cluster at TULNG; 30-minute RTO for site failover |
| NFR-009 | No single point of failure in orchestration layer | Availability | vRO Cluster, ConfigLoader | Clustered vRO with shared database; configuration externalized from code; no hardcoded endpoints |
| NFR-010 | Graceful degradation when NSX Manager unavailable | Availability | CircuitBreaker | Circuit breaker OPEN state rejects calls immediately with descriptive error; saga compensates completed steps |
| NFR-011 | Automatic recovery from transient API failures | Availability | RetryHandler | Exponential backoff retry with configurable intervals [5s, 15s, 45s]; shouldRetry predicate filters non-retryable errors |
| NFR-012 | In-flight workflows survive single vRO node failure | Availability | vRO Cluster | vRO persists workflow state to shared PostgreSQL database; surviving node resumes execution |
| NFR-013 | All API communication over TLS 1.2+ | Security | REST client configuration | vRO REST hosts configured with TLS 1.2 minimum; certificate validation enabled |
| NFR-014 | No credentials stored in code or configuration files | Security | ConfigLoader, vault references | All secrets use `{{vault:secret/...}}` patterns resolved at runtime by credential store |
| NFR-015 | Service accounts follow principle of least privilege | Security | vRO RBAC, NSX RBAC | vRO account has NsxTagOperator + NsxSecurityEngineer roles only; no admin privileges |
| NFR-016 | All operations carry correlation ID for traceability | Security | CorrelationContext | Correlation ID generated at pipeline entry, propagated via HTTP headers and log entries |
| NFR-017 | Failed authentication attempts logged and alerted | Security | Logger, NSX Adapter | DFW-2002 errors logged with full context; circuit breaker trips on repeated auth failures |
| NFR-018 | Input validation at pipeline entry point | Security | LifecycleOrchestrator, TagCardinalityEnforcer | All inputs validated against tag dictionary and cardinality rules before any API calls |
| NFR-019 | Tag combination conflicts detected before application | Security | TagCardinalityEnforcer — `validateTagCombinations()` | Conflict rules checked against merged tag set; invalid combinations rejected with descriptive errors |
| NFR-020 | DFW policy changes auditable to originating RITM | Compliance | CorrelationContext, Logger | Every log entry includes RITM-derived correlation ID; ServiceNow callback links result to RITM |
| NFR-021 | Audit logs retained for 7+ years | Compliance | Logger, Splunk/ELK configuration | Structured JSON logs shipped to Splunk with 7-year retention policy |
| NFR-022 | YAML policies include compliance framework references | Compliance | Policy YAML metadata | Each policy file contains compliance_tags array (PCI, SOX, HIPAA) |
| NFR-023 | Policy changes require peer review before deployment | Compliance | Git workflow, CI pipeline | YAML policies stored in git; changes require PR review and CI validation |
| NFR-024 | DFW rules traceable to BRD requirements | Compliance | Policy YAML metadata | Each policy file contains brd_reference field linking to specific BRD appendix |
| NFR-025 | Quarterly policy review enforced | Compliance | Policy YAML metadata | review_cadence_days field (default: 90) enables automated review reminders |
| NFR-026 | Modular code architecture with clear separation of concerns | Maintainability | All modules | Each module handles one domain (tags, groups, DFW, shared); no circular dependencies |
| NFR-027 | 80% line coverage, 70% branch coverage | Maintainability | Jest test suite | jest.config.js enforces coverage thresholds; CI fails below targets |
| NFR-028 | Consistent error code taxonomy across all modules | Maintainability | ErrorFactory | Centralized error code registry (DFW-XXXX); all modules use ErrorFactory for error creation |
| NFR-029 | Configuration externalized from business logic | Maintainability | ConfigLoader | All endpoints, timeouts, thresholds loaded from ConfigLoader; no magic numbers in business logic |
| NFR-030 | Design patterns documented with rationale | Maintainability | SDD, LLD, ADRs | Each pattern documented with WHERE used and WHY chosen; ADRs capture key decisions |
| NFR-031 | Code follows ESLint rules enforced in CI | Maintainability | .eslintrc.json, CI pipeline | ESLint runs in CI with zero-tolerance for errors; rules include no-var, prefer-const, eqeqeq |
| NFR-032 | Structured JSON logging for all operations | Observability | Logger | Every log entry is single-line JSON with timestamp, level, correlationId, step, message, metadata |
| NFR-033 | Circuit breaker statistics exposed for dashboards | Observability | CircuitBreaker — `getStats()` | Stats include name, state, totalSuccesses, totalFailures, recentFailures, thresholds |
| NFR-034 | Saga compensation outcomes tracked and reported | Observability | SagaCoordinator — `compensate()` return value | Returns {compensated, failed, errors} for monitoring and alerting |
| NFR-035 | Real-time pipeline health dashboard | Observability | Logger + Splunk/ELK | Dashboard panels for circuit breaker state, throughput, error rate, latency, DLQ depth |
| NFR-036 | Alerting on circuit breaker state changes | Observability | Logger + monitoring rules | WARN log emitted on OPEN transition; monitoring rule triggers PagerDuty alert |
| NFR-037 | DLQ depth monitoring with threshold alerting | Observability | DLQ + monitoring | DLQ depth metric exposed; alert when depth > 0 entries |
| NFR-038 | Retry exhaustion rate tracking | Observability | RetryHandler enriched errors | retryCount property on final error enables Splunk query for retry exhaustion rate |
| NFR-039 | Saga compensation can be manually triggered | Operability | SagaCoordinator — `compensate()` | Compensation can be invoked from vRO workflow console for manual rollback |
| NFR-040 | Circuit breaker can be manually reset | Operability | CircuitBreaker — `reset()` | reset() method clears all failure counters and returns to CLOSED state |
| NFR-041 | DLQ entries can be inspected and reprocessed | Operability | DLQ management workflow | Operators can list, inspect, and resubmit DLQ entries through vRO workflow |
| NFR-042 | Configuration changes do not require code deployment | Operability | ConfigLoader, vRO Configuration Elements | Endpoint URLs, timeouts, thresholds configurable via vRO UI without redeploying actions |
| NFR-043 | Emergency quarantine can isolate a VM immediately | Operability | Emergency quarantine workflow | Dedicated workflow applies quarantine tag and DROP-all DFW rule within 60 seconds |
| NFR-044 | Rollback supported via git revert for YAML policies | Operability | Git workflow, CI pipeline | git revert on a policy change produces a valid state; CI validates reverted files |
| NFR-045 | Batch operations supported for legacy workload onboarding | Operability | TagOperations batch wrapper | Batch mode processes multiple VMs sequentially with per-VM error isolation |
| NFR-046 | JSON schema validation for all API payloads | Performance | ajv schema validator, CI pipeline | Schemas in schemas/ directory; CI validates all payloads against schemas |
| NFR-047 | YAML policy schema validation in CI | Performance | CI pipeline — validate-policies job | Invalid YAML structure fails CI build before merge |
| NFR-048 | Node.js 18+ runtime requirement enforced | Maintainability | package.json engines field | engines.node >= 18.0.0; CI runs on Node 18 |
| NFR-049 | No external runtime dependencies beyond ajv | Maintainability | package.json dependencies | Only ajv listed as production dependency; all other deps are devDependencies |
| NFR-050 | Documentation completeness verified in CI | Maintainability | CI pipeline — docs-check job | CI verifies existence of SDD.md, HLD.md, LLD.md, FRD.md, RUNBOOK.md |

---

*End of Non-Functional Requirements Mapping*
