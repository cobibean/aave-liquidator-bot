const path = require("path");
const express = require("express");
const { createStatusService } = require("./statusService");
const { clampInt, parseSince } = require("./time");

function createApp(options = {}) {
  const app = express();
  const service = options.statusService || createStatusService(options);

  app.disable("x-powered-by");

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "aave-liquidator-monitor",
      checkedAt: new Date().toISOString(),
    });
  });

  app.get("/api/status", async (_req, res) => {
    const status = await service.getStatus();
    res.status(status.ok ? 200 : 207).json(status);
  });

  app.get("/api/logs", async (req, res) => {
    const sinceMs = parseSince(req.query.since || "1h", "1h", "24h");
    const limit = clampInt(req.query.limit, {
      fallback: 500,
      min: 1,
      max: clampInt(process.env.MONITOR_MAX_LOG_LINES, { fallback: 2000, min: 100, max: 5000 }),
    });
    const filter = typeof req.query.filter === "string" ? req.query.filter : "";
    const result = await service.getRawLogs({ sinceMs, filter, limit });

    if (req.query.format === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=liquidator-logs.txt");
      res.status(result.ok ? 200 : 207).send(result.lines.join("\n"));
      return;
    }

    res.status(result.ok ? 200 : 207).json(result);
  });

  app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

  return app;
}

if (require.main === module) {
  const host = process.env.MONITOR_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.MONITOR_PORT || "8787", 10);
  const app = createApp();

  app.listen(port, host, () => {
    console.log(`Liquidator monitor listening on http://${host}:${port}`);
  });
}

module.exports = {
  createApp,
};
