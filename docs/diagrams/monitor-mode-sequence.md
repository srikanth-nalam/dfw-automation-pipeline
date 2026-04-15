# Monitor-Mode Deployment Sequence

## Overview

This diagram shows the monitor-mode deployment workflow, where firewall rules are initially deployed with permissive ALLOW+LOG actions to observe real traffic patterns before promoting to full enforcement. The operator triggers monitor-mode, reviews logged traffic, and then promotes the policy to enforce original actions.

```mermaid
sequenceDiagram
    participant Op as Operator
    participant PD as PolicyDeployer
    participant NSX as NSX Manager
    participant AL as Audit Log

    Op->>PD: triggerMonitorModeDeploy(policyId)

    rect rgb(230, 245, 255)
        Note over PD: Phase 1 -- Save and Override Actions
        PD->>PD: deployMonitorMode(policyId)
        PD->>PD: Save original rule actions\nto actionMap keyed by ruleId
        PD->>PD: Set all rule actions\nto ALLOW with logging enabled
    end

    rect rgb(230, 255, 230)
        Note over PD,NSX: Phase 2 -- Deploy Monitor-Mode Policy
        PD->>NSX: PATCH /policy/api/v1/infra/domains/default\n/security-policies/{policyId}
        NSX-->>PD: 200 OK -- Policy applied\nin monitor mode
        PD->>AL: Log monitor-mode deployment\n(policyId, timestamp, operator)
        AL-->>PD: Audit entry recorded
    end

    rect rgb(255, 250, 230)
        Note over NSX: Phase 3 -- Traffic Observation
        Note over NSX: Traffic flows through\nwith all rules set to ALLOW.\nAll matched traffic is logged.
        NSX->>AL: Stream traffic log entries\n(srcIP, dstIP, port, ruleId, action=ALLOW)
    end

    Op->>AL: Review logged traffic patterns
    AL-->>Op: Traffic log summary\n(hit counts per rule,\nunexpected flows flagged)

    rect rgb(230, 245, 255)
        Note over Op,NSX: Phase 4 -- Promote to Enforce
        Op->>PD: promoteToEnforce(policyId)
        PD->>NSX: GET /policy/api/v1/infra/domains/default\n/security-policies/{policyId}
        NSX-->>PD: Current monitor-mode policy
        PD->>PD: Restore original actions\nfrom saved actionMap
        PD->>NSX: PATCH /policy/api/v1/infra/domains/default\n/security-policies/{policyId}
        NSX-->>PD: 200 OK -- Policy enforced\nwith original actions
        PD->>AL: Log enforcement promotion\n(policyId, timestamp, operator)
        AL-->>PD: Audit entry recorded
    end

    PD-->>Op: Promotion complete\n(policyId, rulesRestored, status=ENFORCED)
```

## Workflow Summary

| Phase | Description | Key Action |
|-------|-------------|------------|
| Save and Override | Original rule actions preserved in memory map | `deployMonitorMode` stores action per ruleId |
| Deploy Monitor-Mode | Policy pushed to NSX with ALLOW+LOG on all rules | PATCH security policy |
| Traffic Observation | Real traffic flows through; all matches logged | Operator reviews traffic logs |
| Promote to Enforce | Original actions restored and policy redeployed | `promoteToEnforce` restores from actionMap |
