# Architecture Overview

This diagram shows the complete NSX DFW Automation Pipeline architecture, including the ServiceNow request layer, vRO orchestration engine with all internal components, and the VMware VCF infrastructure across both data center sites with NSX-T Federation.

```mermaid
flowchart TB
    subgraph ServiceNow["ServiceNow (Zurich Patch 6)"]
        DICT[Enterprise Tag<br/>Dictionary<br/><i>u_tag_dictionary</i>]
        CATALOG[VM Build Request<br/>Catalog Items<br/><i>Day0 / Day2 / DayN</i>]
        CLIENT_SCRIPTS[Client-Side Scripts<br/><i>onLoad / onChange / onSubmit</i>]
        APPROVAL[Approval<br/>Workflow Engine]
        CALLBACK_EP[Scripted REST<br/>Callback Endpoint<br/><i>/api/x_dfw/callback</i>]
        CMDB[CMDB CI<br/>Records]
    end

    subgraph vRO["vRealize Orchestrator 8.x Cluster"]
        REST_LISTENER[REST API Listener<br/><i>POST /trigger</i>]
        VALIDATOR[Payload Validator<br/><i>Schema + Business Rules</i>]
        FACTORY[Orchestrator Factory<br/><i>Day0 / Day2 / DayN</i>]

        subgraph LIFECYCLE["Lifecycle Orchestrators"]
            DAY0[Day0Orchestrator<br/><i>Provision + Tag + Verify</i>]
            DAY2[Day2Orchestrator<br/><i>Impact Analysis + Update</i>]
            DAYN[DayNOrchestrator<br/><i>Dependency Check + Decomm</i>]
        end

        subgraph TAG_LAYER["Tag Management"]
            TAG_OPS[TagOperations<br/><i>Read-Compare-Write</i>]
            TAG_CARD[TagCardinalityEnforcer<br/><i>Single/Multi + Conflicts</i>]
        end

        subgraph DFW_LAYER["DFW Validation"]
            DFW_VAL[DFWPolicyValidator<br/><i>Coverage + Orphan Checks</i>]
            RULE_DETECT[RuleConflictDetector<br/><i>Shadow / Contradict / Dup</i>]
        end

        subgraph RESILIENCE["Resilience Infrastructure"]
            CB[CircuitBreaker<br/><i>Per-Endpoint State Machine</i>]
            RETRY[RetryHandler<br/><i>Exponential Backoff</i>]
            REST_CLIENT[RestClient<br/><i>GET / POST / PATCH / DELETE</i>]
        end

        subgraph ERROR_INFRA["Error & Compensation"]
            SAGA[SagaCoordinator<br/><i>Journal + LIFO Compensate</i>]
            DLQ[Dead Letter Queue<br/><i>Failed Operations Store</i>]
            ERR_FACTORY[ErrorFactory<br/><i>DFW-XXXX Taxonomy</i>]
        end

        subgraph SHARED["Shared Services"]
            LOGGER[Logger<br/><i>Structured JSON</i>]
            CONFIG[ConfigLoader<br/><i>Site Endpoints + Vault Refs</i>]
            CORR[CorrelationContext<br/><i>RITM-{n}-{epoch}</i>]
        end
    end

    subgraph VCF["VMware Cloud Foundation"]
        subgraph NDCNG["NDCNG Data Center"]
            VC_N[vCenter Server<br/>NDCNG]
            NSX_N[NSX Manager<br/>NDCNG Cluster]
            ESXI_N[ESXi Hosts<br/>DFW Kernel Modules]
        end
        subgraph TULNG["TULNG Data Center"]
            VC_T[vCenter Server<br/>TULNG]
            NSX_T[NSX Manager<br/>TULNG Cluster]
            ESXI_T[ESXi Hosts<br/>DFW Kernel Modules]
        end
        NSX_GM[NSX Federation<br/>Global Manager<br/><i>Active / Standby</i>]
    end

    %% ServiceNow internal flow
    DICT -->|Reference Values| CATALOG
    CATALOG --> CLIENT_SCRIPTS
    CLIENT_SCRIPTS -->|Validated Request| APPROVAL
    CALLBACK_EP -->|Update CI| CMDB

    %% ServiceNow to vRO
    APPROVAL -->|REST POST /trigger<br/>TLS 1.2+| REST_LISTENER
    REST_LISTENER --> VALIDATOR
    VALIDATOR --> FACTORY
    FACTORY --> DAY0
    FACTORY --> DAY2
    FACTORY --> DAYN

    %% Orchestrators to subsystems
    DAY0 --> TAG_OPS
    DAY2 --> TAG_OPS
    DAYN --> TAG_OPS
    TAG_OPS --> TAG_CARD
    DAY0 --> DFW_VAL
    DAY2 --> DFW_VAL
    DAYN --> DFW_VAL
    DFW_VAL --> RULE_DETECT

    %% Orchestrators to saga/error
    DAY0 --> SAGA
    DAY2 --> SAGA
    DAYN --> SAGA
    SAGA -.->|On Exhaustion| DLQ

    %% REST call chain
    TAG_OPS --> REST_CLIENT
    DFW_VAL --> REST_CLIENT
    REST_CLIENT --> CB
    CB --> RETRY

    %% vRO to VMware infrastructure
    RETRY -->|VAPI| VC_N
    RETRY -->|VAPI| VC_T
    RETRY -->|REST| NSX_N
    RETRY -->|REST| NSX_T
    DFW_VAL -->|REST /policy/api| NSX_GM

    %% NSX Federation
    NSX_N <-->|Federation Sync| NSX_GM
    NSX_T <-->|Federation Sync| NSX_GM
    NSX_N -->|DFW Rules Push| ESXI_N
    NSX_T -->|DFW Rules Push| ESXI_T

    %% Callbacks
    DAY0 -->|POST /callback| CALLBACK_EP
    DAY2 -->|POST /callback| CALLBACK_EP
    DAYN -->|POST /callback| CALLBACK_EP

    %% Shared services (dotted)
    LOGGER -.->|All Components| LIFECYCLE
    CONFIG -.->|Endpoint Resolution| LIFECYCLE
    CORR -.->|Correlation ID| LOGGER
```

## Component Summary

| Layer | Components | Responsibility |
|-------|-----------|----------------|
| Request | ServiceNow Catalog, Tag Dictionary, Approval Engine | User-facing request intake, validation, approval |
| Orchestration | LifecycleOrchestrator (Day0/Day2/DayN), Factory | Workflow coordination, step sequencing |
| Tag Management | TagOperations, TagCardinalityEnforcer | Idempotent tag CRUD, cardinality/conflict enforcement |
| DFW Validation | DFWPolicyValidator, RuleConflictDetector | Coverage verification, conflict detection |
| Resilience | CircuitBreaker, RetryHandler, RestClient | Fault tolerance, exponential backoff, endpoint protection |
| Error Handling | SagaCoordinator, DLQ, ErrorFactory | Compensation, dead-letter storage, structured errors |
| Shared | Logger, ConfigLoader, CorrelationContext | Logging, configuration, request tracing |
| Infrastructure | vCenter, NSX Manager, NSX Global Manager, ESXi | VM management, tag storage, DFW enforcement |
