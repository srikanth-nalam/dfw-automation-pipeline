# Migration Bulk Tag Sequence Diagram

## Overview

This diagram shows the end-to-end flow of the MigrationBulkTagger processing a Greenzone VM migration wave, from manifest loading through post-migration verification.

```mermaid
sequenceDiagram
    participant Op as Migration Operator
    participant MBT as MigrationBulkTagger
    participant CMDB as ServiceNow CMDB
    participant TD as Tag Dictionary
    participant NSX as NSX Manager
    participant RL as RateLimiter
    participant Saga as SagaCoordinator
    participant GMV as GroupMembershipVerifier
    participant SNOW as ServiceNow

    Op->>MBT: loadManifest(manifestJson)
    MBT->>MBT: Parse manifest structure
    MBT->>MBT: Identify waves and VM entries
    MBT-->>Op: Manifest loaded\n(waveCount, totalVMs)

    Op->>MBT: preValidate(waveId)
    MBT->>CMDB: Verify CMDB CI records exist
    CMDB-->>MBT: CI records found
    MBT->>TD: Validate tag values against dictionary
    TD-->>MBT: Tag values valid
    MBT->>NSX: Verify VMs exist in NSX fabric
    NSX-->>MBT: NSX VM external IDs confirmed
    MBT->>MBT: Check for tag conflicts
    MBT-->>Op: Validation result\n(valid, warnings, errors)

    Op->>MBT: executeWave(waveId)
    MBT->>Saga: begin(waveCorrelationId)

    loop For each VM in wave
        MBT->>RL: acquire(1)
        RL-->>MBT: Token acquired
        MBT->>NSX: Read current tags
        NSX-->>MBT: Current tag state
        MBT->>MBT: Compute tag delta
        MBT->>NSX: PATCH tags (apply manifest tags)
        NSX-->>MBT: Tags applied
        MBT->>Saga: recordStep(vmName, rollbackFn)
        MBT->>SNOW: Progress callback\n(completed/total)
    end

    MBT-->>Op: Wave execution result\n(succeeded, failed, skipped)

    Op->>MBT: verifyPostMigration(waveId)
    loop For each VM in wave
        MBT->>NSX: Read current tags at new location
        NSX-->>MBT: Tag state post-migration
        MBT->>MBT: Compare against expected tags
        alt Tags missing
            MBT->>NSX: Re-apply missing tags
            NSX-->>MBT: Tags restored
        end
        MBT->>GMV: verifyMembership(vmId, site)
        GMV-->>MBT: Group membership confirmed
    end
    MBT-->>Op: Verification result

    Op->>MBT: generateWaveReport(waveId)
    MBT-->>Op: Wave report\n(pre-validation, execution,\npost-migration, per-VM status)
```

## Manifest Structure

The migration manifest defines waves of VMs with their target tag assignments:

| Field | Description |
|-------|-------------|
| `manifestId` | Unique identifier for the migration event |
| `waves[].waveId` | Identifier for each migration wave |
| `waves[].scheduledDate` | Planned execution date for the wave |
| `waves[].vms[].vmName` | VM name as registered in vCenter |
| `waves[].vms[].cmdbCi` | Corresponding CMDB CI identifier |
| `waves[].vms[].tags` | Target tag assignments (Region, SecurityZone, Environment, AppCI, SystemRole) |
