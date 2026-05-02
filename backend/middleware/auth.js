// middleware/auth.js — JWT authentication + RBAC authorization
require("dotenv").config();
const jwt    = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { pgPool }     = require("../config/db");
const { parseRoles } = require("./helpers");

// Verify JWT on every protected route
const authenticate = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer "))
    return res.status(401).json({ success: false, message: "No token provided." });

  try {
    req.user = jwt.verify(
      header.split(" ")[1],
      process.env.JWT_SECRET || "changeme"
    );
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired token." });
  }
};

// Check user holds at least one of the required roles
const authorize = (...roles) => (req, res, next) => {
  const userRoles = req.user?.roles || [];
  if (!roles.some((r) => userRoles.includes(r)))
    return res.status(403).json({ success: false, message: "Access denied." });
  next();
};

// Write an audit entry — non-blocking, failures are only logged
async function logAudit(empId, actionType, entityType, entityId, outcome = "SUCCESS", req = {}, detail = null) {
  try {
    await pgPool.query(
      `INSERT INTO audit_log (emp_id, action_type, entity_type, entity_id, outcome, ip_address, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [empId, actionType, entityType, String(entityId), outcome,
       req.ip || null, detail ? JSON.stringify(detail) : null]
    );
  } catch (err) {
    console.error("Audit log failed:", err.message);
  }
}

module.exports = { authenticate, authorize, logAudit, bcrypt, jwt, parseRoles };
