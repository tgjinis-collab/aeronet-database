// routes/dashboard.routes.js
const router   = require("express").Router();
const { pgPool, getMongo } = require("../config/db");
const { authenticate } = require("../middleware/auth");

// GET /api/dashboard/summary
router.get("/summary", authenticate, async (req, res) => {
  try {
    const [sup, parts, orders, ships, certs, qc] = await Promise.all([
      pgPool.query("SELECT COUNT(*) FROM supplier"),
      pgPool.query("SELECT COUNT(*) FROM part"),
      pgPool.query("SELECT COUNT(*) FROM purchase_order WHERE status NOT IN ('COMPLETED','CANCELLED')"),
      pgPool.query("SELECT COUNT(*) FROM shipment WHERE arrived_at IS NULL"),
      pgPool.query("SELECT COUNT(*) FROM certification WHERE is_immutable = true"),
      pgPool.query("SELECT current_status, COUNT(*) FROM qc_report GROUP BY current_status"),
    ]);
    res.json({
      success: true,
      data: {
        active_suppliers:     parseInt(sup.rows[0].count),
        total_parts:          parseInt(parts.rows[0].count),
        open_orders:          parseInt(orders.rows[0].count),
        in_transit_shipments: parseInt(ships.rows[0].count),
        approved_certs:       parseInt(certs.rows[0].count),
        qc_by_status:         Object.fromEntries(qc.rows.map((r) => [r.current_status, parseInt(r.count)])),
      },
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/dashboard/supplier-kpis
router.get("/supplier-kpis", authenticate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT s.supplier_id, s.business_name, s.accreditation,
              COUNT(po.order_id)                                          AS total_orders,
              COUNT(po.order_id) FILTER (WHERE po.status = 'COMPLETED')  AS completed_orders,
              ROUND(AVG(po.actual_delivery_date - po.desired_delivery_date)) AS avg_delay_days,
              COUNT(qr.qc_report_id)                                      AS total_qc_reports,
              COUNT(qr.qc_report_id) FILTER (WHERE qr.current_status = 'APPROVED') AS approved_qc
         FROM supplier s
         LEFT JOIN purchase_order po     ON po.supplier_id = s.supplier_id
         LEFT JOIN purchase_order_line pol ON pol.order_id = po.order_id
         LEFT JOIN delivered_item di    ON di.order_line_id = pol.order_line_id
         LEFT JOIN qc_report qr         ON qr.delivered_item_id = di.delivered_item_id
        GROUP BY s.supplier_id ORDER BY total_orders DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/dashboard/shipment-status
router.get("/shipment-status", authenticate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT sh.shipment_id, sh.tracking_number, sh.carrier_name, sh.port_of_entry,
              sh.dispatched_at, po.status AS order_status, s.business_name AS supplier_name
         FROM shipment sh
         JOIN purchase_order po ON po.order_id = sh.order_id
         JOIN supplier s ON s.supplier_id = po.supplier_id
        WHERE sh.arrived_at IS NULL ORDER BY sh.dispatched_at ASC`
    );
    const mongoDB   = getMongo();
    const enriched  = await Promise.all(
      rows.map(async (ship) => {
        const lastEvent = mongoDB
          ? await mongoDB.collection("shipment_events").findOne({ _pgShipmentRef: ship.shipment_id }, { sort: { timestamp: -1 } })
          : null;
        return { ...ship, last_event: lastEvent || null };
      })
    );
    res.json({ success: true, data: enriched });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/dashboard/qc-insights
router.get("/qc-insights", authenticate, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT qr.report_type, qr.current_status, COUNT(*) AS count, MAX(qr.created_at) AS latest
         FROM qc_report qr GROUP BY qr.report_type, qr.current_status ORDER BY qr.report_type`
    );
    const recentDrafts = await pgPool.query(
      `SELECT qr.*, di.serial_number FROM qc_report qr
         JOIN delivered_item di ON di.delivered_item_id = qr.delivered_item_id
        WHERE qr.current_status = 'DRAFT' ORDER BY qr.created_at DESC LIMIT 5`
    );
    res.json({ success: true, data: { breakdown: rows, pending_drafts: recentDrafts.rows } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/dashboard/iot-anomalies
router.get("/iot-anomalies", authenticate, async (req, res) => {
  try {
    const mongoDB  = getMongo();
    const anomalies = mongoDB
      ? await mongoDB.collection("sensor_readings").find({ anomaly: true }).sort({ timestamp: -1 }).limit(20).toArray()
      : [];
    res.json({ success: true, count: anomalies.length, data: anomalies });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
