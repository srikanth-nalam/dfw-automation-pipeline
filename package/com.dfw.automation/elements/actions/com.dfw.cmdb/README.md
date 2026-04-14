# com.dfw.cmdb — CMDB Validation Actions

Actions for validating CMDB configuration item data against NSX-T tag state.

## Actions

| Action          | Source                                    | Description                                                         |
|-----------------|-------------------------------------------|---------------------------------------------------------------------|
| CMDBValidator   | src/vro/actions/cmdb/CMDBValidator.js     | Cross-references CMDB CI records with actual NSX-T tag assignments  |

## Module Path

```
com.dfw.cmdb.*
```

## Validation Checks

1. **Tag Completeness** — All 5 required tags (Region, SecurityZone, Environment, AppCI, SystemRole) are present on the VM in NSX-T.
2. **CMDB-NSX Consistency** — Tag values in NSX-T match the corresponding CMDB CI fields.
3. **CI Existence** — The VM exists in the CMDB as an active configuration item.
4. **AppCI Validity** — The AppCI tag references an active application in the CMDB portfolio.

## Dependencies

- com.dfw.shared (ConfigLoader, Logger, RestClient)
- com.dfw.adapters (NsxApiAdapter, VcenterApiAdapter)
