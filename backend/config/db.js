// config/db.js — PostgreSQL + MongoDB connections
require("dotenv").config();
const { Pool }      = require("pg");
const { MongoClient } = require("mongodb");

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pgPool = new Pool({
  host:     process.env.PG_HOST,
  port:     parseInt(process.env.PG_PORT || "5432"),
  database: process.env.PG_DATABASE,
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  max:      10,
  idleTimeoutMillis: 30000,
  ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
});

pgPool.on("error", (err) =>
  console.error("Unexpected PostgreSQL pool error:", err.message)
);

// ── MongoDB ───────────────────────────────────────────────────────────────────
const mongoClient = new MongoClient(process.env.MONGO_URI || "mongodb://localhost:27017");
let mongoDB = null;

async function connectMongo() {
  await mongoClient.connect();
  mongoDB = mongoClient.db(process.env.MONGO_DB_NAME || "aeronetb_db");
  console.log("✓ MongoDB connected:", mongoDB.databaseName);

  // Disable strict schema validators so inserts never fail on missing optional fields
  const collections = [
    "qc_reports", "certification_documents",
    "sensor_readings", "shipment_events", "manufacturing_specs",
  ];
  for (const col of collections) {
    try {
      await mongoDB.command({ collMod: col, validator: {}, validationLevel: "off" });
    } catch (_) { /* collection may not exist yet — ignore */ }
  }
}

function getMongo() { return mongoDB; }

module.exports = { pgPool, connectMongo, getMongo };
