# ADR-006: Multi-Site Federation Strategy

**Status:** Accepted
**Date:** 2026-03-21
**Deciders:** Senior Cloud Security Architect, NSX Platform Engineer, Operations Lead, Platform Engineering Lead

## Context

The organization operates two data center sites — **NDCNG** and **TULNG** — each with independent vCenter and NSX Manager instances. VMs are provisioned at specific sites based on workload placement policies, disaster recovery requirements, and capacity availability. DFW policies must be consistently applied across both sites to maintain a uniform security posture.

### Multi-Site Challenges

1. **Policy Consistency:** Infrastructure and environment DFW policies (DNS, NTP, zone isolation) must be identical at both sites. Manual synchronization is error-prone and does not scale.

2. **Site-Specific Policies:** Application-level DFW rules may be specific to one site (e.g., an application running only at NDCNG). These rules should not be deployed to TULNG.

3. **Independent Operation:** A failure at one site must not prevent operations at the other site. The pipeline must route requests to the correct site and handle single-site outages gracefully.

4. **Tag Consistency:** Tag categories and allowed values must be identical across both sites so that the same tag set produces the same security group membership regardless of where the VM is provisioned.

5. **Aggregate Visibility:** Global security groups (e.g., "All-Production-VMs") must span both sites for cross-site policy enforcement and compliance reporting.

6. **Scalability:** The architecture must accommodate additional sites without fundamental redesign.

### Options Considered

**Option A: NSX-T Federation with Global Manager**
Leverage NSX-T Federation for cross-site policy management via the Global Manager, while site-specific policies are managed via Local Managers.

**Option B: Manual Synchronization**
Deploy the same policies to both sites independently. Use a reconciliation script to detect and fix drift. No Global Manager infrastructure.

**Option C: Single NSX Manager**
Consolidate both sites under a single NSX Manager instance. Simplifies management but creates a single point of failure and requires stretched networking.

**Option D: Fully Independent Sites**
Treat each site as a completely independent NSX domain with no cross-site policy coordination. Each site has its own policy definitions.

## Decision

We leverage **NSX-T Federation with a Global Manager** for cross-site policy management, combined with site-aware routing in the vRO orchestration layer.

### Federation Architecture

The Global Manager (Active/Standby deployment) serves as the single control point for policies that must be consistent across both sites. Local Managers at each site handle site-specific policies and enforce all policies on local ESXi hosts.

### Responsibility Matrix

**Global Manager handles:**

| Resource | Examples | Scope |
|----------|---------|-------|
| Infrastructure policies | DNS, NTP, AD/Kerberos, Monitoring, Backup | Both sites |
| Environment policies | Production/Development/Sandbox isolation | Both sites |
| Compliance policies | PCI segmentation, HIPAA zones | Both sites |
| Emergency policies | Quarantine isolation | Both sites |
| Aggregate security groups | All-Production-VMs, All-PCI-VMs | Both sites |
| Tag category definitions | Application, Tier, Environment, etc. | Both sites |

**Local Managers handle:**

| Resource | Examples | Scope |
|----------|---------|-------|
| Application policies | App-specific micro-segmentation rules | Single site |
| Application security groups | APP001-Web-NDCNG, APP001-App-NDCNG | Single site |
| Local tag assignments | Tags applied to site-local VMs | Single site |
| DFW rule enforcement | Realized rules on local ESXi hosts | Single site |

### vRO Site-Aware Routing

The `ConfigLoader` maps site codes to endpoint URLs:

```javascript
sites: {
  NDCNG: {
    vcenterUrl: "https://vcenter-ndcng.corp.local",
    nsxUrl: "https://nsx-ndcng.corp.local",
    nsxGlobalUrl: "https://nsx-gm.corp.local"
  },
  TULNG: {
    vcenterUrl: "https://vcenter-tulng.corp.local",
    nsxUrl: "https://nsx-tulng.corp.local",
    nsxGlobalUrl: "https://nsx-gm.corp.local"
  }
}
```

Each lifecycle orchestrator resolves endpoints based on the `site` field in the incoming payload:

1. **Tag operations** are directed to the site-specific vCenter (VAPI) and NSX Manager (REST).
2. **Global policy deployments** go through the NSX Global Manager API.
3. **Group membership verification** uses the site-specific NSX Manager.
4. **DFW coverage validation** uses the site-specific NSX Manager for realized state.

### Policy Scope Convention

The policy-as-code YAML files use a `scope` field to control deployment:

| Scope Value | Deployed Via | Target |
|------------|-------------|--------|
| `GLOBAL` | Global Manager API | Both sites (federated) |
| `LOCAL:NDCNG` | NDCNG NSX Manager API | NDCNG only |
| `LOCAL:TULNG` | TULNG NSX Manager API | TULNG only |

### Failover Behavior

The per-endpoint circuit breaker (ADR-004) provides site-independent failure isolation:

| Failure Scenario | NDCNG Impact | TULNG Impact | Global Manager Impact |
|-----------------|-------------|-------------|---------------------|
| NDCNG NSX Manager down | NDCNG operations fail (DFW-6004) | No impact | Global policies remain enforced locally |
| TULNG NSX Manager down | No impact | TULNG operations fail (DFW-6004) | Global policies remain enforced locally |
| Global Manager down | Local operations continue | Local operations continue | Global policy changes queued |
| NDCNG vCenter down | NDCNG tag ops fail | No impact | No impact |
| ServiceNow outage | No new requests | No new requests | No impact on enforcement |

Key resilience properties:

- **Degraded but operational:** When one site's NSX Manager is down, the other site continues processing requests. The failed site's requests receive an immediate error (DFW-6004) via circuit breaker fast-fail.
- **Local enforcement independence:** Global policies already deployed to both sites are enforced by the local NSX data plane and ESXi DFW kernel modules, even if the Global Manager is unavailable.
- **No cross-site dependency for local operations:** A Day 0 provisioning at NDCNG requires only the NDCNG vCenter and NDCNG NSX Manager. It does not depend on any TULNG infrastructure.

### Global Manager High Availability

The NSX Global Manager is deployed in Active/Standby configuration:

- **Active GM** handles all API calls and federation synchronization.
- **Standby GM** receives continuous replication from the Active.
- **Failover:** On Active GM failure, the Standby can be promoted (manual or automated). Estimated RTO: < 15 minutes. RPO: < 30 seconds (replication lag).
- **During GM failover:** Local site operations continue unaffected. Only global policy changes are deferred until the new Active GM is available.

### Scaling to Additional Sites

Adding a new data center site requires:

1. Deploy NSX Manager cluster at the new site.
2. Register the new Local Manager with the existing Global Manager.
3. Add the new site's endpoints to `ConfigLoader` configuration.
4. Deploy a vRO cluster at the new site (or extend existing cluster).
5. Add per-endpoint circuit breaker configuration.
6. Federation automatically syncs global policies to the new Local Manager.

No changes to the core pipeline logic (orchestrators, saga coordinator, tag operations) are required. The `LifecycleOrchestrator.resolveEndpoints(site)` method dynamically resolves the correct endpoints based on the site code.

### Why Not the Alternatives

**Manual Synchronization:** Error-prone, requires custom synchronization scripts, and has no built-in conflict resolution. Federation provides native synchronization with consistency guarantees.

**Single NSX Manager:** Creates a single point of failure for both sites. Requires stretched L2 networking between data centers. A single NSX Manager outage impacts all workloads at both sites.

**Fully Independent Sites:** Loses cross-site policy consistency guarantee. Global policies (infrastructure, environment) must be manually maintained in parallel. Compliance reporting across sites becomes difficult.

## Consequences

### Positive

- **Single management point** for global policies via Federation eliminates manual synchronization.
- **Independent site operation** during outages ensures business continuity per site.
- **Consistent security posture** across both sites guaranteed by NSX Federation.
- **Scalable architecture** for adding new sites without core logic changes.
- **No cross-site dependency** for local operations (provisioning, tag updates, decommissions).
- **Aggregate visibility** via global security groups enables cross-site compliance reporting.
- **Separation of concerns** between global infrastructure policies and site-local application policies.

### Negative

- **NSX Federation infrastructure complexity:** Global Manager (Active/Standby) adds components to deploy, patch, and monitor.
- **Global Manager is a control plane SPOF** for global policy changes. Mitigated by Active/Standby deployment.
- **Federated policy propagation delay:** Changes via Global Manager take 10-30 seconds to propagate. Emergency changes should target Local Managers directly for immediate effect.
- **Endpoint configuration maintenance:** vRO must maintain endpoint mappings for each site.
- **Testing complexity:** Full integration testing requires a multi-site lab or careful mocking.
- **Federation version coupling:** Both Local Managers and the Global Manager must run compatible NSX-T versions. Upgrades must be coordinated.

### Mitigations

- **Global Manager SPOF** is mitigated by Active/Standby deployment with < 15-minute RTO.
- **Propagation delay** is mitigated by using Local Manager APIs for time-sensitive operations (emergency quarantine applies directly to the local site).
- **Testing complexity** is mitigated by comprehensive unit tests with mocked endpoints and periodic integration tests in a multi-site staging environment.
- **Version coupling** is mitigated by following VMware's published upgrade sequence (Local Managers first, then Global Manager).

## Related Decisions

- ADR-001 (vRO Selection) provides the site-aware endpoint resolution via ConfigLoader.
- ADR-004 (Circuit Breaker) provides per-endpoint failure isolation essential for site independence.
- ADR-005 (Policy-as-Code) uses the `scope` field to determine Global vs. Local deployment target.
- ADR-002 (Tag Governance) ensures consistent tag categories across both sites via Federation.
