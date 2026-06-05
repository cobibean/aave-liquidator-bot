// Lean latency instrumentation. Emits single-line, greppable, key=value records
// so we can measure WHERE liquidations are won/lost (Detect → Decide → Deliver)
// without a metrics server. Every record is prefixed "📊 METRIC " and is flat
// key=value pairs, so `docker logs … | grep '📊 METRIC'` + a one-liner parses it.
//
// Design intent: zero new deps, negligible cost, never throws into the hot path.
// This exists to answer "is enrichment/gas/inclusion actually costing us
// liquidations?" with DATA before we build more speed machinery (e.g. 4.3).
//
// Record types (the `ev` field):
//   sweep   — one per HF sweep: chain, type, set size, sweep ms, block, candidates
//   trigger_scan — throttled block/price trigger scans over the persisted hot tier
//   attempt — one per attemptLiquidation: chain, user, hf, the per-stage timings
//             (decideMs = enrich+sim+floor before broadcast; deliverMs = broadcast
//             → receipt), outcome (precheck_fail / testmode / sent / mined /
//             reverted / error), and the block at detect vs at send (in-process lag).

function emit(ev, fields = {}) {
  try {
    const parts = [`ev=${ev}`];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      // Keep values single-token: strip whitespace, cap length.
      const s = String(v).replace(/\s+/g, "_").slice(0, 80);
      parts.push(`${k}=${s}`);
    }
    console.log(`📊 METRIC ${parts.join(" ")}`);
  } catch (_) {
    // never let instrumentation break the bot
  }
}

// Small monotonic stopwatch helper.
function now() {
  return Date.now();
}
function since(t0) {
  return t0 ? Date.now() - t0 : null;
}

module.exports = { emit, now, since };
