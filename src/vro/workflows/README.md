# Importing Workflow Actions into vRO 8.x

This guide covers importing the DFW Automation Pipeline JavaScript actions into VMware Aria Automation Orchestrator (formerly vRealize Orchestrator) 8.x.

## Prerequisites

- VMware Aria Automation Orchestrator 8.x (8.10+)
- vRO CLI (`vro-cli`) or Orchestrator Client UI
- Access to vCenter and NSX Manager REST endpoints
- Service account with permissions outlined in `docs/SDD.md`

## Module Mapping

Map each source directory to a vRO action module:

| Source Directory | vRO Module Path | Description |
|-----------------|----------------|-------------|
| `src/vro/actions/shared/` | `com.enterprise.dfw.shared` | Cross-cutting utilities (Logger, CircuitBreaker, RetryHandler, etc.) |
| `src/vro/actions/tags/` | `com.enterprise.dfw.tags` | Tag CRUD operations and cardinality enforcement |
| `src/vro/actions/groups/` | `com.enterprise.dfw.groups` | Security group membership management |
| `src/vro/actions/dfw/` | `com.enterprise.dfw.policy` | DFW policy validation and rule conflict detection |
| `src/vro/actions/lifecycle/` | `com.enterprise.dfw.lifecycle` | Saga coordinator and lifecycle orchestration |

## Step-by-Step Import

### 1. Create the vRO Project

```bash
vro-cli project create --name "DFW-Automation-Pipeline" \
  --group "com.enterprise.dfw" \
  --version "1.0.0"
```

### 2. Import Shared Utilities First

Import the `shared/` module first since other modules depend on it:

```bash
vro-cli action import --module "com.enterprise.dfw.shared" \
  --file src/vro/actions/shared/Logger.js \
  --name "Logger"

vro-cli action import --module "com.enterprise.dfw.shared" \
  --file src/vro/actions/shared/ErrorFactory.js \
  --name "ErrorFactory"

vro-cli action import --module "com.enterprise.dfw.shared" \
  --file src/vro/actions/shared/ConfigLoader.js \
  --name "ConfigLoader"

vro-cli action import --module "com.enterprise.dfw.shared" \
  --file src/vro/actions/shared/RetryHandler.js \
  --name "RetryHandler"

vro-cli action import --module "com.enterprise.dfw.shared" \
  --file src/vro/actions/shared/CircuitBreaker.js \
  --name "CircuitBreaker"

vro-cli action import --module "com.enterprise.dfw.shared" \
  --file src/vro/actions/shared/CorrelationContext.js \
  --name "CorrelationContext"
```

### 3. Import Domain Modules

```bash
# Tags
vro-cli action import --module "com.enterprise.dfw.tags" \
  --file src/vro/actions/tags/TagCardinalityEnforcer.js \
  --name "TagCardinalityEnforcer"

vro-cli action import --module "com.enterprise.dfw.tags" \
  --file src/vro/actions/tags/TagOperations.js \
  --name "TagOperations"

# DFW
vro-cli action import --module "com.enterprise.dfw.policy" \
  --file src/vro/actions/dfw/DFWPolicyValidator.js \
  --name "DFWPolicyValidator"

vro-cli action import --module "com.enterprise.dfw.policy" \
  --file src/vro/actions/dfw/RuleConflictDetector.js \
  --name "RuleConflictDetector"

# Lifecycle
vro-cli action import --module "com.enterprise.dfw.lifecycle" \
  --file src/vro/actions/lifecycle/SagaCoordinator.js \
  --name "SagaCoordinator"
```

### 4. Configure vRO Configuration Elements

Create a Configuration Element named `DFW-Pipeline-Config` with the following attributes. Use the structure defined in `ConfigLoader.js`:

| Attribute | Type | Value |
|-----------|------|-------|
| `vcenterUrl_NDCNG` | `string` | `https://vcenter-ndcng.company.internal` |
| `vcenterUrl_TULNG` | `string` | `https://vcenter-tulng.company.internal` |
| `nsxUrl_NDCNG` | `string` | `https://nsx-manager-ndcng.company.internal` |
| `nsxUrl_TULNG` | `string` | `https://nsx-manager-tulng.company.internal` |
| `nsxGlobalUrl_NDCNG` | `string` | `https://nsx-global-ndcng.company.internal` |
| `nsxGlobalUrl_TULNG` | `string` | `https://nsx-global-tulng.company.internal` |
| `retryIntervals` | `string` | `5000,15000,45000` |
| `circuitBreakerThreshold` | `number` | `5` |
| `circuitBreakerResetMs` | `number` | `60000` |

**Secrets** must be stored in the vRO credential store or HashiCorp Vault. The `ConfigLoader` uses `{{vault:secret/...}}` reference patterns that are resolved at runtime.

### 5. Create Workflows

Use the Workflow Designer to create three primary workflows:

1. **Day 0 - Provision**: Tag assignment, group membership, DFW policy application
2. **Day 2 - Update**: Tag modification via read-compare-write, group reconciliation
3. **Day N - Decommission**: Tag removal, group cleanup, policy verification

Each workflow should use the `SagaCoordinator` to track steps and enable rollback on failure.

### 6. Configure REST Hosts

Register these REST hosts in vRO:

- **vCenter REST Host**: `https://vcenter-{site}.company.internal` (Basic auth)
- **NSX Manager REST Host**: `https://nsx-manager-{site}.company.internal` (Basic auth)
- **NSX Global Manager REST Host**: `https://nsx-global-{site}.company.internal` (Basic auth)
- **ServiceNow REST Host**: `https://company.service-now.com` (OAuth 2.0)

### 7. Validate the Deployment

After import, run the built-in self-test workflow that:

1. Verifies connectivity to all REST hosts
2. Validates circuit breaker state (all CLOSED)
3. Confirms configuration element is readable
4. Performs a dry-run tag operation on a test VM

## Troubleshooting

| Issue | Resolution |
|-------|-----------|
| `Cannot find module './Logger'` | Ensure shared module is imported first with correct module path |
| `Circuit breaker OPEN` | Reset via `CircuitBreaker.reset()` or wait for `resetTimeout` |
| Authentication failures | Verify credential store entries and vault references |
| vRO version incompatibility | Minimum vRO 8.10; check Rhino JS engine compatibility |
