// middleware/helpers.js — Shared utility functions

// Parse roles — ARRAY_AGG returns "{ROLE}" string; normalize to array always
function parseRoles(r) {
  if (!r) return [];
  if (Array.isArray(r)) return r.filter(Boolean);
  return String(r).replace(/^{|}$/g, "").split(",").filter(Boolean);
}

// Derive access level from roles for display in Users table
function deriveAccessLevel(roles) {
  const r = parseRoles(roles);
  if (r.includes("AUDITOR"))              return "AUDIT";
  if (r.includes("QUALITY_INSPECTOR"))    return "APPROVE";
  if (r.includes("SUPPLY_CHAIN_MANAGER")) return "READ_WRITE";
  if (r.includes("PROCUREMENT_OFFICER"))  return "WRITE";
  if (r.includes("EQUIPMENT_ENGINEER"))   return "WRITE";
  return "READ";
}

// Custom UUID validator — accepts any 8-4-4-4-12 hex pattern
// (seed UUIDs use version 0 which isUUID() rejects)
const isUUIDlike = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const { body, param } = require("express-validator");
const uuidField  = (field) =>
  body(field).custom(isUUIDlike).withMessage(`${field} must be a valid UUID`);
const uuidParam  = (field) =>
  param(field).custom(isUUIDlike).withMessage(`${field} must be a valid UUID`);

module.exports = { parseRoles, deriveAccessLevel, isUUIDlike, uuidField, uuidParam };
