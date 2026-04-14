# com.dfw.shared — Shared Utility Actions

Cross-cutting utility actions used by all DFW Automation workflows.

## Actions

| Action               | Source                              | Description                                                       |
|----------------------|-------------------------------------|-------------------------------------------------------------------|
| ConfigLoader         | src/vro/actions/shared/ConfigLoader.js         | Centralized configuration loader with per-site endpoint resolution |
| Logger               | src/vro/actions/shared/Logger.js               | Structured logging with correlation ID propagation                 |
| CorrelationContext   | src/vro/actions/shared/CorrelationContext.js   | Request-scoped correlation context for end-to-end tracing          |
| RetryHandler         | src/vro/actions/shared/RetryHandler.js         | Configurable retry with exponential backoff                        |
| CircuitBreaker       | src/vro/actions/shared/CircuitBreaker.js       | Circuit breaker pattern for downstream service protection          |
| RestClient           | src/vro/actions/shared/RestClient.js           | HTTP client with retry, circuit breaker, and timeout integration   |
| PayloadValidator     | src/vro/actions/shared/PayloadValidator.js     | JSON Schema-based payload validation for inbound requests          |
| ErrorFactory         | src/vro/actions/shared/ErrorFactory.js         | Standardized error creation with error codes and categories        |
| RateLimiter          | src/vro/actions/shared/RateLimiter.js          | Token-bucket rate limiter for API call throttling                  |

## Module Path

```
com.dfw.shared.*
```

## Dependencies

None (leaf module).

## Notes

- All shared actions are stateless and thread-safe.
- Configuration is loaded once per workflow execution and cached in `CorrelationContext`.
- Vault references (`{{vault:secret/...}}`) are resolved at runtime by the vRO secrets manager.
