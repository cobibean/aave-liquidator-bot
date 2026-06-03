// Local per-(wallet,chain) nonce tracking + a bounded in-flight gate, so we can
// fire liquidations back-to-back without (a) a getTransactionCount round-trip
// before every send, or (b) two same-block targets colliding on the same nonce.
//
// Why this matters for speed: previously each send implicitly fetched the nonce
// from the node and we blocked on tx.wait() before starting the next candidate —
// so target #2 waited for #1's receipt and was often already gone. With a local
// nonce we assign #1, #2, #3 immediately; with non-blocking send (ASYNC_SEND) we
// broadcast all viable targets and confirm out-of-band.
//
// Each chain runs in its OWN process now (compose: one container per chain), and
// there is one wallet, so a manager instance owns the entire nonce space for its
// chain — no cross-process contention. We seed lazily from the "pending" count
// (includes our own not-yet-mined txs) and RESYNC from the chain on any send
// error, so a dropped/replaced tx can't wedge us.

const { ethers } = require("ethers");

class NonceManager {
  constructor(wallet, chainKey) {
    this.wallet = wallet;
    this.chainKey = chainKey || "default";
    this.next = null; // next nonce to hand out; null = not yet seeded
    this.seeding = null; // in-flight seed promise (dedupe concurrent first calls)
    this.inFlight = 0; // count of broadcast-but-unconfirmed txs
  }

  // Returns the next nonce to use and optimistically advances the counter.
  // Seeds from the chain's pending count on first use.
  async reserve() {
    if (this.next === null) {
      if (!this.seeding) {
        this.seeding = this.wallet
          .getTransactionCount("pending")
          .then((n) => {
            // Only adopt if a concurrent resync hasn't already set a higher value.
            if (this.next === null || n > this.next) this.next = n;
          })
          .finally(() => {
            this.seeding = null;
          });
      }
      await this.seeding;
    }
    const nonce = this.next;
    this.next += 1;
    return nonce;
  }

  // Re-read the authoritative pending nonce after an error (e.g. "nonce too low",
  // a replaced/dropped tx). Forces a fresh seed on the next reserve().
  async resync() {
    try {
      const n = await this.wallet.getTransactionCount("pending");
      this.next = n;
    } catch (_) {
      // Couldn't reach the node; drop the cached value so the next reserve()
      // re-seeds from scratch rather than trusting a possibly-stale counter.
      this.next = null;
    }
  }

  // True if we're at/over the configured concurrent-send cap for this chain.
  atCapacity(max) {
    return this.inFlight >= max;
  }

  acquire() {
    this.inFlight += 1;
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

// Returns the maximum number of concurrently-broadcast (unconfirmed) txs allowed
// per chain. 1 preserves the old "one liquidation in flight at a time" behavior;
// raise it (ASYNC_SEND) to fire on multiple same-block targets at once.
function maxInFlight() {
  const v = parseInt(process.env.MAX_INFLIGHT_TX || "1", 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

module.exports = { NonceManager, maxInFlight };
