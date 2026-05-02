// routes/suppliers.routes.js
const router     = require("express").Router();
const { body }   = require("express-validator");
const { pgPool } = require("../config/db");
const { authenticate, authorize, logAudit } = require("../middleware/auth");
const { validate }    = require("../middleware/validate");
const { uuidParam }   = require("../middleware/helpers");

// GET /api/suppliers
router.get("/", authenticate, async (req, res) => {
  try {
    const { accreditation, search, limit = 50, offset = 0 } = req.query;
    let sql = "SELECT * FROM supplier WHERE 1=1";
    const params = [];
    if (accreditation) { params.push(accreditation); sql += ` AND accreditation = $${params.length}`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (business_name ILIKE $${params.length} OR contact_email ILIKE $${params.length})`; }
    sql += ` ORDER BY business_name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pgPool.query(sql, params);
    await logAudit(req.user.emp_id, "VIEW", "SUPPLIER", "LIST", "SUCCESS", req);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/suppliers/:id
router.get("/:id", authenticate, [uuidParam("id")], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query("SELECT * FROM supplier WHERE supplier_id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Supplier not found." });
    await logAudit(req.user.emp_id, "VIEW", "SUPPLIER", req.params.id, "SUCCESS", req);
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/suppliers
router.post("/", authenticate, authorize("PROCUREMENT_OFFICER"),
  [body("business_name").notEmpty().trim(), body("address").notEmpty().trim(), body("contact_email").isEmail().normalizeEmail()],
  validate,
  async (req, res) => {
    const { business_name, address, contact_name, contact_email, contact_phone, accreditation } = req.body;
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO supplier (business_name, address, contact_name, contact_email, contact_phone, accreditation)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [business_name, address, contact_name || null, contact_email, contact_phone || null, accreditation || "PENDING"]
      );
      await logAudit(req.user.emp_id, "CREATE", "SUPPLIER", rows[0].supplier_id, "SUCCESS", req, { business_name });
      res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  }
);

// PUT /api/suppliers/:id
router.put("/:id", authenticate, authorize("PROCUREMENT_OFFICER"), [uuidParam("id")], validate, async (req, res) => {
  const allowed = ["business_name","address","contact_name","contact_email","contact_phone","accreditation"];
  const fields  = Object.keys(req.body).filter((k) => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ success: false, message: "No valid fields to update." });
  const sets   = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
  const values = [req.params.id, ...fields.map((f) => req.body[f])];
  try {
    const { rows } = await pgPool.query(`UPDATE supplier SET ${sets} WHERE supplier_id = $1 RETURNING *`, values);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Supplier not found." });
    await logAudit(req.user.emp_id, "UPDATE", "SUPPLIER", req.params.id, "SUCCESS", req, req.body);
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/suppliers/:id/parts
router.get("/:id/parts", authenticate, [uuidParam("id")], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT spo.*, p.part_name, p.description
         FROM supplier_part_offering spo
         JOIN part p ON p.part_id = spo.part_id
        WHERE spo.supplier_id = $1 AND spo.is_active = true`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
