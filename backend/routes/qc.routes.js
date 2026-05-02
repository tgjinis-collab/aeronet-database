// routes/qc.routes.js
const router     = require("express").Router();
const { body }   = require("express-validator");
const { pgPool, getMongo } = require("../config/db");
const { authenticate, authorize, logAudit } = require("../middleware/auth");
const { validate }  = require("../middleware/validate");
const { uuidParam, uuidField } = require("../middleware/helpers");

// GET /api/qc-reports
router.get("/", authenticate, async (req, res) => {
  try {
    const { status, delivered_item_id, report_type, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT qr.*, di.serial_number, di.batch_number
                 FROM qc_report qr JOIN delivered_item di ON di.delivered_item_id = qr.delivered_item_id
                WHERE 1=1`;
    const params = [];
    if (status)            { params.push(status);            sql += ` AND qr.current_status = $${params.length}`; }
    if (delivered_item_id) { params.push(delivered_item_id); sql += ` AND qr.delivered_item_id = $${params.length}`; }
    if (report_type)       { params.push(report_type);       sql += ` AND qr.report_type = $${params.length}`; }
    sql += ` ORDER BY qr.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pgPool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/qc-reports/:id
router.get("/:id", authenticate, [uuidParam("id")], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query("SELECT * FROM qc_report WHERE qc_report_id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "QC report not found." });
    const mongoDB = getMongo();
    const mongoDoc = (rows[0].mongo_doc_ref && mongoDB)
      ? await mongoDB.collection("qc_reports").findOne({ _pgRef: req.params.id })
      : null;
    await logAudit(req.user.emp_id, "VIEW", "QC_REPORT", req.params.id, "SUCCESS", req);
    res.json({ success: true, data: { header: rows[0], document: mongoDoc } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/qc-reports
router.post("/", authenticate, authorize("QUALITY_INSPECTOR"),
  [uuidField("delivered_item_id"),
   body("report_type").isIn(["VISUAL_INSPECTION","DIMENSIONAL_CHECK","NON_DESTRUCTIVE_TESTING","ENVIRONMENTAL_STRESS"])],
  validate,
  async (req, res) => {
    const { delivered_item_id, report_type, notes } = req.body;
    const results        = req.body.results || { notes: notes || "Pending" };
    const inspectionDate = req.body.inspectionDate || new Date().toISOString();
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [header] } = await client.query(
        `INSERT INTO qc_report (delivered_item_id, report_type, current_status) VALUES ($1,$2,'DRAFT') RETURNING *`,
        [delivered_item_id, report_type]
      );
      await client.query("COMMIT");
      await logAudit(req.user.emp_id, "CREATE", "QC_REPORT", header.qc_report_id, "SUCCESS", req, { report_type });

      // MongoDB best-effort — does NOT block the PG response
      const mongoDB  = getMongo();
      const mongoDoc = {
        reportId:        `QC-${header.qc_report_id.substring(0, 8).toUpperCase()}`,
        _pgRef:          header.qc_report_id,
        partId:          delivered_item_id,
        deliveredItemId: delivered_item_id,
        report_type,
        current_status:  "DRAFT",
        inspector:       { _pgEmpId: req.user.emp_id, employeeId: req.user.emp_id },
        inspectionDate,
        createdAt:  new Date(),
        updatedAt:  new Date(),
        results,
        notes:      notes || null,
        versions: [{ versionNo: 1, createdAt: new Date(), createdBy: { _pgEmpId: req.user.emp_id }, status: "DRAFT", summary: "Initial draft.", resultSnapshot: results }],
      };
      if (mongoDB) {
        try {
          await mongoDB.collection("qc_reports").insertOne(mongoDoc);
          await pgPool.query("UPDATE qc_report SET mongo_doc_ref = $1 WHERE qc_report_id = $2",
            [`mongo:qc_reports:${header.qc_report_id}`, header.qc_report_id]);
        } catch (e) { console.warn("MongoDB QC insert (non-fatal):", e.message); }
      }

      res.status(201).json({ success: true, data: { header, document: mongoDoc } });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ success: false, message: err.message });
    } finally { client.release(); }
  }
);

// PATCH /api/qc-reports/:id/status
router.patch("/:id/status", authenticate, authorize("QUALITY_INSPECTOR"),
  [uuidParam("id"), body("status").isIn(["SUBMITTED","APPROVED","REJECTED"]), body("summary").notEmpty().trim()],
  validate,
  async (req, res) => {
    const { status, summary, resultSnapshot } = req.body;
    try {
      const { rows } = await pgPool.query(
        `UPDATE qc_report SET current_status = $2 WHERE qc_report_id = $1 RETURNING *`,
        [req.params.id, status]
      );
      if (!rows[0]) return res.status(404).json({ success: false, message: "QC report not found." });

      const mongoDB = getMongo();
      if (mongoDB) {
        try {
          await mongoDB.collection("qc_reports").updateOne(
            { _pgRef: req.params.id },
            { $set: { current_status: status, updatedAt: new Date() },
              $push: { versions: { versionNo: Date.now(), createdAt: new Date(), createdBy: { _pgEmpId: req.user.emp_id }, status, summary, resultSnapshot: resultSnapshot || {} } } }
          );
        } catch (e) { console.warn("MongoDB QC update (non-fatal):", e.message); }
      }

      await logAudit(req.user.emp_id, "UPDATE", "QC_REPORT", req.params.id, "SUCCESS", req, { status });
      res.json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  }
);

module.exports = router;
