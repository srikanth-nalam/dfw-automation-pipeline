/**
 * @file RuleReviewScheduler.js
 * @description Periodic review scheduler for DFW rules in the NSX DFW
 *   Automation Pipeline. Scans the rule registry for rules approaching
 *   their review date, notifies owners, escalates overdue rules, and
 *   auto-expires rules that remain uncertified past a grace period.
 *
 * Error codes: DFW-12001 through DFW-12005
 *
 * @module dfw/RuleReviewScheduler
 */

'use strict';

/**
 * Default notification template for review reminders.
 * @constant {string}
 * @private
 */
const NOTIFICATION_TABLE = '/api/now/table/sys_email';

/**
 * Default escalation target role.
 * @constant {string}
 * @private
 */
const ESCALATION_ROLE = 'Security Architect';

/**
 * @class RuleReviewScheduler
 * @classdesc Manages the periodic review cycle for DFW rules. Scans for
 *   upcoming reviews, sends owner notifications, escalates overdue rules
 *   to security architects, and auto-expires uncertified rules.
 *
 * @example
 * const scheduler = new RuleReviewScheduler({ ruleRegistry, restClient, logger });
 * const dueRules = await scheduler.scanForDueReviews(30);
 */
class RuleReviewScheduler {
  /**
   * Creates a new RuleReviewScheduler instance.
   *
   * @param {Object} dependencies - Injected dependencies.
   * @param {Object} dependencies.ruleRegistry - Rule registry for querying rules.
   * @param {Object} dependencies.restClient - HTTP client for notifications.
   * @param {Object} dependencies.logger - Structured logger.
   *
   * @throws {Error} [DFW-12001] When required dependencies are missing.
   *
   * @example
   * const scheduler = new RuleReviewScheduler({ ruleRegistry, restClient, logger });
   */
  constructor(dependencies) {
    if (!dependencies) {
      throw new Error('[DFW-12001] RuleReviewScheduler requires dependencies');
    }
    if (!dependencies.ruleRegistry) {
      throw new Error('[DFW-12001] RuleReviewScheduler requires a ruleRegistry instance');
    }
    if (!dependencies.restClient) {
      throw new Error('[DFW-12001] RuleReviewScheduler requires a restClient instance');
    }
    if (!dependencies.logger) {
      throw new Error('[DFW-12001] RuleReviewScheduler requires a logger instance');
    }

    /** @private */
    this.ruleRegistry = dependencies.ruleRegistry;
    /** @private */
    this.restClient = dependencies.restClient;
    /** @private */
    this.logger = dependencies.logger;
  }

  /**
   * Scans the rule registry for rules due for review within the given
   * grace period.
   *
   * @async
   * @param {number} [graceDays=30] - Number of days from today to look ahead.
   * @returns {Promise<Object[]>} Array of rules with upcoming review dates.
   *
   * @throws {Error} [DFW-12002] When the scan fails.
   *
   * @example
   * const dueRules = await scheduler.scanForDueReviews(14);
   * console.log(`${dueRules.length} rules due for review`);
   */
  async scanForDueReviews(graceDays = 30) {
    this.logger.info('Scanning for rules due for review', {
      graceDays,
      component: 'RuleReviewScheduler'
    });

    let rules;
    try {
      rules = await this.ruleRegistry.findExpiring(graceDays);
    } catch (err) {
      this.logger.error('Failed to scan for due reviews', {
        graceDays,
        errorMessage: err.message,
        component: 'RuleReviewScheduler'
      });
      throw new Error(`[DFW-12002] Failed to scan for due reviews: ${err.message}`);
    }

    this.logger.info('Review scan complete', {
      rulesFound: rules.length,
      graceDays,
      component: 'RuleReviewScheduler'
    });

    return rules;
  }

  /**
   * Sends review reminder notifications to rule owners.
   *
   * Creates a ServiceNow email notification for each rule's owner
   * with details about the upcoming review deadline.
   *
   * @async
   * @param {Object[]} rules - Array of rules needing review.
   * @returns {Promise<{notificationsSent: number, failures: Object[]}>}
   *   Notification result summary.
   *
   * @throws {Error} [DFW-12003] When no rules are provided.
   *
   * @example
   * const result = await scheduler.notifyOwners(dueRules);
   * console.log(`${result.notificationsSent} notifications sent`);
   */
  async notifyOwners(rules) {
    if (!Array.isArray(rules)) {
      throw new Error('[DFW-12003] rules must be an array');
    }

    if (rules.length === 0) {
      this.logger.info('No rules to notify about', {
        component: 'RuleReviewScheduler'
      });
      return { notificationsSent: 0, failures: [] };
    }

    this.logger.info('Sending review notifications to owners', {
      ruleCount: rules.length,
      component: 'RuleReviewScheduler'
    });

    let notificationsSent = 0;
    const failures = [];

    for (const rule of rules) {
      const owner = rule.owner || rule.certifiedBy || 'unassigned';
      const ruleId = rule.ruleId || rule.sys_id || 'unknown';
      const reviewDate = rule.review_date || 'unknown';

      const notification = {
        type: 'review_reminder',
        recipients: owner,
        subject: `DFW Rule Review Due: ${ruleId}`,
        body: this._buildNotificationBody(rule),
        priority: this._calculateNotificationPriority(rule)
      };

      try {
        await this.restClient.post(NOTIFICATION_TABLE, notification);
        notificationsSent += 1;

        this.logger.debug('Notification sent', {
          ruleId,
          owner,
          reviewDate,
          component: 'RuleReviewScheduler'
        });
      } catch (err) {
        this.logger.warn('Failed to send notification', {
          ruleId,
          owner,
          errorMessage: err.message,
          component: 'RuleReviewScheduler'
        });
        failures.push({
          ruleId,
          owner,
          error: err.message
        });
      }
    }

    this.logger.info('Owner notifications complete', {
      notificationsSent,
      failures: failures.length,
      component: 'RuleReviewScheduler'
    });

    return { notificationsSent, failures };
  }

  /**
   * Escalates overdue rules to the Security Architect role.
   *
   * Rules that have been past their review date for more than the
   * specified escalation period are escalated with a higher-priority
   * notification to the security team.
   *
   * @async
   * @param {Object[]} rules - Array of rules to check for escalation.
   * @param {number} [escalationDays=14] - Number of days past review date
   *   before escalation triggers.
   * @returns {Promise<{escalated: number, escalatedRules: Object[]}>}
   *   Escalation result.
   *
   * @throws {Error} [DFW-12004] When escalation fails.
   *
   * @example
   * const result = await scheduler.escalateOverdue(rules, 14);
   * console.log(`${result.escalated} rules escalated`);
   */
  async escalateOverdue(rules, escalationDays = 14) {
    if (!Array.isArray(rules)) {
      throw new Error('[DFW-12004] rules must be an array');
    }

    this.logger.info('Checking for overdue rules to escalate', {
      ruleCount: rules.length,
      escalationDays,
      component: 'RuleReviewScheduler'
    });

    const now = new Date();
    const escalatedRules = [];

    for (const rule of rules) {
      const reviewDate = rule.review_date ? new Date(rule.review_date) : null;
      if (!reviewDate) {
        continue;
      }

      const daysPastDue = Math.floor((now - reviewDate) / (1000 * 60 * 60 * 24));
      if (daysPastDue <= escalationDays) {
        continue;
      }

      const ruleId = rule.ruleId || rule.sys_id || 'unknown';

      const escalation = {
        type: 'escalation',
        recipients: ESCALATION_ROLE,
        subject: `ESCALATION: DFW Rule ${ruleId} overdue by ${daysPastDue} days`,
        body: this._buildEscalationBody(rule, daysPastDue),
        priority: 1
      };

      try {
        await this.restClient.post(NOTIFICATION_TABLE, escalation);
        escalatedRules.push({
          ruleId,
          owner: rule.owner || 'unassigned',
          daysPastDue,
          reviewDate: rule.review_date
        });

        this.logger.info('Rule escalated', {
          ruleId,
          daysPastDue,
          component: 'RuleReviewScheduler'
        });
      } catch (err) {
        this.logger.error('Failed to escalate rule', {
          ruleId,
          errorMessage: err.message,
          component: 'RuleReviewScheduler'
        });
        throw new Error(`[DFW-12004] Failed to escalate rule "${ruleId}": ${err.message}`);
      }
    }

    this.logger.info('Escalation check complete', {
      escalated: escalatedRules.length,
      component: 'RuleReviewScheduler'
    });

    return {
      escalated: escalatedRules.length,
      escalatedRules
    };
  }

  /**
   * Auto-expires rules that remain uncertified past the grace period.
   *
   * Rules whose review date is further in the past than graceDays are
   * transitioned to EXPIRED state via the rule registry.
   *
   * @async
   * @param {Object[]} rules - Array of rules to check for auto-expiry.
   * @param {number} [graceDays=60] - Number of days past review date
   *   before auto-expiry triggers.
   * @returns {Promise<{expired: number, expiredRules: Object[]}>}
   *   Expiry result.
   *
   * @throws {Error} [DFW-12005] When auto-expiry fails.
   *
   * @example
   * const result = await scheduler.autoExpire(rules, 60);
   * console.log(`${result.expired} rules auto-expired`);
   */
  async autoExpire(rules, graceDays = 60) {
    if (!Array.isArray(rules)) {
      throw new Error('[DFW-12005] rules must be an array');
    }

    this.logger.info('Checking for rules to auto-expire', {
      ruleCount: rules.length,
      graceDays,
      component: 'RuleReviewScheduler'
    });

    const now = new Date();
    const expiredRules = [];

    for (const rule of rules) {
      const reviewDate = rule.review_date ? new Date(rule.review_date) : null;
      if (!reviewDate) {
        continue;
      }

      const daysPastDue = Math.floor((now - reviewDate) / (1000 * 60 * 60 * 24));
      if (daysPastDue <= graceDays) {
        continue;
      }

      const ruleId = rule.ruleId || rule.sys_id || 'unknown';
      const currentState = rule.state || 'unknown';

      // Only expire rules in REVIEW_DUE or CERTIFIED state
      if (currentState !== 'REVIEW_DUE' && currentState !== 'CERTIFIED') {
        this.logger.debug('Skipping auto-expire for rule not in eligible state', {
          ruleId,
          currentState,
          component: 'RuleReviewScheduler'
        });
        continue;
      }

      try {
        await this.ruleRegistry.updateState(ruleId, 'EXPIRED', {
          reason: `Auto-expired: ${daysPastDue} days past review date (grace: ${graceDays})`,
          changedBy: 'review-scheduler'
        });

        expiredRules.push({
          ruleId,
          owner: rule.owner || 'unassigned',
          daysPastDue,
          previousState: currentState
        });

        this.logger.info('Rule auto-expired', {
          ruleId,
          daysPastDue,
          previousState: currentState,
          component: 'RuleReviewScheduler'
        });
      } catch (err) {
        this.logger.error('Failed to auto-expire rule', {
          ruleId,
          errorMessage: err.message,
          component: 'RuleReviewScheduler'
        });
        throw new Error(`[DFW-12005] Failed to auto-expire rule "${ruleId}": ${err.message}`);
      }
    }

    this.logger.info('Auto-expire check complete', {
      expired: expiredRules.length,
      component: 'RuleReviewScheduler'
    });

    return {
      expired: expiredRules.length,
      expiredRules
    };
  }

  /**
   * Generates a review health report summarising the current state of
   * rule reviews across the entire registry.
   *
   * @async
   * @returns {Promise<{
   *   timestamp: string,
   *   totalDueWithin30: number,
   *   totalDueWithin14: number,
   *   totalOverdue: number,
   *   rulesByState: Object,
   *   healthScore: number
   * }>} Review health report.
   *
   * @throws {Error} [DFW-12002] When the report generation fails.
   *
   * @example
   * const report = await scheduler.generateReviewReport();
   * console.log(`Review health score: ${report.healthScore}%`);
   */
  async generateReviewReport() {
    this.logger.info('Generating review health report', {
      component: 'RuleReviewScheduler'
    });

    let dueWithin30;
    let dueWithin14;
    try {
      dueWithin30 = await this.ruleRegistry.findExpiring(30);
      dueWithin14 = await this.ruleRegistry.findExpiring(14);
    } catch (err) {
      throw new Error(`[DFW-12002] Failed to generate review report: ${err.message}`);
    }

    const now = new Date();
    const overdue = dueWithin30.filter((rule) => {
      const reviewDate = rule.review_date ? new Date(rule.review_date) : null;
      return reviewDate && reviewDate < now;
    });

    // Build state summary
    const rulesByState = {};
    for (const rule of dueWithin30) {
      const state = rule.state || 'unknown';
      if (!rulesByState[state]) {
        rulesByState[state] = 0;
      }
      rulesByState[state] += 1;
    }

    // Health score: 100% if no overdue, decreasing with overdue count
    const totalDue = dueWithin30.length;
    const healthScore = totalDue > 0
      ? Math.max(0, Math.round(((totalDue - overdue.length) / totalDue) * 100))
      : 100;

    const report = {
      timestamp: now.toISOString(),
      totalDueWithin30: dueWithin30.length,
      totalDueWithin14: dueWithin14.length,
      totalOverdue: overdue.length,
      rulesByState,
      healthScore
    };

    this.logger.info('Review health report generated', {
      totalDueWithin30: report.totalDueWithin30,
      totalOverdue: report.totalOverdue,
      healthScore: report.healthScore,
      component: 'RuleReviewScheduler'
    });

    return report;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Builds the notification body for a review reminder.
   *
   * @private
   * @param {Object} rule - Rule record.
   * @returns {string} Formatted notification body.
   */
  _buildNotificationBody(rule) {
    const ruleId = rule.ruleId || rule.sys_id || 'unknown';
    const reviewDate = rule.review_date || 'not set';
    const name = rule.name || ruleId;

    return [
      `DFW Rule Review Reminder`,
      ``,
      `Rule: ${name} (${ruleId})`,
      `Review Date: ${reviewDate}`,
      `Current State: ${rule.state || 'unknown'}`,
      `Owner: ${rule.owner || 'unassigned'}`,
      ``,
      `Please review and re-certify this rule before the review date.`,
      `Failure to re-certify will result in automatic escalation and eventual expiry.`
    ].join('\n');
  }

  /**
   * Builds the escalation body for an overdue rule.
   *
   * @private
   * @param {Object} rule - Rule record.
   * @param {number} daysPastDue - Number of days past the review date.
   * @returns {string} Formatted escalation body.
   */
  _buildEscalationBody(rule, daysPastDue) {
    const ruleId = rule.ruleId || rule.sys_id || 'unknown';
    const name = rule.name || ruleId;

    return [
      `ESCALATION: DFW Rule Review Overdue`,
      ``,
      `Rule: ${name} (${ruleId})`,
      `Days Past Due: ${daysPastDue}`,
      `Review Date: ${rule.review_date || 'not set'}`,
      `Owner: ${rule.owner || 'unassigned'}`,
      ``,
      `This rule has not been re-certified and requires immediate attention.`,
      `If not addressed, the rule will be auto-expired.`
    ].join('\n');
  }

  /**
   * Calculates notification priority based on proximity to review date.
   *
   * @private
   * @param {Object} rule - Rule record.
   * @returns {number} Priority level (1=highest, 4=lowest).
   */
  _calculateNotificationPriority(rule) {
    const reviewDate = rule.review_date ? new Date(rule.review_date) : null;
    if (!reviewDate) {
      return 3;
    }

    const now = new Date();
    const daysUntilDue = Math.floor((reviewDate - now) / (1000 * 60 * 60 * 24));

    if (daysUntilDue < 0) {
      return 1; // Overdue
    }
    if (daysUntilDue <= 7) {
      return 2; // Due within a week
    }
    if (daysUntilDue <= 14) {
      return 3; // Due within two weeks
    }
    return 4; // More than two weeks away
  }
}

module.exports = RuleReviewScheduler;
