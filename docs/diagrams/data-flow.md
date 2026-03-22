# End-to-End Data Flow

This diagram traces the complete data flow through the NSX DFW Automation Pipeline, from the enterprise tag dictionary through ServiceNow catalog submission, vRO orchestration, VMware tag application, NSX propagation, dynamic security group evaluation, DFW policy enforcement, and the feedback loop through callbacks and CMDB synchronization.

```mermaid
flowchart LR
    subgraph SOURCE["Data Sources"]
        DICT["Tag Dictionary\nu_tag_dictionary\nCategories, Values,\nCardinality, Mandatory"]
        POLICY_REPO["Policy Repository\npolicies/dfw-rules/*.yaml\nDFW Rules, Groups,\nService Definitions"]
    end

    subgraph REQUEST["Request Layer"]
        FORM["Catalog Form\nVM Build Request"]
        CLIENT["Client Scripts\nonLoad: defaults\nonChange: validate\nonSubmit: check"]
        RITM["RITM Record\nRequest Item"]
        APPROVER["Approval Engine\nManager + Security"]
    end

    subgraph ORCHESTRATION["Orchestration Layer"]
        PAYLOAD["vRO Payload\nJSON: vmId, site,\ntags, requestType"]
        VALIDATOR["Payload Validator\nSchema + Business"]
        ORCHESTRATOR["Lifecycle Orchestrator\nDay0/Day2/DayN"]
        TAGGER["Tag Operations\nRead-Compare-Write"]
        CARDINALITY["Cardinality Enforcer\nSingle/Multi/Conflicts"]
    end

    subgraph VMWARE["VMware Infrastructure"]
        VC_TAGS["vCenter Tags\nVAPI Tag Association"]
        NSX_TAGS["NSX Tags\nAuto-propagated from vC"]
        GROUPS["Dynamic Security Groups\nTag-based membership\ncriteria evaluation"]
        DFW["DFW Policies\nInfrastructure + Env +\nApplication + Emergency"]
        ESXI["ESXi Data Plane\nDFW Kernel Module\nRealized Rules"]
    end

    subgraph FEEDBACK["Feedback Loop"]
        CALLBACK["Callback Payload\ncorrelationId, status,\ntags, groups, rules"]
        RITM_UPDATE["RITM Updated\nClosed Complete or\nFailed with details"]
        CMDB["CMDB CI Record\nTags, Groups,\nDFW Status synced"]
    end

    subgraph ERROR_PATH["Error Path"]
        DLQ["Dead Letter Queue\nFailed payload +\nerror + compensation"]
        SPLUNK["Splunk Logs\nStructured JSON +\ncorrelationId"]
    end

    %% Source to Request
    DICT -->|"Reference values (dropdowns, not free-text)"| FORM
    FORM --> CLIENT
    CLIENT -->|"Validated user input"| RITM
    RITM -->|"Approval required"| APPROVER
    APPROVER -->|"Approved: REST POST with correlation ID"| PAYLOAD

    %% Request to Orchestration
    PAYLOAD --> VALIDATOR
    VALIDATOR -->|"Valid payload"| ORCHESTRATOR
    ORCHESTRATOR --> TAGGER
    TAGGER --> CARDINALITY
    CARDINALITY -->|"Validated tag set (delta computed)"| TAGGER

    %% Orchestration to VMware
    TAGGER -->|"VAPI: attach/detach tag associations"| VC_TAGS
    VC_TAGS -->|"Auto-propagation (vCenter → NSX sync)"| NSX_TAGS
    NSX_TAGS -->|"Criteria evaluation (tag match → group add)"| GROUPS
    GROUPS -->|"Rule binding (source/dest group match)"| DFW
    DFW -->|"Rule realization (pushed to hosts)"| ESXI
    POLICY_REPO -->|"Schema-validated YAML (CI pipeline)"| DFW

    %% Feedback
    ORCHESTRATOR -->|"POST /callback"| CALLBACK
    CALLBACK --> RITM_UPDATE
    RITM_UPDATE -->|"Attribute sync"| CMDB

    %% Error path
    ORCHESTRATOR -.->|"After retry exhaustion + saga compensation"| DLQ
    ORCHESTRATOR -.->|"All operations logged with corrId"| SPLUNK
    DLQ -.->|"Manual reprocess or purge"| ORCHESTRATOR
```

## Data Transformation Summary

| Stage | Input | Transformation | Output |
|-------|-------|---------------|--------|
| Tag Dictionary | Controlled vocabulary definitions | Loaded as catalog variable reference | Dropdown values for user selection |
| Catalog Form | User selections + client script defaults | Client-side validation (onLoad/onChange/onSubmit) | RITM record with tag key-value pairs |
| Approval | RITM record | Manager and security team approval workflow | Approved request → REST POST trigger |
| Payload Validation | JSON payload from ServiceNow | Schema validation (ajv) + business rules | Validated payload or rejection error |
| Cardinality Enforcement | Current tags + desired tags | Single-value dedup, conflict rules, delta computation | Clean tag delta (add/remove sets) |
| Tag Application | Tag delta | VAPI read-compare-write (idempotent) | Tags attached/detached on vCenter VM |
| Tag Propagation | vCenter tags | Automatic vCenter-to-NSX synchronization | NSX fabric VM tags updated |
| Group Evaluation | NSX tags on VM | Dynamic group membership criteria matching | VM added/removed from security groups |
| DFW Enforcement | Security group membership | Rule source/destination group binding | Active DFW rules on ESXi kernel |
| Callback | Pipeline execution result | Structured JSON with status, tags, groups, errors | RITM updated, CMDB CI synced |

## Data Residency

| Data Element | Storage Location | Retention | Encryption |
|-------------|-----------------|-----------|-----------|
| Tag Dictionary | ServiceNow custom table | Permanent | ServiceNow at-rest encryption |
| Request Payloads | ServiceNow RITM + vRO execution log | Per retention policy | TLS in-transit, at-rest encryption |
| Tags | vCenter (primary), NSX (propagated) | Until removed | VMware VSAN encryption |
| DFW Rules (desired) | Git repository (YAML) | Permanent (version controlled) | Repository encryption |
| DFW Rules (realized) | NSX Manager + ESXi hosts | Until policy change | NSX datastore encryption |
| DLQ Entries | vRO configuration elements | Until purged (default 30 days) | vRO datastore encryption |
| Audit Logs | Splunk | 1 year | Splunk at-rest encryption |
