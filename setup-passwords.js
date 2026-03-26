// setup-passwords.js
// Run this ONCE to add password_hash column and set default passwords
// Usage: node setup-passwords.js
// Default password for all users: AeroNet2025

require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const pool = new Pool({
  host:     process.env.PG_HOST     || "ep-round-credit-agupbcie-pooler.c-2.eu-central-1.aws.neon.tech",
  port:     parseInt(process.env.PG_PORT || "5432"),
  database: process.env.PG_DATABASE || "aeronetsql",
  user:     process.env.PG_USER     || "neondb_owner",
  password: process.env.PG_PASSWORD || "npg_k5Z2UJTWFblm",
  ssl: (process.env.PG_SSL === "true") ? { rejectUnauthorized: false } : false,
});

async function setup() {
  const client = await pool.connect();
  try {
    console.log("Connected to PostgreSQL...");

    // 1. Add password_hash column if it doesn't exist
    await client.query(`
      ALTER TABLE "user"
      ADD COLUMN IF NOT EXISTS password_hash TEXT;
    `);
    console.log("✓ password_hash column ready");

    // 2. Hash the default password
    const hash = await bcrypt.hash("AeroNet2025", 12);
    console.log("✓ Password hashed");

    // 3. Set password for all existing users
    const result = await client.query(`
      UPDATE "user" SET password_hash = $1
      WHERE password_hash IS NULL
      RETURNING full_name, email
    `, [hash]);

    console.log(`✓ Passwords set for ${result.rowCount} users:`);
    result.rows.forEach(u => console.log(`   ${u.full_name} — ${u.email}`));

    console.log("\n✅ Setup complete!");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Login credentials for all users:");
    console.log("Password: AeroNet2025");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Emails:");
    console.log("  s.mitchell@aeronetb.com  (Procurement Officer)");
    console.log("  j.doe@aeronetb.com       (Quality Inspector)");
    console.log("  a.khan@aeronetb.com      (Quality Inspector)");
    console.log("  j.smith@aeronetb.com     (Supply Chain Manager)");
    console.log("  l.tremblay@aeronetb.com  (Equipment Engineer)");
    console.log("  d.okafor@aeronetb.com    (Auditor)");

  } catch (err) {
    console.error("Setup failed:", err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

setup();
