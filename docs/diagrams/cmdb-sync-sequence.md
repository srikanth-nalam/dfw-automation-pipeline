# CMDB-Driven Tag Sync Sequence Diagram

## Overview

This diagram shows how a change to a CMDB CI field triggers automatic Day-2 tag synchronization through the `cmdbTagSyncRule` business rule and the vRO DFW-Day2-TagUpdate workflow.

```mermaid
sequenceDiagram
    participant Admin as CMDB Administrator
    participant CMDB as cmdb_ci_vm_instance
    participant BR as cmdbTagSyncRule\nBusiness Rule
    participant VRO as vRO REST API
    participant D2 as Day2Orchestrator
    participant Tags as TagOperations
    participant NSX as NSX Manager
    participant SNOW as ServiceNow

    Admin->>CMDB: Update CI record\n(e.g., change environment\nfrom Development to Production)

    CMDB->>BR: Business rule fires\n(after update trigger)

    BR->>BR: Detect changed fields
    Note over BR: Compare previous values\nto current values for\nmonitored fields:\nenvironment, application, tier

    BR->>BR: Assemble Day-2 payload
    Note over BR: Build JSON payload with\ncorrelationId, requestType,\nvmId, site, newTags

    BR->>BR: Log change detection\nin CI work notes

    BR->>VRO: POST /workflows/{id}/executions\n(Day-2 tag update payload)
    VRO-->>BR: HTTP 202 Accepted\n(executionId)

    VRO->>D2: execute(payload)
    D2->>Tags: getCurrentTags(vmId, site)
    Tags->>NSX: GET /fabric/.../tags
    NSX-->>Tags: Current NSX tags

    D2->>Tags: updateTags(vmId, newTags, site)
    Note over Tags: Compute delta between\ncurrent NSX tags and\nnew CMDB-derived tags

    Tags->>NSX: PATCH /fabric/.../tags
    NSX-->>Tags: 200 OK

    D2->>D2: Verify tag propagation
    D2->>D2: Verify group membership
    D2->>D2: Validate DFW coverage

    D2->>SNOW: POST /dfw_callback\n(status: SUCCESS)
    Note over SNOW: RITM updated with\ntag sync results and\ncorrelation ID
```

## Monitored CMDB Fields

| Field | NSX Tag | Sync Behavior |
|-------|---------|---------------|
| `environment` | Environment | Direct value mapping |
| `u_application_ci` | AppCI | Maps CMDB app CI sys_id to application code |
| `u_system_role` | SystemRole | Direct value mapping |
| `u_security_zone` | SecurityZone | Direct value mapping |
| `u_region` | Region | Direct value mapping |

## Business Rule Configuration

| Setting | Value |
|---------|-------|
| Table | `cmdb_ci_vm_instance` |
| When | After update |
| Filter | Monitored fields changed AND `operational_status=1` |
| Order | 200 |
