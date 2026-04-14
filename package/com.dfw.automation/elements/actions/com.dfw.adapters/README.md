# com.dfw.adapters — External System Adapters

Adapter actions that encapsulate communication with external systems (NSX-T, ServiceNow,
vCenter). All API-specific protocol, authentication, and serialization details are
isolated within these adapters.

## Actions

| Action              | Source                                      | Description                                                         |
|---------------------|---------------------------------------------|---------------------------------------------------------------------|
| NsxApiAdapter       | src/adapters/NsxApiAdapter.js               | NSX-T Policy API client — tags, groups, DFW rules, and policies     |
| SnowPayloadAdapter  | src/adapters/SnowPayloadAdapter.js          | ServiceNow payload transformation and callback execution            |
| VcenterApiAdapter   | src/adapters/VcenterApiAdapter.js           | vCenter REST API client — VM inventory, tag reads, and metadata     |

## Module Path

```
com.dfw.adapters.*
```

## Adapter Pattern

Each adapter:

1. Accepts domain-level parameters (VM name, tag map, policy ID).
2. Transforms them into the platform-specific API request format.
3. Executes the request via `RestClient` (with retry, circuit breaker, rate limiting).
4. Transforms the platform response back into a domain-level result.

This ensures that upstream orchestrators never deal with raw HTTP details.

## Endpoint Resolution

Endpoints are resolved per-site via `ConfigLoader.getSiteConfig(siteCode)`:

| Site    | vCenter                                    | NSX-T Manager                               |
|---------|--------------------------------------------|----------------------------------------------|
| NDCNG   | vcenter-ndcng.company.internal             | nsx-manager-ndcng.company.internal           |
| TULNG   | vcenter-tulng.company.internal             | nsx-manager-tulng.company.internal           |

## Dependencies

- com.dfw.shared (ConfigLoader, Logger, RestClient, CircuitBreaker, RateLimiter)
