# ADR-002: Tag Governance Model — Centralized Enterprise Tag Dictionary

**Status:** Accepted
**Date:** 2026-03-21
**Deciders:** Senior Cloud Security Architect, Security Architect, ServiceNow Platform Owner

## Context

VMware NSX Distributed Firewall (DFW) policies rely on tag-based dynamic security groups to determine which VMs are subject to which firewall rules. The correctness and consistency of tags directly determines whether VMs receive the intended network security posture. Inconsistent, misspelled, or unauthorized tags can result in VMs being placed in incorrect security groups — either exposing them to unauthorized traffic or blocking legitimate communication.

### The Problem

Without governance, tags become an uncontrolled namespace. Evidence from the current environment shows:

- **13 variations** of the "Production" environment tag across the VM inventory (e.g., "Production", "Prod", "PROD", "production", "Prd")
- **No cardinality enforcement** — some VMs have multiple Environment tags, causing unpredictable group membership
- **Free-text tag values** allow any string, leading to typos that silently bypass DFW policies
- **No mandatory tag enforcement** — approximately 20% of VMs have no environment or application tags, leaving them outside DFW policy coverage
- **No conflict detection** — VMs tagged with both PCI compliance and Sandbox environment exist, violating isolation requirements

### Requirements

The pipeline must ensure that:

1. All tags applied to VMs conform to a controlled vocabulary with enumerated allowed values.
2. Mandatory tags (Application, Tier, Environment, DataClassification, CostCenter) are present at provisioning time (Day 0) and maintained through lifecycle changes (Day 2).
3. Tag cardinality rules are enforced — single-value categories (Application, Tier, Environment, DataClassification, CostCenter) allow exactly one value; multi-value categories (Compliance) allow zero or more values.
4. Free-text tag entry is completely prohibited to prevent drift and inconsistency.
5. Conflict rules are enforced — certain tag combinations are forbidden (PCI+Sandbox, HIPAA+Sandbox, Confidential without compliance tag).
6. The tag vocabulary is maintainable by the security and infrastructure teams without code changes.
7. Validation occurs at both the request layer (ServiceNow) and the execution layer (vRO) for defense-in-depth.

### Options Considered

**Option A: Centralized Tag Dictionary in ServiceNow**
A custom table (`u_tag_dictionary`) in ServiceNow defining valid tag categories, allowed values, cardinality rules, and mandatory flags. Catalog forms reference this dictionary for dropdown selections. vRO validates incoming payloads against the same dictionary data.

**Option B: vCenter Tag Policy**
Use vCenter's native tag categories with cardinality enforcement at the vCenter level. Tag categories are defined with single-cardinality or multi-cardinality constraints. However, vCenter does not support value-level validation (any string can be a tag value within a category) or cross-category conflict rules.

**Option C: External CMDB-driven Approach**
Derive tags from CMDB CI attributes at provisioning time. Tag values are computed from the CI's application, environment, and classification attributes. However, this creates a tight coupling between CMDB data quality and security posture, and CMDB attributes are not always maintained with security-grade accuracy.

**Option D: Free-form Tagging with Post-hoc Validation**
Allow any tags during provisioning and run periodic compliance scans to detect violations. Non-compliant VMs are flagged for remediation. This is the current state and is the source of the problems described above.

## Decision

We will implement a **centralized Enterprise Tag Dictionary as a custom table in ServiceNow**, with mandatory tag enforcement at the catalog submission layer and runtime validation in vRO.

The Tag Dictionary table (`u_tag_dictionary`) defines each valid tag category with:
- **Category name** (e.g., Application, Tier, Environment)
- **Allowed values** (enumerated list per category)
- **Cardinality type** (single or multi)
- **Mandatory flag** (required at Day 0 provisioning)
- **Description** and **owner** for governance tracking

### Implementation Architecture

**ServiceNow Catalog Layer:**
- Catalog item variable sets reference the Tag Dictionary via GlideRecord lookups.
- `onLoad` client script sets defaults (DataClassification=Internal, Compliance=None).
- `onChange` client script validates selections in real-time (conflict detection, cardinality checks).
- `onSubmit` client script performs final validation before RITM creation.
- Users select from dropdowns only — no free-text input fields for tag values.

**vRO Validation Layer:**
- `PayloadValidator` validates incoming tag sets against the dictionary definition.
- `TagCardinalityEnforcer` enforces cardinality rules and conflict detection independently of ServiceNow.
- This dual validation provides defense-in-depth — even if ServiceNow validation is bypassed (API integration, bulk import), vRO catches invalid tags before they reach vCenter.

**Tag Categories:**

| Category | Cardinality | Mandatory | Example Values |
|----------|------------|-----------|---------------|
| Application | Single | Yes | APP001, APP002, ... |
| Tier | Single | Yes | Web, App, DB, Middleware |
| Environment | Single | Yes | Production, PreProduction, Development, Sandbox |
| DataClassification | Single | Yes | Confidential, Internal, Public |
| CostCenter | Single | Yes | CC-1234, CC-5678, ... |
| Compliance | Multi | No | PCI, HIPAA, SOX, None |

**Conflict Rules:**

| Rule | Condition | Violation |
|------|-----------|-----------|
| PCI+Sandbox | Compliance includes PCI AND Environment is Sandbox | PCI workloads cannot run in Sandbox |
| HIPAA+Sandbox | Compliance includes HIPAA AND Environment is Sandbox | HIPAA workloads cannot run in Sandbox |
| Confidential without compliance | DataClassification is Confidential AND Compliance is None or empty | Confidential data requires at least one compliance framework |
| None mutual exclusivity | Compliance includes None AND any other compliance value | "None" cannot coexist with a compliance framework |

## Consequences

### Positive

- **Single source of truth** for all valid tags, accessible to both the request layer (ServiceNow) and execution layer (vRO).
- **Prevents invalid tags at the earliest point** — catalog submission rejects invalid selections before a request is even created.
- **Cardinality enforcement** ensures VMs cannot have conflicting single-value tags (e.g., two different Environment tags).
- **Conflict detection** prevents security violations (PCI in Sandbox) before they reach the DFW layer.
- **Self-service governance** — dictionary updates (adding new application codes, tag values) are a data change, not a code change. Security teams can add new values through the ServiceNow UI.
- **Dual validation** provides defense-in-depth against ServiceNow bypass, API integrations, or bulk import paths.
- **Audit trail** — all dictionary changes are tracked via ServiceNow audit log.

### Negative

- **Synchronization requirement:** vRO's validation must stay aligned with the ServiceNow dictionary. If a new tag value is added to ServiceNow but vRO's cache is stale, valid requests may be rejected. Mitigated by fetching dictionary data at runtime or using a short-lived cache.
- **ServiceNow dependency:** The pipeline's correctness depends on the ServiceNow custom table being accurate and available. Mitigated by vRO's independent validation (falls back to a local configuration element if ServiceNow is unreachable).
- **Initial data load:** Requires defining and loading all valid tag categories, values, and rules into the dictionary table before go-live. This is a one-time effort but requires coordination with application owners for application codes.
- **Change coordination:** Changes to mandatory tag requirements may require updates to both the dictionary table and the catalog form variable sets. Mitigated by using dynamic variable sets that auto-populate from the dictionary.
- **Legacy workload gap:** Existing VMs provisioned before the pipeline was deployed do not have dictionary-validated tags. Requires a batch onboarding process (see Runbook Section 7) to bring legacy VMs into compliance.

## Related Decisions

- ADR-001 (vRO Selection) enables the dual-validation architecture by providing a JavaScript runtime for independent tag validation.
- ADR-005 (Policy-as-Code) depends on consistent tags for security group membership and DFW rule binding.
- ADR-003 (Saga Pattern) provides compensation for tag operations that fail mid-execution.
