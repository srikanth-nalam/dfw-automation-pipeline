# com.dfw.groups — Security Group Actions

Actions for NSX-T dynamic security group membership verification and reconciliation.

## Actions

| Action                      | Source                                                 | Description                                                       |
|-----------------------------|--------------------------------------------------------|-------------------------------------------------------------------|
| GroupMembershipVerifier     | src/vro/actions/groups/GroupMembershipVerifier.js      | Validates that tagged VMs appear in expected NSX security groups   |
| GroupReconciler             | src/vro/actions/groups/GroupReconciler.js              | Reconciles group membership drift and reports discrepancies        |
| OrphanGroupCleaner          | src/vro/actions/groups/OrphanGroupCleaner.js           | Detects and removes empty security groups not referenced by rules  |

## Module Path

```
com.dfw.groups.*
```

## How Groups Work

NSX dynamic security groups use tag-based membership criteria. When a VM receives
its 5-tag assignment (Region, SecurityZone, Environment, AppCI, SystemRole), it
automatically joins the corresponding security groups. These actions verify that
the dynamic membership resolved correctly and reconcile any discrepancies.

## Dependencies

- com.dfw.shared (ConfigLoader, Logger, RestClient)
- com.dfw.adapters (NsxApiAdapter)
