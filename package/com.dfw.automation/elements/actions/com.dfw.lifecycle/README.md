# com.dfw.lifecycle — Lifecycle Orchestrator Actions

Orchestrator actions that coordinate the end-to-end DFW automation lifecycle, from
Day-0 provisioning through Day-N decommissioning, including bulk operations, drift
detection, and migration workflows.

## Actions

| Action                         | Source                                                       | Description                                                          |
|--------------------------------|--------------------------------------------------------------|----------------------------------------------------------------------|
| LifecycleOrchestrator          | src/vro/actions/lifecycle/LifecycleOrchestrator.js           | Base orchestrator with common lifecycle coordination logic            |
| Day0Orchestrator               | src/vro/actions/lifecycle/Day0Orchestrator.js                | Day-0 provisioning — tag assignment, group verification, policy push |
| Day2Orchestrator               | src/vro/actions/lifecycle/Day2Orchestrator.js                | Day-2 tag updates — change detection, re-tagging, group re-eval      |
| DayNOrchestrator               | src/vro/actions/lifecycle/DayNOrchestrator.js                | Day-N decommissioning — tag cleanup, group removal, policy archival  |
| BulkTagOrchestrator            | src/vro/actions/lifecycle/BulkTagOrchestrator.js             | Bulk tag remediation for multiple VMs in a single transaction        |
| DriftDetectionWorkflow         | src/vro/actions/lifecycle/DriftDetectionWorkflow.js          | Scheduled drift scan comparing CMDB state vs NSX-T tag state         |
| ImpactAnalysisAction           | src/vro/actions/lifecycle/ImpactAnalysisAction.js            | Pre-change impact analysis for tag and rule modifications            |
| LegacyOnboardingOrchestrator   | src/vro/actions/lifecycle/LegacyOnboardingOrchestrator.js    | Brownfield VM onboarding — discovers and tags existing VMs           |
| MigrationVerifier              | src/vro/actions/lifecycle/MigrationVerifier.js               | Verifies tag and policy integrity after cross-site VM migration      |
| MigrationBulkTagger            | src/vro/actions/lifecycle/MigrationBulkTagger.js             | Bulk re-tagging for VMs migrated between sites or environments       |
| QuarantineOrchestrator         | src/vro/actions/lifecycle/QuarantineOrchestrator.js          | Emergency quarantine — isolates compromised VMs via DFW rules        |
| SagaCoordinator                | src/vro/actions/lifecycle/SagaCoordinator.js                 | Distributed saga pattern for multi-step workflow compensation        |
| DeadLetterQueue                | src/vro/actions/lifecycle/DeadLetterQueue.js                 | Failed request capture for manual review and retry                   |
| PhantomVMDetector              | src/vro/actions/lifecycle/PhantomVMDetector.js               | Detects VMs present in NSX but absent from vCenter                   |
| UnregisteredVMOnboarder        | src/vro/actions/lifecycle/UnregisteredVMOnboarder.js         | Onboards unregistered VMs discovered during hygiene sweeps           |
| NSXHygieneOrchestrator         | src/vro/actions/lifecycle/NSXHygieneOrchestrator.js          | Orchestrates full hygiene sweep across all cleanup sub-modules       |

## Module Path

```
com.dfw.lifecycle.*
```

## Workflow Dispatch

```
ServiceNow RITM  -->  vRO Trigger  -->  LifecycleOrchestrator.dispatch()
                                              |
                   +----------+----------+----+----+----------+
                   |          |          |         |          |
                Day0       Day2       DayN     BulkTag   Quarantine
```

## Dependencies

- com.dfw.shared (all shared actions)
- com.dfw.tags (TagOperations, TagCardinalityEnforcer, TagPropagationVerifier)
- com.dfw.groups (GroupMembershipVerifier, GroupReconciler)
- com.dfw.dfw (DFWPolicyValidator, PolicyDeployer)
- com.dfw.cmdb (CMDBValidator)
- com.dfw.adapters (NsxApiAdapter, SnowPayloadAdapter, VcenterApiAdapter)
