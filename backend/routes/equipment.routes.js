// routes/equipment.routes.js
const router     = require("express").Router();
const { body }   = require("express-validator");
const { pgPool, getMongo } = require("../config/db");
const { authenticate, authorize, logAudit } = require("../middleware/auth");
const { validate }  = require("../middleware/validate");
const { uuidParam, uuidField } = require("../middleware/helpers");

// GET /api/equipment
router.get("/", authenticate, async (req, res) => {
  try {
    const { rows } = await pgPool.query("SELECT * FROM equipment WHERE is_active = true ORDER BY equipment_name");
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/equipment/:id
router.get("/:id", authenticate, [uuidParam("id")], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query("SELECT * FROM equipment WHERE equipment_id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: "Equipment not found." });
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/equipment
router.post("/", authenticate, authorize("EQUIPMENT_ENGINEER"),
  [body("equipment_name").notEmpty().trim(), body("equipment_type").notEmpty().trim()],
  validate,
  async (req, res) => {
    const { equipment_name, facility_plant, equipment_type, manufacturer, model_number, install_date } = req.body;
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO equipment (equipment_name, facility_plant, equipment_type, manufacturer, model_number, install_date)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [equipment_name, facility_plant || null, equipment_type, manufacturer || null, model_number || null, install_date || null]
      );
      await logAudit(req.user.emp_id, "CREATE", "EQUIPMENT", rows[0].equipment_id, "SUCCESS", req);
      res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  }
);

// GET /api/equipment/:id/readings  (MongoDB)
router.get("/:id/readings", authenticate, authorize("EQUIPMENT_ENGINEER","SUPPLY_CHAIN_MANAGER"),
  [uuidParam("id")], validate,
  async (req, res) => {
    try {
      const mongoDB = getMongo();
      const { from, to, anomaly_only, limit = 100 } = req.query;
      const filter = { assignedToId: req.params.id };
      if (from || to) { filter.timestamp = {}; if (from) filter.timestamp.$gte = new Date(from); if (to) filter.timestamp.$lte = new Date(to); }
      if (anomaly_only === "true") filter.anomaly = true;
      const readings = mongoDB
        ? await mongoDB.collection("sensor_readings").find(filter).sort({ timestamp: -1 }).limit(Number(limit)).toArray()
        : [];
      res.json({ success: true, count: readings.length, data: readings });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  }
);

// GET /api/equipment/:id/devices
router.get("/:id/devices", authenticate, [uuidParam("id")], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT * FROM iot_device WHERE assigned_to_type = 'EQUIPMENT' AND assigned_to_id = $1`, [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/sensor-readings  (MongoDB)
router.post("/sensor-readings", authenticate, authorize("EQUIPMENT_ENGINEER"),
  [uuidField("deviceId"), uuidField("assignedToId"), body("assignedToType").isIn(["EQUIPMENT","SHIPMENT","CONTAINER"])],
  validate,
  async (req, res) => {
    const mongoDB = getMongo();
    if (!mongoDB) return res.status(503).json({ success: false, message: "MongoDB unavailable." });
    try {
      const doc = { ...req.body, timestamp: new Date(), anomaly: req.body.anomaly || false };
      const result = await mongoDB.collection("sensor_readings").insertOne(doc);
      res.status(201).json({ success: true, data: { _id: result.insertedId, ...doc } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  }
);

module.exports = router;
