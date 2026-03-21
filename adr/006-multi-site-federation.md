# ADR-006: Multi-Site Federation via NSX-T Global Manager

**Status:** Accepted

**Date:** 2026-03-21

## Context

The organization operates two VMware VCF data center sites — NDCNG and TULNG — each with independent vCenter and NSX Manager instances. VMs may be provisioned at either site, and DFW security policies must be consistently applied regardless of which site hosts a given VM. Cross-site communication between VMs also requires firewall rules that span both sites.

The pipeline must:

- Apply consistent DFW policies across both sites without manual duplication.
- Support site-aware orchestration (vRO at each site communicates with its local vCenter and NSX Manager).
- Maintain independent site operation during cross-site network outages (each site must continue to enforce its local policies).
- Enable centralized policy management for rules that span both sites.

Options considered:

- **NSX-T Federation with Global Manager:** Use VMware's built-in federation feature to synchronize policies across sites via an active/standby Global Manager.
- **Manual policy replication:** Maintain identical policies on each NSX Manager independently, synchronized by scripts or automation.
- **Single NSX Manager:** Consolidate both sites under a single NSX Manager instance.
- **Third-party policy orchestrator:** Use a vendor-neutral SDN policy manager to abstract across sites.

## Decision

We will use **NSX-T Federation with the Global Manager** for cross-site DFW policy management. The Global Manager (deployed in active/standby configuration) serves as the single control point for policies that must span both sites. Site-specific policies are managed on the respective Local Managers (NSX Manager at each site).

The vRO orchestration layer is site-aware:
- Each vRO cluster communicates with its local vCenter and NSX Manager for site-local operations (tag application, group verification).
- Cross-site policies (federated security groups, federated firewall sections) are managed through the Global Manager API.
- Site routing logic in vRO determines whether an operation targets the local NSX Manager or the Global Manager based on the policy scope.

During a cross-site network partition, each site continues to enforce its locally cached policies independently. Policy updates targeting the Global Manager are queued and applied once connectivity is restored.

## Consequences

**Positive:**
- Single point of policy definition for cross-site rules eliminates manual duplication and the risk of policy drift between sites.
- Federation sync is handled natively by NSX, reducing custom synchronization code.
- Each site maintains autonomous policy enforcement during network partitions, ensuring no security gaps during outages.
- Global Manager active/standby deployment provides high availability for the federation control plane.
- Aligns with VMware's recommended architecture for multi-site VCF deployments.

**Negative:**
- Adds infrastructure complexity: Global Manager requires its own deployment, patching, and monitoring.
- Federation sync latency means policy changes may not be immediately reflected at both sites (typically seconds, but can be longer during high load).
- Global Manager API differs slightly from Local Manager API, requiring conditional logic in the vRO workflows.
- NSX Federation has specific version compatibility requirements that constrain NSX upgrade sequencing across sites.
- During a Global Manager outage, federated policy updates are blocked (local policies continue to function, but new cross-site rules cannot be deployed).
- Troubleshooting federation sync issues requires expertise in both Local and Global Manager operations.
