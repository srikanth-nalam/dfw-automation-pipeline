# ADR-004: Circuit Breaker Implementation

**Status:** Accepted

**Date:** 2026-03-21

## Context

The DFW automation pipeline makes REST API calls to multiple external systems (vCenter VAPI, NSX Manager REST API, ServiceNow REST API) that may experience transient failures, high latency, or complete outages. Without protection, a downstream system outage can cause cascading failures: workflow threads block waiting for timeouts, retry storms amplify load on the degraded system, and the vRO cluster's thread pool becomes exhausted — affecting all workflows, not just those targeting the failed endpoint.

The pipeline needs a mechanism to detect when a downstream endpoint is unhealthy and temporarily stop sending requests to it, allowing the endpoint to recover while failing fast for incoming requests.

Options considered:

- **In-memory circuit breaker per endpoint:** A state machine (CLOSED/OPEN/HALF-OPEN) that tracks failures and trips open after a threshold, with automatic recovery probing.
- **External circuit breaker service:** A shared service (e.g., Hystrix, Resilience4j) managing circuit state.
- **Timeout-only approach:** Rely solely on request timeouts without circuit breaking.
- **Load balancer health checks:** Delegate failure detection to the network load balancer.

## Decision

We will implement an **in-memory circuit breaker per endpoint** within the vRO `RestClient` module. Each unique endpoint (identified by base URL) maintains its own circuit breaker instance with the following configuration:

- **Failure threshold:** 5 consecutive failures trip the circuit to OPEN.
- **Reset timeout:** 60 seconds in OPEN state before transitioning to HALF-OPEN.
- **Half-open probe:** A single request is allowed through in HALF-OPEN state. If it succeeds, the circuit closes; if it fails, the circuit reopens for another 60 seconds.
- **Failure criteria:** HTTP 5xx responses, connection timeouts, and network errors count as failures. HTTP 4xx responses do not trip the circuit (these indicate client errors, not endpoint health issues).

The circuit breaker state is maintained in the vRO action's execution context (in-memory per node). Circuit state is not shared across vRO cluster nodes — each node independently tracks endpoint health based on its own request outcomes.

## Consequences

**Positive:**
- Prevents cascade failures by failing fast when a downstream system is unhealthy, freeing vRO workflow threads.
- Automatic recovery via HALF-OPEN probing eliminates the need for manual intervention to resume traffic after an outage.
- Per-endpoint isolation ensures that a vCenter outage does not affect NSX Manager operations (and vice versa).
- Simple in-memory implementation with no external dependencies, suitable for the vRO runtime environment.
- 5-failure threshold with 60-second reset provides a balance between sensitivity and stability.

**Negative:**
- In-memory state is not shared across vRO cluster nodes, so each node independently detects failures (potentially sending up to 5 x N requests to a failed endpoint, where N is the number of nodes).
- Circuit breaker state is lost on vRO node restart, resetting to CLOSED (acceptable since the node would re-detect failures quickly).
- Fixed threshold and timeout values may not be optimal for all endpoints — future enhancement could make these configurable per endpoint.
- Does not address partial degradation (e.g., an endpoint that is slow but not failing) — a bulkhead pattern may be needed as a future complement.
