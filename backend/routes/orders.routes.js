// routes/orders.routes.js
const router     = require("express").Router();
const { body }   = require("express-validator");
const { pgPool } = require("../config/db");
const { authenticate, authorize, logAudit } = require("../middleware/auth");
const { validate }  = require("../middleware/validate");
const { uuidParam, uuidField } = require("../middleware/helpers");

// GET /api/orders
router.get("/", authenticate, async (req, res) => {
  try {
    const { status, supplier_id, from, to, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT po.*, s.business_name AS supplier_name
                 FROM purchase_order po JOIN supplier s ON s.supplier_id = po.supplier_id
                WHERE 1=1`;
    const params = [];
    if (status)      { params.push(status);      sql += ` AND po.status = $${params.length}`; }
    if (supplier_id) { params.push(supplier_id); sql += ` AND po.supplier_id = $${params.length}`; }
    if (from)        { params.push(from);         sql += ` AND po.order_date >= $${params.length}`; }
    if (to)          { params.push(to);           sql += ` AND po.order_date <= $${params.length}`; }
    sql += ` ORDER BY po.order_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pgPool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/orders/:id
router.get("/:id", authenticate, [uuidParam("id")], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT po.*, s.business_name AS supplier_name
         FROM purchase_order po JOIN supplier s ON s.supplier_id = po.supplier_id
        WHERE po.order_id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "Order not found." });
    await logAudit(req.user.emp_id, "VIEW", "PURCHASE_ORDER", req.params.id, "SUCCESS", req);
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/orders
router.post("/", authenticate, authorize("PROCUREMENT_OFFICER"),
  [uuidField("supplier_id"), body("order_date").optional(), body("desired_delivery_date").optional()],
  validate,
  async (req, res) => {
    const { supplier_id, order_date, desired_delivery_date } = req.body;
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [order] } = await client.query(
        `INSERT INTO purchase_order (supplier_id, order_date, desired_delivery_date, created_by_emp_id)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [supplier_id, order_date || new Date(), desired_delivery_date || null, req.user.emp_id]
      );
      const insertedLines = [];
      for (const line of lines) {
        if (!line.supplier_part_id) continue;
        try {
          const { rows: [ol] } = await client.query(
            `INSERT INTO purchase_order_line (order_id, supplier_part_id, quantity, unit_price_usd)
             VALUES ($1,$2,$3,$4) RETURNING *`,
            [order.order_id, line.supplier_part_id, line.quantity || 1, line.unit_price_usd || null]
          );
          insertedLines.push(ol);
        } catch (lineErr) { console.warn("Skipping line:", lineErr.message); }
      }
      await client.query("COMMIT");
      await logAudit(req.user.emp_id, "CREATE", "PURCHASE_ORDER", order.order_id, "SUCCESS", req, { supplier_id });
      res.status(201).json({ success: true, data: { order, lines: insertedLines } });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ success: false, message: err.message });
    } finally { client.release(); }
  }
);

// PATCH /api/orders/:id/status
router.patch("/:id/status", authenticate, authorize("PROCUREMENT_OFFICER", "SUPPLY_CHAIN_MANAGER"),
  [uuidParam("id"), body("status").isIn(["PLACED","CONFIRMED","DISPATCHED","DELIVERED","COMPLETED","CANCELLED"])],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pgPool.query(
        `UPDATE purchase_order SET status = $2 WHERE order_id = $1 RETURNING *`,
        [req.params.id, req.body.status]
      );
      if (!rows[0]) return res.status(404).json({ success: false, message: "Order not found." });
      await logAudit(req.user.emp_id, "UPDATE", "PURCHASE_ORDER", req.params.id, "SUCCESS", req, { status: req.body.status });
      res.json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  }
);

// GET /api/orders/:id/lines
router.get("/:id/lines", authenticate, [uuidParam("id")], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT pol.*, spo.customisation_summary, p.part_name
         FROM purchase_order_line pol
         JOIN supplier_part_offering spo ON spo.supplier_part_id = pol.supplier_part_id
         JOIN part p ON p.part_id = spo.part_id
        WHERE pol.order_id = $1`, [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
