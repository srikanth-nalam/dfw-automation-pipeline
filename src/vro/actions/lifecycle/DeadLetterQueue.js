/**
 * @file DeadLetterQueue.js
 * @description In-memory Dead Letter Queue (DLQ) for the DFW Automation Pipeline.
 *   Stores failed operations with full metadata for later analysis and
 *   reprocessing. Each entry captures the original payload, error details,
 *   correlation ID, timestamps, and retry count.
 *
 *   The DLQ enables reliable failure handling by decoupling error recovery from
 *   the main workflow execution path. Operations that fail after exhausting
 *   retries are enqueued here rather than being silently dropped.
 *
 *   Entries can be listed with filters, individually reprocessed through an
 *   orchestrator, or purged after a configurable retention period.
 *
 * @module lifecycle/DeadLetterQueue
 */

'use strict';

/**
 * Possible statuses for a DLQ entry.
 *
 * @enum {string}
 * @readonly
 */
const DLQ_STATUS = Object.freeze({
  /** Entry is waiting for manual review or reprocessing. */
  PENDING: 'pending',
  /** Entry is currently being reprocessed. */
  PROCESSING: 'processing',
  /** Entry was successfully reprocessed and resolved. */
  RESOLVED: 'resolved',
  /** Entry failed reprocessing and remains in the queue. */
  FAILED: 'failed'
});

/**
 * @class DeadLetterQueue
 * @classdesc In-memory Dead Letter Queue that stores failed pipeline operations
 *   for later inspection, reprocessing, or purging.
 *
 * @example
 * const Logger = require('../shared/Logger');
 * const dlq = new DeadLetterQueue(new Logger({ step: 'DLQ' }));
 *
 * const id = await dlq.enqueue(
 *   { vmName: 'srv-web-01', requestType: 'Day0' },
 *   new Error('vCenter unreachable'),
 *   'RITM-00001-1679000000000'
 * );
 * // id => 'DLQ-1679000000000-RITM-00001-1679000000000'
 */
class DeadLetterQueue {
  /**
   * Creates a new DeadLetterQueue instance.
   *
   * @param {import('../shared/Logger')} logger - Logger instance for structured
   *   logging of DLQ operations (enqueue, dequeue, reprocess, purge).
   */
  constructor(logger) {
    /**
     * Logger instance for DLQ operations.
     * @private
     * @type {import('../shared/Logger')}
     */
    this._logger = logger;

    /**
     * In-memory store for DLQ entries, keyed by DLQ entry ID.
     * @private
     * @type {Map<string, Object>}
     */
    this._store = new Map();
  }

  /**
   * Stores a failed operation in the dead letter queue with full metadata.
   *
   * The entry is assigned a unique ID in the format `DLQ-{timestamp}-{correlationId}`
   * and stored with a `pending` status, ready for manual review or automated
   * reprocessing.
   *
   * @param {Object} failedPayload - The original payload that failed processing.
   *   This is stored verbatim for replay during reprocessing.
   * @param {Error|string} error - The error that caused the failure. If an Error
   *   instance, its `message`, `code`, and `stack` properties are extracted.
   * @param {string} correlationId - Correlation ID linking this failure back to
   *   the originating ServiceNow request.
   * @returns {Promise<string>} The generated DLQ entry ID.
   *
   * @example
   * const id = await dlq.enqueue(
   *   { vmName: 'srv-web-01', requestType: 'Day0', site: 'NDCNG' },
   *   new Error('Connection timeout'),
   *   'RITM-00001-1679000000000'
   * );
   */
  async enqueue(failedPayload, error, correlationId) {
    const timestamp = Date.now();
    const id = `DLQ-${timestamp}-${correlationId}`;

    const errorDetails = error instanceof Error
      ? {
        message: error.message,
        code: error.code || null,
        stack: error.stack || null
      }
      : {
        message: String(error),
        code: null,
        stack: null
      };

    const entry = {
      id,
      correlationId,
      payload: failedPayload,
      error: errorDetails,
      status: DLQ_STATUS.PENDING,
      retryCount: 0,
      enqueuedAt: new Date(timestamp).toISOString(),
      lastAttemptAt: null,
      resolvedAt: null
    };

    this._store.set(id, entry);

    this._logger.warn('Operation enqueued to Dead Letter Queue', {
      dlqId: id,
      correlationId,
      errorMessage: errorDetails.message,
      payloadType: failedPayload && failedPayload.requestType
        ? failedPayload.requestType
        : 'unknown',
      component: 'DeadLetterQueue'
    });

    return id;
  }

  /**
   * Removes and returns a DLQ entry by its ID.
   *
   * Once dequeued, the entry is permanently removed from the in-memory store.
   * This is typically used after successful manual resolution or when an entry
   * is no longer needed.
   *
   * @param {string} id - The DLQ entry ID to dequeue.
   * @returns {Promise<Object|null>} The dequeued entry object, or `null` if no
   *   entry with the given ID exists.
   *
   * @example
   * const entry = await dlq.dequeue('DLQ-1679000000000-RITM-00001');
   * if (entry) {
   *   console.log('Dequeued:', entry.payload);
   * }
   */
  async dequeue(id) {
    const entry = this._store.get(id);

    if (!entry) {
      this._logger.warn('Attempted to dequeue non-existent DLQ entry', {
        dlqId: id,
        component: 'DeadLetterQueue'
      });
      return null;
    }

    this._store.delete(id);

    this._logger.info('Entry dequeued from Dead Letter Queue', {
      dlqId: id,
      correlationId: entry.correlationId,
      status: entry.status,
      component: 'DeadLetterQueue'
    });

    return entry;
  }

  /**
   * Lists DLQ entries with optional filtering by status and/or date range.
   *
   * When no filter is provided, all entries are returned. Filters can be
   * combined — an entry must match ALL specified criteria to be included.
   *
   * @param {Object} [filter={}] - Optional filter criteria.
   * @param {string} [filter.status] - Filter by entry status. One of
   *   `'pending'`, `'processing'`, `'resolved'`, `'failed'`.
   * @param {string} [filter.since] - ISO 8601 date string. Only entries
   *   enqueued at or after this timestamp are included.
   * @param {string} [filter.until] - ISO 8601 date string. Only entries
   *   enqueued at or before this timestamp are included.
   * @param {string} [filter.correlationId] - Filter by correlation ID.
   * @returns {Promise<Array<Object>>} Array of matching DLQ entries.
   *
   * @example
   * // List all pending entries
   * const pending = await dlq.list({ status: 'pending' });
   *
   * @example
   * // List entries from the last 24 hours
   * const recent = await dlq.list({
   *   since: new Date(Date.now() - 86400000).toISOString()
   * });
   */
  async list(filter = {}) {
    const entries = Array.from(this._store.values());

    const filtered = entries.filter((entry) => {
      // Filter by status
      if (filter.status && entry.status !== filter.status) {
        return false;
      }

      // Filter by correlation ID
      if (filter.correlationId && entry.correlationId !== filter.correlationId) {
        return false;
      }

      // Filter by enqueued date range — since
      if (filter.since) {
        const sinceDate = new Date(filter.since).getTime();
        const entryDate = new Date(entry.enqueuedAt).getTime();
        if (entryDate < sinceDate) {
          return false;
        }
      }

      // Filter by enqueued date range — until
      if (filter.until) {
        const untilDate = new Date(filter.until).getTime();
        const entryDate = new Date(entry.enqueuedAt).getTime();
        if (entryDate > untilDate) {
          return false;
        }
      }

      return true;
    });

    this._logger.debug('DLQ list queried', {
      totalEntries: entries.length,
      matchedEntries: filtered.length,
      filter,
      component: 'DeadLetterQueue'
    });

    return filtered;
  }

  /**
   * Retrieves a DLQ entry and re-runs it through the provided orchestrator.
   *
   * The entry's status is set to `processing` during reprocessing. On success,
   * the status is updated to `resolved` and the entry's `resolvedAt` timestamp
   * is set. On failure, the status is set back to `failed`, the retry count is
   * incremented, and the error details are updated.
   *
   * @param {string} id - The DLQ entry ID to reprocess.
   * @param {import('./LifecycleOrchestrator')} orchestrator - The orchestrator
   *   instance to use for reprocessing. Its `run(payload)` method is called
   *   with the entry's stored payload.
   * @returns {Promise<{success: boolean, result?: Object, error?: string}>}
   *   An object indicating whether reprocessing succeeded or failed.
   * @throws {Error} If the entry ID does not exist in the queue.
   *
   * @example
   * const outcome = await dlq.reprocess(
   *   'DLQ-1679000000000-RITM-00001',
   *   day0Orchestrator
   * );
   * if (outcome.success) {
   *   console.log('Reprocessing succeeded:', outcome.result);
   * }
   */
  async reprocess(id, orchestrator) {
    const entry = this._store.get(id);

    if (!entry) {
      throw new Error(
        `[DFW-6010] DLQ entry "${id}" not found. Cannot reprocess.`
      );
    }

    this._logger.info('Reprocessing DLQ entry', {
      dlqId: id,
      correlationId: entry.correlationId,
      retryCount: entry.retryCount,
      component: 'DeadLetterQueue'
    });

    // Mark as processing
    entry.status = DLQ_STATUS.PROCESSING;
    entry.lastAttemptAt = new Date().toISOString();
    entry.retryCount += 1;

    try {
      const result = await orchestrator.run(entry.payload);

      // Mark as resolved on success
      entry.status = DLQ_STATUS.RESOLVED;
      entry.resolvedAt = new Date().toISOString();

      this._logger.info('DLQ entry reprocessed successfully', {
        dlqId: id,
        correlationId: entry.correlationId,
        retryCount: entry.retryCount,
        component: 'DeadLetterQueue'
      });

      return { success: true, result };
    } catch (err) {
      // Mark as failed and update error details
      entry.status = DLQ_STATUS.FAILED;
      entry.error = {
        message: err.message || String(err),
        code: err.code || null,
        stack: err.stack || null
      };

      this._logger.error('DLQ entry reprocessing failed', {
        dlqId: id,
        correlationId: entry.correlationId,
        retryCount: entry.retryCount,
        errorMessage: err.message,
        component: 'DeadLetterQueue'
      });

      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Removes all entries older than the specified number of days.
   *
   * Entries are compared by their `enqueuedAt` timestamp. Only entries in
   * `pending` or `resolved` status are eligible for purging — entries with
   * `processing` status are skipped to avoid data loss during active retries.
   *
   * @param {number} days - The age threshold in days. Entries enqueued more
   *   than this many days ago will be removed.
   * @returns {Promise<{purged: number, skipped: number}>} Summary of the purge
   *   operation with counts of removed and skipped entries.
   *
   * @example
   * const result = await dlq.purgeOlderThan(30);
   * // result => { purged: 5, skipped: 1 }
   */
  async purgeOlderThan(days) {
    if (typeof days !== 'number' || days <= 0) {
      throw new Error(
        '[DFW-6011] Days parameter must be a positive number.'
      );
    }

    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    let purged = 0;
    let skipped = 0;

    for (const [id, entry] of this._store.entries()) {
      const entryTime = new Date(entry.enqueuedAt).getTime();

      if (entryTime < cutoff) {
        // Do not purge entries actively being reprocessed
        if (entry.status === DLQ_STATUS.PROCESSING) {
          skipped += 1;
          continue;
        }

        this._store.delete(id);
        purged += 1;
      }
    }

    this._logger.info('DLQ purge completed', {
      purged,
      skipped,
      thresholdDays: days,
      remainingEntries: this._store.size,
      component: 'DeadLetterQueue'
    });

    return { purged, skipped };
  }

  /**
   * Returns aggregate statistics about the current DLQ contents.
   *
   * @returns {Promise<{count: number, oldest: string|null, newest: string|null, byStatus: Object.<string, number>}>}
   *   An object containing:
   *   - `count` — total number of entries
   *   - `oldest` — ISO 8601 timestamp of the oldest entry, or `null` if empty
   *   - `newest` — ISO 8601 timestamp of the newest entry, or `null` if empty
   *   - `byStatus` — breakdown of entry counts by status
   *
   * @example
   * const stats = await dlq.getStats();
   * // stats => {
   * //   count: 3,
   * //   oldest: '2026-03-20T08:00:00.000Z',
   * //   newest: '2026-03-21T14:30:00.000Z',
   * //   byStatus: { pending: 2, failed: 1 }
   * // }
   */
  async getStats() {
    const entries = Array.from(this._store.values());

    if (entries.length === 0) {
      return {
        count: 0,
        oldest: null,
        newest: null,
        byStatus: {}
      };
    }

    // Sort by enqueuedAt to find oldest and newest
    const sorted = entries
      .map((e) => ({ enqueuedAt: e.enqueuedAt, status: e.status }))
      .sort((a, b) => new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime());

    // Count by status
    const byStatus = {};
    for (const entry of entries) {
      byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
    }

    return {
      count: entries.length,
      oldest: sorted[0].enqueuedAt,
      newest: sorted[sorted.length - 1].enqueuedAt,
      byStatus
    };
  }
}

/** Expose status constants for external use. */
DeadLetterQueue.DLQ_STATUS = DLQ_STATUS;

module.exports = DeadLetterQueue;
