# ADR-001: Orchestration Engine Selection — vRealize Orchestrator

**Status:** Accepted

**Date:** 2026-03-21

## Context

The DFW automation pipeline requires an orchestration engine to coordinate VM provisioning, tag application, NSX group verification, and DFW policy validation across multiple VMware VCF sites. The engine must integrate tightly with vCenter (VAPI) and NSX Manager (REST), support long-running workflows with retry and compensation logic, and operate within the existing enterprise VMware ecosystem.

Several options were evaluated:

- **vRealize Orchestrator (vRO 8.x):** VCF-native orchestration engine with built-in VAPI and REST plug-ins, JavaScript/TypeScript workflow support, and cluster-capable deployment.
- **vRealize Automation (vRA):** Full cloud automation platform with blueprint-driven provisioning, governance policies, and self-service catalog.
- **Custom Node.js Service:** A bespoke microservice built on Node.js with REST client libraries for VMware API integration.
- **Ansible Tower / AWX:** Agentless automation platform using declarative playbooks for infrastructure configuration.

Key forces at play:

- The organization has existing vRO infrastructure and operational expertise.
- Native VAPI access is required for vCenter tag operations with full fidelity.
- Real-time, event-driven orchestration with sub-minute response times is needed.
- The solution must support saga-pattern compensation for multi-step rollbacks.
- Operational overhead and licensing costs must be minimized.

## Decision

We will use **vRealize Orchestrator (vRO 8.x)** as the orchestration engine for the DFW automation pipeline.

vRO is the native orchestration component of VMware Cloud Foundation, providing first-class VAPI plug-in access to vCenter and REST-based integration with NSX Manager. It supports JavaScript-based workflow actions, enabling implementation of saga coordination, circuit breakers, and retry logic directly within workflows. The existing vRO cluster infrastructure can be leveraged without additional licensing or deployment overhead.

vRA was rejected because it introduces unnecessary complexity for this use case — the pipeline does not require blueprint-driven provisioning or a self-service portal, as ServiceNow serves as the request front-end. A custom Node.js service was rejected because it lacks native VAPI support (requiring additional abstraction layers), introduces a new operational dependency, and would need custom deployment infrastructure. Ansible was rejected because its pull-based, declarative execution model is not well-suited for real-time, event-driven orchestration with complex branching and compensation logic.

## Consequences

**Positive:**
- Native VAPI plug-in provides direct, type-safe access to vCenter tag operations without additional REST abstraction.
- Leverages existing vRO cluster infrastructure and operational runbooks, reducing time to production.
- Built-in workflow visualization aids troubleshooting and operational support.
- JavaScript action support enables implementation of complex patterns (saga, circuit breaker) within the platform.
- No additional licensing costs beyond existing VCF entitlement.

**Negative:**
- vRO's JavaScript runtime (Rhino/Nashorn) has limitations compared to modern Node.js (no native async/await, limited npm ecosystem).
- Workflow development tooling (vRO Client) is less mature than modern IDE-based development workflows.
- Unit testing vRO actions requires mock frameworks specific to the vRO runtime.
- Team members unfamiliar with vRO will require onboarding and training.
- Tight coupling to VMware ecosystem limits portability if the organization moves away from VCF.
