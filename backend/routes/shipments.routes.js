// routes/shipments.routes.js
const router     = require("express").Router();
const { body }   = require("express-validator");
const { pgPool, getMongo } = require("../config/db");
const { authenticate, authorize, logAudit } = require("../middleware/auth");
const { validate }  = require("../middleware/validate");
const { uuidParam, uuidField } = require("../middleware/helpers");

// GET /api/shipments
router.get("/", authenticate, async (req, res) => {
  try {
    const { order_id, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT s.*, po.status AS order_status FROM shipment s JOIN purchase_order po ON po.order_id = s.order_id WHERE 1=1`;
    const params = [];
    if (order_id) { params.push(order_id); sql += ` AND s.order_id = $1`; }
    sql += ` ORDER BY s.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pgPool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/shipments/:id
router.get("/:id", authenticate, [uuidParam("id")], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT s.*, po.supplier_id FROM shipment s JOIN purchase_order po ON po.order_id = s.order_id WHERE s.shipment_id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "Shipment not found." });
    await logAudit(req.user.emp_id, "VIEW", "SHIPMENT", req.params.id, "SUCCESS", req);
    res.json({ success: true, data: rows[0] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/shipments
router.post("/", authenticate, authorize("PROCUREMENT_OFFICER", "SUPPLY_CHAIN_MANAGER"),
  [uuidField("order_id"), body("tracking_number").notEmpty().trim()],
  validate,
  async (req, res) => {
    const { order_id, tracking_number, port_of_entry, carrier_name } = req.body;
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO shipment (order_id, tracking_number, port_of_entry, carrier_name)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [order_id, tracking_number, port_of_entry || null, carrier_name || null]
      );
      await logAudit(req.user.emp_id, "CREATE", "SHIPMENT", rows[0].shipment_id, "SUCCESS", req, { tracking_number });
      res.status(201).json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  }
);

// GET /api/shipments/:id/events  (MongoDB)
router.get("/:id/events", authenticate, [uuidParam("id")], validate, async (req, res) => {
  try {
    const mongoDB = getMongo();
    const events = mongoDB
      ? await mongoDB.collection("shipment_events").find({ _pgShipmentRef: req.params.id }).sort({ timestamp: 1 }).toArray()
      : [];
    res.json({ success: true, data: events });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/shipments/:id/events  (MongoDB)
router.post("/:id/events", authenticate, authorize("SUPPLY_CHAIN_MANAGER", "PROCUREMENT_OFFICER"),
  [uuidParam("id"), body("eventType").isIn(["CHECKPOINT","CONDITION_UPDATE"]), body("location").notEmpty()],
  validate,
  async (req, res) => {
    const mongoDB = getMongo();
    if (!mongoDB) return res.status(503).json({ success: false, message: "MongoDB unavailable." });
    try {
      const doc = {
        _pgShipmentRef: req.params.id,
        trackingNumber: req.body.trackingNumber || null,
        eventType:      req.body.eventType,
        timestamp:      new Date(),
        location:       req.body.location,
        containerCondition: req.body.containerCondition || {},
        notes:          req.body.notes || null,
        loggedBy:       req.user.emp_id,
      };
      const result = await mongoDB.collection("shipment_events").insertOne(doc);
      await logAudit(req.user.emp_id, "CREATE", "SHIPMENT_EVENT", req.params.id, "SUCCESS", req, { eventType: doc.eventType });
      res.status(201).json({ success: true, data: { _id: result.insertedId, ...doc } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  }
);

// GET /api/shipments/:id/items
router.get("/:id/items", authenticate, [uuidParam("id")], validate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT di.*, pol.quantity, p.part_name
         FROM delivered_item di
         JOIN purchase_order_line pol ON pol.order_line_id = di.order_line_id
         JOIN supplier_part_offering spo ON spo.supplier_part_id = pol.supplier_part_id
         JOIN part p ON p.part_id = spo.part_id
        WHERE di.shipment_id = $1`, [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/delivered-items — for QC/cert form dropdowns
router.get("/delivered-items/all", authenticate, async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const { rows } = await pgPool.query(
      `SELECT di.delivered_item_id, di.serial_number, di.batch_number, di.shipment_id,
              di.delivery_timestamp, p.part_name, sh.tracking_number, s.business_name AS supplier_name
         FROM delivered_item di
         JOIN purchase_order_line pol ON pol.order_line_id = di.order_line_id
         JOIN supplier_part_offering spo ON spo.supplier_part_id = pol.supplier_part_id
         JOIN part p ON p.part_id = spo.part_id
         LEFT JOIN shipment sh ON sh.shipment_id = di.shipment_id
         LEFT JOIN purchase_order po ON po.order_id = sh.order_id
         LEFT JOIN supplier s ON s.supplier_id = po.supplier_id
        ORDER BY di.delivery_timestamp DESC LIMIT $1 OFFSET $2`,
      [Number(limit), Number(offset)]
    );
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
