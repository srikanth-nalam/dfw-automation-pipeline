# 5-Tag Security Taxonomy Model

## Overview

This diagram shows the 5-tag mandatory security taxonomy, its mapping to NSX scopes and security group patterns, and the relationship between tags and DFW policy constructs.

```mermaid
classDiagram
    class MandatoryTags {
        <<5-Tag Taxonomy>>
        +Region : single
        +SecurityZone : single
        +Environment : single
        +AppCI : single
        +SystemRole : single
    }

    class OptionalTags {
        <<Governance Tags>>
        +Compliance : multi
        +DataClassification : single
        +CostCenter : single
    }

    class RegionScope {
        <<NSX Scope: Region>>
        NDCNG
        TULNG
        maps to SG-Region-NDCNG
        maps to SG-Region-TULNG
    }

    class SecurityZoneScope {
        <<NSX Scope: SecurityZone>>
        DMZ
        Internal
        Restricted
        Management
        maps to SG-Zone-DMZ
        maps to SG-Zone-Internal
    }

    class EnvironmentScope {
        <<NSX Scope: Environment>>
        Production
        PreProduction
        UAT
        Development
        Sandbox
        DR
        maps to SG-Env-Production
        maps to SG-Env-Development
    }

    class AppCIScope {
        <<NSX Scope: AppCI>>
        APP001
        APP002
        APP003
        maps to SG-App-APP001
    }

    class SystemRoleScope {
        <<NSX Scope: SystemRole>>
        WebServer
        AppServer
        Database
        Middleware
        DNS
        Monitoring
        maps to SG-Role-WebServer
        maps to SG-Role-Database
    }

    class DFWPolicies {
        <<DFW Policy Targets>>
        Zone Isolation Rules
        Environment Isolation Rules
        Application Micro-Segmentation
        Role-Based Access Control
        Cross-Site Policies
    }

    MandatoryTags --> RegionScope : Region tag
    MandatoryTags --> SecurityZoneScope : SecurityZone tag
    MandatoryTags --> EnvironmentScope : Environment tag
    MandatoryTags --> AppCIScope : AppCI tag
    MandatoryTags --> SystemRoleScope : SystemRole tag

    RegionScope --> DFWPolicies : Cross-Site Policies
    SecurityZoneScope --> DFWPolicies : Zone Isolation Rules
    EnvironmentScope --> DFWPolicies : Environment Isolation Rules
    AppCIScope --> DFWPolicies : Application Micro-Segmentation
    SystemRoleScope --> DFWPolicies : Role-Based Access Control

    MandatoryTags -- OptionalTags : Extended with
```

## Tag-to-NSX Mapping

```mermaid
flowchart LR
    subgraph Tags ["VM Tags"]
        R["Region\n(e.g., NDCNG)"]
        SZ["SecurityZone\n(e.g., Internal)"]
        E["Environment\n(e.g., Production)"]
        A["AppCI\n(e.g., APP001)"]
        SR["SystemRole\n(e.g., WebServer)"]
    end

    subgraph NSXScopes ["NSX Scopes"]
        RS["Scope: Region"]
        SZS["Scope: SecurityZone"]
        ES["Scope: Environment"]
        AS["Scope: AppCI"]
        SRS["Scope: SystemRole"]
    end

    subgraph Groups ["Security Groups"]
        G1["SG-Region-NDCNG"]
        G2["SG-Zone-Internal"]
        G3["SG-Env-Production"]
        G4["SG-App-APP001"]
        G5["SG-Role-WebServer"]
    end

    subgraph Policies ["DFW Policies"]
        P1["Cross-Site\nIsolation"]
        P2["Zone-Based\nAccess Control"]
        P3["Environment\nIsolation"]
        P4["Application\nMicro-Segmentation"]
        P5["Role-Based\nAccess Control"]
    end

    R --> RS --> G1 --> P1
    SZ --> SZS --> G2 --> P2
    E --> ES --> G3 --> P3
    A --> AS --> G4 --> P4
    SR --> SRS --> G5 --> P5
```

## Taxonomy Details

### Mandatory Tags (5)

| Tag | Cardinality | NSX Scope | Purpose | Example Values |
|-----|-------------|-----------|---------|----------------|
| Region | Single | Region | Geographic site identifier | NDCNG, TULNG |
| SecurityZone | Single | SecurityZone | Network security zone classification | DMZ, Internal, Restricted, Management |
| Environment | Single | Environment | Deployment lifecycle stage | Production, Pre-Production, UAT, Development, Sandbox, DR |
| AppCI | Single | AppCI | CMDB application CI reference | APP001, APP002, APP003 |
| SystemRole | Single | SystemRole | Workload function identifier | WebServer, AppServer, Database, Middleware, DNS, Monitoring |

### Optional Tags (3)

| Tag | Cardinality | NSX Scope | Purpose | Example Values |
|-----|-------------|-----------|---------|----------------|
| Compliance | Multi | Compliance | Regulatory framework applicability | PCI, HIPAA, SOX, None |
| DataClassification | Single | DataClassification | Data sensitivity level | Public, Internal, Confidential, Restricted |
| CostCenter | Single | CostCenter | Financial chargeback identifier | CC-IT-INFRA-001, CC-SEC-OPS-002 |
