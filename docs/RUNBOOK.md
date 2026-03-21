# Operations Runbook

## NSX DFW Automation Pipeline

**Version:** 1.0
**Date:** 2026-03-21
**Author:** Enterprise Infrastructure & Cloud Security

---

## Table of Contents

1. [DLQ Handling](#1-dlq-handling)
2. [Circuit Breaker Reset Procedures](#2-circuit-breaker-reset-procedures)
3. [Retry Exhaustion Troubleshooting](#3-retry-exhaustion-troubleshooting)
4. [Rollback Procedures](#4-rollback-procedures)
5. [Drift Remediation](#5-drift-remediation)
6. [Emergency Quarantine](#6-emergency-quarantine)
7. [Legacy Workload Onboarding](#7-legacy-workload-onboarding)
8. [Monitoring Dashboard Interpretation](#8-monitoring-dashboard-interpretation)
9. [Escalation Matrix](#9-escalation-matrix)
10. [Common Error Codes Reference](#10-common-error-codes-reference)

---

## 1. DLQ Handling

The Dead Letter Queue (DLQ) stores operations that have failed all retry attempts and could not be compensated. Each DLQ entry represents a pipeline execution that requires manual investigation and resolution. The DLQ is a critical operational component -- a non-zero DLQ depth always warrants investigation.

### 1.1 List DLQ Entries

To view all current DLQ entries, use the vRO DLQ Management workflow:

1. Open the vRO Orchestrator Client.
2. Navigate to **Workflows > DFW Pipeline > DLQ Management > List DLQ Entries**.
3. Execute the workflow. It returns a JSON array of DLQ entries.

Each entry contains:
- `id`: Unique DLQ entry identifier
- `correlationId`: The pipeline correlation ID (RITM-based)
- `operation`: The lifecycle operation type (day0-provision, day2-update, dayn-decommission)
- `vmId`: The target VM identifier
- `site`: The target site (NDCNG or TULNG)
- `error`: The final error that caused DLQ placement
- `completedSteps`: Steps that completed before failure
- `compensationResult`: Outcome of any compensation attempts
- `timestamp`: When the entry was created
- `retryCount`: Number of retries attempted before DLQ placement
- `originalPayload`: The original ServiceNow input payload for reprocessing

Alternatively, query Splunk with:
```
index=dfw_pipeline level=ERROR "DLQ entry created" | table correlationId, vmId, site, error.code, error.message, timestamp
```

### 1.2 Inspect a DLQ Entry

To examine a specific DLQ entry in detail:

1. Navigate to **Workflows > DFW Pipeline > DLQ Management > Inspect DLQ Entry**.
2. Provide the DLQ entry `id`.
3. Review the full error context, including the original input payload, each completed step, and the compensation result.

Key fields to examine:
- **error.code**: The DFW error code identifies the failure category (e.g., DFW-2001 for NSX API failure, DFW-3003 for tag cardinality violation).
- **compensationResult.failed**: If greater than zero, manual cleanup may be required (tags or groups left in an inconsistent state).
- **completedSteps**: Indicates how far the pipeline progressed before failing. Steps that completed successfully may have left state in NSX that needs verification.

**Interpreting compensation results:**

| compensated | failed | Interpretation | Action Required |
|-------------|--------|---------------|-----------------|
| N | 0 | All completed steps were successfully compensated | Fix root cause, then reprocess |
| N | M | Some compensations failed | Verify NSX state manually for failed compensations, then reprocess |
| 0 | 0 | No steps to compensate (failed at first step) | Fix root cause, then reprocess |

### 1.3 Reprocess DLQ Entries

After fixing the root cause (e.g., restoring NSX Manager connectivity, correcting invalid input data):

1. Navigate to **Workflows > DFW Pipeline > DLQ Management > Reprocess DLQ Entry**.
2. Provide the DLQ entry `id`.
3. The workflow will re-execute the original pipeline operation with the same input parameters.
4. If reprocessing succeeds, the DLQ entry is marked as resolved.
5. If reprocessing fails again, the entry remains in the DLQ with an updated retry count.

**Batch reprocessing**: To reprocess all DLQ entries for a specific error code:

1. Navigate to **Workflows > DFW Pipeline > DLQ Management > Batch Reprocess by Error Code**.
2. Provide the error code (e.g., `DFW-2001`).
3. The workflow processes entries sequentially, pausing between entries to avoid overloading recovered services.

**Pre-reprocessing checklist:**
- Verify the root cause has been resolved (e.g., NSX Manager is healthy, credentials are valid)
- Check circuit breaker state for the target endpoint (should be CLOSED)
- Verify that compensated steps have been fully reversed (no stale tags or group memberships)
- For Day 0 operations, verify the VM still exists in vCenter inventory

### 1.4 Purge DLQ Entries

To remove resolved or obsolete DLQ entries:

1. Navigate to **Workflows > DFW Pipeline > DLQ Management > Purge DLQ Entries**.
2. Provide filter criteria: older than N days, specific error code, or specific correlation ID.
3. Confirm the purge. Purged entries are archived to Splunk before deletion.

**Retention policy:** DLQ entries should be retained for at least 30 days before purging to allow for audit review. Entries related to compliance-scoped VMs (PCI, HIPAA, SOX) should be retained for 90 days.

---

## 2. Circuit Breaker Reset Procedures

When a circuit breaker is in the OPEN state, all calls to the affected endpoint are immediately rejected with error DFW-6004. The breaker will automatically transition to HALF_OPEN after the `resetTimeout` (default: 60 seconds) elapses, and a single probe call determines whether the endpoint has recovered. However, manual intervention may be required if the automatic recovery is not sufficient.

### 2.1 Check Circuit Breaker State

To view the current state of all circuit breakers:

1. Navigate to **Workflows > DFW Pipeline > Operations > Circuit Breaker Status**.
2. Execute the workflow. It returns statistics for each tracked endpoint.

The output includes:
- `name`: Endpoint identifier (e.g., `nsx-manager-ndcng`, `vcenter-tulng`)
- `state`: Current state (`CLOSED`, `OPEN`, or `HALF_OPEN`)
- `totalSuccesses`: Lifetime successful calls
- `totalFailures`: Lifetime failed calls
- `recentFailures`: Failures within the current sliding window
- `thresholds`: Configured `failureThreshold`, `resetTimeout`, `windowSize`

Alternatively, query Splunk:
```
index=dfw_pipeline component=CircuitBreaker "transitioned" | table endpoint, previousState, newState, _time
```

### 2.2 Manual Reset

If the underlying issue has been resolved and you need to immediately restore service (without waiting for the reset timeout):

1. Navigate to **Workflows > DFW Pipeline > Operations > Reset Circuit Breaker**.
2. Provide the endpoint name (e.g., `nsx-manager-ndcng`).
3. Execute the workflow. The breaker is reset to CLOSED, clearing all failure counters.

**Caution:** Only reset a circuit breaker after confirming that the underlying service has recovered. Resetting prematurely will cause the breaker to immediately trip again when calls fail, and may compound the problem with additional load on a struggling service.

**Pre-reset verification steps:**
1. Verify the endpoint is reachable: test with a simple REST call from the vRO server
2. Check the endpoint's health page or status API if available
3. Confirm with the infrastructure team that the issue has been resolved
4. Review recent Splunk logs for the endpoint to ensure errors have stopped

### 2.3 Verify Recovery After Reset

After resetting a breaker:

1. Monitor the Splunk dashboard for the next 5 minutes.
2. Verify that calls to the endpoint are succeeding (look for `totalSuccesses` incrementing).
3. If the breaker trips again within 5 minutes, the underlying issue has not been resolved. Escalate to the infrastructure team.

**Post-reset monitoring query:**
```
index=dfw_pipeline component=CircuitBreaker endpoint="nsx-manager-ndcng" | timechart span=1m count by result
```

### 2.4 Adjust Thresholds

If the default thresholds are too aggressive or too lenient for a specific endpoint:

1. Open the vRO Configuration Element `DFW-Pipeline-Config`.
2. Modify the circuit breaker settings:
   - `circuitBreakerThreshold`: Number of failures to trip (default: 5)
   - `circuitBreakerResetMs`: Time in OPEN state before HALF_OPEN (default: 60000ms)
   - `circuitBreakerWindowMs`: Sliding window for failure counting (default: 300000ms)
3. Save the Configuration Element. Changes take effect on the next pipeline execution.

**Threshold guidance:**

| Scenario | Recommended Threshold | Recommended Reset | Rationale |
|----------|----------------------|-------------------|-----------|
| Stable endpoint, rare failures | 5 failures / 300s window | 60s | Default — balanced protection |
| Flaky endpoint, frequent transient errors | 10 failures / 600s window | 30s | More tolerant of transient issues |
| Critical endpoint, must protect aggressively | 3 failures / 120s window | 120s | Trips faster, recovers slower |

---

## 3. Retry Exhaustion Troubleshooting

When the RetryHandler exhausts all retry attempts, the final error is enriched with `retryCount` and `operationName` properties. This section covers common causes and resolution steps.

### 3.1 Identify Retry Exhaustion Events

Query Splunk:
```
index=dfw_pipeline "failed after" "attempts" | table correlationId, operationName, retryCount, errorMessage, _time
```

For a time-bounded search:
```
index=dfw_pipeline "failed after" "attempts" earliest=-1h | stats count by error.code | sort -count
```

### 3.2 Common Causes and Resolutions

| Error Code | Cause | Resolution | Expected Recovery Time |
|-----------|-------|-----------|-----------------------|
| DFW-2001 | NSX Manager API unreachable or returning 5xx | Check NSX Manager service status; verify network connectivity from vRO; check NSX Manager cluster health | 5-30 minutes (depends on root cause) |
| DFW-2002 | NSX authentication failure | Verify service account credentials in vault; check if account is locked; verify RBAC permissions | 10-60 minutes (credential rotation or unlock) |
| DFW-7001 | Operation timeout | Check NSX Manager load; verify no long-running operations blocking the API; increase http.timeout if needed | 5-15 minutes (typically resolves when load subsides) |
| DFW-7002 | Generic retry limit exceeded | Review the underlying error message; may require infrastructure team investigation | Varies |
| DFW-7004 | Tag propagation sync timeout | NSX data plane is slow to realize changes; check ESXi host agent status; verify NSX transport node connectivity | 10-30 minutes |
| HTTP 429 | Rate limiting | Reduce pipeline concurrency; increase retry intervals; check NSX Manager API rate limits | Immediate (reduce load) |

### 3.3 Steps to Investigate

1. **Identify the failing endpoint:** Check the error context for the URL being called.
2. **Test endpoint connectivity:** From the vRO server, run a simple REST call to the endpoint.
3. **Check service health:** Log into the NSX Manager or vCenter UI and verify the service is responsive.
4. **Review recent changes:** Check if any infrastructure changes (patches, network changes, certificate renewals) coincide with the failures.
5. **Check resource utilization:** Verify CPU, memory, and disk on the NSX Manager and vCenter appliances.
6. **Check circuit breaker state:** If the circuit breaker is OPEN, the endpoint may still be unhealthy.
7. **Review DLQ entries:** Check if multiple operations are failing with the same error code, indicating a systemic issue.
8. **Reprocess the operation:** Once the root cause is resolved, reprocess via DLQ or re-submit from ServiceNow.

---

## 4. Rollback Procedures

### 4.1 Tag Rollback

If incorrect tags were applied to a VM and need to be reverted:

**Automatic (via Saga):** If the pipeline detected the error during execution, the SagaCoordinator has already compensated by removing the incorrect tags. Check the callback in ServiceNow for the compensation result.

**Manual:**
1. Identify the VM and the incorrect tags from the Splunk log (search by correlation ID).
2. Navigate to **Workflows > DFW Pipeline > Operations > Rollback Tags**.
3. Provide the VM ID, site, and the desired tag state (the previous tag snapshot from the saga journal).
4. Execute the workflow. It uses the `updateTags()` method to restore the previous state via read-compare-write.

**Splunk query to find the previous tag state:**
```
index=dfw_pipeline correlationId="RITM-12345-*" step="getCurrentTags" | table metadata.currentTags
```

### 4.2 Policy Rollback via Git Revert

If a YAML policy change introduced a problem:

1. Identify the problematic commit in the git log:
   ```bash
   git log --oneline policies/dfw-rules/
   ```

2. Create a revert commit:
   ```bash
   git revert <commit-hash>
   ```

3. Push the revert and wait for CI to validate the reverted state.

4. Deploy the reverted policy via the policy reconciliation workflow:
   - Navigate to **Workflows > DFW Pipeline > Policy Management > Reconcile Policies**.
   - The workflow reads the current YAML files and applies them to NSX Manager.

**Important:** Do not manually edit NSX Manager UI to revert policies. Always use git revert to maintain audit trail and version control consistency.

### 4.3 Group Membership Rollback

If VMs were incorrectly added to or removed from security groups:

1. Navigate to **Workflows > DFW Pipeline > Operations > Reconcile Group Membership**.
2. Provide the VM ID and site.
3. The workflow reads the VM's current tags and recalculates the correct group membership.
4. It adds the VM to groups it should belong to and removes it from groups it should not.

**Verification after rollback:**
```
index=dfw_pipeline correlationId="<rollback-correlation-id>" | table step, status, metadata
```

---

## 5. Drift Remediation

Drift occurs when the actual NSX state diverges from the desired state defined in YAML policies and tag configurations. Common causes include manual changes in the NSX Manager UI, failed pipeline executions, and federation sync delays between NDCNG and TULNG.

### 5.1 Detect Drift

Run the drift detection workflow:

1. Navigate to **Workflows > DFW Pipeline > Policy Management > Detect Drift**.
2. Provide the site code (NDCNG or TULNG) or leave blank for both sites.
3. The workflow compares:
   - YAML policy definitions vs. NSX realized DFW rules
   - Expected group membership (based on VM tags) vs. actual group membership
   - Tag dictionary values vs. actual tags on VMs

Results are logged to Splunk and returned as a JSON report.

**Drift categories:**

| Category | Description | Severity | Auto-Remediation |
|----------|-------------|----------|------------------|
| Policy drift | DFW rules in NSX differ from YAML definitions | High | Yes (reconcile workflow) |
| Group drift | VM group membership differs from tag-based expectation | Medium | Yes (reconcile workflow) |
| Tag drift | VM tags differ from expected state | Medium | Case-by-case |
| Orphan drift | Security groups have rules but no members | Low | Detection only (manual review) |

### 5.2 Remediate Drift

**Automatic remediation:**

1. Navigate to **Workflows > DFW Pipeline > Policy Management > Remediate Drift**.
2. Review the drift report and confirm the remediation plan.
3. The workflow applies the desired state from YAML and tag configurations to NSX.
4. Each remediation step is recorded in a saga for rollback capability.

**Manual remediation:**

For complex drift scenarios, manually correct the NSX state through the NSX Manager UI, then re-run drift detection to confirm alignment. Document the manual correction in the change management system.

### 5.3 Prevent Drift

- Restrict direct NSX Manager UI access to read-only for all but emergency operations.
- Schedule weekly drift detection runs via vRO scheduled workflows.
- Alert on any drift detected (Splunk alert on drift detection results).
- Enforce all changes through the pipeline to maintain audit trail.
- Review NSX Manager audit logs for unauthorized direct changes.

**Scheduled drift detection query:**
```
index=dfw_pipeline component="DriftDetector" | table site, driftCategory, driftCount, _time
```

---

## 6. Emergency Quarantine

The emergency quarantine procedure isolates a compromised or suspected-compromised VM by applying a restrictive DFW policy that blocks all traffic except management access. This procedure is designed for speed and should be executable within 60 seconds.

### 6.1 Activate Quarantine

**URGENT: This procedure should be executed immediately upon security team direction.**

1. Navigate to **Workflows > DFW Pipeline > Emergency > Activate Quarantine**.
2. Provide:
   - VM ID: The NSX external ID of the VM to quarantine
   - Site: NDCNG or TULNG
   - Reason: Free-text justification (stored in audit log)
   - Incident Number: ServiceNow incident reference
3. Execute the workflow. It will:
   a. Apply a `Quarantine=Active` tag to the VM
   b. The quarantine security group (tag-based: Quarantine=Active) membership updates
   c. A high-priority DFW DROP-all rule takes effect, blocking all traffic
   d. Management access (SSH/RDP from jump hosts) is preserved via a higher-priority ALLOW rule
   e. A callback is sent to ServiceNow incident with quarantine confirmation

**Expected completion time: < 60 seconds**

**Quarantine policy reference:** The quarantine DFW rules are defined in `policies/dfw-rules/emergency-quarantine.yaml` and are pre-deployed to NSX Manager. The quarantine takes effect by adding the VM to the quarantine security group via the tag, not by creating new DFW rules.

### 6.2 Verify Quarantine

After activation:

1. Verify the Quarantine tag is present on the VM:
   ```
   GET {nsxUrl}/api/v1/fabric/virtual-machines/{vmId}/tags
   ```
   Expected: `Quarantine=Active` tag present in the response.

2. Verify DFW rules are enforced:
   ```
   GET {nsxUrl}/policy/api/v1/infra/realized-state/enforcement-points/default/virtual-machines/{vmId}/rules
   ```
   Expected: High-priority DROP rule from quarantine policy is present and active.

3. Verify network isolation by confirming the VM cannot reach other workloads (security team validates).

4. Verify management access is preserved by confirming SSH/RDP from authorized jump hosts still works.

**Splunk verification query:**
```
index=dfw_pipeline component="EmergencyQuarantine" vmId="<vmId>" | table action, status, duration, _time
```

### 6.3 Deactivate Quarantine

After the security investigation is complete and the VM is cleared:

1. Navigate to **Workflows > DFW Pipeline > Emergency > Deactivate Quarantine**.
2. Provide the VM ID, site, and the clearance authorization (incident number with resolution).
3. The workflow removes the Quarantine tag and restores normal DFW policy coverage.
4. Verify that the VM has regained its original security group membership and DFW rules.

**Post-quarantine verification checklist:**
- Quarantine tag removed from VM
- VM restored to original security groups
- Normal DFW rules active (validated via DFWPolicyValidator)
- Management and application traffic flowing normally
- ServiceNow incident updated with quarantine deactivation

---

## 7. Legacy Workload Onboarding

The batch onboarding procedure tags existing VMs that were provisioned before the DFW automation pipeline was deployed. This process brings pre-existing VMs under the pipeline's tag governance and DFW policy coverage.

### 7.1 Prepare the Batch File

Create a CSV file with the following columns:

```csv
vmId,site,Application,Tier,Environment,DataClassification,Compliance,CostCenter
vm-001,NDCNG,APP001,Web,Production,Internal,PCI,CC-1234
vm-002,NDCNG,APP001,App,Production,Internal,PCI,CC-1234
vm-003,TULNG,APP002,DB,Development,Internal,None,CC-5678
```

**Column requirements:**
- `vmId`: Must match the NSX external ID of the VM in vCenter inventory
- `site`: Must be `NDCNG` or `TULNG`
- `Application`: Must match the pattern `^[A-Z]{2,5}[0-9]{3,5}$`
- `Tier`: Must be one of: Web, Application, Database, Middleware, Utility, Shared-Services
- `Environment`: Must be one of: Production, Pre-Production, UAT, Staging, Development, Sandbox, DR
- `DataClassification`: Must be one of: Public, Internal, Confidential, Restricted
- `Compliance`: Must be one of: None, PCI, HIPAA, SOX (or comma-separated for multi-value)
- `CostCenter`: Must match the pattern `^CC[0-9]{4,8}$`

### 7.2 Validate the Batch

Before processing, validate the batch file:

1. Navigate to **Workflows > DFW Pipeline > Batch > Validate Batch File**.
2. Upload the CSV file.
3. The workflow validates:
   - All VM IDs exist in vCenter inventory
   - All tag values are in the tag dictionary
   - No tag combination conflicts (PCI + Sandbox, Confidential + None compliance, etc.)
   - Site codes are valid
   - No duplicate VM IDs in the batch
4. Review the validation report. Fix any errors before proceeding.

**Common validation errors:**

| Error | Cause | Resolution |
|-------|-------|------------|
| VM not found | vmId does not exist in vCenter | Verify VM ID in vCenter inventory; VM may have been decommissioned |
| Invalid tag value | Value not in tag dictionary | Use an approved value from `policies/tag-categories/categories.yaml` |
| Tag conflict | PCI + Sandbox or similar | Correct the conflicting values in the CSV |
| Duplicate VM | Same vmId appears multiple times | Remove duplicate rows; keep the correct one |

### 7.3 Execute Batch Onboarding

1. Navigate to **Workflows > DFW Pipeline > Batch > Execute Batch Onboarding**.
2. Upload the validated CSV file.
3. Provide a batch correlation ID (e.g., `BATCH-LEGACY-20260321`).
4. The workflow processes each VM sequentially:
   a. Applies tags using the read-compare-write pattern
   b. Verifies group membership
   c. Validates DFW coverage
   d. Logs success or failure per VM
5. Failed VMs are written to an error report (not to DLQ, to avoid flooding).

**Expected processing time:** Approximately 30-60 seconds per VM (includes tag propagation wait).

### 7.4 Post-Onboarding Verification

After batch processing completes:

1. Review the batch execution report in Splunk:
   ```
   index=dfw_pipeline correlationId="BATCH-LEGACY-20260321" | stats count by status
   ```
2. Run drift detection for the affected VMs to confirm tag and policy alignment.
3. Review failed VMs individually and remediate as needed.
4. Update the CMDB to reflect the VMs are now under DFW pipeline management.

---

## 8. Monitoring Dashboard Interpretation

The pipeline monitoring dashboard in Splunk provides real-time visibility into pipeline health. This section explains how to interpret each panel and what actions to take.

### 8.1 Circuit Breaker Panel

| Color | State | Meaning | Action |
|-------|-------|---------|--------|
| Green | CLOSED | Normal operation; API calls succeeding | No action required |
| Yellow | HALF_OPEN | Recovery in progress; probe call pending | Monitor for 2 minutes; should return to green |
| Red | OPEN | Endpoint failing; calls being rejected | Check endpoint health; see Section 2 for reset procedure |

**Dashboard query:**
```
index=dfw_pipeline component=CircuitBreaker | dedup endpoint | table endpoint, state, recentFailures, totalSuccesses, totalFailures
```

### 8.2 Throughput Panel

Displays operations per hour segmented by type (Day 0, Day 2, Day N). Normal ranges:

- **Day 0:** 10-50 operations/hour during business hours
- **Day 2:** 5-20 operations/hour
- **Day N:** 1-10 operations/hour

**Anomaly interpretation:**

| Anomaly | Possible Cause | Investigation Steps |
|---------|---------------|---------------------|
| Sudden spike (>3x normal) | Batch operation or form misconfiguration causing duplicates | Check for batch correlation IDs; verify ServiceNow form not submitting duplicates |
| Sudden drop (near zero) | ServiceNow outage preventing new requests | Check ServiceNow platform status; verify vRO inbound queue |
| Sustained high volume | Normal during maintenance windows or large onboarding | Confirm with change calendar; monitor for errors |

### 8.3 Error Rate Panel

Displays the percentage of operations resulting in errors over a rolling 1-hour window. Thresholds:

- **< 5%:** Normal. Occasional transient failures are expected.
- **5-10%:** Elevated. Investigate the most common error code.
- **> 10%:** Critical. Likely indicates a systemic issue (API degradation, configuration error).

**Investigation query for elevated error rate:**
```
index=dfw_pipeline level=ERROR earliest=-1h | stats count by error.code | sort -count | head 5
```

### 8.4 Latency Panel

Displays pipeline execution time percentiles (p50, p90, p99). Healthy values:

- **p50:** < 30 seconds
- **p90:** < 60 seconds
- **p99:** < 120 seconds

Latency exceeding these thresholds typically indicates NSX Manager API slowness or retry delays. Check the retry rate panel for correlation.

**Latency investigation query:**
```
index=dfw_pipeline step="complete" | stats p50(duration) as p50, p90(duration) as p90, p99(duration) as p99 by operation
```

### 8.5 DLQ Depth Panel

Displays the current number of entries in the Dead Letter Queue. This should normally be zero. Any non-zero value requires investigation:

- **1-5 entries:** Review entries individually; likely isolated failures.
- **5-20 entries:** Possible systemic issue; check for common error code.
- **> 20 entries:** Significant outage or configuration problem; engage on-call.

**DLQ trend query:**
```
index=dfw_pipeline "DLQ entry created" | timechart span=1h count
```

### 8.6 Retry Rate Panel

Displays the percentage of operations that required at least one retry. Healthy value: < 10%.

- **10-20%:** Endpoint instability; monitor circuit breaker state.
- **> 20%:** Sustained endpoint issues; investigate root cause and consider escalation.

### 8.7 Saga Compensation Panel

Displays the count and success rate of saga compensations. Any compensation event indicates a pipeline failure that required rollback.

- **All compensations succeeded:** Pipeline is recovering correctly from failures.
- **Compensations with failures:** Manual intervention required; check DLQ for affected operations.

---

## 9. Escalation Matrix

| Severity | Condition | First Responder | Escalation (15 min) | Escalation (60 min) |
|----------|-----------|----------------|---------------------|---------------------|
| P1 - Critical | Circuit breaker OPEN on production NSX Manager | DFW Pipeline On-Call Engineer | Platform Engineering Lead | Infrastructure Director |
| P1 - Critical | DLQ depth > 10 entries | DFW Pipeline On-Call Engineer | Platform Engineering Lead | Infrastructure Director |
| P1 - Critical | Emergency quarantine activation failure | Security Operations | DFW Pipeline On-Call + Security Lead | CISO |
| P2 - High | Pipeline failure rate > 10% for 30+ minutes | DFW Pipeline On-Call Engineer | Platform Engineering Lead | N/A |
| P2 - High | Tag propagation timeout affecting multiple VMs | DFW Pipeline On-Call Engineer | NSX Platform Engineer | Platform Engineering Lead |
| P3 - Medium | Retry rate > 20% for 1+ hour | DFW Pipeline Support Engineer | DFW Pipeline On-Call Engineer | N/A |
| P3 - Medium | Single VM tag operation failure (non-recurring) | DFW Pipeline Support Engineer | Investigate via DLQ | Escalate if pattern emerges |
| P4 - Low | Tag validation failures from catalog form | ServiceNow Admin Team | DFW Pipeline Support Engineer | N/A |
| P4 - Low | Drift detected during scheduled scan | DFW Pipeline Support Engineer | Remediate per Section 5 | N/A |

### Contact Information

| Role | Contact | Hours |
|------|---------|-------|
| DFW Pipeline On-Call Engineer | PagerDuty rotation: `dfw-pipeline-oncall` | 24/7 |
| DFW Pipeline Support Engineer | Teams channel: `#dfw-pipeline-support` | Business hours |
| Platform Engineering Lead | Teams/PagerDuty | 24/7 for P1/P2 |
| NSX Platform Engineer | PagerDuty rotation: `nsx-platform-oncall` | 24/7 |
| Security Operations | PagerDuty rotation: `secops-oncall` | 24/7 |
| ServiceNow Admin Team | Teams channel: `#snow-admin` | Business hours |

### Escalation Procedure

1. **Acknowledge** the alert within 5 minutes. Update the PagerDuty incident status.
2. **Assess** the severity using the matrix above. Upgrade or downgrade as needed based on actual impact.
3. **Communicate** status to the `#dfw-pipeline-support` Teams channel. For P1/P2, create a bridge call.
4. **Investigate** using the troubleshooting steps in the relevant section of this runbook.
5. **Resolve** the issue and verify recovery. Update the ServiceNow incident with root cause and resolution.
6. **Post-incident** review for P1/P2 incidents within 48 hours. Document findings and action items.

---

## 10. Common Error Codes Reference

Quick reference for the most frequently encountered DFW error codes. For the complete taxonomy, refer to the `ErrorFactory` source code in `src/vro/actions/shared/ErrorFactory.js`.

| Code | Category | Description | Retryable | Typical Resolution |
|------|----------|-------------|-----------|-------------------|
| DFW-2001 | NSX API | NSX Manager API unreachable or 5xx | Yes | Check NSX Manager health; verify network from vRO |
| DFW-2002 | NSX API | NSX authentication failure | No | Verify credentials in vault; check account lock |
| DFW-3003 | Tags | Tag cardinality violation | No | Fix input data; verify tag dictionary |
| DFW-4001 | Validation | Invalid input payload | No | Fix ServiceNow form data; validate against schema |
| DFW-4003 | Validation | Tag combination conflict (PCI+Sandbox) | No | Correct tag combination in ServiceNow |
| DFW-4004 | Validation | Invalid site code | No | Use NDCNG or TULNG |
| DFW-6004 | Circuit Breaker | Call rejected, breaker OPEN | Yes (after reset) | Wait for automatic recovery or manual reset |
| DFW-7001 | Timeout | Operation timed out | Yes | Check endpoint load; increase timeout if needed |
| DFW-7004 | Timeout | Tag propagation sync timeout | Yes | Check NSX data plane; verify transport node connectivity |
| DFW-7006 | DFW | VM has no DFW coverage | No | Verify tags and group membership; run reconciliation |
| DFW-7007 | DFW | Orphaned rule (group with rules but no members) | No | Review group membership criteria; remove orphaned rules |
| DFW-8001 | Saga | Saga compensation failed | No | Manual cleanup required; check DLQ entry |
| DFW-9001 | System | Unexpected system error | Yes | Review full stack trace; escalate if recurring |

---

*End of Operations Runbook*
