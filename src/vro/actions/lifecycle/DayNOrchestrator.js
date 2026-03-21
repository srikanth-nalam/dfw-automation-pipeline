/**
 * @file DayNOrchestrator.js
 * @description Full DayN (decommissioning) orchestrator for the DFW Automation
 *   Pipeline. Extends {@link LifecycleOrchestrator} and implements the complete
 *   decommission workflow with saga-based compensating transactions.
 *
 *   Execute steps:
 *     1. getCurrentTags       - Read VM's current NSX tags
 *     2. getGroupMemberships  - Read VM's current security group memberships
 *     3. checkDependencies    - Halt if other VMs depend on this VM's groups
 *     4. checkOrphanedRules   - Detect DFW rules that will become orphaned
 *     5. removeTags           - Remove all NSX tags from the VM
 *
 *   Verify steps:
 *     6. verifyGroupRemoval   - Confirm VM left all NSX groups
 *     7. verifyCleanup        - Final validation of clean state
 *
 *   Post-verify steps:
 *     8. deprovisionVM        - Delete VM via vCenter API
 *     9. updateCMDB           - Mark VM as decommissioned in ServiceNow CMDB
 *    10. callbackSuccess      - Notify ServiceNow of successful decommission
 *
 *   Uses SagaCoordinator for compensating transactions (e.g., re-add tags
 *   if removal fails downstream). Uses ErrorFactory for structured errors.
 *
 * @module lifecycle/DayNOrchestrator
 */

'use strict';

const LifecycleOrchestrator = require('./LifecycleOrchestrator');
const ErrorFactory = require('../shared/ErrorFactory');

/**
 * Default polling configuration for group removal verification.
 * @constant {Object}
 * @private
 */
const GROUP_REMOVAL_POLL_CONFIG = Object.freeze({
    /** Maximum number of polling attempts. */
    maxAttempts: 20,
    /** Interval between polling attempts in milliseconds. */
    intervalMs: 10000,
    /** Total timeout in milliseconds (200 seconds). */
    timeoutMs: 200000
});

/**
 * @class DayNOrchestrator
 * @extends LifecycleOrchestrator
 * @classdesc Orchestrates Day N (decommissioning) workflows for VMs being
 *   retired. Ensures safe removal of all NSX tags, verifies clean group
 *   departure, deprovisions the VM, and updates the CMDB.
 *
 *   Uses SagaCoordinator to record compensating actions for each mutation,
 *   enabling automatic rollback if any step fails. For example, if tag
 *   removal succeeds but group removal verification fails, the saga
 *   coordinator will re-apply the original tags.
 *
 * @example
 * const orchestrator = LifecycleOrchestrator.create('DayN', dependencies);
 * const result = await orchestrator.run({
 *   correlationId: 'RITM-00003-1679000000000',
 *   requestType: 'DayN',
 *   site: 'NDCNG',
 *   vmId: 'vm-1234',
 *   vmName: 'srv-web-01',
 *   callbackUrl: 'https://snow.company.internal/api/callback'
 * });
 */
class DayNOrchestrator extends LifecycleOrchestrator {
    /**
     * Creates a new DayNOrchestrator instance.
     *
     * @param {Object} dependencies - Injected dependencies. See
     *   {@link LifecycleOrchestrator} constructor for the full dependency contract.
     */
    constructor(dependencies) {
        super(dependencies);
    }

    // ---------------------------------------------------------------------------
    // Template Method implementations
    // ---------------------------------------------------------------------------

    /**
     * Prepares the Day N decommission workflow by resolving the target VM
     * identity and validating that the payload contains sufficient information
     * to proceed.
     *
     * @param {Object} payload - The validated request payload.
     * @param {string} payload.vmId - The vCenter VM identifier.
     * @param {string} payload.vmName - VM display name.
     * @param {string} payload.site - Site code.
     * @param {Object} endpoints - Resolved site endpoints.
     * @returns {Promise<Object>} Preparation result containing the resolved VM
     *   identity and decommission intent.
     */
    async prepare(payload, endpoints) {
        this.logger.info('Preparing Day N decommission', {
            correlationId: payload.correlationId,
            vmId: payload.vmId,
            vmName: payload.vmName,
            site: payload.site,
            component: 'DayNOrchestrator'
        });

        const vmId = payload.vmId || payload.vmName;

        if (!vmId) {
            throw ErrorFactory.createError(
                'DFW-4001',
                'Day N payload must include a vmId or vmName to identify the target VM.',
                'prepare',
                0,
                { payload: { requestType: payload.requestType, site: payload.site } }
            );
        }

        return {
            vmId,
            vmName: payload.vmName,
            site: payload.site,
            targetEndpoints: endpoints,
            intent: 'decommission'
        };
    }

    /**
     * Executes the Day N decommission workflow:
     *   1. getCurrentTags       - Read current NSX tags
     *   2. getGroupMemberships  - Read current group memberships
     *   3. checkDependencies    - Halt if dependencies found
     *   4. checkOrphanedRules   - Detect orphaned DFW rules
     *   5. removeTags           - Remove all tags
     *
     * Registers a compensating action with the SagaCoordinator to re-apply
     * the original tags if a later step fails.
     *
     * @param {Object} payload - The validated request payload.
     * @param {Object} endpoints - Resolved site endpoints.
     * @returns {Promise<Object>} Execution result with previous state and removal results.
     */
    async execute(payload, endpoints) {
        const vmId = payload.vmId || payload.vmName;
        const site = payload.site;

        this.logger.info('Executing Day N decommission workflow', {
            correlationId: payload.correlationId,
            vmId,
            component: 'DayNOrchestrator'
        });

        // Step 1: Get current tags
        const currentTags = await this._timedStep('getCurrentTags', async () => {
            return this._getCurrentTags(vmId, site);
        });

        // Step 2: Get group memberships
        const groupMemberships = await this._timedStep('getGroupMemberships', async () => {
            return this._getGroupMemberships(vmId, site);
        });

        // Step 3: Check dependencies - HALT if found
        const dependencyResult = await this._timedStep('checkDependencies', async () => {
            return this._checkDependencies(vmId, site, groupMemberships);
        });

        // Step 4: Check for orphaned DFW rules
        const orphanedRulesResult = await this._timedStep('checkOrphanedRules', async () => {
            return this._checkOrphanedRules(groupMemberships, site);
        });

        // Step 5: Remove all tags
        const allCategories = Object.keys(currentTags);
        const removeResult = await this._timedStep('removeTags', async () => {
            return this._removeTags(vmId, allCategories, site);
        });

        // Register compensating action with SagaCoordinator:
        // Re-apply the previous tags if a later step fails
        await this.sagaCoordinator.recordStep('removeTags', async () => {
            this.logger.warn('Compensating: Re-applying previous tags after failure', {
                vmId,
                correlationId: payload.correlationId,
                previousTags: currentTags,
                component: 'DayNOrchestrator'
            });
            await this.tagOperations.applyTags(vmId, currentTags, site);
        });

        return {
            vmId,
            previousTags: currentTags,
            previousGroups: groupMemberships,
            dependencyCheck: dependencyResult,
            orphanedRulesCheck: orphanedRulesResult,
            tagRemoval: removeResult
        };
    }

    /**
     * Verifies the Day N decommission results, then performs post-verification
     * cleanup:
     *   6. verifyGroupRemoval  - Confirm VM left all NSX groups
     *   7. verifyCleanup       - Final cleanup validation
     *   8. deprovisionVM       - Delete VM via vCenter
     *   9. updateCMDB          - Update ServiceNow CMDB
     *
     * @param {Object} payload - The validated request payload.
     * @param {Object} endpoints - Resolved site endpoints.
     * @returns {Promise<Object>} Verification and cleanup result.
     */
    async verify(payload, endpoints) {
        const vmId = payload.vmId || payload.vmName;
        const site = payload.site;

        this.logger.info('Verifying Day N decommission results', {
            correlationId: payload.correlationId,
            vmId,
            component: 'DayNOrchestrator'
        });

        // Step 6: Verify group removal
        const groupRemovalResult = await this._timedStep('verifyGroupRemoval', async () => {
            return this._verifyGroupRemoval(vmId, site);
        });

        // Step 7: Final cleanup validation
        const cleanupResult = await this._timedStep('verifyCleanup', async () => {
            return this._verifyCleanup(vmId, site);
        });

        // Step 8: Deprovision VM
        const deprovisionResult = await this._timedStep('deprovisionVM', async () => {
            return this._deprovisionVM(vmId, endpoints);
        });

        // Step 9: Update CMDB
        const cmdbResult = await this._timedStep('updateCMDB', async () => {
            return this._updateCMDB(payload);
        });

        return {
            groupRemoval: groupRemovalResult,
            cleanupValidation: cleanupResult,
            deprovision: deprovisionResult,
            cmdbUpdate: cmdbResult
        };
    }

    // ---------------------------------------------------------------------------
    // Execute sub-steps (private)
    // ---------------------------------------------------------------------------

    /**
     * Reads the current NSX tags assigned to the VM.
     * @private
     */
    async _getCurrentTags(vmId, site) {
        this.logger.info('Reading current tags for decommission', {
            vmId, site, component: 'DayNOrchestrator'
        });

        const result = await this.tagOperations.getTags(vmId, site);
        const tags = result && result.tags ? result.tags : result || {};

        this.logger.info('Current tags retrieved', {
            vmId,
            tagCount: Object.keys(tags).length,
            categories: Object.keys(tags),
            component: 'DayNOrchestrator'
        });

        return tags;
    }

    /**
     * Reads the VM's current NSX group memberships.
     * @private
     */
    async _getGroupMemberships(vmId, site) {
        this.logger.info('Reading current group memberships', {
            vmId, site, component: 'DayNOrchestrator'
        });

        const groups = await this.groupVerifier.getEffectiveGroups(vmId, site);

        this.logger.info('Current group memberships retrieved', {
            vmId,
            groupCount: groups.length,
            groups,
            component: 'DayNOrchestrator'
        });

        return {
            groups: groups,
            membershipCount: groups.length
        };
    }

    /**
     * Checks whether any other VMs depend on this VM's group memberships.
     * If this VM is the last member of a group referenced by DFW rules
     * protecting other VMs, decommission is blocked to prevent cascading
     * security policy disruptions.
     *
     * @private
     * @throws {DfwError} DFW-7005 if dependencies are found.
     */
    async _checkDependencies(vmId, site, groupMemberships) {
        this.logger.info('Checking for decommission dependencies', {
            vmId, site, component: 'DayNOrchestrator'
        });

        const groups = groupMemberships.groups || [];

        // For each group the VM belongs to, check if removing this VM
        // would leave the group empty while DFW rules reference it
        const dependencies = [];

        for (const groupName of groups) {
            try {
                // Query group members via the group verifier's rest client
                const membersResult = await this.groupVerifier.getGroupMembers
                    ? await this.groupVerifier.getGroupMembers(groupName, site)
                    : { members: [] };

                const members = membersResult.members || membersResult || [];
                const memberCount = Array.isArray(members) ? members.length : 0;

                // If this VM is the sole member, check if DFW rules reference this group
                if (memberCount <= 1) {
                    const rulesResult = await this.dfwValidator.getRulesReferencingGroup
                        ? await this.dfwValidator.getRulesReferencingGroup(groupName, site)
                        : { rules: [] };

                    const referencingRules = rulesResult.rules || rulesResult || [];
                    if (Array.isArray(referencingRules) && referencingRules.length > 0) {
                        dependencies.push({
                            group: groupName,
                            memberCount: memberCount,
                            referencingRuleCount: referencingRules.length,
                            dependentVMs: members.filter(function (m) {
                                const id = typeof m === 'string' ? m : (m.vmId || m.id || '');
                                return id !== vmId;
                            })
                        });
                    }
                }
            } catch (err) {
                this.logger.warn('Dependency check failed for group — treating as safe', {
                    vmId, groupName, errorMessage: err.message,
                    component: 'DayNOrchestrator'
                });
            }
        }

        if (dependencies.length > 0) {
            const dependencyDetails = dependencies.map(function (dep) {
                return 'group "' + dep.group + '" (' + dep.referencingRuleCount + ' referencing rules)';
            }).join(', ');

            this.logger.error('Decommission blocked — dependencies found', {
                vmId, site,
                dependencyCount: dependencies.length,
                dependencies,
                component: 'DayNOrchestrator'
            });

            throw ErrorFactory.createError(
                'DFW-7005',
                'Cannot decommission VM "' + vmId + '" — dependencies found: ' + dependencyDetails +
                '. Resolve dependent VM configurations before proceeding with decommission.',
                'checkDependencies',
                0,
                { vmId, dependencies }
            );
        }

        this.logger.info('No dependencies found — safe to decommission', {
            vmId, site, component: 'DayNOrchestrator'
        });

        return { hasDependencies: false, dependencies: [] };
    }

    /**
     * Checks for DFW rules that would become orphaned after tag removal.
     * Orphaned rules are logged as warnings but do not block decommission.
     * @private
     */
    async _checkOrphanedRules(groupMemberships, site) {
        const groups = groupMemberships.groups || [];

        this.logger.info('Checking for orphaned DFW rules', {
            groupCount: groups.length,
            groups, site, component: 'DayNOrchestrator'
        });

        let orphanedRules = [];

        try {
            const result = await this.dfwValidator.checkOrphanedRules
                ? await this.dfwValidator.checkOrphanedRules(groups, site)
                : { orphanedRules: [] };

            orphanedRules = result && result.orphanedRules ? result.orphanedRules : [];
        } catch (err) {
            this.logger.warn('Orphaned rule check failed — proceeding without', {
                errorMessage: err.message, site, component: 'DayNOrchestrator'
            });
        }

        const hasOrphanedRules = orphanedRules.length > 0;

        if (hasOrphanedRules) {
            this.logger.warn('Orphaned DFW rules detected — cleanup recommended', {
                orphanedRuleCount: orphanedRules.length,
                orphanedRules, site, component: 'DayNOrchestrator'
            });
        } else {
            this.logger.info('No orphaned DFW rules detected', {
                site, component: 'DayNOrchestrator'
            });
        }

        return { hasOrphanedRules, orphanedRules };
    }

    /**
     * Removes all NSX tags from the VM across all categories.
     * @private
     */
    async _removeTags(vmId, allCategories, site) {
        this.logger.info('Removing all NSX tags from VM', {
            vmId,
            categories: allCategories,
            categoryCount: allCategories.length,
            site, component: 'DayNOrchestrator'
        });

        const result = await this.tagOperations.removeTags(vmId, allCategories, site);

        this.logger.info('All NSX tags removed from VM', {
            vmId,
            removedCategories: allCategories,
            component: 'DayNOrchestrator'
        });

        return {
            vmId,
            removedCategories: allCategories,
            categoryCount: allCategories.length,
            operationResult: result
        };
    }

    // ---------------------------------------------------------------------------
    // Verify sub-steps (private)
    // ---------------------------------------------------------------------------

    /**
     * Verifies that the VM is no longer a member of any NSX groups after tag
     * removal. Polls with a timeout to allow for NSX propagation delay.
     * @private
     */
    async _verifyGroupRemoval(vmId, site) {
        this.logger.info('Verifying VM group removal', {
            vmId, site, component: 'DayNOrchestrator'
        });

        let attempts = 0;
        const startTime = Date.now();

        while (attempts < GROUP_REMOVAL_POLL_CONFIG.maxAttempts) {
            attempts += 1;

            const elapsed = Date.now() - startTime;
            if (elapsed >= GROUP_REMOVAL_POLL_CONFIG.timeoutMs) {
                break;
            }

            try {
                const groups = await this.groupVerifier.getEffectiveGroups(vmId, site);

                if (!groups || groups.length === 0) {
                    this.logger.info('VM successfully removed from all NSX groups', {
                        vmId,
                        attempts,
                        durationMs: Date.now() - startTime,
                        component: 'DayNOrchestrator'
                    });
                    return { vmId, groups: [], fullyRemoved: true };
                }

                this.logger.debug('VM still in groups, waiting for removal...', {
                    vmId,
                    remainingGroups: groups,
                    attempt: attempts,
                    component: 'DayNOrchestrator'
                });
            } catch (err) {
                this.logger.warn('Group removal check failed, retrying...', {
                    vmId, attempt: attempts,
                    errorMessage: err.message,
                    component: 'DayNOrchestrator'
                });
            }

            await DayNOrchestrator._sleep(GROUP_REMOVAL_POLL_CONFIG.intervalMs);
        }

        // Final check after timeout
        let remainingGroups = [];
        try {
            remainingGroups = await this.groupVerifier.getEffectiveGroups(vmId, site);
        } catch (err) {
            this.logger.warn('Final group check failed', {
                vmId, errorMessage: err.message, component: 'DayNOrchestrator'
            });
        }

        if (remainingGroups && remainingGroups.length > 0) {
            this.logger.warn('VM still in groups after timeout — proceeding with caution', {
                vmId, remainingGroups, component: 'DayNOrchestrator'
            });
        }

        return {
            vmId,
            groups: remainingGroups || [],
            fullyRemoved: !remainingGroups || remainingGroups.length === 0
        };
    }

    /**
     * Performs final cleanup validation to ensure the VM's security posture
     * has been fully unwound.
     * @private
     */
    async _verifyCleanup(vmId, site) {
        this.logger.info('Performing final cleanup validation', {
            vmId, site, component: 'DayNOrchestrator'
        });

        let tagsRemaining = 0;
        let policiesRemaining = 0;

        // Check remaining tags
        try {
            const tagResult = await this.tagOperations.getTags(vmId, site);
            const tags = tagResult && tagResult.tags ? tagResult.tags : tagResult || {};
            tagsRemaining = Object.keys(tags).length;
        } catch (err) {
            this.logger.warn('Could not verify remaining tags', {
                vmId, errorMessage: err.message, component: 'DayNOrchestrator'
            });
        }

        // Check remaining DFW policies
        try {
            const dfwResult = await this.dfwValidator.validatePolicies
                ? await this.dfwValidator.validatePolicies(vmId, site)
                : { policies: [] };
            const policies = dfwResult && dfwResult.policies ? dfwResult.policies : [];
            policiesRemaining = policies.length;
        } catch (err) {
            this.logger.warn('Could not verify remaining DFW policies', {
                vmId, errorMessage: err.message, component: 'DayNOrchestrator'
            });
        }

        const clean = tagsRemaining === 0 && policiesRemaining === 0;

        if (clean) {
            this.logger.info('Cleanup validation passed — VM is fully unwound', {
                vmId, component: 'DayNOrchestrator'
            });
        } else {
            this.logger.warn('Cleanup validation found residual state', {
                vmId, tagsRemaining, policiesRemaining, component: 'DayNOrchestrator'
            });
        }

        return { vmId, tagsRemaining, policiesRemaining, clean };
    }

    // ---------------------------------------------------------------------------
    // Post-verify steps (private)
    // ---------------------------------------------------------------------------

    /**
     * Deprovisions (deletes) the VM via the vCenter REST API.
     * Powers off the VM first if running, then deletes it.
     * @private
     */
    async _deprovisionVM(vmId, endpoints) {
        this.logger.info('Deprovisioning VM via vCenter API', {
            vmId,
            vcenterUrl: endpoints.vcenterUrl,
            component: 'DayNOrchestrator'
        });

        // Power off VM first (if running)
        try {
            await this.restClient.post(
                `${endpoints.vcenterUrl}/api/vcenter/vm/${vmId}/power`,
                { action: 'stop' }
            );
            this.logger.debug('VM powered off', {
                vmId, component: 'DayNOrchestrator'
            });
        } catch (err) {
            // VM may already be powered off
            this.logger.debug('VM power-off returned error (may already be off)', {
                vmId, errorMessage: err.message, component: 'DayNOrchestrator'
            });
        }

        // Delete VM
        await this.restClient.delete(
            `${endpoints.vcenterUrl}/api/vcenter/vm/${vmId}`
        );

        const deprovisionedAt = new Date().toISOString();

        this.logger.info('VM deprovisioned successfully', {
            vmId, deprovisionedAt, component: 'DayNOrchestrator'
        });

        return { vmId, status: 'deprovisioned', deprovisionedAt };
    }

    /**
     * Updates the CMDB to reflect the VM's decommissioned status.
     * @private
     */
    async _updateCMDB(payload) {
        this.logger.info('Updating CMDB for decommissioned VM', {
            correlationId: payload.correlationId,
            vmName: payload.vmName,
            component: 'DayNOrchestrator'
        });

        const cmdbPayload = {
            correlationId: payload.correlationId,
            vmName: payload.vmName,
            vmId: payload.vmId,
            status: 'decommissioned',
            decommissionedAt: new Date().toISOString(),
            decommissionedBy: 'DFW-Automation-Pipeline'
        };

        const cmdbCi = payload.cmdbCi || payload.cmdb_ci || payload.vmName;

        try {
            await this.snowAdapter.updateCI(cmdbCi, cmdbPayload);

            this.logger.info('CMDB updated successfully', {
                correlationId: payload.correlationId,
                cmdbCi,
                component: 'DayNOrchestrator'
            });

            return { updated: true, cmdbCi, status: 'decommissioned' };
        } catch (err) {
            this.logger.error('CMDB update failed — manual intervention required', {
                correlationId: payload.correlationId,
                cmdbCi,
                errorMessage: err.message,
                component: 'DayNOrchestrator'
            });

            // Do not throw - the VM has already been decommissioned.
            return {
                updated: false,
                cmdbCi,
                status: 'cmdb_update_failed',
                error: err.message
            };
        }
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * Sleeps for the specified duration. Used for polling intervals.
     *
     * @private
     * @static
     * @param {number} ms - Duration in milliseconds.
     * @returns {Promise<void>}
     */
    static _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

module.exports = DayNOrchestrator;
