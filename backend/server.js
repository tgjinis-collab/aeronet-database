// =============================================================================
// AeroNetB ASCM — server.js (entry point)
// =============================================================================
require("dotenv").config();
const express = require("express");
const morgan  = require("morgan");
const helmet  = require("helmet");
const cors    = require("cors");
const path    = require("path");

const { pgPool, connectMongo, getMongo } = require("./config/db");
const { authenticate } = require("./middleware/auth");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin:         process.env.CORS_ORIGIN || "*",
  methods:        ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","Accept"],
  credentials:    false,
}));
app.options("*", cors());
app.use(express.json());
app.use(morgan("dev"));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth",           require("./routes/auth.routes"));
app.use("/api/suppliers",      require("./routes/suppliers.routes"));
app.use("/api/orders",         require("./routes/orders.routes"));
app.use("/api/shipments",      require("./routes/shipments.routes"));
// GET /api/delivered-items — direct endpoint
app.get("/api/delivered-items", authenticate, async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const { rows } = await pgPool.query(
      `SELECT di.delivered_item_id, di.serial_number, di.batch_number, di.shipment_id,
              di.delivery_timestamp, p.part_name, sh.tracking_number, s.business_name AS supplier_name
         FROM delivered_item di
         JOIN purchase_order_line pol ON pol.order_line_id = di.order_line_id
         JOIN supplier_part_offering spo ON spo.supplier_part_id = pol.supplier_part_id
         JOIN part p ON p.part_id = spo.part_id
         LEFT JOIN shipment sh ON sh.shipment_id = di.shipment_id
         LEFT JOIN purchase_order po ON po.order_id = sh.order_id
         LEFT JOIN supplier s ON s.supplier_id = po.supplier_id
        ORDER BY di.delivery_timestamp DESC LIMIT $1 OFFSET $2`,
      [Number(limit), Number(offset)]
    );
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
app.use("/api/qc-reports",     require("./routes/qc.routes"));
app.use("/api/certifications", require("./routes/certifications.routes"));
app.use("/api/equipment",      require("./routes/equipment.routes"));
// sensor-readings POST is handled inside equipment.routes as /sensor-readings
app.use("/api/users",          require("./routes/users.routes"));
app.use("/api/audit-logs",     require("./routes/audit.routes"));
app.use("/api/dashboard",      require("./routes/dashboard.routes"));

// Parts (inline — small enough not to warrant a separate file)

app.get("/api/parts", authenticate, async (req, res) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;
    let sql = "SELECT * FROM part WHERE 1=1"; const params = [];
    if (search) { params.push(`%${search}%`); sql += ` AND (part_name ILIKE $1 OR description ILIKE $1)`; }
    sql += ` ORDER BY part_name LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pgPool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/parts/:id/spec/full", authenticate, async (req, res) => {
  try {
    const { rows } = await pgPool.query("SELECT * FROM part_baseline_spec WHERE part_id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Spec not found." });
    const mongoDB   = getMongo();
    const mongoDoc  = mongoDB ? await mongoDB.collection("manufacturing_specs").findOne({ _pgPartRef: req.params.id }) : null;
    res.json({ success: true, data: { relational: rows[0], document: mongoDoc || null } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    await pgPool.query("SELECT 1");
    const mongoDB    = getMongo();
    const mongoStatus = mongoDB ? "ok" : "unavailable";
    if (mongoDB) await mongoDB.command({ ping: 1 });
    res.json({ success: true, postgres: "ok", mongodb: mongoStatus });
  } catch (err) { res.status(503).json({ success: false, message: err.message }); }
});

// ── Serve dashboard ──────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "index.html")));

// ── Error handlers ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "Internal server error." });
});
app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found." }));

// ── Startup ──────────────────────────────────────────────────────────────────
(async () => {
  try {
    await pgPool.query("SELECT 1");
    console.log("✓ PostgreSQL connected");
  } catch (err) {
    console.error("PostgreSQL startup failed:", err.message);
    process.exit(1);
  }
  try {
    await connectMongo();
  } catch (err) {
    console.warn("⚠ MongoDB unavailable — document features disabled:", err.message);
  }
  app.listen(PORT, () => console.log(`✓ AeroNetB API running on port ${PORT}`));
})();
