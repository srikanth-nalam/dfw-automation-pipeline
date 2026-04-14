# Rule Request Pipeline Sequence Diagram

## Overview

This diagram shows how DFW rule requests from four different intake channels are normalized and processed through the unified RuleRequestPipeline into the RuleLifecycleManager.

```mermaid
sequenceDiagram
    participant Cat as ServiceNow Catalog
    participant Onb as Onboarding Workflow
    participant Emg as Emergency Request
    participant Aud as Audit Finding
    participant RRP as RuleRequestPipeline
    participant PV as PayloadValidator
    participant RR as RuleRegistry
    participant RLM as RuleLifecycleManager
    participant SNOW as ServiceNow

    Note over Cat,Aud: Four Intake Channels

    Cat->>RRP: submitRequest("Catalog", catalogPayload)
    Note over Cat: User submits DFW Rule\nRequest catalog item

    Onb->>RRP: submitRequest("Onboarding", onboardPayload)
    Note over Onb: LegacyOnboarding or\nMigrationBulkTagger\ncreates rule automatically

    Emg->>RRP: submitRequest("Emergency", emergencyPayload)
    Note over Emg: Break-glass security\nincident response

    Aud->>RRP: submitRequest("Audit", auditPayload)
    Note over Aud: Compliance scan or\nRuleReviewScheduler\nfinds gap

    RRP->>RRP: validateSource(source)
    RRP->>PV: validate(payload, sourceSchema)
    PV-->>RRP: Validation result

    RRP->>RRP: normalizePayload(source, rawPayload)
    Note over RRP: Transform source-specific\nformat to common\nrule definition

    RRP->>RR: registerRule(normalizedDefinition)
    RR->>RR: getNextId()
    RR-->>RRP: ruleId = DFW-R-XXXX

    RRP->>RLM: transitionState(ruleId, REQUESTED, system, source)
    RLM-->>RRP: State initialized

    RRP->>SNOW: Create tracking record\nwith ruleId and source
    SNOW-->>RRP: Tracking record created

    RRP-->>Cat: {ruleId, state: REQUESTED}
    RRP-->>Onb: {ruleId, state: REQUESTED}
    RRP-->>Emg: {ruleId, state: REQUESTED}
    RRP-->>Aud: {ruleId, state: REQUESTED}
```

## Intake Channel Details

| Channel | Source | Trigger | Priority | Approval Required |
|---------|--------|---------|----------|-------------------|
| Catalog | ServiceNow Catalog | User submits DFW Rule Request item | Normal | Yes -- Security Architect |
| Onboarding | LegacyOnboardingOrchestrator or MigrationBulkTagger | Automated rule creation during VM onboarding | Normal | Yes -- Security Architect |
| Emergency | Security incident response | Break-glass emergency rule request | High | Post-hoc review only |
| Audit | RuleReviewScheduler or compliance scan | Audit finding requires rule creation or modification | Normal | Yes -- Security Architect |
