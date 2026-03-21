# ADR-001: Orchestration Engine Selection — vRealize Orchestrator

**Status:** Accepted
**Date:** 2026-03-21
**Deciders:** Senior Cloud Security Architect, Platform Engineering Lead, vRO Developer

## Context

The DFW automation pipeline requires an orchestration engine to coordinate VM provisioning, tag application, NSX group verification, and DFW policy validation across multiple VMware VCF sites. The engine must integrate tightly with vCenter (VAPI) and NSX Manager (REST), support long-running workflows with retry and compensation logic, and operate within the existing enterprise VMware ecosystem.

The orchestration engine must satisfy the following requirements:

1. **Native vCenter integration:** Direct VAPI access for tag operations with full type safety and session management.
2. **REST API support:** Ability to make authenticated REST calls to NSX Manager, NSX Global Manager, and ServiceNow endpoints.
3. **Workflow coordination:** Support for sequential multi-step workflows with conditional branching, error handling, and saga-pattern compensation.
4. **Real-time execution:** Sub-minute response times for ServiceNow-triggered provisioning requests (not batch-oriented).
5. **Cluster capability:** Active/active deployment for high availability across the two data center sites.
6. **Operational maturity:** Existing organizational expertise, runbooks, and monitoring integration.
7. **Licensing efficiency:** No additional licensing costs beyond current VMware Cloud Foundation entitlement.

Several options were evaluated:

### Option A: vRealize Orchestrator (vRO 8.x)

VCF-native orchestration engine with built-in VAPI and REST plug-ins. Supports JavaScript/TypeScript-based workflow actions. Cluster-capable with active/active deployment. Already deployed in both data center sites. The team has existing operational experience with vRO 7.x and 8.x.

### Option B: vRealize Automation (vRA) with ABX

Full cloud automation platform with blueprint-driven provisioning, governance policies, and self-service catalog. Action-Based eXtensibility (ABX) actions provide event-driven custom logic. However, ServiceNow is the designated self-service portal, making vRA's catalog capabilities redundant.

### Option C: Custom Node.js Microservice

A bespoke microservice built on Node.js with REST client libraries for VMware API integration. Would require custom deployment infrastructure (containers, service mesh, load balancing) and operational tooling (monitoring, log aggregation, health checks). No native VAPI support — would require an additional REST-based abstraction layer.

### Option D: Ansible Tower / AWX

Agentless automation platform using declarative playbooks for infrastructure configuration. Strong community modules for VMware (vmware.vmware_rest collection). However, Ansible's pull-based, playbook-oriented execution model is not well-suited for real-time, event-driven orchestration with complex branching and stateful compensation.

## Decision

We will use **vRealize Orchestrator (vRO 8.x)** as the orchestration engine for the DFW automation pipeline.

vRO is the native orchestration component of VMware Cloud Foundation, providing first-class VAPI plug-in access to vCenter and REST-based integration with NSX Manager. It supports JavaScript-based workflow actions, enabling implementation of saga coordination, circuit breakers, and retry logic directly within workflows. The existing vRO cluster infrastructure at both NDCNG and TULNG can be leveraged without additional licensing or deployment overhead.

The JavaScript action runtime enables the following design patterns within the vRO platform:
- **Template Method** via the abstract `LifecycleOrchestrator` with Day0/Day2/DayN concrete implementations
- **Saga Pattern** via the `SagaCoordinator` for multi-step compensation
- **Circuit Breaker** via per-endpoint state machines wrapping REST calls
- **Strategy Pattern** via pluggable retry strategies in the `RetryHandler`
- **Factory Pattern** for lifecycle orchestrator instantiation based on request type

### Why Not the Alternatives

**vRA** was rejected because it introduces unnecessary platform complexity for this use case. The pipeline does not require blueprint-driven provisioning or a self-service portal — ServiceNow serves as the request front-end. Adding vRA would create a duplicate catalog layer, increase licensing complexity, and require additional operational expertise. ABX actions, while flexible, have execution time limits and cold-start penalties that conflict with the sub-minute response requirement.

**Custom Node.js** was rejected because it lacks native VAPI support (requiring an additional REST-based abstraction layer for vCenter tag operations), introduces a new operational dependency (container platform, CI/CD pipeline, monitoring), and would require building deployment infrastructure from scratch. The development velocity advantage of Node.js does not outweigh the operational overhead for this specific use case.

**Ansible** was rejected because its declarative, playbook-oriented execution model does not map well to stateful, event-driven orchestration with saga compensation. Ansible's "desired state" approach is excellent for configuration management but awkward for workflows that require recording completed steps, maintaining a compensation journal, and executing conditional rollbacks. Additionally, Ansible Tower's webhook integration does not provide the same real-time response characteristics as vRO's REST API listener.

## Consequences

### Positive

- **Native VAPI plug-in** provides direct, type-safe access to vCenter tag operations (attach, detach, list) without additional REST abstraction or serialization overhead.
- **Leverages existing infrastructure:** Both NDCNG and TULNG already have vRO 8.x clusters deployed, configured, and monitored. No new infrastructure provisioning required.
- **Operational familiarity:** The operations team has existing runbooks, PagerDuty integration, and Splunk dashboards for vRO. Time to production is significantly reduced.
- **Built-in workflow visualization** aids troubleshooting and operational support. Workflow execution history is preserved and queryable.
- **JavaScript action support** enables implementation of complex patterns (saga, circuit breaker, retry) within the platform, using standard programming constructs.
- **No additional licensing costs** beyond the existing VCF entitlement — vRO is included.
- **Cluster deployment** provides active/active high availability with automatic workload distribution.

### Negative

- **JavaScript runtime limitations:** vRO's Rhino/Nashorn-based JavaScript runtime does not support modern ES6+ features (native async/await, arrow functions in all contexts, native module imports). Workarounds are required for asynchronous patterns.
- **Development tooling:** The vRO Client is less mature than modern IDE-based development workflows. Syntax highlighting, IntelliSense, and debugging capabilities are limited compared to VS Code or IntelliJ.
- **Unit testing constraints:** Testing vRO actions requires mock frameworks specific to the vRO runtime. The project uses Jest with mocked vRO system objects, but this does not fully replicate the vRO execution environment.
- **Team onboarding:** Team members unfamiliar with vRO will require training on the workflow designer, action scripting, configuration elements, and the plug-in model.
- **Vendor lock-in:** Tight coupling to the VMware ecosystem limits portability if the organization moves away from VCF. However, the business logic (saga coordination, tag operations, retry handling) is implemented in plain JavaScript and could be extracted.

### Mitigations

- **Runtime limitations** are mitigated by using polyfills and wrapper functions for modern JavaScript features. The codebase is transpile-compatible if migration to a newer runtime becomes necessary.
- **Development tooling** is mitigated by developing and testing actions locally with Jest, then deploying to vRO via the `vro-scripting-api` CLI tool.
- **Vendor lock-in** is mitigated by keeping business logic in pure JavaScript actions (no vRO-specific system object dependencies in core logic), enabling extraction to an alternative runtime with minimal refactoring.

## Related Decisions

- ADR-003 (Saga Pattern) depends on vRO's JavaScript action support for the SagaCoordinator implementation.
- ADR-004 (Circuit Breaker) leverages vRO's in-memory module state for per-endpoint circuit breaker tracking.
- ADR-006 (Multi-Site Federation) uses vRO's site-specific endpoint resolution via ConfigLoader.
