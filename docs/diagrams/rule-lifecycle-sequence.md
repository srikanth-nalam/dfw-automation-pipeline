# Rule Lifecycle Sequence Diagram

## Overview

This diagram shows the full DFW rule lifecycle state machine from initial request through enforcement, periodic review, and eventual expiry or rollback.

```mermaid
sequenceDiagram
    participant Requester as Rule Requester
    participant RRP as RuleRequestPipeline
    participant RR as RuleRegistry
    participant RLM as RuleLifecycleManager
    participant IA as ImpactAnalysisAction
    participant Approver as Security Architect
    participant NSX as NSX Manager
    participant RRS as RuleReviewScheduler
    participant Owner as Rule Owner

    Requester->>RRP: submitRequest(source, payload)
    RRP->>RRP: normalizePayload(source, payload)
    RRP->>RR: registerRule(ruleDefinition)
    RR-->>RRP: ruleId = DFW-R-0042
    RRP->>RLM: transitionState(ruleId, REQUESTED)
    Note over RLM: State: REQUESTED

    RLM->>IA: analyzeImpact(ruleId)
    IA->>IA: Evaluate affected VMs,\ngroups, and policies
    IA-->>RLM: Impact report
    RLM->>RLM: transitionState(ruleId, IMPACT_ANALYZED)
    Note over RLM: State: IMPACT_ANALYZED

    RLM->>Approver: Request approval with impact report
    Approver-->>RLM: approveRule(ruleId)
    RLM->>RLM: transitionState(ruleId, APPROVED)
    Note over RLM: State: APPROVED

    RLM->>NSX: Deploy rule in monitor mode\n(action=ALLOW+LOG)
    NSX-->>RLM: Rule deployed
    RLM->>RLM: transitionState(ruleId, MONITOR_MODE)
    Note over RLM: State: MONITOR_MODE\n7-day validation period

    RLM->>RLM: Validation period elapsed
    RLM->>RLM: transitionState(ruleId, VALIDATED)
    Note over RLM: State: VALIDATED

    RLM->>NSX: Change action to ENFORCE
    NSX-->>RLM: Rule enforced on data plane
    RLM->>RLM: transitionState(ruleId, ENFORCED)
    Note over RLM: State: ENFORCED

    RRS->>RR: scanForReviewDue()
    RR-->>RRS: Rules approaching expiry
    RRS->>RLM: transitionState(ruleId, REVIEW_DUE)
    Note over RLM: State: REVIEW_DUE

    RRS->>Owner: notifyOwners(dueRules)
    Owner-->>RLM: certifyRule(ruleId)
    RLM->>RLM: transitionState(ruleId, CERTIFIED)
    Note over RLM: State: CERTIFIED

    RLM->>RLM: transitionState(ruleId, ENFORCED)
    Note over RLM: Returns to ENFORCED\nuntil next review cycle

    Note over RRS: If owner does not certify\nwithin grace period:
    RRS->>RLM: autoExpire(ruleId)
    RLM->>RLM: transitionState(ruleId, EXPIRED)
    Note over RLM: State: EXPIRED\nRule disabled in NSX
```

## State Machine Summary

| State | Description | Valid Transitions |
|-------|-------------|-------------------|
| REQUESTED | Initial submission | IMPACT_ANALYZED |
| IMPACT_ANALYZED | Impact report generated | APPROVED, ROLLED_BACK |
| APPROVED | Approved by Security Architect | MONITOR_MODE |
| MONITOR_MODE | Deployed with logging only | VALIDATED, ROLLED_BACK |
| VALIDATED | Monitoring period passed | ENFORCED |
| ENFORCED | Active on data plane | CERTIFIED, REVIEW_DUE, ROLLED_BACK |
| CERTIFIED | Re-certified by owner | ENFORCED |
| REVIEW_DUE | Approaching expiry | CERTIFIED, EXPIRED |
| EXPIRED | Not re-certified, disabled | REQUESTED |
| ROLLED_BACK | Removed due to incident | REQUESTED |
