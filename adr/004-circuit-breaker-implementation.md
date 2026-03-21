# ADR-004: Circuit Breaker Implementation

**Status:** Accepted
**Date:** 2026-03-21
**Deciders:** Senior Cloud Security Architect, NSX Platform Engineer, Platform Engineering Lead

## Context

The vRO orchestration layer makes REST API calls to vCenter and NSX Manager endpoints at both data center sites. These endpoints may experience transient outages, maintenance windows, degraded performance, or complete failures. Without protection, a failing endpoint causes cascading failures as retry attempts consume vRO thread pool resources and concurrent workflow executions stack up waiting for unresponsive services.

### The Cascade Failure Problem

In a failure scenario without circuit breakers:

1. NSX Manager at NDCNG becomes unresponsive (e.g., during a control plane upgrade).
2. All Day 0/Day 2/Day N workflows targeting NDCNG call the NSX Manager REST API.
3. Each call waits for the HTTP timeout (default 30 seconds) before failing.
4. The RetryHandler retries each failed call 3 times with exponential backoff (5s, 15s, 45s).
5. Each workflow consumes a vRO execution thread for the full retry duration (~120 seconds per workflow).
6. The vRO thread pool becomes saturated with waiting workflows.
7. **New requests to TULNG (healthy site) are queued behind NDCNG timeouts**, degrading both sites.

This cascade effect means a single-site failure impacts the entire pipeline, violating the site-independence requirement.

### Requirements

- Detect persistent endpoint failures quickly (within 5 failures, not 100)
- Prevent wasted retry attempts during known outages
- Automatically recover when the endpoint is restored (no manual intervention for normal cases)
- Isolate failures per endpoint (NDCNG NSX failure does not affect TULNG)
- Provide observable state for monitoring dashboards and alerting
- Be configurable per endpoint for different sensitivity profiles

### Alternatives Considered

**Retry-only approach:** The RetryHandler handles transient failures but does not prevent cascade failures during sustained outages. After retries are exhausted, the workflow fails, but during the retry window, resources are consumed and concurrent workflows are affected.

**Static timeouts with backpressure:** Reduce HTTP timeouts aggressively and use a semaphore to limit concurrent calls per endpoint. This limits resource consumption but does not provide fast-fail behavior or automatic recovery detection.

**Health check polling:** Run a periodic health check against each endpoint and route traffic away from unhealthy endpoints. This adds constant overhead even when endpoints are healthy and introduces a polling delay before failure detection.

**External circuit breaker service:** Use an external service (Hystrix, Resilience4j) to manage circuit state. This introduces an additional infrastructure dependency that must be deployed, monitored, and maintained. Not justified for the 4-6 endpoints in this pipeline.

**Load balancer health checks:** Delegate failure detection to the network load balancer. Load balancers can detect server-level failures but cannot distinguish between different API endpoints on the same server, and they do not provide application-level circuit breaking.

## Decision

We implement the **Circuit Breaker pattern** with three states, instantiated per endpoint, within the vRO `RestClient` module:

### State Machine

```
CLOSED ──[failure count >= threshold within window]──> OPEN
OPEN ──[resetTimeout elapsed]──> HALF_OPEN
HALF_OPEN ──[probe succeeds]──> CLOSED
HALF_OPEN ──[probe fails]──> OPEN
```

**CLOSED (Normal Operation):**
- All calls pass through to the target endpoint.
- Failures are counted within a sliding time window (default: 5 minutes).
- When the failure count reaches the threshold (default: 5), the circuit transitions to OPEN.
- Successes do not reset the failure count — failures expire naturally from the sliding window.

**OPEN (Endpoint Down):**
- All calls fail immediately with error code DFW-6004 without contacting the endpoint.
- This prevents wasted resources on known-failing endpoints.
- After the reset timeout elapses (default: 60 seconds), the circuit transitions to HALF_OPEN on the next call attempt (lazy transition).

**HALF_OPEN (Recovery Probe):**
- A single "probe" call is allowed through to the endpoint.
- If the probe succeeds, the circuit transitions to CLOSED (recovered), and all counters are reset.
- If the probe fails, the circuit transitions back to OPEN for another reset interval.
- While the probe is in-flight, additional calls are rejected (same as OPEN behavior).

### Configuration

All circuit breaker settings are externalized via `ConfigLoader` and the vRO Configuration Element `DFW-Pipeline-Config`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `failureThreshold` | 5 | Number of failures within the window to trip the breaker |
| `resetTimeout` | 60000ms (60s) | Time in OPEN state before transitioning to HALF_OPEN |
| `windowSize` | 300000ms (5min) | Sliding window for failure counting |

### Per-Endpoint Isolation

The `CircuitBreaker` uses a module-level `_endpointStates` Map that maintains separate state for each endpoint:

| Endpoint Key | Target |
|-------------|--------|
| `vcenter-ndcng` | vCenter Server at NDCNG |
| `vcenter-tulng` | vCenter Server at TULNG |
| `nsx-ndcng` | NSX Manager cluster at NDCNG |
| `nsx-tulng` | NSX Manager cluster at TULNG |
| `nsx-global` | NSX Federation Global Manager |
| `servicenow` | ServiceNow callback endpoint |

A failure at `nsx-ndcng` only opens the `nsx-ndcng` circuit. All other endpoints remain CLOSED and operational. This is critical for the multi-site architecture — a single-site failure must not cascade to the other site.

### Failure Criteria

Not all errors trip the circuit breaker:

| Response | Trips Circuit? | Reason |
|---------|---------------|--------|
| HTTP 5xx | Yes | Server-side failure indicates endpoint health issue |
| HTTP 429 | Yes | Rate limiting indicates endpoint is overwhelmed |
| Connection timeout | Yes | Endpoint may be unreachable |
| Network error | Yes | Infrastructure failure |
| HTTP 4xx (except 429) | No | Client error — not an endpoint health issue |
| HTTP 2xx | No (resets probe) | Success — endpoint is healthy |

### Integration with RestClient and RetryHandler

The call chain for each API call is:

```
Orchestrator -> TagOperations -> RestClient -> CircuitBreaker -> RetryHandler -> HTTP
```

1. **CircuitBreaker** checks state before the call:
   - CLOSED: allow call, pass to RetryHandler
   - OPEN: reject immediately with DFW-6004
   - HALF_OPEN: allow one probe call
2. **RetryHandler** handles the actual retries for transient failures
3. If RetryHandler exhausts retries, CircuitBreaker records the failure
4. If failure count reaches threshold within the sliding window, circuit opens

### Observable State

Each circuit breaker instance exposes statistics via `getStats()`:

```json
{
  "endpoint": "nsx-ndcng",
  "state": "OPEN",
  "failureCount": 5,
  "lastFailureTime": 1711000000000,
  "totalSuccesses": 142,
  "totalFailures": 8,
  "totalRejections": 23
}
```

These statistics are emitted to structured logs on every state transition and displayed on the Splunk monitoring dashboard (see Runbook Section 8.1). PagerDuty alerts fire when any production circuit transitions to OPEN.

## Consequences

### Positive

- **Prevents cascade failures** during endpoint outages — failing endpoint does not consume thread pool resources or affect other endpoints.
- **Fast-fail behavior** during known outages — calls rejected in < 1ms instead of waiting 30s+ for timeout.
- **Automatic recovery** via HALF_OPEN probe — no manual intervention required for transient outages.
- **Per-endpoint isolation** ensures single-site failures do not impact the other site.
- **Observable state** enables monitoring dashboards with color-coded status (green/yellow/red) and PagerDuty alerting on OPEN transitions.
- **Configurable thresholds** allow tuning per endpoint based on its reliability characteristics.
- **Complementary to RetryHandler** — circuit breaker prevents retry storms during sustained outages, while RetryHandler handles individual transient failures.
- **Simple implementation** with no external dependencies, suitable for the vRO runtime environment.

### Negative

- **In-memory state is not shared** across vRO cluster nodes. Each node maintains its own circuit breaker state, so one node may have an OPEN circuit while another is still CLOSED. This is acceptable because the failure detection window is short (5 failures) and both nodes will converge quickly.
- **Single probe in HALF_OPEN** may not guarantee full recovery — the endpoint may succeed on one call but fail on the next. Mitigated by the fact that if the probe succeeds, the circuit closes, and subsequent failures will re-open it within the threshold.
- **60-second OPEN window** may be too long for fast-recovering endpoints or too short for slow maintenance windows. Mitigated by externalized configuration that can be tuned per endpoint.
- **Adds complexity to the call chain** — RestClient -> CircuitBreaker -> RetryHandler -> HTTP requires careful understanding of the interaction between retries and circuit state.
- **Does not address partial degradation** — an endpoint that responds slowly but does not fail will not trip the circuit. A bulkhead or concurrency limiter pattern may be needed as a future complement.
- **Circuit breaker state is lost on vRO node restart**, resetting to CLOSED. Acceptable since the node would re-detect failures quickly (within 5 failed calls).

### Mitigations

- **Cluster state divergence** is mitigated by the short failure detection window — both nodes will detect the same outage independently within seconds.
- **Configuration tuning** is supported via the vRO Configuration Element, allowing threshold adjustments without code changes.
- **Manual reset** is available via the Operations workflow (see Runbook Section 2.2) for cases where automatic recovery is not sufficient.

## Related Decisions

- ADR-001 (vRO Selection) provides the in-memory module state mechanism for per-endpoint tracking.
- ADR-003 (Saga Pattern) uses the circuit breaker to protect compensating actions during recovery.
- ADR-006 (Multi-Site Federation) depends on per-endpoint circuit breakers for site-independent failure handling.
