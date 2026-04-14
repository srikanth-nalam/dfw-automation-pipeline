# Developer Deployment Guide — NSX DFW Automation Pipeline

This guide provides step-by-step instructions for deploying the NSX DFW Automation Pipeline in a lab or production environment. It covers prerequisites, component-by-component deployment, test data setup, demo walkthroughs, and troubleshooting.

---

## Table of Contents

1. [Prerequisites Checklist](#1-prerequisites-checklist)
2. [Where to Deploy Each Component](#2-where-to-deploy-each-component)
3. [Test Data Setup for Demos](#3-test-data-setup-for-demos)
4. [Monitor-Mode Deployment](#4-monitor-mode-deployment)
5. [Drift Trend Analysis](#5-drift-trend-analysis)
6. [Running Tests](#6-running-tests)
7. [Troubleshooting Common Setup Issues](#7-troubleshooting-common-setup-issues)
13. [Hygiene Module Configuration](#13-hygiene-module-configuration)
14. [ServiceNow Scheduled Job Setup for Hygiene Sweep](#14-servicenow-scheduled-job-setup-for-hygiene-sweep)
15. [Test Data Setup for Hygiene Testing](#15-test-data-setup-for-hygiene-testing)

---

## 1. Prerequisites Checklist

Before starting deployment, verify that every prerequisite in this section is satisfied. Missing a single item will cause integration failures that are difficult to diagnose.

### 1.1 VMware Infrastructure Prerequisites

| Component | Minimum Version | Notes |
|-----------|----------------|-------|
| VMware vCenter Server | 7.0 Update 3 or later (vSphere 8.x also supported) | Required for tag management API and VM inventory |
| NSX-T Manager | 3.2 or later (NSX 4.x also supported) | Required for tag CRUD, security groups, and DFW policy API |
| NSX-T Federation Global Manager | 3.2+ (if multi-site federation is used) | Required only for cross-site tag and policy synchronization |
| VMware Aria Automation Orchestrator (vRO) | 8.10 or later (standalone or embedded) | Hosts all pipeline actions and workflows |

**Infrastructure inventory required:**

- At least **2 vCenter + NSX Manager instances** — one for the NDCNG site and one for the TULNG site. If demonstrating single-site only, one pair is sufficient.
- At least **1 test VM template** registered in vCenter (e.g., `RHEL9-GOLD-TEMPLATE`, `W2K22-GOLD-TEMPLATE`). Templates are used by Day 0 provisioning for VM cloning.
- A **test cluster** available for VM provisioning (e.g., `TEST-CLUSTER-01`).
- A **test datastore** with sufficient free space — at least 100 GB recommended (e.g., `TEST-VSAN-DS01`).
- A **test network/segment** available for VM connectivity (e.g., `VLAN-TEST-172.20.10.0`).

### 1.2 ServiceNow Prerequisites

| Component | Requirement | Notes |
|-----------|-------------|-------|
| ServiceNow instance | Zurich Patch 6 or later | Personal Developer Instance (PDI) acceptable for testing |
| Admin access | `admin` role on the instance | Required for creating tables, scripts, and catalog items |
| REST API access | Enabled via System Web Services > REST API | Required for vRO↔ServiceNow integration |
| ITSM plugins | Incident, Change, Request plugins activated | Standard ITSM package |
| Service Catalog module | Activated | Required for catalog item creation |

**ServiceNow tables required (must exist or be created):**

| Table | Type | Purpose |
|-------|------|---------|
| `u_enterprise_tag_dictionary` | Custom — script provided in Section 3 | Stores the enterprise tag taxonomy with metadata |
| `sc_cat_item` | Standard | Catalog items for VM requests |
| `cmdb_ci_server` or `cmdb_ci_vm_instance` | Standard | VM Configuration Items in CMDB |
| `sys_user_group` | Standard | Groups for VM Requestors, Admins, etc. |
| `sc_req_item` | Standard | Requested Items (RITMs) for catalog flows |

### 1.3 Service Accounts Required

Each integration point requires a dedicated service account with least-privilege permissions. Do not share service accounts across integration points.

#### vRO → vCenter

- **Purpose:** VM lookup, tag read/write on VMs, folder traversal
- **Account name suggestion:** `svc-vro-vcenter`
- **Required vCenter roles:**
  - `VcTaggingAdmin` — full tag CRUD operations
  - `VcTagAssigner` — assign/unassign tags to VMs
  - `ReadOnly` — on VM folders and Datacenters (for VM discovery)
- **Scope:** Assign at the vCenter root level or at the Datacenter level for both NDCNG and TULNG

#### vRO → NSX Manager

- **Purpose:** Tag CRUD on VMs, security group read/write, DFW policy read/write, fabric VM read
- **Account name suggestion:** `svc-vro-nsx`
- **Required NSX role:** `enterprise_admin` **or** a custom role with these permissions:
  - Tag CRUD (create, read, update, delete tags on VMs)
  - Security Group Read/Write (create and modify dynamic security groups)
  - DFW Policy Read/Write (create, modify, and delete DFW policies and rules)
  - Fabric Virtual Machine Read (resolve VM external IDs to NSX VM references)
- **Scope:** Configure on each NSX Manager instance (NDCNG and TULNG)

#### vRO → NSX Global Manager

- **Purpose:** Cross-site tag and policy federation
- **Account name suggestion:** `svc-vro-nsx-global`
- **Required role:** Same as NSX Manager role above, applied on the Global Manager
- **Note:** Only required if multi-site federation is in use

#### vRO → ServiceNow

- **Purpose:** Callback writes — updates RITM work notes, closes tasks, creates incidents
- **Account name suggestion:** `svc-vro-snow`
- **Authentication:** OAuth 2.0 client credentials (preferred) or Basic Auth
- **Required ServiceNow roles:**
  - `rest_api_explorer` — REST API access
  - `itil` — incident and change management
  - `cmdb_write` — update CMDB CI records
  - `catalog_admin` — update catalog request items

#### ServiceNow → vRO

- **Purpose:** Trigger vRO workflows via REST API on catalog item submission
- **Account name suggestion:** `svc-snow-vro`
- **Authentication:** Basic Auth configured in vRO
- **Required vRO permission:** `workflow_execute` — ability to invoke workflows via REST
- **Endpoint:** vRO REST API base URL (typically `https://vro-host.company.internal:443/vco/api/`)

### 1.4 Network Connectivity Requirements

All connections use HTTPS (port 443). Verify bi-directional connectivity through firewalls and load balancers before proceeding.

| Source | Destination | Port | Protocol | Purpose |
|--------|-------------|------|----------|---------|
| ServiceNow instance | vRO REST endpoint | 443 | HTTPS | Trigger workflows on catalog submission |
| vRO | vCenter API (NDCNG) | 443 | HTTPS | VM lookup, tag operations |
| vRO | vCenter API (TULNG) | 443 | HTTPS | VM lookup, tag operations |
| vRO | NSX Manager API (NDCNG) | 443 | HTTPS | Tag CRUD, groups, DFW policies |
| vRO | NSX Manager API (TULNG) | 443 | HTTPS | Tag CRUD, groups, DFW policies |
| vRO | NSX Global Manager API | 443 | HTTPS | Federation sync (if applicable) |
| vRO | ServiceNow REST API | 443 | HTTPS | Callback writes to RITM/incidents |

**Tip:** Use `curl -k https://<endpoint>:443/api` from the vRO appliance to verify connectivity before importing actions.

### 1.5 Development Tools

These tools are needed for local development, testing, and deployment:

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18+ | Running Jest tests locally |
| npm | 9+ | Package management |
| Git | 2.x+ | Repository management |
| vRO CLI (`vro-cli`) | Latest | Optional — command-line import of actions/workflows |
| VS Code or similar editor | Latest | JavaScript/YAML editing with linting |
| Postman or similar REST client | Latest | Manual API testing and debugging |

**Quick verification:**

```bash
node --version    # Should output v18.x.x or later
npm --version     # Should output 9.x.x or later
git --version     # Should output 2.x.x or later
```

---

## 2. Where to Deploy Each Component

This section maps every source file in the repository to its deployment target with step-by-step instructions.

### 2.1 vRO Actions Deployment

All files in `src/vro/actions/` are deployed as vRO Actions. Each file exports a single JavaScript class that becomes a vRO Action.

#### Import Order (CRITICAL)

Dependencies must be imported before dependents. Follow this exact sequence:

| Order | Source File | vRO Module | Action Name |
|-------|------------|------------|-------------|
| 1 | `src/vro/actions/shared/Logger.js` | `com.enterprise.dfw.shared` | `Logger` |
| 2 | `src/vro/actions/shared/ErrorFactory.js` | `com.enterprise.dfw.shared` | `ErrorFactory` |
| 3 | `src/vro/actions/shared/ConfigLoader.js` | `com.enterprise.dfw.shared` | `ConfigLoader` |
| 4 | `src/vro/actions/shared/CorrelationContext.js` | `com.enterprise.dfw.shared` | `CorrelationContext` |
| 5 | `src/vro/actions/shared/RetryHandler.js` | `com.enterprise.dfw.shared` | `RetryHandler` |
| 6 | `src/vro/actions/shared/CircuitBreaker.js` | `com.enterprise.dfw.shared` | `CircuitBreaker` |
| 7 | `src/vro/actions/shared/RestClient.js` | `com.enterprise.dfw.shared` | `RestClient` |
| 8 | `src/vro/actions/shared/PayloadValidator.js` | `com.enterprise.dfw.shared` | `PayloadValidator` |
| 9 | `src/vro/actions/tags/TagCardinalityEnforcer.js` | `com.enterprise.dfw.tags` | `TagCardinalityEnforcer` |
| 10 | `src/vro/actions/tags/TagOperations.js` | `com.enterprise.dfw.tags` | `TagOperations` |
| 11 | `src/vro/actions/tags/TagPropagationVerifier.js` | `com.enterprise.dfw.tags` | `TagPropagationVerifier` |
| 12 | `src/vro/actions/groups/GroupMembershipVerifier.js` | `com.enterprise.dfw.groups` | `GroupMembershipVerifier` |
| 13 | `src/vro/actions/groups/GroupReconciler.js` | `com.enterprise.dfw.groups` | `GroupReconciler` |
| 14 | `src/vro/actions/dfw/DFWPolicyValidator.js` | `com.enterprise.dfw.policy` | `DFWPolicyValidator` |
| 15 | `src/vro/actions/dfw/RuleConflictDetector.js` | `com.enterprise.dfw.policy` | `RuleConflictDetector` |
| 16 | `src/vro/actions/dfw/PolicyDeployer.js` | `com.enterprise.dfw.policy` | `PolicyDeployer` |
| 17 | `src/vro/actions/lifecycle/SagaCoordinator.js` | `com.enterprise.dfw.lifecycle` | `SagaCoordinator` |
| 18 | `src/vro/actions/lifecycle/DeadLetterQueue.js` | `com.enterprise.dfw.lifecycle` | `DeadLetterQueue` |
| 19 | `src/vro/actions/lifecycle/LifecycleOrchestrator.js` | `com.enterprise.dfw.lifecycle` | `LifecycleOrchestrator` |
| 20 | `src/vro/actions/lifecycle/Day0Orchestrator.js` | `com.enterprise.dfw.lifecycle` | `Day0Orchestrator` |
| 21 | `src/vro/actions/lifecycle/Day2Orchestrator.js` | `com.enterprise.dfw.lifecycle` | `Day2Orchestrator` |
| 22 | `src/vro/actions/lifecycle/DayNOrchestrator.js` | `com.enterprise.dfw.lifecycle` | `DayNOrchestrator` |
| 23 | `src/vro/actions/lifecycle/ImpactAnalysisAction.js` | `com.enterprise.dfw.lifecycle` | `ImpactAnalysisAction` |
| 24 | `src/vro/actions/lifecycle/QuarantineOrchestrator.js` | `com.enterprise.dfw.lifecycle` | `QuarantineOrchestrator` |
| 25 | `src/vro/actions/lifecycle/BulkTagOrchestrator.js` | `com.enterprise.dfw.lifecycle` | `BulkTagOrchestrator` |
| 26 | `src/vro/actions/lifecycle/DriftDetectionWorkflow.js` | `com.enterprise.dfw.lifecycle` | `DriftDetectionWorkflow` |
| 27 | `src/vro/actions/lifecycle/LegacyOnboardingOrchestrator.js` | `com.enterprise.dfw.lifecycle` | `LegacyOnboardingOrchestrator` |
| 28 | `src/vro/actions/lifecycle/MigrationVerifier.js` | `com.enterprise.dfw.lifecycle` | `MigrationVerifier` |
| 29 | `src/vro/actions/tags/UntaggedVMScanner.js` | `com.enterprise.dfw.tags` | `UntaggedVMScanner` |
| 30 | `src/vro/actions/shared/RateLimiter.js` | `com.enterprise.dfw.shared` | `RateLimiter` |

#### How to Create an Action in vRO UI

For each file in the table above:

1. Open the Orchestrator client and navigate to **Library > Actions**.
2. Locate or create the module (e.g., `com.enterprise.dfw.shared`). Right-click the module and select **New Action**.
3. Set the **Action Name** to match the table above (e.g., `Logger`).
4. Set the **Return Type** to `Any` (the actions return JavaScript objects).
5. Open the source file from the repository and copy the entire file content.
6. Paste the code into the vRO action's **Script** tab.
7. Click **Save**, then click **Validate** to verify there are no syntax errors.
8. Repeat for the next action in the import order.

**Important:** The shared module (`com.enterprise.dfw.shared`) must be fully imported before the tags, groups, dfw, or lifecycle modules. Actions in those modules depend on `Logger`, `ErrorFactory`, `ConfigLoader`, and other shared utilities.

#### vRO CLI Batch Import (Alternative)

If using `vro-cli`, create a batch import script:

```bash
#!/bin/bash
# batch-import-actions.sh — Import all vRO actions in dependency order
VRO_HOST="https://vro-host.company.internal:443"
VRO_USER="svc-vro-admin"

ACTIONS=(
  "com.enterprise.dfw.shared:Logger:src/vro/actions/shared/Logger.js"
  "com.enterprise.dfw.shared:ErrorFactory:src/vro/actions/shared/ErrorFactory.js"
  "com.enterprise.dfw.shared:ConfigLoader:src/vro/actions/shared/ConfigLoader.js"
  "com.enterprise.dfw.shared:CorrelationContext:src/vro/actions/shared/CorrelationContext.js"
  "com.enterprise.dfw.shared:RetryHandler:src/vro/actions/shared/RetryHandler.js"
  "com.enterprise.dfw.shared:CircuitBreaker:src/vro/actions/shared/CircuitBreaker.js"
  "com.enterprise.dfw.shared:RestClient:src/vro/actions/shared/RestClient.js"
  "com.enterprise.dfw.shared:PayloadValidator:src/vro/actions/shared/PayloadValidator.js"
  "com.enterprise.dfw.tags:TagCardinalityEnforcer:src/vro/actions/tags/TagCardinalityEnforcer.js"
  "com.enterprise.dfw.tags:TagOperations:src/vro/actions/tags/TagOperations.js"
  "com.enterprise.dfw.tags:TagPropagationVerifier:src/vro/actions/tags/TagPropagationVerifier.js"
  "com.enterprise.dfw.groups:GroupMembershipVerifier:src/vro/actions/groups/GroupMembershipVerifier.js"
  "com.enterprise.dfw.groups:GroupReconciler:src/vro/actions/groups/GroupReconciler.js"
  "com.enterprise.dfw.policy:DFWPolicyValidator:src/vro/actions/dfw/DFWPolicyValidator.js"
  "com.enterprise.dfw.policy:RuleConflictDetector:src/vro/actions/dfw/RuleConflictDetector.js"
  "com.enterprise.dfw.policy:PolicyDeployer:src/vro/actions/dfw/PolicyDeployer.js"
  "com.enterprise.dfw.lifecycle:SagaCoordinator:src/vro/actions/lifecycle/SagaCoordinator.js"
  "com.enterprise.dfw.lifecycle:DeadLetterQueue:src/vro/actions/lifecycle/DeadLetterQueue.js"
  "com.enterprise.dfw.lifecycle:LifecycleOrchestrator:src/vro/actions/lifecycle/LifecycleOrchestrator.js"
  "com.enterprise.dfw.lifecycle:Day0Orchestrator:src/vro/actions/lifecycle/Day0Orchestrator.js"
  "com.enterprise.dfw.lifecycle:Day2Orchestrator:src/vro/actions/lifecycle/Day2Orchestrator.js"
  "com.enterprise.dfw.lifecycle:DayNOrchestrator:src/vro/actions/lifecycle/DayNOrchestrator.js"
  "com.enterprise.dfw.lifecycle:ImpactAnalysisAction:src/vro/actions/lifecycle/ImpactAnalysisAction.js"
  "com.enterprise.dfw.lifecycle:QuarantineOrchestrator:src/vro/actions/lifecycle/QuarantineOrchestrator.js"
  "com.enterprise.dfw.lifecycle:BulkTagOrchestrator:src/vro/actions/lifecycle/BulkTagOrchestrator.js"
  "com.enterprise.dfw.lifecycle:DriftDetectionWorkflow:src/vro/actions/lifecycle/DriftDetectionWorkflow.js"
  "com.enterprise.dfw.lifecycle:LegacyOnboardingOrchestrator:src/vro/actions/lifecycle/LegacyOnboardingOrchestrator.js"
  "com.enterprise.dfw.lifecycle:MigrationVerifier:src/vro/actions/lifecycle/MigrationVerifier.js"
  "com.enterprise.dfw.tags:UntaggedVMScanner:src/vro/actions/tags/UntaggedVMScanner.js"
  "com.enterprise.dfw.shared:RateLimiter:src/vro/actions/shared/RateLimiter.js"
)

for entry in "${ACTIONS[@]}"; do
  IFS=':' read -r module name filepath <<< "$entry"
  echo "Importing $module/$name from $filepath..."
  vro-cli action import --host "$VRO_HOST" --user "$VRO_USER" \
    --module "$module" --name "$name" --file "$filepath"
done

echo "All actions imported."
```

### 2.2 vRO Workflows to Create

Create three main workflows in the vRO Workflow Designer. Each workflow receives a JSON payload string from ServiceNow, parses it, invokes the appropriate lifecycle orchestrator, and sends a callback with the result.

#### Workflow 1: DFW-Day0-Provision

- **Purpose:** Handles new VM provisioning with full tag, group, and DFW policy setup
- **Input Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `payloadJson` | `string` | JSON payload from ServiceNow containing VM details and tag assignments |

- **Scriptable Task Code:**

```javascript
// DFW-Day0-Provision — Scriptable Task
var Logger = System.getModule("com.enterprise.dfw.shared").Logger;
var ConfigLoader = System.getModule("com.enterprise.dfw.shared").ConfigLoader;
var PayloadValidator = System.getModule("com.enterprise.dfw.shared").PayloadValidator;
var Day0Orchestrator = System.getModule("com.enterprise.dfw.lifecycle").Day0Orchestrator;
var CorrelationContext = System.getModule("com.enterprise.dfw.shared").CorrelationContext;

var logger = new Logger("DFW-Day0-Provision");
var config = new ConfigLoader().load();
var correlationId = CorrelationContext.generate();

try {
    var payload = JSON.parse(payloadJson);
    logger.info("Starting Day 0 provisioning", { correlationId: correlationId, vmName: payload.vmName });

    var validator = new PayloadValidator();
    validator.validate(payload, "day0");

    var orchestrator = new Day0Orchestrator(config);
    var result = orchestrator.execute(payload, correlationId);

    logger.info("Day 0 provisioning completed", { correlationId: correlationId, result: result.status });
    System.getModule("com.enterprise.dfw.shared").RestClient.callback(config, correlationId, result);
} catch (e) {
    logger.error("Day 0 provisioning failed", { correlationId: correlationId, error: e.message });
    System.getModule("com.enterprise.dfw.shared").RestClient.callback(config, correlationId, { status: "FAILED", error: e.message });
    throw e;
}
```

- **Error Handling:** Set the workflow error handler to catch exceptions and invoke the callback with a failure status. The SagaCoordinator handles compensating actions automatically within the orchestrator.

#### Workflow 2: DFW-Day2-TagUpdate

- **Purpose:** Handles tag updates on existing VMs with impact analysis and group reconciliation
- **Input Parameters:** Same as Day 0 (`payloadJson` as `string`)

- **Scriptable Task Code:**

```javascript
// DFW-Day2-TagUpdate — Scriptable Task
var Logger = System.getModule("com.enterprise.dfw.shared").Logger;
var ConfigLoader = System.getModule("com.enterprise.dfw.shared").ConfigLoader;
var PayloadValidator = System.getModule("com.enterprise.dfw.shared").PayloadValidator;
var Day2Orchestrator = System.getModule("com.enterprise.dfw.lifecycle").Day2Orchestrator;
var CorrelationContext = System.getModule("com.enterprise.dfw.shared").CorrelationContext;

var logger = new Logger("DFW-Day2-TagUpdate");
var config = new ConfigLoader().load();
var correlationId = CorrelationContext.generate();

try {
    var payload = JSON.parse(payloadJson);
    logger.info("Starting Day 2 tag update", { correlationId: correlationId, vmName: payload.vmName });

    var validator = new PayloadValidator();
    validator.validate(payload, "day2");

    var orchestrator = new Day2Orchestrator(config);
    var result = orchestrator.execute(payload, correlationId);

    logger.info("Day 2 tag update completed", { correlationId: correlationId, result: result.status });
    System.getModule("com.enterprise.dfw.shared").RestClient.callback(config, correlationId, result);
} catch (e) {
    logger.error("Day 2 tag update failed", { correlationId: correlationId, error: e.message });
    System.getModule("com.enterprise.dfw.shared").RestClient.callback(config, correlationId, { status: "FAILED", error: e.message });
    throw e;
}
```

#### Workflow 3: DFW-DayN-Decommission

- **Purpose:** Handles VM decommission with tag removal, orphaned rule cleanup, and CMDB updates
- **Input Parameters:** Same as Day 0 (`payloadJson` as `string`)

- **Scriptable Task Code:**

```javascript
// DFW-DayN-Decommission — Scriptable Task
var Logger = System.getModule("com.enterprise.dfw.shared").Logger;
var ConfigLoader = System.getModule("com.enterprise.dfw.shared").ConfigLoader;
var PayloadValidator = System.getModule("com.enterprise.dfw.shared").PayloadValidator;
var DayNOrchestrator = System.getModule("com.enterprise.dfw.lifecycle").DayNOrchestrator;
var CorrelationContext = System.getModule("com.enterprise.dfw.shared").CorrelationContext;

var logger = new Logger("DFW-DayN-Decommission");
var config = new ConfigLoader().load();
var correlationId = CorrelationContext.generate();

try {
    var payload = JSON.parse(payloadJson);
    logger.info("Starting Day N decommission", { correlationId: correlationId, vmName: payload.vmName });

    var validator = new PayloadValidator();
    validator.validate(payload, "dayN");

    var orchestrator = new DayNOrchestrator(config);
    var result = orchestrator.execute(payload, correlationId);

    logger.info("Day N decommission completed", { correlationId: correlationId, result: result.status });
    System.getModule("com.enterprise.dfw.shared").RestClient.callback(config, correlationId, result);
} catch (e) {
    logger.error("Day N decommission failed", { correlationId: correlationId, error: e.message });
    System.getModule("com.enterprise.dfw.shared").RestClient.callback(config, correlationId, { status: "FAILED", error: e.message });
    throw e;
}
```

#### Exposing Workflows as REST Endpoints

To allow ServiceNow to trigger workflows via REST:

1. In the Orchestrator client, navigate to **Administration > API > REST API**.
2. Enable the vRO REST API if not already enabled.
3. Each workflow is invocable at: `POST /vco/api/workflows/{workflow-id}/executions`
4. The request body format:
   ```json
   {
     "parameters": [
       {
         "name": "payloadJson",
         "type": "string",
         "value": { "string": { "value": "{...escaped JSON payload...}" } }
       }
     ]
   }
   ```
5. Note each workflow's ID from the URL in the Orchestrator UI. ServiceNow will reference these IDs in the `vroTrigger.js` configuration.

### 2.3 vRO Configuration Elements

Create a Configuration Element to hold all externalized configuration values.

- **Category:** `DFW Automation`
- **Element Name:** `DFW-Pipeline-Config`

| Attribute Name | Type | Value | Description |
|---------------|------|-------|-------------|
| `vcenterUrl_NDCNG` | String | `https://vcenter-ndcng.company.internal` | vCenter endpoint for NDCNG site |
| `vcenterUrl_TULNG` | String | `https://vcenter-tulng.company.internal` | vCenter endpoint for TULNG site |
| `nsxUrl_NDCNG` | String | `https://nsx-manager-ndcng.company.internal` | NSX Manager endpoint for NDCNG |
| `nsxUrl_TULNG` | String | `https://nsx-manager-tulng.company.internal` | NSX Manager endpoint for TULNG |
| `nsxGlobalUrl` | String | `https://nsx-global-ndcng.company.internal` | NSX Global Manager endpoint |
| `snowUrl` | String | `https://instance.service-now.com` | ServiceNow instance URL |
| `snowCallbackPath` | String | `/api/x_enterprise/dfw_callbacks/vro_callback` | ServiceNow callback endpoint path |
| `retryIntervals` | String | `5000,15000,45000` | Comma-separated retry intervals in ms |
| `retryMaxRetries` | Number | `3` | Maximum retry attempts |
| `cbFailureThreshold` | Number | `5` | Circuit breaker failure threshold |
| `cbResetTimeout` | Number | `60000` | Circuit breaker reset timeout in ms |
| `cbWindowSize` | Number | `300000` | Circuit breaker window size in ms |
| `httpTimeout` | Number | `30000` | HTTP request timeout in ms |

**Credential store entries:** For each vault reference in `ConfigLoader.js`, create corresponding credential entries in the vRO Credential Store:

- `secret/vro/vcenter/username` and `secret/vro/vcenter/password`
- `secret/vro/nsx/username` and `secret/vro/nsx/password`
- `secret/vro/nsx-global/username` and `secret/vro/nsx-global/password`
- `secret/vro/snow/username` and `secret/vro/snow/password`

Navigate to **Administration > Credential Store** to add these entries.

### 2.4 ServiceNow Deployment

For each file in `src/servicenow/`, deploy to the corresponding ServiceNow component using the exact navigation paths below.

#### Client Scripts

**File:** `src/servicenow/catalog/client-scripts/vmBuildRequest_onLoad.js`
- **Navigate to:** Service Catalog > Catalog Definitions > Maintain Items > "VM Build Request" > Related Links > Client Scripts > New
- **Configuration:**
  - Name: `VM Build Request — onLoad`
  - Table: `sc_cat_item` (attached via catalog item)
  - Type: `onLoad`
  - Script: Paste the file contents
  - Active: true
  - Order: 100

**File:** `src/servicenow/catalog/client-scripts/vmBuildRequest_onChange.js`
- **Navigate to:** Same catalog item > Client Scripts > New
- **Configuration:**
  - Name: `VM Build Request — onChange`
  - Type: `onChange`
  - Variable name: (set to the variable that triggers the change — e.g., `application_code`)
  - Script: Paste the file contents
  - Active: true
  - Order: 200

**File:** `src/servicenow/catalog/client-scripts/tagUpdateRequest_onLoad.js`
- **Navigate to:** Service Catalog > Catalog Definitions > Maintain Items > "VM Security Tag Update Request" > Client Scripts > New
- **Configuration:**
  - Name: `Tag Update Request — onLoad`
  - Type: `onLoad`
  - Script: Paste the file contents
  - Active: true
  - Order: 100

**File:** `src/servicenow/catalog/client-scripts/quarantineRequest_onLoad.js`
- **Navigate to:** Service Catalog > Catalog Definitions > Maintain Items > "Emergency VM Quarantine Request" > Client Scripts > New
- **Configuration:**
  - Name: `Quarantine Request — onLoad`
  - Table: `sc_cat_item` (attached via catalog item)
  - Type: `onLoad`
  - Script: Paste the file contents
  - Active: true
  - Order: 100

**File:** `src/servicenow/catalog/client-scripts/bulkTagRequest_onLoad.js`
- **Navigate to:** Service Catalog > Catalog Definitions > Maintain Items > "Bulk Tag Remediation Request" > Client Scripts > New
- **Configuration:**
  - Name: `Bulk Tag Request — onLoad`
  - Table: `sc_cat_item` (attached via catalog item)
  - Type: `onLoad`
  - Script: Paste the file contents
  - Active: true
  - Order: 100

#### Server Scripts

**File:** `src/servicenow/catalog/server-scripts/catalogItemValidation.js`
- **Navigate to:** Service Catalog > Catalog Definitions > Maintain Items > (each catalog item) > Process Engine > Catalog Item Script
- **Configuration:**
  - This is a **Validation Script** on each catalog item
  - Paste the script into the Catalog Item's Validation Script field
  - Apply to all 5 catalog items listed in Section 2.6

**File:** `src/servicenow/catalog/server-scripts/tagDictionaryLookup.js`
- **Navigate to:** System Definition > Script Includes > New
- **Configuration:**
  - Name: `TagDictionaryLookup`
  - API Name: `global.TagDictionaryLookup`
  - Client callable: **true** (used by GlideAjax from client scripts)
  - Script: Paste the file contents
  - Active: true

#### UI Policies

**File:** `src/servicenow/catalog/ui-policies/conditionalFieldPolicies.js`
- **Navigate to:** Service Catalog > Catalog Definitions > Maintain Items > (catalog item) > Related Links > Catalog UI Policies
- **Configuration:** Create the UI Policies as defined in the configuration within the file. Each policy controls field visibility based on selected values (e.g., show Compliance-specific fields only when Compliance is not "None").

#### Integration Scripts

**File:** `src/servicenow/integration/vroTrigger.js`
- **Deploy as:** Subflow or Flow action in Flow Designer, or as a Script Include called from a catalog workflow
- **Navigate to:** Process Automation > Flow Designer > New Subflow (or System Definition > Script Includes > New)
- **Configuration:**
  - Name: `VroTrigger`
  - This script builds the REST payload and invokes the vRO REST endpoint
  - Configure the vRO endpoint URL and authentication within the script or reference a Connection & Credential alias

**File:** `src/servicenow/integration/vroCallbackHandler.js`
- **Deploy as:** Scripted REST API Resource
- **Navigate to:** System Web Services > Scripted REST APIs > New
- **Configuration:**
  - Service name: `DFW Automation Callbacks`
  - API ID: `x_enterprise_dfw_callbacks`
  - Base API path: `/api/x_enterprise/dfw_callbacks`
- Then create a **Scripted REST Resource** under this service:
  - Resource name: `vRO Callback Handler`
  - HTTP Method: `POST`
  - Relative path: `/vro_callback`
  - Script: Paste the file contents
  - Authentication: Requires `rest_api_explorer` role
- **Full callback URL:** `https://<instance>.service-now.com/api/x_enterprise/dfw_callbacks/vro_callback`

**File:** `src/servicenow/integration/correlationIdGenerator.js`
- **Navigate to:** System Definition > Script Includes > New
- **Configuration:**
  - Name: `CorrelationIdGenerator`
  - Client callable: false
  - Script: Paste the file contents
  - Active: true

#### Business Rules

**File:** `src/servicenow/business-rules/tagFieldServerValidation.js`
- **Navigate to:** System Definition > Business Rules > New
- **Configuration:**
  - Name: `Tag Field Server Validation`
  - Table: `sc_req_item`
  - When to run: **before** insert and update
  - Filter: (optional) add condition to scope to DFW-related catalog items
  - Script: Paste the file contents
  - Active: true
  - Order: 100

### 2.5 ServiceNow Tables to Create

#### Enterprise Tag Dictionary (`u_enterprise_tag_dictionary`)

1. Navigate to: **System Definition > Tables > New**
2. Set:
   - Label: `Enterprise Tag Dictionary`
   - Name: `u_enterprise_tag_dictionary`
   - Add to Module: `DFW Automation`
3. Add the following columns:

| Column Label | Column Name | Type | Length | Mandatory | Notes |
|-------------|-------------|------|--------|-----------|-------|
| Category | `u_category` | Choice | — | Yes | Values: Application, Tier, Environment, Compliance, DataClassification, CostCenter |
| Value | `u_value` | String | 128 | Yes | The tag value (e.g., "Production", "Web") |
| NSX Tag Key | `u_nsx_tag_key` | String | 128 | Yes | NSX-T tag scope — typically matches category name |
| Description | `u_description` | String | 1000 | Yes | Human-readable description |
| Is Active | `u_is_active` | True/False | — | Yes | Whether value is available for new assignments |
| Cardinality | `u_cardinality` | Choice | — | No | SINGLE or MULTI |
| Requires Approval | `u_requires_approval` | True/False | — | No | Whether additional approval is needed |
| Approver Role | `u_approver_role` | String | 256 | No | Role required for approval |
| Effective Date | `u_effective_date` | Date | — | No | When the tag value becomes available |
| Retirement Date | `u_retirement_date` | Date | — | No | Planned deactivation date |

4. Click **Submit** to create the table.
5. Add a **unique index** on (`u_category`, `u_value`) to prevent duplicate entries.

### 2.6 ServiceNow Catalog Items to Create

Create 5 catalog items under the Service Catalog. Navigate to **Service Catalog > Catalog Definitions > Maintain Items > New** for each.

#### 1. VM Build Request (Windows)

- **Name:** VM Build Request (Windows)
- **Category:** Infrastructure
- **Variables:**

| Variable | Type | Mandatory | Reference Qualifier / Choices |
|----------|------|-----------|-------------------------------|
| Application Code | Reference | Yes | Table: `u_enterprise_tag_dictionary`, filter: `u_category=Application^u_is_active=true` |
| Tier | Select Box | Yes | Choices from tag dictionary: Web, Application, Database, Middleware, Utility, Shared-Services |
| Environment | Select Box | Yes | Choices: Production, Pre-Production, UAT, Staging, Development, Sandbox, DR |
| Compliance | Multi Select | Yes | Choices: PCI, HIPAA, SOX, None |
| Data Classification | Select Box | Yes | Choices: Public, Internal, Confidential, Restricted |
| Cost Center | String | No | Pattern: CC followed by 4-8 digits |
| Site | Select Box | Yes | Choices: NDCNG, TULNG |
| VM Name | String | Yes | Auto-generated or manual |
| Business Justification | Multi-line Text | Yes | Free text |

- **Workflow:** Attach an approval workflow (manager approval; Security Architect for Production + PCI/HIPAA)
- **Validation Script:** Attach `catalogItemValidation.js`
- **Client Scripts:** Attach `vmBuildRequest_onLoad.js` and `vmBuildRequest_onChange.js`

#### 2. VM Build Request (Linux)

- Same structure as Windows, separate catalog item. Adjust any OS-specific variables (e.g., template name defaults to `RHEL9-GOLD-TEMPLATE` instead of `W2K22-GOLD-TEMPLATE`).

#### 3. VM Security Tag Update Request

- **Name:** VM Security Tag Update Request
- **Category:** Infrastructure
- **Variables:**

| Variable | Type | Mandatory | Notes |
|----------|------|-----------|-------|
| VM (CMDB CI) | Reference | Yes | Table: `cmdb_ci_vm_instance`, filter: `operational_status=1` |
| Current Tags | Multi-line Text | No | Read-only — populated by client script from NSX |
| New Environment | Select Box | No | Same choices as Day 0 |
| New Tier | Select Box | No | Same choices as Day 0 |
| New Compliance | Multi Select | No | Same choices as Day 0 |
| New Data Classification | Select Box | No | Same choices as Day 0 |
| Change Justification | Multi-line Text | Yes | Free text |

- **Client Scripts:** Attach `tagUpdateRequest_onLoad.js`
- **Workflow:** Security Architect approval if changing from/to Production

#### 4. VM Decommission Request

- **Name:** VM Decommission Request
- **Category:** Infrastructure
- **Variables:**

| Variable | Type | Mandatory | Notes |
|----------|------|-----------|-------|
| VM (CMDB CI) | Reference | Yes | Table: `cmdb_ci_vm_instance` |
| Decommission Reason | Select Box | Yes | Choices: End of Life, Migration, Replacement, Other |
| Decommission Details | Multi-line Text | Yes | Free text |
| Confirm CMDB Relationships Reviewed | Checkbox | Yes | Must be checked before submission |

- **Workflow:** VM Administrator approval; auto-check for CMDB relationships

#### 5. Emergency VM Quarantine Request

- **Name:** Emergency VM Quarantine Request
- **Category:** Security
- **Variables:**

| Variable | Type | Mandatory | Notes |
|----------|------|-----------|-------|
| VM (CMDB CI) | Reference | Yes | Table: `cmdb_ci_vm_instance` |
| Justification | Multi-line Text | Yes | Security incident description |
| Quarantine Duration | Select Box | Yes | Choices: 1 hour, 4 hours, 24 hours, Indefinite |
| Incident Number | Reference | No | Table: `incident` — link to active security incident |

- **Workflow:** No approval required (break-glass — Security Architect role can submit directly)

### 2.7 NSX Configuration

#### Tag Categories

Create the following tag categories in each NSX Manager (NDCNG and TULNG). Navigate to **Inventory > Tags > Tag Categories > Add Category** in the NSX Manager UI.

| Category Name | Cardinality | Description |
|--------------|-------------|-------------|
| Application | Single | Application code from CMDB |
| Tier | Single | Deployment tier (Web, App, DB, etc.) |
| Environment | Single | Deployment environment (Production, Dev, etc.) |
| Compliance | Multiple | Compliance frameworks (PCI, HIPAA, SOX, None) |
| DataClassification | Single | Data sensitivity level |
| CostCenter | Single | Financial cost center for chargeback |

See `policies/tag-categories/categories.yaml` for the full taxonomy with allowed values, validation patterns, and governance rules.

#### Dynamic Security Groups

Create aggregate groups from `policies/security-groups/aggregate-groups.yaml`. In NSX Manager, navigate to **Inventory > Groups > Add Group**.

**Environment Groups:**
- `All-Production-VMs` — Criteria: Tag `Environment` EQUALS `Production`
- `All-Development-VMs` — Criteria: Tag `Environment` EQUALS `Development`
- `All-PreProduction-VMs` — Criteria: Tag `Environment` EQUALS `Pre-Production`
- `All-Sandbox-VMs` — Criteria: Tag `Environment` EQUALS `Sandbox`

**Tier Groups:**
- `All-Web-Tier-VMs` — Criteria: Tag `Tier` EQUALS `Web`
- `All-App-Tier-VMs` — Criteria: Tag `Tier` EQUALS `Application`
- `All-Database-VMs` — Criteria: Tag `Tier` EQUALS `Database`

**Compliance Groups:**
- `All-PCI-VMs` — Criteria: Tag `Compliance` EQUALS `PCI`
- `All-HIPAA-VMs` — Criteria: Tag `Compliance` EQUALS `HIPAA`
- `All-SOX-VMs` — Criteria: Tag `Compliance` EQUALS `SOX`

**Application-specific groups** (from `policies/security-groups/application-groups.yaml`):
- `APP001_Web_Production` — Criteria: Tag `Application` EQUALS `APP001` AND Tag `Tier` EQUALS `Web` AND Tag `Environment` EQUALS `Production`
- `APP001_App_Production` — Same pattern for App tier
- `APP001_DB_Production` — Same pattern for Database tier

Also create the **infrastructure support groups** referenced by DFW policies:
- `DNS-Servers`, `NTP-Servers`, `AD-Domain-Controllers`, `Monitoring-Servers`, `Backup-Servers`, `Management-Jump-Hosts`, `Quarantined-VMs`

These groups use IP-based or tag-based criteria matching your infrastructure server inventory.

#### DFW Policies

Import or recreate the DFW policies from the `policies/dfw-rules/` YAML files. In NSX Manager, navigate to **Security > Distributed Firewall**.

Each policy must be placed in the correct DFW category:

| DFW Category | Policy | YAML File | Priority |
|-------------|--------|-----------|----------|
| Emergency | Emergency Quarantine Isolation Rules | `emergency-quarantine.yaml` | 100 |
| Infrastructure | Shared Services Infrastructure Allow Rules | `infrastructure-shared-services.yaml` | 1000 |
| Environment | Environment Zone Isolation Rules | `environment-zone-isolation.yaml` | 2000 |
| Application | APP001 Three-Tier Micro-Segmentation | `application-template.yaml` | 3100 |
| Application | Default Deny All | (manual) | 9999 |

**Default Deny All** — Create a final catch-all rule in the Application category:
- Rule name: `Default-Deny-All`
- Action: `DROP`
- Source: `ANY`
- Destination: `ANY`
- Services: `ANY`
- Logged: `true`
- Log label: `DEFAULT-DENY-ALL`
- Sequence: `9999`

### 2.8 Adapters Deployment

The adapter files in `src/adapters/` are utility modules used within vRO actions:

| File | vRO Module | Action Name | Purpose |
|------|-----------|-------------|---------|
| `NsxApiAdapter.js` | `com.enterprise.dfw.adapters` | `NsxApiAdapter` | Abstracts NSX Manager REST API calls |
| `VcenterApiAdapter.js` | `com.enterprise.dfw.adapters` | `VcenterApiAdapter` | Abstracts vCenter REST API calls |
| `SnowPayloadAdapter.js` | `com.enterprise.dfw.adapters` | `SnowPayloadAdapter` | Transforms ServiceNow payloads to internal format |

Import these as vRO actions in the `com.enterprise.dfw.adapters` module following the same procedure as Section 2.1. These adapters should be imported **after** the shared module but **before** the tags/groups/dfw modules that consume them.

---

## 3. Test Data Setup for Demos

This section provides complete test data and demo scenarios for stakeholder presentations.

### 3.1 ServiceNow Test Data

#### Enterprise Tag Dictionary — Bulk Load

Populate the `u_enterprise_tag_dictionary` table with the following records. Use the background script below to load all entries at once.

**Environment Values (7 entries):**

| Category | Value | NSX Tag Key | Description | Is Active | Requires Approval |
|----------|-------|-------------|-------------|-----------|-------------------|
| Environment | Production | Environment | Live production workloads serving end users | true | false |
| Environment | Pre-Production | Environment | Final staging before production — mirrors production config | true | false |
| Environment | UAT | Environment | User acceptance testing — business validation | true | false |
| Environment | Staging | Environment | Integration testing and release candidate validation | true | false |
| Environment | Development | Environment | Active development and unit testing | true | false |
| Environment | Sandbox | Environment | Experimental and proof-of-concept workloads | true | false |
| Environment | DR | Environment | Disaster recovery replicas — mirrors production | true | false |

**Tier Values (6 entries):**

| Category | Value | NSX Tag Key | Description | Is Active | Requires Approval |
|----------|-------|-------------|-------------|-----------|-------------------|
| Tier | Web | Tier | Front-end web servers, reverse proxies | true | false |
| Tier | Application | Tier | Business logic servers, API gateways | true | false |
| Tier | Database | Tier | Relational databases, NoSQL stores | true | false |
| Tier | Middleware | Tier | Message queues, ESBs, integration platforms | true | false |
| Tier | Utility | Tier | Jump hosts, bastion servers, automation runners | true | false |
| Tier | Shared-Services | Tier | DNS, NTP, LDAP, monitoring, backup | true | false |

**Compliance Values (4 entries):**

| Category | Value | NSX Tag Key | Description | Is Active | Requires Approval |
|----------|-------|-------------|-------------|-----------|-------------------|
| Compliance | PCI | Compliance | Payment Card Industry DSS v4.0 | true | true |
| Compliance | HIPAA | Compliance | Health Insurance Portability and Accountability Act | true | true |
| Compliance | SOX | Compliance | Sarbanes-Oxley Act IT General Controls | true | true |
| Compliance | None | Compliance | No specific compliance framework | true | false |

**DataClassification Values (4 entries):**

| Category | Value | NSX Tag Key | Description | Is Active | Requires Approval |
|----------|-------|-------------|-------------|-----------|-------------------|
| DataClassification | Public | DataClassification | Data intended for public consumption | true | false |
| DataClassification | Internal | DataClassification | Internal-use data — not for external distribution | true | false |
| DataClassification | Confidential | DataClassification | Sensitive business data — PII, financials, trade secrets | true | true |
| DataClassification | Restricted | DataClassification | Highest sensitivity — ePHI, PAN, classified | true | true |

**Application Values (5 entries):**

| Category | Value | NSX Tag Key | Description | Is Active | Requires Approval |
|----------|-------|-------------|-------------|-----------|-------------------|
| Application | APP001 | Application | WebPortal — Enterprise customer-facing portal | true | false |
| Application | APP002 | Application | PaymentGateway — Credit card processing platform | true | false |
| Application | APP003 | Application | HRSystem — Human resources management | true | false |
| Application | APP004 | Application | MonitoringPlatform — Infrastructure observability | true | false |
| Application | APP005 | Application | DatabaseCluster — Shared database infrastructure | true | false |

**Bulk-Load Background Script:**

Run this in ServiceNow at **System Definition > Scripts — Background**:

```javascript
// Background script to populate Enterprise Tag Dictionary
// Run at: System Definition > Scripts — Background

var records = [
    // Environment
    { category: 'Environment', value: 'Production', nsxTagKey: 'Environment', description: 'Live production workloads serving end users', isActive: true, requiresApproval: false },
    { category: 'Environment', value: 'Pre-Production', nsxTagKey: 'Environment', description: 'Final staging before production — mirrors production config', isActive: true, requiresApproval: false },
    { category: 'Environment', value: 'UAT', nsxTagKey: 'Environment', description: 'User acceptance testing — business validation', isActive: true, requiresApproval: false },
    { category: 'Environment', value: 'Staging', nsxTagKey: 'Environment', description: 'Integration testing and release candidate validation', isActive: true, requiresApproval: false },
    { category: 'Environment', value: 'Development', nsxTagKey: 'Environment', description: 'Active development and unit testing', isActive: true, requiresApproval: false },
    { category: 'Environment', value: 'Sandbox', nsxTagKey: 'Environment', description: 'Experimental and proof-of-concept workloads', isActive: true, requiresApproval: false },
    { category: 'Environment', value: 'DR', nsxTagKey: 'Environment', description: 'Disaster recovery replicas — mirrors production', isActive: true, requiresApproval: false },
    // Tier
    { category: 'Tier', value: 'Web', nsxTagKey: 'Tier', description: 'Front-end web servers, reverse proxies, and static content servers', isActive: true, requiresApproval: false },
    { category: 'Tier', value: 'Application', nsxTagKey: 'Tier', description: 'Business logic servers, API gateways, and middleware', isActive: true, requiresApproval: false },
    { category: 'Tier', value: 'Database', nsxTagKey: 'Tier', description: 'Relational databases, NoSQL stores, and data warehouses', isActive: true, requiresApproval: false },
    { category: 'Tier', value: 'Middleware', nsxTagKey: 'Tier', description: 'Message queues, ESBs, and integration platforms', isActive: true, requiresApproval: false },
    { category: 'Tier', value: 'Utility', nsxTagKey: 'Tier', description: 'Jump hosts, bastion servers, automation runners', isActive: true, requiresApproval: false },
    { category: 'Tier', value: 'Shared-Services', nsxTagKey: 'Tier', description: 'DNS, NTP, LDAP, monitoring, backup', isActive: true, requiresApproval: false },
    // Compliance
    { category: 'Compliance', value: 'PCI', nsxTagKey: 'Compliance', description: 'Payment Card Industry Data Security Standard (PCI DSS v4.0)', isActive: true, requiresApproval: true },
    { category: 'Compliance', value: 'HIPAA', nsxTagKey: 'Compliance', description: 'Health Insurance Portability and Accountability Act', isActive: true, requiresApproval: true },
    { category: 'Compliance', value: 'SOX', nsxTagKey: 'Compliance', description: 'Sarbanes-Oxley Act — IT General Controls', isActive: true, requiresApproval: true },
    { category: 'Compliance', value: 'None', nsxTagKey: 'Compliance', description: 'No specific compliance framework applies', isActive: true, requiresApproval: false },
    // DataClassification
    { category: 'DataClassification', value: 'Public', nsxTagKey: 'DataClassification', description: 'Data intended for public consumption — no sensitivity', isActive: true, requiresApproval: false },
    { category: 'DataClassification', value: 'Internal', nsxTagKey: 'DataClassification', description: 'Internal-use data — not for external distribution', isActive: true, requiresApproval: false },
    { category: 'DataClassification', value: 'Confidential', nsxTagKey: 'DataClassification', description: 'Sensitive business data — PII, financial records, trade secrets', isActive: true, requiresApproval: true },
    { category: 'DataClassification', value: 'Restricted', nsxTagKey: 'DataClassification', description: 'Highest sensitivity — regulated data (ePHI, PAN, classified)', isActive: true, requiresApproval: true },
    // Application
    { category: 'Application', value: 'APP001', nsxTagKey: 'Application', description: 'WebPortal — Enterprise customer-facing portal', isActive: true, requiresApproval: false },
    { category: 'Application', value: 'APP002', nsxTagKey: 'Application', description: 'PaymentGateway — Credit card processing platform', isActive: true, requiresApproval: false },
    { category: 'Application', value: 'APP003', nsxTagKey: 'Application', description: 'HRSystem — Human resources management', isActive: true, requiresApproval: false },
    { category: 'Application', value: 'APP004', nsxTagKey: 'Application', description: 'MonitoringPlatform — Infrastructure observability', isActive: true, requiresApproval: false },
    { category: 'Application', value: 'APP005', nsxTagKey: 'Application', description: 'DatabaseCluster — Shared database infrastructure', isActive: true, requiresApproval: false }
];

var insertCount = 0;
records.forEach(function(rec) {
    var gr = new GlideRecord('u_enterprise_tag_dictionary');
    gr.initialize();
    gr.u_category = rec.category;
    gr.u_value = rec.value;
    gr.u_nsx_tag_key = rec.nsxTagKey;
    gr.u_description = rec.description;
    gr.u_is_active = rec.isActive;
    gr.u_requires_approval = rec.requiresApproval;
    gr.u_effective_date = new GlideDate().getDisplayValue();
    gr.insert();
    insertCount++;
});

gs.info('Enterprise Tag Dictionary: Inserted ' + insertCount + ' records.');
```

#### Test Users and Groups

Create the following test users and groups in ServiceNow at **User Administration > Users** and **User Administration > Groups**:

**Test Users:**

| User ID | Name | Role | Purpose |
|---------|------|------|---------|
| `vm-requestor-01` | Demo VM Requestor | `catalog_user` | Submits VM build/update/decommission requests |
| `vm-admin-01` | Demo VM Administrator | `itil`, `catalog_admin` | Approves VM requests, manages infrastructure |
| `security-architect-01` | Demo Security Architect | `itil`, `security_admin` | Approves security-sensitive changes, quarantine requests |
| `operations-lead-01` | Demo Operations Lead | `itil` | Reviews drift incidents, manages operations |

**Test Groups:**

| Group Name | Members | Purpose |
|------------|---------|---------|
| VM Requestors | `vm-requestor-01` | Default assignment group for catalog requests |
| VM Administrators | `vm-admin-01` | Approval group for VM provisioning |
| Security Architects | `security-architect-01` | Approval group for Production/PCI changes |
| Operations Leads | `operations-lead-01` | Assignment group for drift incidents |

#### Test CMDB CI Records

Create test VM Configuration Items in ServiceNow at **Configuration > Servers > Virtual Machine Instances > New** (or use `cmdb_ci_server`):

| Name | IP Address | OS | Status | Assignment Group | Environment |
|------|-----------|-----|--------|-----------------|-------------|
| NDCNG-APP001-WEB-P01 | 172.20.10.11 | RHEL 9 | Operational | VM Administrators | Production |
| NDCNG-APP001-APP-P01 | 172.20.10.12 | RHEL 9 | Operational | VM Administrators | Production |
| NDCNG-APP001-DB-P01 | 172.20.10.13 | RHEL 9 | Operational | VM Administrators | Production |
| TULNG-APP002-WEB-D01 | 172.20.20.11 | RHEL 9 | Operational | VM Administrators | Development |
| NDCNG-APP003-APP-U01 | 172.20.10.21 | RHEL 9 | Operational | VM Administrators | UAT |
| NDCNG-APP001-MID-P01 | 172.20.10.14 | RHEL 9 | Operational | VM Administrators | Production |
| TULNG-APP004-UTL-S01 | 172.20.20.21 | RHEL 9 | Operational | Operations Leads | Sandbox |
| NDCNG-APP005-DB-P01 | 172.20.10.31 | RHEL 9 | Operational | VM Administrators | Production |

For each CI, also set: `serial_number`, `model_id` (optional), `company`, and any `cmdb_ci_relationship` links for dependency-check demos.

### 3.2 vCenter / NSX Test Data

#### Test VMs

These VMs should either be pre-created in vCenter or will be created by Day 0 demos. Pre-create these for Day 2 and Day N demos:

| VM Name | Tier | Environment | Site | Compliance | Data Classification |
|---------|------|-------------|------|------------|-------------------|
| NDCNG-APP001-WEB-P01 | Web | Production | NDCNG | PCI | Confidential |
| NDCNG-APP001-APP-P01 | Application | Production | NDCNG | PCI | Confidential |
| NDCNG-APP001-DB-P01 | Database | Production | NDCNG | PCI | Restricted |
| TULNG-APP002-WEB-D01 | Web | Development | TULNG | None | Internal |
| NDCNG-APP003-APP-U01 | Application | UAT | NDCNG | SOX | Internal |

Apply the corresponding NSX tags to each VM in NSX Manager at **Inventory > Virtual Machines > (select VM) > Tags > Add Tag**.

#### NSX Tag Categories

Create these in NSX Manager at **Inventory > Tags > Tag Categories > Add Category**:

| Category | Cardinality | Description |
|----------|-------------|-------------|
| Application | Single value | Application code from CMDB |
| Tier | Single value | Deployment tier (Web, Application, Database, etc.) |
| Environment | Single value | Deployment environment |
| Compliance | Multiple values | Regulatory compliance frameworks |
| DataClassification | Single value | Data sensitivity level |
| CostCenter | Single value | Financial cost center |

#### NSX Dynamic Security Groups

Create these at **Inventory > Groups > Add Group**:

**Aggregate groups:**
- `All-Production-VMs` — Tag criteria: Environment = Production
- `All-Development-VMs` — Tag criteria: Environment = Development
- `All-Database-VMs` — Tag criteria: Tier = Database
- `All-PCI-VMs` — Tag criteria: Compliance = PCI

**Application-specific groups:**
- `APP001_Web_Production` — Tag criteria: Application = APP001 AND Tier = Web AND Environment = Production
- `APP001_App_Production` — Tag criteria: Application = APP001 AND Tier = Application AND Environment = Production
- `APP001_DB_Production` — Tag criteria: Application = APP001 AND Tier = Database AND Environment = Production

**Infrastructure support groups (IP-based or static):**
- `DNS-Servers`, `NTP-Servers`, `AD-Domain-Controllers`, `Monitoring-Servers`, `Backup-Servers`, `Management-Jump-Hosts`
- `Quarantined-VMs` — Tag criteria: Quarantine = Active

#### DFW Policies

Create the following DFW policies from the YAML templates in `policies/dfw-rules/`. In NSX Manager, navigate to **Security > Distributed Firewall** and create policies in the correct category:

1. **Emergency Quarantine** (`emergency-quarantine.yaml`) — Emergency category, priority 100
   - Allows SSH/RDP from jump hosts, ICMP from monitoring, blocks everything else for quarantined VMs
2. **Shared Services Infrastructure** (`infrastructure-shared-services.yaml`) — Infrastructure category, priority 1000
   - Allows DNS, NTP, AD/LDAP, monitoring, backup traffic from all VMs
3. **Environment Zone Isolation** (`environment-zone-isolation.yaml`) — Environment category, priority 2000
   - Blocks Production↔Development/Sandbox, allows limited Pre-Production→Production read access
4. **APP001 Application Policy** (`application-template.yaml`) — Application category, priority 3100
   - Three-tier micro-segmentation: LB→Web→App→DB with specific ports
5. **Default Deny All** (manual) — Application category, priority 9999
   - DROP all remaining traffic, logged with label `DEFAULT-DENY-ALL`

### 3.3 Test Payloads for vRO Workflow Invocation

Use the following JSON payloads when testing vRO workflows via REST API or from the vRO client directly.

#### Quarantine Payload

```json
{
  "correlationId": "CID-QUAR-TEST-001",
  "requestType": "quarantine",
  "vmId": "vm-1001",
  "site": "NDCNG",
  "justification": "Suspected lateral movement from compromised endpoint",
  "durationMinutes": 60
}
```

#### Bulk Tag Payload

```json
{
  "correlationId": "CID-BULK-TEST-001",
  "requestType": "bulk_tag",
  "site": "NDCNG",
  "vms": [
    "NDCNG-LEGACY-WEB-001",
    "NDCNG-LEGACY-APP-001",
    "NDCNG-LEGACY-DB-001"
  ],
  "batchSize": 10,
  "dryRun": true
}
```

#### Drift Scan Payload

```json
{
  "correlationId": "CID-DRIFT-TEST-001",
  "requestType": "drift_scan",
  "site": "NDCNG",
  "scope": "full",
  "autoRemediate": true
}
```

### 3.4 Demo Scenarios — Step-by-Step Walkthrough

These scenarios are designed for live stakeholder demonstrations. Each scenario builds on the test data above.

#### Demo 1: Day 0 — New VM Provisioning with Auto-DFW

This demo shows the full end-to-end flow from ServiceNow catalog request to DFW policy enforcement.

**Steps:**

1. Log into ServiceNow as `vm-requestor-01`.
2. Navigate to **Service Catalog > VM Build Request (Linux)**.
3. Fill in the form:
   - Application: `APP001` (select from tag dictionary lookup)
   - Tier: `Web`
   - Environment: `Production`
   - Compliance: `PCI`
   - Data Classification: `Confidential`
   - Cost Center: `CC-IT-INFRA-001`
   - Site: `NDCNG`
4. **Demonstrate form validation:** Try submitting without Application — show the inline error message from the client script.
5. Submit the request. Show the RITM number generated (e.g., `RITM0010001`).
6. **Show the approval workflow:** The request routes to VM Administrators for standard approval, plus Security Architects because the request is for Production + PCI.
7. Log in as `vm-admin-01` and approve the request.
8. Log in as `security-architect-01` and approve the security sign-off.
9. **Show vRO workflow execution:** Navigate to vRO > Workflow Runs and find the `DFW-Day0-Provision` execution. Show the correlation ID matching the one written to RITM work notes.
10. **Show results in vCenter:** The new VM appears with tags — Application=APP001, Tier=Web, Environment=Production, Compliance=PCI, DataClassification=Confidential.
11. **Show results in NSX Manager:** The VM appears in the relevant dynamic security groups — `All-Production-VMs`, `All-Web-Tier-VMs`, `All-PCI-VMs`, `APP001_Web_Production`.
12. **Show DFW rules are active:** Navigate to Security > Distributed Firewall and verify the APP001 policy rules cover the new VM. Test connectivity — the VM should accept HTTPS (443) from the load balancer group and reject direct database connections.
13. **Show the callback in ServiceNow:** The RITM work notes show the success message with the correlation ID, VM name, and applied tags.

**Expected duration:** 10-15 minutes.

#### Demo 2: Day 2 — Tag Update with Impact Analysis

This demo shows how updating a VM's tags triggers automatic group re-evaluation and DFW policy changes.

**Steps:**

1. Log into ServiceNow as `vm-requestor-01`.
2. Navigate to **Service Catalog > VM Security Tag Update Request**.
3. Select existing VM: `NDCNG-APP001-WEB-P01`.
4. The client script (`tagUpdateRequest_onLoad.js`) fetches and displays current tags in a read-only field.
5. Change **Environment** from `Production` to `Pre-Production`.
6. **Show the impact analysis:** The form displays which security groups the VM will leave (e.g., `All-Production-VMs`) and which it will join (e.g., `All-PreProduction-VMs`). DFW rule changes are summarized.
7. Submit the request. Since this is a change *from* Production, it routes to **Security Architects** for approval.
8. Log in as `security-architect-01` and approve.
9. **Show vRO workflow execution:** The `DFW-Day2-TagUpdate` workflow runs, showing tag delta computation, group reconciliation, and DFW re-evaluation.
10. **Show updated tags in NSX Manager:** The VM's Environment tag is now `Pre-Production`.
11. **Show updated group membership:** The VM is no longer in `All-Production-VMs` and is now in `All-PreProduction-VMs`.

**Expected duration:** 8-10 minutes.

#### Demo 3: Day N — Decommission with Safety Checks

This demo shows the decommission flow including dependency checks and cleanup.

**Steps:**

1. Log into ServiceNow as `vm-admin-01`.
2. Navigate to **Service Catalog > VM Decommission Request**.
3. Select a test VM (e.g., `TULNG-APP002-WEB-D01`).
4. Fill in: Reason = "End of Life", Details = "Development VM no longer needed".
5. Check the "Confirm CMDB Relationships Reviewed" checkbox.
6. **Show the dependency check:** If the VM has CMDB relationships (upstream/downstream CIs), the system flags them and may create an intervention task for manual review.
7. **Show orphaned rule detection:** The pipeline identifies if removing this VM from a security group would leave the group empty, potentially orphaning DFW rules.
8. Submit and approve as `vm-admin-01`.
9. **Show the cleanup sequence in vRO:**
   - Tags removed from the VM in NSX
   - VM removed from dynamic security groups (automatic via tag removal)
   - Orphaned groups cleaned up if applicable
   - CMDB CI status changed to `Retired`
10. **Show the results:** VM tags cleared in NSX, CMDB CI shows `Retired` status, RITM closed with success.

**Expected duration:** 8-10 minutes.

#### Demo 4: Emergency Quarantine

This demo shows the break-glass quarantine flow for security incidents.

**Steps:**

1. Log into ServiceNow as `security-architect-01`.
2. Navigate to **Service Catalog > Emergency VM Quarantine Request**.
3. Select a VM (e.g., `NDCNG-APP001-WEB-P01`).
4. Fill in: Justification = "Suspected lateral movement from compromised endpoint", Duration = "1 hour", Incident = (link to test incident if available).
5. Submit — no approval required (break-glass flow).
6. **Show the Quarantine tag applied in NSX:** Tag `Quarantine=Active` is set on the VM.
7. **Show the VM joins the `Quarantined-VMs` group** in NSX Manager.
8. **Show DFW enforcement:** The Emergency Quarantine policy takes effect immediately:
   - All traffic blocked except SSH/RDP from Management Jump Hosts and ICMP from Monitoring Servers
   - Try pinging the VM from a non-management host — traffic is dropped and logged
   - Try SSHing from a jump host — connection succeeds
9. **Show the auto-expiry:** After the quarantine duration (1 hour), the system automatically removes the `Quarantine=Active` tag, restoring normal DFW policies.

**Expected duration:** 5-8 minutes.

#### Demo 5: Drift Detection and Auto-Remediation

This demo shows how the pipeline detects and corrects unauthorized tag changes.

**Steps:**

1. **Simulate drift:** Log into NSX Manager directly and manually remove the `Environment=Production` tag from `NDCNG-APP001-APP-P01`. This simulates an unauthorized change outside the approved pipeline.
2. **Trigger drift detection:** Either wait for the scheduled daily drift scan workflow in vRO, or trigger it manually from the vRO client.
3. **Show the ServiceNow incident:** The drift scanner creates an incident in ServiceNow:
   - Short description: "Tag drift detected on NDCNG-APP001-APP-P01"
   - Details: Expected tags vs. actual tags, with the missing `Environment=Production` tag highlighted
   - Assignment group: Operations Leads
4. **Show auto-remediation:** The pipeline automatically re-applies the missing `Environment=Production` tag to the VM.
5. **Verify in NSX Manager:** The tag is restored, and the VM is back in `All-Production-VMs` and `APP001_App_Production` groups.
6. **Show incident update:** The ServiceNow incident work notes are updated with the remediation action and the incident is auto-resolved.

**Expected duration:** 5-8 minutes.

#### Demo 6: Emergency Quarantine with Auto-Expiry Verification

This demo walks through the full quarantine lifecycle including tag application, traffic blocking, and auto-expiry metadata verification.

**Steps:**

1. Submit a quarantine request for a compromised VM (e.g., `NDCNG-APP001-WEB-P01`) using the Emergency VM Quarantine Request catalog item or the quarantine test payload via the vRO REST API.
2. **Verify quarantine tag applied:** In NSX Manager, confirm that the `Quarantine=Active` tag is present on the target VM and that it has joined the `Quarantined-VMs` dynamic security group.
3. **Verify traffic blocked:** Attempt to reach the VM from a non-management host — all traffic should be dropped by the Emergency Quarantine DFW policy. Verify that SSH/RDP from Management Jump Hosts still succeeds.
4. **Verify auto-expiry metadata:** Inspect the VM's custom attributes or the quarantine tracking record in ServiceNow to confirm the expiry timestamp matches the requested duration (e.g., 60 minutes from submission). After the duration elapses, confirm the `Quarantine=Active` tag is automatically removed and normal DFW policies are restored.

**Expected duration:** 8-10 minutes.

#### Demo 7: Bulk Legacy Onboarding

This demo shows how to onboard a batch of legacy VMs that were deployed outside the standard pipeline.

**Steps:**

1. **Prepare CSV with legacy VMs:** Create a CSV file listing VMs to onboard with columns for VM name, Application, Tier, Environment, Compliance, DataClassification, and Site. Include at least 3 VMs (e.g., `NDCNG-LEGACY-WEB-001`, `NDCNG-LEGACY-APP-001`, `NDCNG-LEGACY-DB-001`).
2. **Execute dry-run:** Submit the bulk tag payload with `dryRun: true` via the vRO REST API or the Bulk Tag Remediation Request catalog item. The BulkTagOrchestrator processes the CSV and generates a report of intended changes without modifying any tags.
3. **Review report:** Examine the dry-run report to verify the planned tag assignments, group memberships, and DFW policy coverage for each VM.
4. **Execute live run:** Re-submit the bulk tag payload with `dryRun: false`. The BulkTagOrchestrator processes VMs in batches (controlled by `batchSize`) with concurrency limits managed by the RateLimiter.
5. **Verify tags and group memberships:** In NSX Manager, confirm that each onboarded VM has the correct tags applied and appears in the expected dynamic security groups. Verify CMDB CI records are updated in ServiceNow.

**Expected duration:** 10-15 minutes.

#### Demo 8: Drift Detection with Auto-Remediation Verification

This demo verifies the full drift detection lifecycle from scan initiation through auto-remediation.

**Steps:**

1. **Trigger drift scan for a site:** Submit the drift scan payload targeting the NDCNG site with `autoRemediate: true` via the vRO REST API, or trigger the DriftDetectionWorkflow manually from the vRO client. The scan compares the expected tag state (from ServiceNow CMDB and the tag dictionary) against the actual tag state in NSX Manager.
2. **Review drift report:** Examine the drift report generated by the workflow. The report lists each VM with discrepancies — missing tags, extra tags, and incorrect tag values. Verify that the report includes the VM where drift was simulated (e.g., `NDCNG-APP001-APP-P01` with a missing `Environment=Production` tag).
3. **Verify auto-remediation applied correct tags:** In NSX Manager, confirm that the DriftDetectionWorkflow has re-applied the missing or corrected tags. Verify the VM has been restored to the expected dynamic security groups. Check the ServiceNow incident created by the drift scanner to confirm it was auto-resolved with remediation details in the work notes.

**Expected duration:** 8-10 minutes.

---

## 4. Monitor-Mode Deployment

Monitor mode allows new DFW policies to be deployed in an observation-only state before full enforcement. This reduces risk by enabling operators to review traffic patterns and identify false positives before blocking legitimate traffic.

### 4.1 Deploying Policies in Monitor Mode

To deploy a policy in monitor mode, set the `deploymentMode` property to `MONITOR` in the policy definition or pass it as a parameter to the PolicyDeployer:

```javascript
const deployer = new PolicyDeployer(nsxClient, logger, configLoader);

// Deploy in monitor mode (ALLOW action with logging enabled)
const result = await deployer.deployMonitorMode(policyDefinition, site);
// result: { deployed: true, policyId: 'policy-123', mode: 'MONITOR', ruleCount: 5 }
```

In monitor mode, all rules are deployed with `action: ALLOW` and `logged: true` regardless of the intended enforcement action. This allows all traffic to pass while generating log entries for every matched connection. The original intended actions (ALLOW, DROP, REJECT) are preserved in rule tags so they can be restored during promotion.

### 4.2 Reviewing Traffic Logs

After deploying in monitor mode, review the traffic logs in your SIEM (Splunk/ELK) to validate policy correctness:

1. **Filter logs** by the policy ID and log label assigned during monitor-mode deployment.
2. **Identify false positives** -- legitimate traffic that would be blocked under enforcement mode. Look for log entries where the intended action is DROP but the traffic source/destination is a known-good communication path.
3. **Identify missing rules** -- expected traffic flows that do not appear in the logs, indicating that the policy scope may not cover all required workloads.
4. **Review for a minimum observation period** (recommended: 48-72 hours, configurable via `monitorModeDurationHours` in the pipeline configuration) to capture business-cycle traffic variations.

### 4.3 Promoting to Enforcement

Once the observation period confirms that the policy is correct, promote it to enforcement mode:

```javascript
// Promote from MONITOR to ENFORCE -- restores original rule actions
const promoteResult = await deployer.promoteToEnforce(policyId, site);
// promoteResult: { promoted: true, policyId: 'policy-123', mode: 'ENFORCE', ruleCount: 5 }
```

Promotion restores each rule's original action (DROP, REJECT, ALLOW) and retains logging. The transition is atomic at the policy level -- all rules within the policy are promoted together to prevent partial enforcement states.

### 4.4 Checking Current Deployment Mode

Query the current deployment mode of any policy:

```javascript
const mode = await deployer.getDeploymentMode(policyId, site);
// mode: 'MONITOR' | 'ENFORCE' | 'DISABLED'
```

---

## 5. Drift Trend Analysis

Drift trend analysis extends the standard drift detection workflow by storing historical scan results and computing trends over configurable lookback windows. This enables operators to identify systemic drift patterns, recurring offenders, and environmental factors contributing to tag inconsistency.

### 5.1 Configuration

Drift trend tracking is configured in the pipeline configuration under the `driftTrend` section:

```javascript
{
  driftTrend: {
    enabled: true,                    // Enable/disable trend tracking
    lookbackDays: 30,                 // Number of days of scan history to retain
    scanRetentionCount: 100,          // Maximum number of scan records per VM
    trendThreshold: 3,                // Number of drift occurrences to flag as trending
    storageMode: 'local+servicenow'   // Store history locally and sync to ServiceNow
  }
}
```

### 5.2 How It Works

1. **Scan History Storage**: After each drift detection scan, the `DriftDetectionWorkflow.storeScanHistory()` method persists the scan results (VM ID, drift categories, severity, timestamp) to local storage and optionally to a ServiceNow custom table.
2. **Trend Analysis**: The `DriftDetectionWorkflow.analyzeDriftTrend()` method queries stored scan history within the configured lookback window and computes per-VM and per-category drift frequency.
3. **Summary Generation**: The `DriftDetectionWorkflow.generateDriftSummary()` method produces a structured report identifying:
   - VMs with recurring drift (exceeding the trend threshold)
   - Most frequently drifted tag categories
   - Time-of-day and day-of-week drift patterns
   - Correlation between drift events and infrastructure changes (e.g., vMotion, maintenance windows)

### 5.3 Lookback Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `lookbackDays` | 30 | How far back to analyze scan history |
| `scanRetentionCount` | 100 | Maximum stored scans per VM before oldest are pruned |
| `trendThreshold` | 3 | Minimum drift occurrences within the lookback window to classify as a trend |

Operators can adjust these settings per site or globally. Shorter lookback windows (7 days) are useful for detecting acute issues, while longer windows (90 days) reveal chronic patterns.

---

## 6. Running Tests

### 6.1 Quick Reference

```bash
# Run the full test suite with coverage
npm test

# Run with detailed coverage report
npx jest --coverage

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run a specific test directory
npx jest tests/unit/dfw/
npx jest tests/unit/lifecycle/
npx jest tests/unit/shared/
npx jest tests/unit/tags/
npx jest tests/unit/servicenow/

# Run a single test file
npx jest tests/unit/dfw/PolicyDeployer.test.js

# Run tests matching a name pattern
npx jest --testNamePattern="monitor mode"

# Watch mode for development
npx jest --watch

# Generate coverage summary only
npx jest --coverage --coverageReporters=text-summary
```

### 6.2 Coverage Targets

The project targets **95%+** line, branch, function, and statement coverage across all modules. Coverage is enforced in CI -- builds fail if coverage drops below the configured thresholds.

| Metric | Target |
|--------|--------|
| Line Coverage | 95%+ |
| Branch Coverage | 95%+ |
| Function Coverage | 95%+ |
| Statement Coverage | 95%+ |

### 6.3 Test Organization

| Directory | Contents | Count |
|-----------|----------|-------|
| `tests/unit/shared/` | Shared utilities (CircuitBreaker, RetryHandler, Logger, etc.) | ~10 suites |
| `tests/unit/tags/` | Tag operations and cardinality enforcement | ~3 suites |
| `tests/unit/groups/` | Group membership and reconciliation | ~2 suites |
| `tests/unit/dfw/` | DFW policy validation, conflict detection, deployment | ~5 suites |
| `tests/unit/lifecycle/` | Orchestrators, saga, drift detection, migration | ~12 suites |
| `tests/unit/servicenow/` | ServiceNow client scripts and integrations | ~12 suites |
| `tests/unit/adapters/` | API adapter tests | ~3 suites |
| `tests/unit/cmdb/` | CMDB validation | ~1 suite |
| `tests/integration/` | End-to-end pipeline integration | 1 suite |
| **Total** | | **54 suites, 1161+ tests** |

---

## 7. Troubleshooting Common Setup Issues

| Symptom | Likely Cause | Resolution |
|---------|-------------|------------|
| vRO action import fails with "Class not found" | Dependency actions not imported yet | Import the shared module (`com.enterprise.dfw.shared`) first, following the exact import order in Section 2.1 |
| ServiceNow REST call to vRO returns 401 Unauthorized | OAuth token expired or Basic Auth credentials incorrect | Verify credentials in the Connection & Credential alias. For Basic Auth, ensure the user has `workflow_execute` permission in vRO. For OAuth, regenerate the token. |
| ServiceNow REST call to vRO returns 403 Forbidden | vRO user lacks workflow execution permissions | Grant the `workflow_execute` role to the service account in vRO Administration > Access Control |
| NSX tag not propagating to security groups | vCenter-NSX integration service unhealthy | Check NSX Manager > System > Fabric > Compute Managers — ensure the vCenter connection status is "Up". Restart the NSX messaging service if needed. |
| Circuit breaker stuck in OPEN state | Too many downstream failures exceeded threshold | Wait for the reset timeout (default: 60 seconds) or invoke the `CircuitBreaker.reset()` action manually from the vRO client. Check the downstream service health. |
| Form validation not firing on catalog item | Client script not active or not attached to the correct catalog item | Verify the client script is Active=true, attached to the correct catalog item, and the Type (onLoad/onChange) is correct. Check browser developer console for JavaScript errors. |
| CMDB CI not found during Day 2 tag update | CI record does not exist, has wrong class, or is not in Operational status | Ensure the CI exists in `cmdb_ci_vm_instance` or `cmdb_ci_server` with `operational_status=1`. The reference qualifier on the catalog variable filters for active CIs only. |
| vRO workflow execution hangs with no callback | Network connectivity issue between vRO and ServiceNow | Verify vRO can reach the ServiceNow REST API on port 443. Check the vRO workflow logs for timeout errors. Test with `curl` from the vRO appliance. |
| Tag cardinality violation error | Attempted to assign multiple values to a single-cardinality tag category | Check the tag category cardinality in NSX Manager. For categories like Environment and Tier (single-value), remove the existing tag before applying the new one. The TagCardinalityEnforcer handles this automatically in the pipeline. |
| DFW policy not applied to VM | VM not a member of any source/destination group referenced by the policy | Verify the VM has the correct tags in NSX Manager. Check dynamic security group membership. Ensure the DFW policy is not disabled and is in the correct category. |
| Drift detection not running | Scheduled workflow not configured or disabled in vRO | Verify the drift detection workflow is scheduled in vRO > Workflow Scheduler. The default schedule is daily at 02:00. Check that the workflow is not paused or errored. |
| Saga rollback fails with partial state | Compensating action encountered an API error during rollback | Check the Dead Letter Queue for failed compensation events. Manually remediate the partial state using the details in the DLQ entry. The SagaCoordinator logs each step with the correlation ID for traceability. |
| REST callback payload rejected by ServiceNow | Payload schema mismatch or missing required fields | Validate the callback payload against `schemas/vro-snow-callback.schema.json`. Ensure the `correlationId` and `status` fields are present. Check the Scripted REST API logs in ServiceNow. |

---

## 8. CMDB Access Prerequisites

### 5.1 CMDB Service Account

The CMDBValidator module requires read access to the ServiceNow CMDB to extract VM inventory and validate tag completeness. Configure the following:

| Requirement | Details |
|-------------|---------|
| Service Account | `svc-vro-cmdb` (or extend `svc-vro-snow` permissions) |
| Required Roles | `cmdb_read`, `itil` |
| Tables Accessed | `cmdb_ci_vm_instance`, `cmdb_ci_appl`, `cmdb_rel_ci` |
| API Permissions | REST API read access to CMDB tables and task creation |

### 5.2 CMDB Table Access Verification

Verify access by running the following from the vRO appliance or any REST client:

```bash
curl -u svc-vro-cmdb:password \
  "https://instance.service-now.com/api/now/table/cmdb_ci_vm_instance?sysparm_limit=1" \
  -H "Accept: application/json"
```

A successful response returns HTTP 200 with a JSON body containing a `result` array.

---

## 9. VRA Package Import Instructions

### 6.1 Package Import via Orchestrator UI

1. Open the Aria Automation Orchestrator client.
2. Navigate to **Administration > Packages > Import Package**.
3. Browse to `package/com.dfw.automation/` and select the package archive.
4. Review the import manifest -- verify all actions, workflows, and configuration elements are listed.
5. Click **Import** and wait for completion.
6. Verify import by navigating to **Library > Actions** and confirming the `com.enterprise.dfw.*` modules are present.

### 6.2 Package Import via CLI

```bash
cd package/
./scripts/import-package.sh --host https://vro-host.company.internal:443 \
  --user svc-vro-admin --password '{{vault:secret/vro/admin/password}}'
```

The import script processes actions in dependency order, creates workflows, and configures configuration elements.

### 6.3 Post-Import Configuration

After importing the package, update the `DFW-Pipeline-Config` configuration element with environment-specific values:

| Attribute | Value |
|-----------|-------|
| `cmdbUrl` | `https://instance.service-now.com` |
| `ruleRegistryTable` | `x_dfw_rule_registry` |
| `reviewNotificationWindowDays` | `30` |
| `reviewGracePeriodDays` | `14` |
| `migrationBatchSize` | `50` |

---

## 10. New vRO Workflow Creation Instructions

### 7.1 Workflow: DFW-CMDBValidation

- **Purpose:** Runs CMDB validation against a specified site, generating gap reports and remediation tasks
- **Input Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `site` | `string` | Target site code (NDCNG or TULNG) |
| `generateTasks` | `boolean` | Whether to create remediation tasks in ServiceNow (default: true) |

- **Scriptable Task Code:**

```javascript
// DFW-CMDBValidation -- Scriptable Task
var Logger = System.getModule("com.enterprise.dfw.shared").Logger;
var ConfigLoader = System.getModule("com.enterprise.dfw.shared").ConfigLoader;
var CMDBValidator = System.getModule("com.enterprise.dfw.cmdb").CMDBValidator;
var CorrelationContext = System.getModule("com.enterprise.dfw.shared").CorrelationContext;

var logger = new Logger("DFW-CMDBValidation");
var config = new ConfigLoader().load();
var correlationId = CorrelationContext.generate();

try {
    logger.info("Starting CMDB validation", { correlationId: correlationId, site: site });
    var validator = new CMDBValidator(config);
    var report = validator.generateGapReport(site);
    if (generateTasks) {
        validator.generateRemediationTasks(report);
    }
    logger.info("CMDB validation completed", { correlationId: correlationId, coverage: report.coveragePercentage });
} catch (e) {
    logger.error("CMDB validation failed", { correlationId: correlationId, error: e.message });
    throw e;
}
```

- **Schedule:** Configure as a scheduled workflow running daily at 02:00.

### 7.2 Workflow: DFW-RuleLifecycle

- **Purpose:** Manages DFW rule lifecycle state transitions
- **Input Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `ruleId` | `string` | Rule identifier (DFW-R-XXXX format) |
| `action` | `string` | Lifecycle action (analyzeImpact, approve, deployMonitor, validate, enforce, certify, rollback) |
| `actor` | `string` | User performing the action |
| `justification` | `string` | Reason for the state transition |

- **Scriptable Task Code:**

```javascript
// DFW-RuleLifecycle -- Scriptable Task
var Logger = System.getModule("com.enterprise.dfw.shared").Logger;
var ConfigLoader = System.getModule("com.enterprise.dfw.shared").ConfigLoader;
var RuleLifecycleManager = System.getModule("com.enterprise.dfw.lifecycle").RuleLifecycleManager;
var CorrelationContext = System.getModule("com.enterprise.dfw.shared").CorrelationContext;

var logger = new Logger("DFW-RuleLifecycle");
var config = new ConfigLoader().load();
var correlationId = CorrelationContext.generate();

try {
    logger.info("Processing rule lifecycle action", { correlationId: correlationId, ruleId: ruleId, action: action });
    var manager = new RuleLifecycleManager(config);
    var result;
    switch (action) {
        case "analyzeImpact": result = manager.analyzeImpact(ruleId); break;
        case "approve": result = manager.transitionState(ruleId, "APPROVED", actor, justification); break;
        case "deployMonitor": result = manager.deployMonitor(ruleId, config.site); break;
        case "validate": result = manager.transitionState(ruleId, "VALIDATED", actor, justification); break;
        case "enforce": result = manager.enforceRule(ruleId, config.site); break;
        case "certify": result = manager.transitionState(ruleId, "CERTIFIED", actor, justification); break;
        case "rollback": result = manager.rollbackRule(ruleId, justification, actor); break;
        default: throw new Error("Unknown action: " + action);
    }
    logger.info("Rule lifecycle action completed", { correlationId: correlationId, result: result });
} catch (e) {
    logger.error("Rule lifecycle action failed", { correlationId: correlationId, error: e.message });
    throw e;
}
```

### 7.3 Workflow: DFW-RuleReview

- **Purpose:** Scheduled workflow that scans for rules due for review, sends notifications, and auto-expires overdue rules
- **Input Parameters:** None (configuration is read from the configuration element)

- **Scriptable Task Code:**

```javascript
// DFW-RuleReview -- Scriptable Task
var Logger = System.getModule("com.enterprise.dfw.shared").Logger;
var ConfigLoader = System.getModule("com.enterprise.dfw.shared").ConfigLoader;
var RuleReviewScheduler = System.getModule("com.enterprise.dfw.lifecycle").RuleReviewScheduler;
var CorrelationContext = System.getModule("com.enterprise.dfw.shared").CorrelationContext;

var logger = new Logger("DFW-RuleReview");
var config = new ConfigLoader().load();
var correlationId = CorrelationContext.generate();

try {
    logger.info("Starting rule review scan", { correlationId: correlationId });
    var scheduler = new RuleReviewScheduler(config);
    var dueRules = scheduler.scanForReviewDue();
    if (dueRules.length > 0) {
        scheduler.notifyOwners(dueRules);
    }
    var overdueRules = scheduler.escalateOverdue(dueRules);
    var expiredRules = scheduler.autoExpire(overdueRules);
    logger.info("Rule review scan completed", {
        correlationId: correlationId,
        dueCount: dueRules.length,
        escalatedCount: overdueRules.length,
        expiredCount: expiredRules.length
    });
} catch (e) {
    logger.error("Rule review scan failed", { correlationId: correlationId, error: e.message });
    throw e;
}
```

- **Schedule:** Configure as a scheduled workflow running daily at 06:00.

### 7.4 Workflow: DFW-MigrationBulkTag

- **Purpose:** Processes migration wave manifests for bulk tag application during Greenzone VM migrations
- **Input Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `manifestJson` | `string` | JSON string containing the migration manifest |
| `waveId` | `string` | Specific wave to process (or "all" for full manifest) |
| `dryRun` | `boolean` | If true, validate only without applying tags |

- **Scriptable Task Code:**

```javascript
// DFW-MigrationBulkTag -- Scriptable Task
var Logger = System.getModule("com.enterprise.dfw.shared").Logger;
var ConfigLoader = System.getModule("com.enterprise.dfw.shared").ConfigLoader;
var MigrationBulkTagger = System.getModule("com.enterprise.dfw.lifecycle").MigrationBulkTagger;
var CorrelationContext = System.getModule("com.enterprise.dfw.shared").CorrelationContext;

var logger = new Logger("DFW-MigrationBulkTag");
var config = new ConfigLoader().load();
var correlationId = CorrelationContext.generate();

try {
    var manifest = JSON.parse(manifestJson);
    logger.info("Starting migration bulk tag", { correlationId: correlationId, waveId: waveId, dryRun: dryRun });
    var tagger = new MigrationBulkTagger(config);
    tagger.loadManifest(manifest);
    var validationResult = tagger.preValidate(waveId);
    if (!dryRun && validationResult.valid) {
        var waveResult = tagger.executeWave(waveId);
        var verifyResult = tagger.verifyPostMigration(waveId);
        var report = tagger.generateWaveReport(waveId);
        logger.info("Migration bulk tag completed", { correlationId: correlationId, result: report.summary });
    } else {
        logger.info("Migration bulk tag dry run completed", { correlationId: correlationId, validation: validationResult });
    }
} catch (e) {
    logger.error("Migration bulk tag failed", { correlationId: correlationId, error: e.message });
    throw e;
}
```

---

## 11. ServiceNow Deployment for New Components

### 8.1 x_dfw_rule_registry Table

1. Navigate to: **System Definition > Tables > New**
2. Set:
   - Label: `DFW Rule Registry`
   - Name: `x_dfw_rule_registry`
   - Add to Module: `DFW Automation`
3. Add columns as specified in the LLD Section 8.3 (RuleRegistry table schema).
4. Click **Submit** to create the table.
5. Add unique index on `u_rule_id`.

### 8.2 cmdbTagSyncRule Business Rule

**File:** `src/servicenow/business-rules/cmdbTagSyncRule.js`
- Navigate to: **System Definition > Business Rules > New**
- Configuration:
  - Name: `CMDB Tag Sync Rule`
  - Table: `cmdb_ci_vm_instance`
  - When to run: **after** update
  - Filter: Add conditions for monitored fields (environment, application, tier)
  - Script: Paste the file contents from `src/servicenow/business-rules/cmdbTagSyncRule.js`
  - Active: true
  - Order: 200

### 8.3 DFW Rule Request Catalog Item

1. Navigate to: **Service Catalog > Catalog Definitions > Maintain Items > New**
2. Configuration:
   - Name: `DFW Rule Request`
   - Category: `Security`
   - Variables:

| Variable | Type | Mandatory | Notes |
|----------|------|-----------|-------|
| Rule Name | String | Yes | Human-readable rule name |
| Description | Multi-line Text | Yes | Detailed rule description |
| Source Group | Reference | Yes | Table: NSX security groups |
| Destination Group | Reference | Yes | Table: NSX security groups |
| Services/Ports | String | Yes | Comma-separated port list |
| Action | Select Box | Yes | Choices: ALLOW, DROP, REJECT |
| Site | Select Box | Yes | Choices: NDCNG, TULNG |
| Justification | Multi-line Text | Yes | Business justification |

3. Attach client script: `ruleRequest_onLoad.js`
4. Workflow: Security Architect approval required

### 8.4 Scheduled Jobs

Create the following scheduled jobs in ServiceNow or vRO:

| Job Name | Schedule | Target Workflow | Description |
|----------|----------|----------------|-------------|
| DFW CMDB Validation - NDCNG | Daily 02:00 | DFW-CMDBValidation | Validate CMDB tag coverage for NDCNG site |
| DFW CMDB Validation - TULNG | Daily 02:30 | DFW-CMDBValidation | Validate CMDB tag coverage for TULNG site |
| DFW Rule Review Scan | Daily 06:00 | DFW-RuleReview | Scan for rules due for review and send notifications |
| DFW Drift Detection - NDCNG | Every 4 hours | DFW-DriftDetection | Scheduled drift scan for NDCNG |
| DFW Drift Detection - TULNG | Every 4 hours | DFW-DriftDetection | Scheduled drift scan for TULNG |

---

## 12. Test Data Setup for New Modules

### 9.1 Rule Registry Test Data

Populate the `x_dfw_rule_registry` table with the following test records:

```javascript
// Background script to populate Rule Registry test data
var rules = [
    {
        rule_id: 'DFW-R-0001',
        rule_name: 'Web Tier HTTP Inbound',
        description: 'Allow HTTP/HTTPS inbound to web tier from load balancer',
        current_state: 'ENFORCED',
        site: 'NDCNG',
        source_channel: 'Catalog',
        review_cadence_days: 90,
        expiry_date: '2026-07-15'
    },
    {
        rule_id: 'DFW-R-0002',
        rule_name: 'App Tier API Access',
        description: 'Allow API traffic from web tier to application tier',
        current_state: 'MONITOR_MODE',
        site: 'NDCNG',
        source_channel: 'Onboarding',
        review_cadence_days: 90,
        expiry_date: '2026-08-01'
    },
    {
        rule_id: 'DFW-R-0003',
        rule_name: 'Database Tier Access',
        description: 'Allow database connections from app tier to database tier',
        current_state: 'REVIEW_DUE',
        site: 'NDCNG',
        source_channel: 'Catalog',
        review_cadence_days: 60,
        expiry_date: '2026-04-20'
    }
];

rules.forEach(function(rule) {
    var gr = new GlideRecord('x_dfw_rule_registry');
    gr.initialize();
    gr.u_rule_id = rule.rule_id;
    gr.u_rule_name = rule.rule_name;
    gr.u_description = rule.description;
    gr.u_current_state = rule.current_state;
    gr.u_site = rule.site;
    gr.u_source_channel = rule.source_channel;
    gr.u_review_cadence_days = rule.review_cadence_days;
    gr.u_expiry_date = rule.expiry_date;
    gr.u_created_date = new GlideDateTime().getDisplayValue();
    gr.insert();
});
gs.info('Rule Registry: Inserted ' + rules.length + ' test records.');
```

### 9.2 Migration Manifest Test Data

Create a test migration manifest file for the MigrationBulkTagger:

```json
{
    "manifestId": "MIG-2026-Q2-TEST-01",
    "description": "Test migration wave for Greenzone Phase 1",
    "waves": [
        {
            "waveId": "WAVE-TEST-001",
            "scheduledDate": "2026-04-15",
            "vms": [
                {
                    "vmName": "NDCNG-APP001-WEB-P01",
                    "cmdbCi": "CI-APP001-WEB-P01",
                    "tags": {
                        "Region": "NDCNG",
                        "SecurityZone": "Internal",
                        "Environment": "Production",
                        "AppCI": "APP001",
                        "SystemRole": "WebServer"
                    }
                },
                {
                    "vmName": "NDCNG-APP001-APP-P01",
                    "cmdbCi": "CI-APP001-APP-P01",
                    "tags": {
                        "Region": "NDCNG",
                        "SecurityZone": "Internal",
                        "Environment": "Production",
                        "AppCI": "APP001",
                        "SystemRole": "AppServer"
                    }
                }
            ]
        }
    ]
}
```

---

## 10. Packaging and Deployment

### 10.1 VRA Package Structure

The `package/` directory at the repository root contains the complete VRA deployment package:

```
package/
  com.dfw.automation/
    actions/          # All vRO actions organized by module
    workflows/        # Workflow XML definitions
    config-elements/  # Configuration element templates
  scripts/
    import-package.sh   # Automated import script
    export-package.sh   # Package export for versioning
  servicenow/
    tables/            # Table XML update sets
    business-rules/    # Business rule update sets
    catalog-items/     # Catalog item configurations
    client-scripts/    # Client script update sets
    server-scripts/    # Server script update sets
    scheduled-jobs/    # Scheduled job configurations
    ui-policies/       # UI policy update sets
    scripted-rest-apis/ # REST API definitions
```

### 10.2 Full Deployment Sequence

1. **Import vRO package**: Use the Orchestrator UI or `scripts/import-package.sh` to import all actions and workflows.
2. **Configure endpoints**: Update the `DFW-Pipeline-Config` configuration element with environment-specific URLs and credential vault references.
3. **Import ServiceNow update sets**: Import update sets from `package/servicenow/` in the following order:
   - Tables (`x_dfw_rule_registry`, `u_enterprise_tag_dictionary`)
   - Business rules (`cmdbTagSyncRule`, `tagFieldServerValidation`)
   - Server scripts (`catalogItemValidation`, `tagDictionaryLookup`)
   - Client scripts (all `*_onLoad.js` and `*_onChange.js`)
   - Catalog items (VM Build, Tag Update, Decommission, Quarantine, Rule Request, Bulk Tag)
   - Scheduled jobs (CMDB validation, rule review, drift detection)
   - UI policies and scripted REST APIs
4. **Configure NSX tag categories**: Create the 5 mandatory + 3 optional tag categories in each NSX Manager.
5. **Create security groups**: Create dynamic security groups based on the new tag taxonomy.
6. **Deploy DFW policies**: Import or create DFW policies from `policies/dfw-rules/` YAML files.
7. **Verify connectivity**: Test REST API connectivity between all integration endpoints.
8. **Run validation**: Execute the DFW-CMDBValidation workflow to verify CMDB data quality.

---

## 13. Hygiene Module Configuration

The NSXHygieneOrchestrator is configured via the vRO Configuration Element `DFW-Pipeline-Config`. The following attributes control hygiene sweep behavior.

### 13.1 Configuration Attributes

Add these attributes to the existing `DFW-Pipeline-Config` configuration element (see Section 2.3 for the base configuration):

| Attribute Name | Type | Default | Description |
|---------------|------|---------|-------------|
| `hygiene.orphanGroups.minAgeHours` | Number | `72` | Minimum group age (hours since creation) before it is eligible for orphan classification. Prevents deletion of groups that are still being populated by in-flight pipeline operations. |
| `hygiene.orphanGroups.archiveDir` | String | `archives/groups/` | Directory path for archived group definitions (relative to vRO working directory) |
| `hygiene.staleRules.maxMonitorDays` | Number | `30` | Maximum days a rule may remain in MONITOR mode without promotion before it is classified as stale |
| `hygiene.staleRules.maxDisabledDays` | Number | `90` | Maximum days a rule may remain disabled before it is classified as stale |
| `hygiene.staleRules.emptyGroupDays` | Number | `14` | Days a rule's source/destination groups must be empty before the rule is classified as stale |
| `hygiene.staleRules.archiveDir` | String | `archives/rules/` | Directory path for archived rule definitions |
| `hygiene.staleTags.maxVMs` | Number | `500` | Maximum number of VMs scanned per tag remediation invocation |
| `hygiene.staleTags.scope` | String | `FULL` | Default scan scope: `FULL` (all managed VMs) or `DRIFTED_ONLY` (only VMs flagged in previous scans) |
| `hygiene.phantomVMs.cleanup` | Boolean | `false` | Whether phantom VM cleanup is enabled by default. When false, phantoms are detected and reported but not cleaned. Set to true only after validating detection accuracy. |
| `hygiene.unregisteredVMs.maxVMs` | Number | `100` | Maximum number of VMs onboarded per invocation |
| `hygiene.unregisteredVMs.defaultAssignmentGroup` | String | `DFW-Pipeline-Admins` | ServiceNow assignment group for newly-created CMDB CI records |
| `hygiene.sweep.quickScanLimit` | Number | `200` | Maximum VMs scanned per task during QUICK scope sweeps |
| `hygiene.sweep.fullScanLimit` | Number | `2000` | Maximum VMs scanned per task during FULL scope sweeps |
| `hygiene.sweep.incidentAssignmentGroup` | String | `DFW-Pipeline-Support` | ServiceNow assignment group for hygiene incidents |

### 13.2 Tag-to-Environment Inference Rules

The UnregisteredVMOnboarder uses configurable mapping rules to infer tag values from vCenter metadata. Add these attributes to `DFW-Pipeline-Config`:

| Attribute Name | Type | Default | Description |
|---------------|------|---------|-------------|
| `hygiene.onboarding.clusterToEnvironment` | String (JSON) | `{"PROD-":"Production","PRE-PROD-":"Pre-Production","UAT-":"UAT","DEV-":"Development","SANDBOX-":"Sandbox"}` | Maps cluster name prefixes to Environment tag values |
| `hygiene.onboarding.networkToClassification` | String (JSON) | `{"PCI-":"PCI","HIPAA-":"HIPAA","DMZ-":"Restricted","INTERNAL-":"Internal"}` | Maps network segment prefixes to DataClassification/Compliance tag values |
| `hygiene.onboarding.defaultCostCenter` | String | `CC-PENDING` | Default CostCenter tag for VMs where cost center cannot be inferred |
| `hygiene.onboarding.defaultCompliance` | String | `None` | Default Compliance tag for VMs where compliance scope cannot be inferred |

### 13.3 Applying Configuration Changes

1. Open the vRO Orchestrator Client.
2. Navigate to **Administration > Configuration Elements > DFW Automation > DFW-Pipeline-Config**.
3. Add or modify the attributes listed above.
4. Click **Save**. Changes take effect on the next hygiene sweep invocation (no restart required).

**Verification:** After saving, run a QUICK-scope dry-run sweep to confirm the configuration is being read correctly:
1. Navigate to **Workflows > DFW Pipeline > Hygiene > Run Hygiene Sweep**.
2. Set `site=NDCNG`, `scope=QUICK`, `dryRun=true`.
3. Verify that the sweep completes successfully and the report reflects the configured scan limits.

---

## 14. ServiceNow Scheduled Job Setup for Hygiene Sweep

The hygiene sweep is designed to run on a recurring schedule via a ServiceNow scheduled job that triggers the vRO workflow.

### 14.1 Create the Scheduled Job

1. Navigate to **System Definition > Scheduled Jobs > New**.
2. Configure the job:

| Field | Value |
|-------|-------|
| Name | `NSX Hygiene Sweep -- NDCNG (Weekly FULL)` |
| Run | `Weekly` |
| Day of Week | `Sunday` |
| Time | `02:00` (during maintenance window) |
| Run as | `svc-snow-vro` (service account with vRO trigger permissions) |
| Active | `true` |

3. In the **Run this Script** field, paste the following:

```javascript
(function executeHygieneSweep() {
    var vROTrigger = new global.VroTrigger();

    var payload = {
        requestType: 'hygiene_sweep',
        site: 'NDCNG',
        scope: 'FULL',
        dryRun: false,
        correlationId: new global.CorrelationIdGenerator().generate('HYG'),
        callbackUrl: gs.getProperty('x_enterprise.dfw.callback_url')
    };

    var workflowId = gs.getProperty('x_enterprise.dfw.hygiene_workflow_id');
    vROTrigger.execute(workflowId, JSON.stringify(payload));

    gs.info('NSX Hygiene Sweep triggered for NDCNG (FULL scope)');
})();
```

4. Click **Submit**.
5. Repeat for the TULNG site with a staggered schedule (e.g., Sunday 03:00).

### 14.2 Daily QUICK Sweep Schedule

For daily health checks, create a second scheduled job:

| Field | Value |
|-------|-------|
| Name | `NSX Hygiene Sweep -- NDCNG (Daily QUICK)` |
| Run | `Daily` |
| Time | `06:00` |
| Active | `true` |

Use the same script as above but with `scope: 'QUICK'` and `dryRun: true`.

### 14.3 Payload Format Reference

The hygiene sweep payload sent from ServiceNow to vRO follows this schema:

```json
{
  "requestType": "hygiene_sweep",
  "site": "NDCNG",
  "scope": "FULL",
  "dryRun": false,
  "correlationId": "HYG-2026-0414-001",
  "callbackUrl": "https://instance.service-now.com/api/x_enterprise/dfw_callbacks/vro_callback"
}
```

| Field | Type | Required | Valid Values | Description |
|-------|------|----------|--------------|-------------|
| `requestType` | String | Yes | `hygiene_sweep` | Fixed value identifying this as a hygiene sweep request |
| `site` | String | Yes | `NDCNG`, `TULNG` | Target site for the sweep |
| `scope` | String | Yes | `FULL`, `QUICK` | Sweep depth (see Section 11.1 of RUNBOOK.md for details) |
| `dryRun` | Boolean | Yes | `true`, `false` | Dry run mode (no mutations when true) |
| `correlationId` | String | Yes | `HYG-{date}-{seq}` | Unique correlation ID for tracing |
| `callbackUrl` | String | No | Valid HTTPS URL | ServiceNow callback URL for result delivery |

### 14.4 Callback Response Format

The vRO workflow sends the hygiene report back to ServiceNow at the configured callback URL. The callback payload follows the standard `vro-snow-callback.schema.json` format:

```json
{
  "correlationId": "HYG-2026-0414-001",
  "status": "completed-with-warnings",
  "requestType": "hygiene_sweep",
  "result": {
    "site": "NDCNG",
    "scope": "FULL",
    "dryRun": false,
    "tasks": { "...per-task results..." },
    "manualReviewItems": [ "...items requiring attention..." ],
    "incidents": ["INC0012345"],
    "overallStatus": "completed-with-warnings"
  },
  "timestamp": "2026-04-14T02:12:34.000Z"
}
```

---

## 15. Test Data Setup for Hygiene Testing

This section describes how to set up test data for validating hygiene module functionality in a lab or development environment.

### 15.1 Mock Orphan Groups

Create security groups in NSX Manager that have no member VMs and are not referenced by any DFW rules. These will be detected by the OrphanGroupCleaner.

1. In NSX Manager, navigate to **Inventory > Groups > Add Group**.
2. Create the following test groups:

| Group Name | Membership Criteria | Purpose |
|------------|---------------------|---------|
| `SG-TEST-ORPHAN-001` | `Tag equals Application:ORPHANTEST001` | Orphan group with no matching VMs |
| `SG-TEST-ORPHAN-002` | `Tag equals Application:ORPHANTEST002` | Orphan group with no matching VMs |
| `SG-TEST-BLOCKED-001` | `Tag equals Application:BLOCKEDTEST001` | Orphan group that will be referenced by a test rule (blocked from deletion) |

3. Create a DFW rule referencing `SG-TEST-BLOCKED-001` to test the "blocked" classification:
   - Navigate to **Security > Distributed Firewall > Add Policy**.
   - Policy name: `TEST-HYGIENE-BLOCKED`
   - Add a rule with source = `SG-TEST-BLOCKED-001`, action = `ALLOW`.

**Expected results after sweep:**
- `SG-TEST-ORPHAN-001` and `SG-TEST-ORPHAN-002` should be deleted (in FULL scope) or reported as orphaned (in QUICK scope).
- `SG-TEST-BLOCKED-001` should be reported as blocked with the referencing rule identified.

### 15.2 Mock Stale Rules

Create DFW rules that meet staleness criteria for the StaleRuleReaper.

1. In NSX Manager, navigate to **Security > Distributed Firewall > Add Policy**.
2. Policy name: `TEST-HYGIENE-STALE-RULES`
3. Add the following rules:

| Rule Name | Source | Destination | Action | Disabled | Purpose |
|-----------|--------|-------------|--------|----------|---------|
| `TEST-STALE-DISABLED` | `SG-TEST-ORPHAN-001` | Any | ALLOW | Yes | Disabled rule (stale after `maxDisabledDays`) |
| `TEST-STALE-MONITOR` | `SG-TEST-ORPHAN-002` | Any | ALLOW (logged=true, tag: `intended_action=DROP`) | No | Monitor-mode rule (stale after `maxMonitorDays`) |

**Note:** To simulate staleness, set `hygiene.staleRules.maxDisabledDays=0` and `hygiene.staleRules.maxMonitorDays=0` in the test configuration. Reset to production values after testing.

### 15.3 Mock Drifted VMs for Tag Remediation

Create VMs with intentionally mismatched tags to test the StaleTagRemediator.

1. Identify a test VM in vCenter (e.g., `TEST-HYGIENE-VM-001`).
2. In ServiceNow CMDB, set the expected tags:
   ```
   Application=APP001, Tier=Web, Environment=Production, DataClassification=Internal, Compliance=PCI, CostCenter=CC-1234
   ```
3. In NSX Manager, apply different tags to the same VM:
   ```
   Application=APP001, Tier=App, Environment=Staging, DataClassification=Internal, Compliance=None, CostCenter=CC-1234
   ```
4. The StaleTagRemediator should detect drift on `Tier`, `Environment`, and `Compliance` categories and remediate them to match the CMDB expected state.

### 15.4 Mock Phantom VMs

Phantom VMs are VMs present in NSX but absent from vCenter. Simulating this in a test environment requires care:

**Option A -- Use the NSX fabric mock API (recommended for unit/integration tests):**
In the test configuration, enable the mock NSX fabric inventory that includes VM IDs not present in the vCenter mock inventory. See `tests/helpers/mockNsxFabric.js` for the mock setup.

**Option B -- Manual simulation in a lab:**
1. Provision a test VM in vCenter and allow NSX to register it.
2. Apply tags to the VM via the pipeline.
3. Delete the VM directly from vCenter (bypass the pipeline's DayN decommission).
4. The VM's NSX record will persist as a phantom.

**Expected results:** The PhantomVMDetector should identify the VM as a phantom and (in FULL scope with cleanup enabled) remove its tags.

### 15.5 Mock Unregistered VMs

Create VMs that exist in vCenter and NSX but have no CMDB record.

1. Provision a test VM directly in vCenter (not through the pipeline or ServiceNow).
2. Do NOT create a CMDB CI record for the VM.
3. Apply NO tags to the VM in NSX.

**Expected results:** The UnregisteredVMOnboarder should discover the VM, create a CMDB CI record, and apply initial tags based on the vCenter metadata (cluster, network, folder).

### 15.6 Running Hygiene Tests

Execute the full hygiene test suite:

```bash
# Run all hygiene module tests
npm test -- --testPathPattern="tests/.*hygiene|tests/.*orphan|tests/.*stale|tests/.*phantom|tests/.*unregistered"

# Run individual module tests
npm test -- --testPathPattern="tests/.*OrphanGroupCleaner"
npm test -- --testPathPattern="tests/.*StaleRuleReaper"
npm test -- --testPathPattern="tests/.*StaleTagRemediator"
npm test -- --testPathPattern="tests/.*PhantomVMDetector"
npm test -- --testPathPattern="tests/.*UnregisteredVMOnboarder"
npm test -- --testPathPattern="tests/.*NSXHygieneOrchestrator"
```

**Integration test with mock data:**

```bash
# Set up mock data, run hygiene sweep, verify results
npm test -- --testPathPattern="tests/integration/hygieneSweep"
```

---

*For architecture details, see [SDD.md](SDD.md), [HLD.md](HLD.md), and [LLD.md](LLD.md). For operational procedures, see [RUNBOOK.md](RUNBOOK.md). For test strategy, see [TEST-STRATEGY.md](TEST-STRATEGY.md).*
