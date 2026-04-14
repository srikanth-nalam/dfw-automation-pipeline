# DFW Automation Pipeline — Deployment Checklist

Use this checklist for every deployment to ensure all components are correctly
installed and verified. Complete each section in order.

---

## Pre-Deployment

- [ ] Verify target environment (dev / staging / production)
- [ ] Confirm change request is approved (production deployments)
- [ ] Verify maintenance window is scheduled (production deployments)
- [ ] Run `validate-package.sh` and confirm all checks pass
- [ ] Confirm package version matches the approved change request
- [ ] Back up current vRO package (export existing com.dfw.automation)
- [ ] Notify stakeholders of planned deployment window

## Infrastructure Prerequisites

- [ ] vRO 8.x / Aria Automation Orchestrator is accessible
- [ ] NSX-T 4.x Manager is accessible at each target site (NDCNG, TULNG)
- [ ] vCenter 8.x is accessible at each target site
- [ ] ServiceNow instance is accessible
- [ ] ServiceNow Mid Server is online and connected
- [ ] VPN / network connectivity confirmed for all endpoints

## Certificate Deployment

- [ ] Obtain TLS certificates from the enterprise PKI team
- [ ] Import vCenter root CA certificate(s) into vRO trust store
- [ ] Import NSX-T Manager root CA certificate(s) into vRO trust store
- [ ] Import NSX Global Manager root CA certificate(s) into vRO trust store
- [ ] Import ServiceNow root CA certificate into vRO trust store
- [ ] Verify certificate chain validity: `openssl verify -CAfile ca-chain.pem cert.pem`
- [ ] Restart vRO service if prompted after certificate import

## vRO Package Deployment

- [ ] Import `com.dfw.automation-{version}.zip` via vRO Client or Aria Assembler
- [ ] Verify all actions appear under the correct module paths:
  - [ ] com.dfw.shared (9 actions)
  - [ ] com.dfw.tags (4 actions)
  - [ ] com.dfw.groups (2 actions)
  - [ ] com.dfw.dfw (6 actions)
  - [ ] com.dfw.cmdb (1 action)
  - [ ] com.dfw.lifecycle (13 actions)
  - [ ] com.dfw.adapters (3 actions)
- [ ] Verify all 10 workflows are imported:
  - [ ] DFW - Day 0 Provision
  - [ ] DFW - Day 2 Tag Update
  - [ ] DFW - Day N Decommission
  - [ ] DFW - Bulk Tag Remediation
  - [ ] DFW - Drift Scan
  - [ ] DFW - Migration Bulk Tag
  - [ ] DFW - Quarantine
  - [ ] DFW - CMDB Validation
  - [ ] DFW - Rule Lifecycle
  - [ ] DFW - Rule Review

## vRO Configuration

- [ ] Deploy `dfw-config.properties` to vRO Configuration Property Pages
- [ ] Deploy `site-config.json` to vRO Configuration Elements
- [ ] Configure vault references for all credential entries:
  - [ ] `{{vault:secret/vro/vcenter/username}}`
  - [ ] `{{vault:secret/vro/vcenter/password}}`
  - [ ] `{{vault:secret/vro/nsx/username}}`
  - [ ] `{{vault:secret/vro/nsx/password}}`
  - [ ] `{{vault:secret/vro/nsx-global/username}}`
  - [ ] `{{vault:secret/vro/nsx-global/password}}`
  - [ ] `{{vault:secret/vro/snow/callback-token}}`
- [ ] Verify site endpoint URLs match the target environment
- [ ] Configure vRO REST endpoint for ServiceNow callback registration

## ServiceNow Deployment

- [ ] Create custom table `x_dfw_rule_registry` (if first deployment)
- [ ] Import Update Set (`update-set.xml`) to sub-production first
- [ ] Preview Update Set — resolve any conflicts
- [ ] Commit Update Set
- [ ] Verify catalog items are visible in the Service Catalog:
  - [ ] VM Build Request
  - [ ] Tag Update Request
  - [ ] Bulk Tag Request
  - [ ] Quarantine Request
  - [ ] Rule Request
- [ ] Verify client scripts are active and bound to catalog items
- [ ] Verify server scripts (Script Includes) are active
- [ ] Verify business rules are active on `cmdb_ci_vm_instance`
- [ ] Verify UI policies are active on catalog item forms
- [ ] Configure scheduled jobs:
  - [ ] DFW CMDB Validation — Weekly (Sundays 02:00 CST)
  - [ ] DFW Drift Detection — Daily (03:00 CST)
  - [ ] DFW Rule Review — Weekly (Mondays 04:00 CST)
- [ ] Verify Enterprise Tag Dictionary (`u_enterprise_tag_dictionary`) is populated
- [ ] Configure vRO REST Message (`vRO_DFW_Automation`) with correct endpoint and credentials
- [ ] Verify Mid Server REST connectivity to vRO

## Smoke Testing

- [ ] **Day-0 Test**: Submit a VM Build Request with all 5 tags in a non-production environment
  - [ ] Verify RITM created in ServiceNow
  - [ ] Verify vRO workflow triggered (check vRO execution logs)
  - [ ] Verify NSX-T tags applied to VM
  - [ ] Verify security group membership
  - [ ] Verify callback received in ServiceNow (RITM updated)
- [ ] **Day-2 Test**: Submit a Tag Update Request for the test VM
  - [ ] Verify tag change applied
  - [ ] Verify security group re-evaluation
- [ ] **Drift Scan Test**: Manually trigger the Drift Scan workflow
  - [ ] Verify scan completes without errors
  - [ ] Verify drift report generated
- [ ] **CMDB Validation Test**: Manually trigger the CMDB Validation workflow
  - [ ] Verify validation completes without errors
- [ ] **Rule Request Test**: Submit a Rule Request (create)
  - [ ] Verify rule created in NSX-T
  - [ ] Verify rule registered in `x_dfw_rule_registry`
- [ ] **Quarantine Test**: Submit a Quarantine Request for a test VM
  - [ ] Verify deny-all rule applied
  - [ ] Verify VM network isolation

## Post-Deployment

- [ ] Monitor vRO execution logs for 24 hours
- [ ] Verify first scheduled drift scan completes successfully
- [ ] Verify first scheduled CMDB validation completes successfully
- [ ] Verify first scheduled rule review completes successfully
- [ ] Update deployment documentation with version and date
- [ ] Close change request
- [ ] Notify stakeholders of successful deployment

## Rollback Procedure (if needed)

- [ ] Import the previously backed-up vRO package
- [ ] Revert the ServiceNow Update Set
- [ ] Verify rollback by running smoke tests against the previous version
- [ ] Document the rollback reason and open a defect ticket

---

**Deployed By**: ___________________________
**Date**: ___________________________
**Version**: ___________________________
**Environment**: ___________________________
**Change Request**: ___________________________
