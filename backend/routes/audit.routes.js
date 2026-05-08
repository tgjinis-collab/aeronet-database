// routes/audit.routes.js — Audit log + Non-compliance flag management
const router   = require("express").Router();
const { body } = require("express-validator");
const { pgPool }                            = require("../config/db");
const { authenticate, authorize, logAudit } = require("../middleware/auth");
const { validate }                          = require("../middleware/validate");
const { uuidParam }                         = require("../middleware/helpers");

// ── Audit Log ─────────────────────────────────────────────────────────────────

// GET /api/audit-logs
router.get("/", authenticate, authorize("AUDITOR","SUPPLY_CHAIN_MANAGER"), async (req, res) => {
  try {
    const { emp_id, entity_type, entity_id, action_type, from, to, limit = 100, offset = 0 } = req.query;
    let sql = `SELECT al.*, u.full_name, u.email
                 FROM audit_log al
                 LEFT JOIN "user" u ON u.emp_id = al.emp_id
                WHERE 1=1`;
    const params = [];
    if (emp_id)      { params.push(emp_id);      sql += ` AND al.emp_id = $${params.length}`; }
    if (entity_type) { params.push(entity_type); sql += ` AND al.entity_type = $${params.length}`; }
    if (entity_id)   { params.push(entity_id);   sql += ` AND al.entity_id = $${params.length}`; }
    if (action_type) { params.push(action_type); sql += ` AND al.action_type = $${params.length}`; }
    if (from)        { params.push(from);         sql += ` AND al.created_at >= $${params.length}`; }
    if (to)          { params.push(to);           sql += ` AND al.created_at <= $${params.length}`; }
    sql += ` ORDER BY al.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pgPool.query(sql, params);
    await logAudit(req.user.emp_id, "VIEW", "AUDIT_LOGS", "LIST", "SUCCESS", req);
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Non-Compliance Flags ──────────────────────────────────────────────────────

// GET /api/audit-logs/flags
router.get("/flags", authenticate, authorize("AUDITOR","SUPPLY_CHAIN_MANAGER"), async (req, res) => {
  try {
    const { status, severity, entity_type, limit = 100, offset = 0 } = req.query;
    let sql = `
      SELECT f.*, u.full_name AS flagged_by_name, r.full_name AS resolved_by_name
        FROM non_compliance_flag f
        JOIN "user" u ON u.emp_id = f.flagged_by_emp_id
        LEFT JOIN "user" r ON r.emp_id = f.resolved_by_emp_id
       WHERE 1=1`;
    const params = [];
    if (status)      { params.push(status);      sql += ` AND f.status = $${params.length}`; }
    if (severity)    { params.push(severity);     sql += ` AND f.severity = $${params.length}`; }
    if (entity_type) { params.push(entity_type); sql += ` AND f.entity_type = $${params.length}`; }
    sql += `
      ORDER BY
        CASE f.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
        f.created_at DESC
      LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pgPool.query(sql, params);
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/audit-logs/flags
router.post("/flags", authenticate, authorize("AUDITOR"),
  [
    body("entity_type").isIn(["QC_REPORT","CERTIFICATION","SUPPLIER","SHIPMENT","DELIVERED_ITEM"]),
    body("entity_id").notEmpty().trim(),
    body("reason").notEmpty().trim().isLength({ max: 2000 }),
    body("severity").isIn(["LOW","MEDIUM","HIGH","CRITICAL"]),
  ],
  validate,
  async (req, res) => {
    const { entity_type, entity_id, reason, severity } = req.body;
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO non_compliance_flag (flagged_by_emp_id, entity_type, entity_id, reason, severity)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.user.emp_id, entity_type, entity_id, reason, severity]
      );
      await logAudit(req.user.emp_id, "CREATE", "NON_COMPLIANCE_FLAG", rows[0].flag_id, "SUCCESS", req,
        { entity_type, entity_id, severity });
      res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  }
);

// GET /api/audit-logs/flags/entity-options?type=...
// IMPORTANT: defined BEFORE /flags/:id so Express doesn't match "entity-options" as a UUID param
router.get("/flags/entity-options", authenticate, authorize("AUDITOR"), async (req, res) => {
  const { type } = req.query;
  try {
    let rows = [];
    if (type === "QC_REPORT") {
      ({ rows } = await pgPool.query(
        `SELECT qr.qc_report_id AS id,
                CONCAT(qr.report_type, ' — ', di.serial_number, ' (', qr.current_status, ')') AS label
           FROM qc_report qr
           JOIN delivered_item di ON di.delivered_item_id = qr.delivered_item_id
          ORDER BY qr.created_at DESC LIMIT 200`
      ));
    } else if (type === "CERTIFICATION") {
      ({ rows } = await pgPool.query(
        `SELECT c.certification_id AS id,
                CONCAT(di.serial_number, ' — ', CASE WHEN c.is_immutable THEN 'APPROVED' ELSE 'PENDING' END) AS label
           FROM certification c
           JOIN delivered_item di ON di.delivered_item_id = c.delivered_item_id
          ORDER BY c.created_at DESC LIMIT 200`
      ));
    } else if (type === "SUPPLIER") {
      ({ rows } = await pgPool.query(
        `SELECT supplier_id AS id, business_name AS label FROM supplier ORDER BY business_name LIMIT 200`
      ));
    } else if (type === "SHIPMENT") {
      ({ rows } = await pgPool.query(
        `SELECT shipment_id AS id,
                CONCAT(tracking_number, ' — ', COALESCE(carrier_name, 'Unknown')) AS label
           FROM shipment ORDER BY created_at DESC LIMIT 200`
      ));
    } else if (type === "DELIVERED_ITEM") {
      ({ rows } = await pgPool.query(
        `SELECT di.delivered_item_id AS id,
                CONCAT(p.part_name, ' — S/N: ', di.serial_number) AS label
           FROM delivered_item di
           JOIN purchase_order_line pol ON pol.order_line_id = di.order_line_id
           JOIN supplier_part_offering spo ON spo.supplier_part_id = pol.supplier_part_id
           JOIN part p ON p.part_id = spo.part_id
          ORDER BY di.delivery_timestamp DESC LIMIT 200`
      ));
    } else {
      return res.status(400).json({ success: false, message: "Invalid type. Use: QC_REPORT, CERTIFICATION, SUPPLIER, SHIPMENT, DELIVERED_ITEM" });
    }
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/audit-logs/flags/:id
router.get("/flags/:id", authenticate, authorize("AUDITOR","SUPPLY_CHAIN_MANAGER"),
  [uuidParam("id")], validate,
  async (req, res) => {
    try {
      const { rows } = await pgPool.query(
        `SELECT f.*, u.full_name AS flagged_by_name, r.full_name AS resolved_by_name
           FROM non_compliance_flag f
           JOIN "user" u ON u.emp_id = f.flagged_by_emp_id
           LEFT JOIN "user" r ON r.emp_id = f.resolved_by_emp_id
          WHERE f.flag_id = $1`,
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ success: false, message: "Flag not found." });
      res.json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  }
);

// PATCH /api/audit-logs/flags/:id/resolve
router.patch("/flags/:id/resolve", authenticate, authorize("AUDITOR","SUPPLY_CHAIN_MANAGER"),
  [uuidParam("id"), body("resolution_note").notEmpty().trim(), body("status").isIn(["REVIEWED","RESOLVED"])],
  validate,
  async (req, res) => {
    const { resolution_note, status } = req.body;
    try {
      const { rows } = await pgPool.query(
        `UPDATE non_compliance_flag
            SET status = $2, resolution_note = $3,
                resolved_by_emp_id = $4, resolved_at = NOW(), updated_at = NOW()
          WHERE flag_id = $1 RETURNING *`,
        [req.params.id, status, resolution_note, req.user.emp_id]
      );
      if (!rows[0]) return res.status(404).json({ success: false, message: "Flag not found." });
      await logAudit(req.user.emp_id, "UPDATE", "NON_COMPLIANCE_FLAG", req.params.id, "SUCCESS", req, { status });
      res.json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  }
);

// GET /api/audit-logs/compliance-summary
router.get("/compliance-summary", authenticate, authorize("AUDITOR","SUPPLY_CHAIN_MANAGER"), async (req, res) => {
  try {
    const [bySeverity, byEntity, recent] = await Promise.all([
      pgPool.query(`SELECT severity, status, COUNT(*) AS count
                      FROM non_compliance_flag GROUP BY severity, status ORDER BY severity, status`),
      pgPool.query(`SELECT entity_type,
                           COUNT(*) AS total,
                           COUNT(*) FILTER (WHERE status = 'OPEN') AS open
                      FROM non_compliance_flag GROUP BY entity_type ORDER BY total DESC`),
      pgPool.query(`SELECT f.*, u.full_name AS flagged_by_name
                      FROM non_compliance_flag f
                      JOIN "user" u ON u.emp_id = f.flagged_by_emp_id
                     ORDER BY f.created_at DESC LIMIT 5`),
    ]);
    res.json({ success: true, data: {
      by_severity:  bySeverity.rows,
      by_entity:    byEntity.rows,
      recent_flags: recent.rows,
    }});
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;