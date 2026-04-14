# com.dfw.dfw — DFW Policy and Rule Management Actions

Actions for NSX Distributed Firewall policy validation, deployment, conflict detection,
and rule lifecycle management.

## Actions

| Action                  | Source                                             | Description                                                        |
|-------------------------|----------------------------------------------------|--------------------------------------------------------------------|
| DFWPolicyValidator      | src/vro/actions/dfw/DFWPolicyValidator.js          | Validates DFW policy YAML against the enterprise schema            |
| PolicyDeployer          | src/vro/actions/dfw/PolicyDeployer.js              | Deploys validated DFW policies to NSX-T via the Policy API         |
| RuleConflictDetector    | src/vro/actions/dfw/RuleConflictDetector.js        | Detects overlapping or conflicting DFW rules before deployment     |
| RuleLifecycleManager    | src/vro/actions/dfw/RuleLifecycleManager.js        | Manages rule creation, modification, expiration, and deactivation  |
| RuleRegistry            | src/vro/actions/dfw/RuleRegistry.js                | Maintains a central registry of all DFW rules with metadata        |
| RuleReviewScheduler     | src/vro/actions/dfw/RuleReviewScheduler.js         | Schedules periodic rule reviews and notifies rule owners           |
| StaleRuleReaper         | src/vro/actions/dfw/StaleRuleReaper.js             | Identifies and disables stale, expired, or unmanaged DFW rules     |

## Module Path

```
com.dfw.dfw.*
```

## Rule Lifecycle States

```
Requested -> Approved -> Active -> Review Due -> Renewed / Expired -> Deactivated
```

## Dependencies

- com.dfw.shared (ConfigLoader, Logger, RestClient, PayloadValidator)
- com.dfw.adapters (NsxApiAdapter)
- com.dfw.tags (TagOperations)
