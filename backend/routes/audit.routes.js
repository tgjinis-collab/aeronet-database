// routes/audit.routes.js
const router   = require("express").Router();
const { pgPool }               = require("../config/db");
const { authenticate, logAudit } = require("../middleware/auth");

// GET /api/audit-logs
router.get("/", authenticate, async (req, res) => {
  try {
    const { emp_id, entity_type, entity_id, action_type, from, to, limit = 100, offset = 0 } = req.query;
    let sql = `SELECT al.*, u.full_name, u.email FROM audit_log al LEFT JOIN "user" u ON u.emp_id = al.emp_id WHERE 1=1`;
    const params = [];
    if (emp_id)      { params.push(emp_id);      sql += ` AND al.emp_id = $${params.length}`; }
    if (entity_type) { params.push(entity_type); sql += ` AND al.entity_type = $${params.length}`; }
    if (entity_id)   { params.push(entity_id);   sql += ` AND al.entity_id = $${params.length}`; }
    if (action_type) { params.push(action_type); sql += ` AND al.action_type = $${params.length}`; }
    if (from)        { params.push(from);         sql += ` AND al.created_at >= $${params.length}`; }
    if (to)          { params.push(to);           sql += ` AND al.created_at <= $${params.length}`; }
    sql += ` ORDER BY al.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pgPool.query(sql, params);
    await logAudit(req.user.emp_id, "VIEW", "AUDIT_LOGS", "LIST", "SUCCESS", req);
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
