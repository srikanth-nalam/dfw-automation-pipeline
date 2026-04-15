# Architecture Overview

This diagram shows the complete NSX DFW Automation Pipeline architecture, including the ServiceNow request layer, vRO orchestration engine with all internal components, and the VMware VCF infrastructure across both data center sites with NSX-T Federation.

The architecture is split into two sub-diagrams for readability.

### ServiceNow and vRO Orchestration

This diagram covers the ServiceNow request layer, the vRO orchestration engine with all internal subsystems, and the connections between them.

```mermaid
flowchart TB
    subgraph ServiceNow["ServiceNow (Zurich Patch 6)"]
        DICT["Enterprise Tag Dictionary\nu_tag_dictionary"]
        CATALOG["VM Build Request Catalog Items\nDay0 / Day2 / DayN"]
        CLIENT_SCRIPTS["Client-Side Scripts\nonLoad / onChange / onSubmit"]
        APPROVAL["Approval\nWorkflow Engine"]
        CALLBACK_EP["Scripted REST Callback Endpoint\n/api/x_dfw/callback"]
        CMDB["CMDB CI\nRecords"]
    end

    subgraph vRO["vRealize Orchestrator 8.x Cluster"]
        REST_LISTENER["REST API Listener\nPOST /trigger"]
        VALIDATOR["Payload Validator\nSchema + Business Rules"]
        FACTORY["Orchestrator Factory\nDay0 / Day2 / DayN"]

        subgraph LIFECYCLE["Lifecycle Orchestrators"]
            DAY0["Day0Orchestrator\nProvision + Tag + Verify"]
            DAY2["Day2Orchestrator\nImpact Analysis + Update"]
            DAYN["DayNOrchestrator\nDependency Check + Decomm"]
        end

        subgraph TAG_LAYER["Tag Management"]
            TAG_OPS["TagOperations\nRead-Compare-Write"]
            TAG_CARD["TagCardinalityEnforcer\nSingle/Multi + Conflicts"]
        end

        subgraph DFW_LAYER["DFW Validation"]
            DFW_VAL["DFWPolicyValidator\nCoverage + Orphan Checks"]
            RULE_DETECT["RuleConflictDetector\nShadow / Contradict / Dup"]
        end

        subgraph RESILIENCE["Resilience Infrastructure"]
            CB["CircuitBreaker\nPer-Endpoint State Machine"]
            RETRY["RetryHandler\nExponential Backoff"]
            REST_CLIENT["RestClient\nGET / POST / PATCH / DELETE"]
        end

        subgraph ERROR_INFRA["Error and Compensation"]
            SAGA["SagaCoordinator\nJournal + LIFO Compensate"]
            DLQ["Dead Letter Queue\nFailed Operations Store"]
            ERR_FACTORY["ErrorFactory\nDFW-XXXX Taxonomy"]
        end

        subgraph SHARED["Shared Services"]
            LOGGER["Logger\nStructured JSON"]
            CONFIG["ConfigLoader\nSite Endpoints + Vault Refs"]
            CORR["CorrelationContext\nRITM-{n}-{epoch}"]
        end
    end

    %% ServiceNow internal flow
    DICT -->|Reference Values| CATALOG
    CATALOG --> CLIENT_SCRIPTS
    CLIENT_SCRIPTS -->|Validated Request| APPROVAL
    CALLBACK_EP -->|Update CI| CMDB

    %% ServiceNow to vRO
    APPROVAL -->|"REST POST /trigger TLS 1.2+"| REST_LISTENER
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

    %% Shared services (dotted)
    LOGGER -.->|All Components| LIFECYCLE
    CONFIG -.->|Endpoint Resolution| LIFECYCLE
    CORR -.->|Correlation ID| LOGGER
```

### VMware Infrastructure and Cross-System Connections

This diagram covers the VMware Cloud Foundation infrastructure (vCenter, NSX, ESXi) across both data center sites, the NSX Federation Global Manager, and the connections from vRO into the infrastructure and back to ServiceNow.

```mermaid
flowchart TB
    %% Re-declare referenced vRO and ServiceNow nodes
    RETRY["RetryHandler"]
    DFW_VAL["DFWPolicyValidator"]
    DAY0["Day0Orchestrator"]
    DAY2["Day2Orchestrator"]
    DAYN["DayNOrchestrator"]
    CALLBACK_EP["Scripted REST Callback Endpoint"]

    subgraph VCF["VMware Cloud Foundation"]
        subgraph NDCNG["NDCNG Data Center"]
            VC_N["vCenter Server\nNDCNG"]
            NSX_N["NSX Manager\nNDCNG Cluster"]
            ESXI_N["ESXi Hosts\nDFW Kernel Modules"]
        end
        subgraph TULNG["TULNG Data Center"]
            VC_T["vCenter Server\nTULNG"]
            NSX_T["NSX Manager\nTULNG Cluster"]
            ESXI_T["ESXi Hosts\nDFW Kernel Modules"]
        end
        NSX_GM["NSX Federation\nGlobal Manager\nActive / Standby"]
    end

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
