/**
 * @file RateLimiter.js
 * @description Token bucket rate limiter for NSX Manager API calls.
 *   Prevents overwhelming the NSX API during bulk operations by enforcing
 *   a maximum request rate with burst tolerance.
 *
 * @module shared/RateLimiter
 */

'use strict';

/**
 * @class RateLimiter
 * @classdesc Implements a token bucket algorithm to rate-limit outbound API
 *   calls. Each call consumes one or more tokens. Tokens refill at a constant
 *   rate up to a configurable maximum (burst size).
 *
 * @example
 * const limiter = new RateLimiter({ maxTokens: 100, refillRate: 20 });
 * await limiter.acquire();   // waits if no tokens available
 * await limiter.acquire(5);  // consume 5 tokens at once
 */
class RateLimiter {
  /**
   * Creates a new RateLimiter.
   *
   * @param {Object} [options={}] - Configuration.
   * @param {number} [options.maxTokens=100]  - Maximum burst size (token capacity).
   * @param {number} [options.refillRate=20]  - Tokens added per second.
   */
  constructor(options = {}) {
    /** @private */
    this.maxTokens = options.maxTokens || 100;
    /** @private */
    this.refillRate = options.refillRate || 20;
    /** @private */
    this.tokens = this.maxTokens;
    /** @private */
    this.lastRefill = Date.now();
  }

  /**
   * Acquires the requested number of tokens, waiting if necessary until
   * enough tokens are available.
   *
   * @param {number} [tokens=1] - Number of tokens to consume.
   * @returns {Promise<boolean>} Resolves to `true` when tokens are acquired.
   */
  async acquire(tokens = 1) {
    this._refill();

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }

    // Wait for tokens to become available
    const deficit = tokens - this.tokens;
    const waitMs = (deficit / this.refillRate) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    this._refill();
    this.tokens -= tokens;
    return true;
  }

  /**
   * Returns the number of tokens currently available.
   *
   * @returns {number} Available tokens.
   */
  getAvailableTokens() {
    this._refill();
    return this.tokens;
  }

  /**
   * Resets the rate limiter to full capacity.
   */
  reset() {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Refills tokens based on elapsed time since last refill.
   *
   * @private
   */
  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

module.exports = RateLimiter;
