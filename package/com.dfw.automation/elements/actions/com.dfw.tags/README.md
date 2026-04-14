# com.dfw.tags — Tag Management Actions

Actions for NSX-T tag lifecycle management, cardinality enforcement, and compliance verification.

## Actions

| Action                    | Source                                          | Description                                                      |
|---------------------------|-------------------------------------------------|------------------------------------------------------------------|
| TagOperations             | src/vro/actions/tags/TagOperations.js           | Core CRUD operations for NSX-T VM tags via the NSX Policy API    |
| TagCardinalityEnforcer    | src/vro/actions/tags/TagCardinalityEnforcer.js  | Validates single-value vs multi-value cardinality constraints     |
| TagPropagationVerifier    | src/vro/actions/tags/TagPropagationVerifier.js  | Confirms tags propagated to NSX-T after vCenter assignment        |
| UntaggedVMScanner         | src/vro/actions/tags/UntaggedVMScanner.js       | Discovers VMs missing required tags from the 5-tag model          |

## Module Path

```
com.dfw.tags.*
```

## Tag Model (5 Required Categories)

| Category      | NSX Scope     | Cardinality   |
|---------------|---------------|---------------|
| Region        | Region        | single-value  |
| SecurityZone  | SecurityZone  | single-value  |
| Environment   | Environment   | single-value  |
| AppCI         | AppCI         | single-value  |
| SystemRole    | SystemRole    | single-value  |

## Dependencies

- com.dfw.shared (ConfigLoader, Logger, RestClient)
- com.dfw.adapters (NsxApiAdapter)
