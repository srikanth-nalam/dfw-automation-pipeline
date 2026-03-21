# ADR-002: Tag Governance Model — Centralized Enterprise Tag Dictionary

**Status:** Accepted

**Date:** 2026-03-21

## Context

VMware NSX Distributed Firewall (DFW) policies rely on tag-based dynamic security groups to determine which VMs are subject to which firewall rules. The correctness and consistency of tags directly determines whether VMs receive the intended network security posture. Inconsistent, misspelled, or unauthorized tags can result in VMs being placed in incorrect security groups — either exposing them to unauthorized traffic or blocking legitimate communication.

The pipeline must ensure that:

- All tags applied to VMs conform to a controlled vocabulary.
- Mandatory tags are present at provisioning time (Day 0) and maintained through lifecycle changes (Day 2).
- Tag cardinality rules are enforced (e.g., a VM may have exactly one value for the "Environment" category).
- Free-text tag entry is prohibited to prevent drift and inconsistency.
- The tag vocabulary is maintainable by the security and infrastructure teams without code changes.

Options considered:

- **Centralized Tag Dictionary in ServiceNow:** A custom table in ServiceNow defining valid tag categories, allowed values, cardinality rules, and mandatory flags. Catalog forms reference this dictionary for validation.
- **vCenter Tag Policy:** Use vCenter's native tag categories and enforce at the vCenter level.
- **External CMDB-driven approach:** Derive tags from CMDB CI attributes at provisioning time.
- **Free-form tagging with post-hoc validation:** Allow any tags and run periodic compliance scans.

## Decision

We will implement a **centralized Enterprise Tag Dictionary as a custom table in ServiceNow**, with mandatory tag enforcement at the catalog submission layer and runtime validation in vRO.

The Tag Dictionary table (`u_tag_dictionary`) defines each valid tag category, its allowed values, cardinality constraints (single vs. multi-value), and whether the tag is mandatory for provisioning. ServiceNow catalog item variable sets reference this dictionary, presenting users with dropdown selections rather than free-text fields. The vRO payload validator independently validates incoming tag sets against the same dictionary data (synced or fetched at runtime) before executing any tag operations.

## Consequences

**Positive:**
- Single source of truth for all valid tags, accessible to both the request layer (ServiceNow) and execution layer (vRO).
- Prevents invalid tags from entering the system at the earliest possible point (catalog submission).
- Cardinality enforcement ensures VMs cannot have conflicting tag values (e.g., two "Environment" tags).
- Dictionary updates (adding new tag values) are a data change, not a code change, enabling security teams to self-serve.
- Dual validation (ServiceNow + vRO) provides defense-in-depth against bypass or integration errors.

**Negative:**
- Requires synchronization or runtime lookup to keep vRO's validation aligned with the ServiceNow dictionary.
- Adds a dependency on the ServiceNow custom table for pipeline correctness.
- Initial setup requires defining and loading all valid tag categories and values.
- Changes to mandatory tag requirements may require catalog form updates in addition to dictionary changes.
