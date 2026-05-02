// routes/auth.routes.js
const router  = require("express").Router();
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const { body } = require("express-validator");
const { pgPool }               = require("../config/db");
const { authenticate, logAudit } = require("../middleware/auth");
const { validate }             = require("../middleware/validate");
const { parseRoles }           = require("../middleware/helpers");

// POST /api/auth/login
router.post(
  "/login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  validate,
  async (req, res) => {
    const { email, password } = req.body;
    try {
      const { rows } = await pgPool.query(
        `SELECT u.emp_id, u.full_name, u.email, u.password_hash, u.is_active,
                ARRAY_AGG(r.role_name) AS roles
           FROM "user" u
           LEFT JOIN user_role ur ON ur.emp_id = u.emp_id
           LEFT JOIN role       r  ON r.role_id = ur.role_id
          WHERE u.email = $1
          GROUP BY u.emp_id`,
        [email]
      );
      const user = rows[0];
      if (!user || !user.is_active)
        return res.status(401).json({ success: false, message: "Invalid credentials." });

      if (!(await bcrypt.compare(password, user.password_hash || "")))
        return res.status(401).json({ success: false, message: "Invalid credentials." });

      const roles = parseRoles(user.roles);
      const token = jwt.sign(
        { emp_id: user.emp_id, email: user.email, roles },
        process.env.JWT_SECRET || "changeme",
        { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
      );

      await logAudit(user.emp_id, "LOGIN", "USER", user.emp_id, "SUCCESS", req);
      res.json({ success: true, token, user: { emp_id: user.emp_id, full_name: user.full_name, email: user.email, roles } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// POST /api/auth/logout
router.post("/logout", authenticate, async (req, res) => {
  await logAudit(req.user.emp_id, "LOGOUT", "USER", req.user.emp_id, "SUCCESS", req);
  res.json({ success: true, message: "Logged out." });
});

module.exports = router;
