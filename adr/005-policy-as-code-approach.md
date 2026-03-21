# ADR-005: Policy-as-Code for DFW Rule Management

**Status:** Accepted
**Date:** 2026-03-21
**Deciders:** Senior Cloud Security Architect, Security Architect, NSX Platform Engineer

## Context

DFW rules in the current environment are managed manually through the NSX Manager UI. This operational model creates several critical problems that affect security posture, compliance, and operational reliability:

### Current State Problems

1. **No version history for rule changes.** When a DFW rule is modified in the NSX Manager UI, there is no record of what the previous rule looked like. If a change introduces a connectivity issue, there is no way to quickly identify what changed or revert to the previous state.

2. **No peer review process.** Any administrator with NSX write access can modify DFW rules without review from the security team. This has led to overly permissive rules being created "temporarily" and never removed.

3. **No rollback capability.** Reverting a problematic rule change requires manually reconstructing the previous configuration from memory or documentation (if it exists). This is error-prone and time-consuming during an incident.

4. **Inconsistent naming and documentation.** Rules created by different administrators use different naming conventions, making it difficult to understand the purpose of each rule. Some rules have no description at all.

5. **No automated validation.** There is no pre-deployment check for rule conflicts (shadowed rules, contradictory rules, duplicates). Rule conflicts are discovered only when they cause connectivity issues in production.

6. **Audit evidence is manual.** Compliance audits (PCI DSS, HIPAA) require evidence of security rule change management. Currently, this evidence is assembled manually from NSX Manager audit logs, which is time-intensive and error-prone.

### Requirements

- Version-controlled history of all rule changes with diffs and attribution
- Mandatory peer review before any rule change is deployed
- One-command rollback to any previous rule state
- Automated validation (schema, conflicts, shadows, duplicates) before deployment
- Consistent rule naming and documentation enforced by schema
- Machine-readable audit trail for compliance evidence
- Separation between rule definition (human-authored) and rule deployment (automated)

### Options Considered

**Option A: YAML Policy Definitions in Git**
Define all DFW rules as YAML files in a version-controlled repository. Changes follow pull request workflow with automated CI validation. Deployment is automated via vRO workflows.

**Option B: NSX Manager UI with Change Tickets**
Continue managing rules in the NSX Manager UI but require a ServiceNow change ticket for each modification. This provides an approval trail but no version control, automated validation, or rollback capability.

**Option C: Terraform NSX Provider**
Use the Terraform NSX-T provider to manage DFW rules as HCL resources. State is tracked in a Terraform state file, and changes are planned and applied via Terraform workflows.

**Option D: Custom REST API Scripts**
Maintain a library of API scripts for policy management with version-controlled scripts and manual execution.

## Decision

We adopt a **policy-as-code approach** where all DFW rule definitions are maintained as YAML files in a version-controlled Git repository.

### Repository Structure

```
policies/
  dfw-rules/
    infrastructure-shared-services.yaml   # Priority 1000 -- DNS, NTP, AD, Monitoring, Backup
    environment-zone-isolation.yaml        # Priority 2000 -- Prod/Dev/Sandbox isolation
    compliance-pci-segmentation.yaml       # Priority 3000 -- PCI zone rules
    application-*.yaml                     # Priority 4000+ -- Application-specific rules
    emergency-quarantine.yaml              # Priority 100 -- Emergency isolation (highest priority)
  security-groups/
    infrastructure-groups.yaml             # All-Production-VMs, All-Development-VMs, etc.
    compliance-groups.yaml                 # All-PCI-VMs, All-HIPAA-VMs, etc.
    application-groups.yaml                # Application-specific groups
  tag-categories/
    categories.yaml                        # Tag category definitions with cardinality rules
schemas/
  dfw-policy-template.schema.json          # JSON Schema for policy YAML validation
```

### Policy YAML Schema

Each policy YAML file follows a defined schema validated by `dfw-policy-template.schema.json`:

```yaml
name: infrastructure-shared-services
displayName: "Infrastructure Shared Services"
category: Infrastructure          # NSX category
scope: GLOBAL                     # GLOBAL or LOCAL:{site}
priority: 1000                    # Lower number = higher priority
rules:
  - name: Allow-DNS
    displayName: "Allow DNS to infrastructure DNS servers"
    sourceGroups:
      - All-VMs
    destinationGroups:
      - Infrastructure-DNS-Servers
    services:
      - DNS-UDP
      - DNS-TCP
    action: ALLOW
    direction: OUT
    logged: true
    notes: "Baseline DNS access required for all VMs"
```

### Change Management Process

1. **Author creates a feature branch** with the proposed YAML change.
2. **CI pipeline runs automatically** on pull request:
   - JSON Schema validation (`ajv` validates YAML against `dfw-policy-template.schema.json`)
   - `RuleConflictDetector` checks for shadowed, contradictory, and duplicate rules
   - Policy naming convention enforcement
   - YAML lint checks
3. **Peer review by Security Architect** is mandatory for merge approval.
4. **Merge to main** triggers automated deployment:
   - vRO `Reconcile Policies` workflow reads current YAML files
   - Differences between YAML definitions and NSX realized state are computed
   - Changes applied to the appropriate NSX Manager (Global Manager for GLOBAL scope, Local Manager for LOCAL scope)
   - Each deployment step is recorded in a saga for rollback capability
5. **Post-deployment verification** confirms the realized DFW state matches the YAML definition.

### Rollback

Rollback is achieved by reverting the Git commit and redeploying:

```bash
git log --oneline policies/dfw-rules/
git revert <commit-hash>
git push
# CI validates the reverted state, then vRO deploys it
```

### Validation Rules

The `RuleConflictDetector` performs the following checks on every pull request:

| Check | Description | Severity |
|-------|-------------|----------|
| Shadowed rules | A rule completely covered by a higher-priority rule | Warning |
| Contradictory rules | Two rules match same traffic with opposite actions | Error (blocks merge) |
| Duplicate rules | Identical source, destination, service, and action | Error (blocks merge) |
| Missing groups | Rule references undefined security group | Error (blocks merge) |
| Priority conflict | Two policies share the same priority number | Error (blocks merge) |
| Schema violation | YAML does not conform to template schema | Error (blocks merge) |

### Emergency Break-Glass Process

During a security incident, waiting for a pull request review is not acceptable. The break-glass procedure allows direct NSX Manager UI changes:

1. Security team makes the change directly in the NSX Manager UI.
2. The change is immediately effective.
3. Within 24 hours, the change must be committed to the Git repository as a YAML update.
4. A drift detection run confirms alignment between the NSX state and Git.
5. If the change is not committed to Git within 48 hours, an automated alert fires.

### Why Not the Alternatives

**NSX Manager UI + Change Tickets:** Provides an approval trail but no version control (no diffs, no rollback), no automated conflict detection, and no machine-readable audit trail. The change ticket approach is reactive (review after the change is made) rather than preventive.

**Terraform NSX-T Provider:** Introduces operational complexity (remote state backend, state locking, plan/apply workflow) and does not integrate well with the existing vRO pipeline. The NSX-T Terraform provider has limited support for conflict detection. HCL syntax is less accessible to the security team than YAML.

**Custom REST API Scripts:** Version-controlled but fragile, lacking schema validation, conflict detection, and a structured deployment workflow.

## Consequences

### Positive

- **Full version history** with Git diffs showing exactly what changed, when, and by whom.
- **Mandatory peer review** enforced through pull request approvals before any deployment.
- **Automated validation** catches conflicts, shadows, and duplicates before production deployment.
- **One-command rollback** via `git revert` restores any previous rule state within minutes.
- **Machine-readable audit trail** satisfies PCI DSS Requirement 1.1.1 and provides compliance evidence.
- **Consistent documentation** enforced by schema (name, displayName, notes fields are required).
- **Self-documenting** configuration — YAML files serve as living documentation of the DFW rule set.
- **Environment promotion** possible — test rules in staging before deploying to production.

### Negative

- **Learning curve** for security team members unfamiliar with Git workflows. Mitigated by training and a simplified Git GUI guide.
- **YAML syntax errors** can be difficult to debug. Mitigated by CI schema validation and YAML linting.
- **Emergency changes require break-glass process.** Adds a reconciliation step after each emergency change.
- **Two sources of truth during migration.** Until all existing rules are migrated to YAML, discrepancies may exist. Drift detection (Runbook Section 5) identifies and resolves these.
- **Deployment latency:** CI pipeline + vRO deployment adds 5-10 minutes between merge and realization. Acceptable for planned changes.

## Related Decisions

- ADR-002 (Tag Governance) provides the tag-based security group definitions that DFW rules reference.
- ADR-006 (Multi-Site Federation) determines Global vs. Local deployment targets via the `scope` field.
- ADR-003 (Saga Pattern) provides rollback capability for the automated deployment workflow.
