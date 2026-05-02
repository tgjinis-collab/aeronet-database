// routes/certifications.routes.js
const router     = require("express").Router();
const { body }   = require("express-validator");
const { pgPool, getMongo } = require("../config/db");
const { authenticate, authorize, logAudit } = require("../middleware/auth");
const { validate }  = require("../middleware/validate");
const { uuidParam, uuidField } = require("../middleware/helpers");

// GET /api/certifications/:id
router.get("/:id", authenticate, [uuidParam("id")], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query("SELECT * FROM certification WHERE certification_id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Certification not found." });
    const mongoDB = getMongo();
    const mongoDoc = mongoDB
      ? await mongoDB.collection("certification_documents").findOne({ _pgRef: req.params.id })
      : null;
    await logAudit(req.user.emp_id, "VIEW", "CERTIFICATION", req.params.id, "SUCCESS", req);
    res.json({ success: true, data: { header: rows[0], document: mongoDoc } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/certifications
router.post("/", authenticate, authorize("QUALITY_INSPECTOR"),
  [uuidField("delivered_item_id")],
  validate,
  async (req, res) => {
    const { delivered_item_id } = req.body;
    const testResults        = Array.isArray(req.body.testResults) ? req.body.testResults : [{ testType: "General", result: "Pass" }];
    const materialTraceability = Array.isArray(req.body.materialTraceability) ? req.body.materialTraceability : [];
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [cert] } = await client.query(
        `INSERT INTO certification (delivered_item_id, is_immutable) VALUES ($1, false) RETURNING *`,
        [delivered_item_id]
      );
      await client.query("COMMIT");
      await logAudit(req.user.emp_id, "CREATE", "CERTIFICATION", cert.certification_id, "SUCCESS", req);

      // MongoDB best-effort
      const mongoDB  = getMongo();
      const mongoDoc = {
        certificationId:   cert.certification_id,
        _pgRef:            cert.certification_id,
        partId:            delivered_item_id,
        deliveredItemId:   delivered_item_id,
        certificationDate: new Date(),
        createdAt:         new Date(),
        inspector:         { _pgEmpId: req.user.emp_id },
        testResults,
        materialTraceability,
        approval:          null,
        is_immutable:      false,
      };
      if (mongoDB) {
        try {
          await mongoDB.collection("certification_documents").insertOne(mongoDoc);
          await pgPool.query("UPDATE certification SET mongo_doc_ref = $1 WHERE certification_id = $2",
            [`mongo:certification_documents:${cert.certification_id}`, cert.certification_id]);
        } catch (e) { console.warn("MongoDB cert insert (non-fatal):", e.message); }
      }

      res.status(201).json({ success: true, data: { header: cert, document: mongoDoc } });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ success: false, message: err.message });
    } finally { client.release(); }
  }
);

// POST /api/certifications/:id/approve
router.post("/:id/approve", authenticate, authorize("QUALITY_INSPECTOR"),
  [uuidParam("id"), body("digitalStamp").notEmpty().trim()],
  validate,
  async (req, res) => {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE certification SET is_immutable = true, approved_at = NOW(), approved_by_emp_id = $2
          WHERE certification_id = $1 AND is_immutable = false RETURNING *`,
        [req.params.id, req.user.emp_id]
      );
      if (!rows[0]) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Not found or already immutable." }); }
      await client.query("COMMIT");

      const mongoDB = getMongo();
      if (mongoDB) {
        try {
          await mongoDB.collection("certification_documents").updateOne(
            { _pgRef: req.params.id },
            { $set: { is_immutable: true, "approval.approvedAt": new Date(), "approval._pgEmpId": req.user.emp_id,
                      "approval.digitalStamp": req.body.digitalStamp, "approval.signatureMethod": "AeroNetB SecureSign v3" } }
          );
        } catch (e) { console.warn("MongoDB cert approve (non-fatal):", e.message); }
      }

      await logAudit(req.user.emp_id, "APPROVE", "CERTIFICATION", req.params.id, "SUCCESS", req);
      res.json({ success: true, data: rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err.message.includes("immutable")) return res.status(403).json({ success: false, message: err.message });
      res.status(500).json({ success: false, message: err.message });
    } finally { client.release(); }
  }
);

module.exports = router;
