# ADR-005: Policy as Code Approach for DFW Rules

**Status:** Accepted

**Date:** 2026-03-21

## Context

NSX Distributed Firewall (DFW) policies define the micro-segmentation rules that govern east-west traffic between VMs. These policies are critical security controls — an incorrect rule can either block legitimate application traffic (causing outages) or allow unauthorized access (creating security vulnerabilities). Currently, DFW policies are managed through the NSX Manager UI or ad-hoc API calls, with no version history, peer review process, or ability to roll back to a known-good state.

The organization requires:

- Auditability: A complete history of who changed what, when, and why.
- Peer review: Security policy changes must be reviewed before deployment.
- Rollback capability: The ability to revert to a previous policy version if a change causes issues.
- Consistency: Policies across NDCNG and TULNG sites must be consistent (enforced via NSX Federation).
- Testability: Policy changes should be validatable before deployment to production.

Options considered:

- **YAML policy definitions in version control:** Define DFW policies as YAML templates in a Git repository, with CI/CD pipeline validation and change-managed deployment.
- **NSX Manager UI with manual change tickets:** Continue using the UI with ServiceNow change records for audit trail.
- **Terraform NSX provider:** Use Terraform's NSX-T provider to manage policies as HCL code.
- **Custom REST API scripts:** Maintain a library of API scripts for policy management.

## Decision

We will adopt a **Policy as Code approach** using YAML-based DFW policy definitions stored in a Git repository. Policy templates define security groups, firewall sections, and rules in a declarative format that is validated by CI pipeline checks and deployed through a change-managed process.

Each policy template includes:
- Security group definitions with tag-based membership criteria.
- Firewall section with ordered rules referencing source/destination groups.
- Metadata including owner, change ticket, and effective date.

The CI pipeline validates policy templates against a JSON Schema, checks for conflicts with existing policies, and runs a dry-run simulation. Deployment to NSX (via the Global Manager for federated policies) requires an approved change ticket and is executed by the vRO pipeline.

## Consequences

**Positive:**
- Full version history in Git provides complete auditability of all policy changes with author attribution.
- Pull request workflow enables peer review of security policy changes before deployment.
- Git revert capability provides immediate rollback to any previous policy version.
- YAML format is human-readable and accessible to security engineers without deep API knowledge.
- CI validation catches syntax errors, schema violations, and potential conflicts before deployment.
- Policy definitions can be tested in a non-production environment before applying to production.

**Negative:**
- Requires security engineers to learn Git-based workflows (mitigated by documentation and training).
- YAML templates must be kept in sync with the actual NSX policy model — schema changes in NSX upgrades require template updates.
- Emergency policy changes still need to follow the Git workflow, which may add latency in critical situations (mitigated by an expedited emergency change process).
- Does not replace the NSX Manager UI entirely — complex policy visualization and troubleshooting still benefit from the UI.
- Initial effort required to convert existing policies from NSX Manager into YAML template format.
