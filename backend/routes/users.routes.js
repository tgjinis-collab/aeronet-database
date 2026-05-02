// routes/users.routes.js
const router   = require("express").Router();
const { body } = require("express-validator");
const bcrypt   = require("bcryptjs");
const { pgPool }               = require("../config/db");
const { authenticate, authorize, logAudit } = require("../middleware/auth");
const { validate }             = require("../middleware/validate");
const { parseRoles, deriveAccessLevel } = require("../middleware/helpers");

// GET /api/users/me
router.get("/me", authenticate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT u.emp_id, u.full_name, u.email, u.job_title, u.department, ARRAY_AGG(r.role_name) AS roles
         FROM "user" u
         LEFT JOIN user_role ur ON ur.emp_id = u.emp_id
         LEFT JOIN role       r  ON r.role_id  = ur.role_id
        WHERE u.emp_id = $1 GROUP BY u.emp_id`,
      [req.user.emp_id]
    );
    const user = rows[0];
    if (user) { user.roles = parseRoles(user.roles); user.access_level = deriveAccessLevel(user.roles); }
    res.json({ success: true, data: user });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/users
router.get("/", authenticate, authorize("SUPPLY_CHAIN_MANAGER", "AUDITOR"), async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT u.emp_id, u.full_name, u.email, u.job_title, u.department, u.is_active, ARRAY_AGG(r.role_name) AS roles
         FROM "user" u
         LEFT JOIN user_role ur ON ur.emp_id = u.emp_id
         LEFT JOIN role       r  ON r.role_id  = ur.role_id
        GROUP BY u.emp_id ORDER BY u.full_name`
    );
    const users = rows.map(u => ({ ...u, roles: parseRoles(u.roles), access_level: deriveAccessLevel(u.roles) }));
    res.json({ success: true, data: users });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/users
router.post("/", authenticate,
  [body("full_name").notEmpty().trim(), body("email").isEmail().normalizeEmail(),
   body("password").isLength({ min: 8 }),
   body("role").isIn(["PROCUREMENT_OFFICER","QUALITY_INSPECTOR","SUPPLY_CHAIN_MANAGER","EQUIPMENT_ENGINEER","AUDITOR"])],
  validate,
  async (req, res) => {
    const { full_name, email, password, job_title, department, phone, role } = req.body;
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const hash = await bcrypt.hash(password, 12);
      const { rows: [user] } = await client.query(
        `INSERT INTO "user" (full_name, email, password_hash, job_title, department, phone)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING emp_id, full_name, email, job_title, department`,
        [full_name, email, hash, job_title || null, department || null, phone || null]
      );
      await client.query(`INSERT INTO user_role (emp_id, role_id) SELECT $1, role_id FROM role WHERE role_name = $2`, [user.emp_id, role]);
      await client.query("COMMIT");
      await logAudit(req.user.emp_id, "CREATE", "USER", user.emp_id, "SUCCESS", req, { role });
      res.status(201).json({ success: true, data: { ...user, role } });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err.code === "23505") return res.status(409).json({ success: false, message: "Email already exists." });
      res.status(500).json({ success: false, message: err.message });
    } finally { client.release(); }
  }
);

module.exports = router;
