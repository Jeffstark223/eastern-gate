/* =========================================================================
   Eastern Gate — public (customer) API

   No login: a customer at a table scans the QR code and orders. Because
   these routes are open to anyone with the link, they are deliberately
   narrow:
     - the menu is read-only and exposes only what a customer needs
       (no who-marked-it-finished, no internal ids beyond item ids);
     - an order is accepted only for a real, active table (found by the
       opaque QR id), and is always priced on the server from the live menu;
     - a small in-memory rate limit stops one device from flooding the
       seller screen with orders.
   Customers only ever see their own order, via the unguessable trackKey
   returned when they place it.
   ========================================================================= */

const express = require('express');
const { getData, persist } = require('../lib/db');
const { computeStatus } = require('../lib/menuStatus');
const { createCustomerOrder } = require('../lib/orders');
const { ok, created, fail, asyncHandler } = require('../lib/respond');

const router = express.Router();

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store'); // the menu must always reflect right now
  next();
});

/* ------------------------------ rate limit ------------------------------ */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ORDERS_PER_WINDOW = 8;
const hits = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_ORDERS_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    const recent = list.filter((t) => now - t < WINDOW_MS);
    if (recent.length) hits.set(ip, recent);
    else hits.delete(ip);
  }
}, WINDOW_MS).unref();

/* -------------------------------- helpers ------------------------------- */
function findTable(data, qrId) {
  if (!qrId || typeof qrId !== 'string') return null;
  return data.tables.find((t) => t.qrId === qrId) || null;
}

/* --------------------------------- menu --------------------------------- */
// GET /api/public/menu
// Today's menu straight from the same data the Admin and Sellers use.
// Items the Admin switched off are left out entirely; items a seller marked
// finished today are included, flagged "finished", so the customer can see
// them but not order them.
router.get(
  '/menu',
  asyncHandler(async (req, res) => {
    const data = getData();
    const items = data.menu
      .map((m) => ({ m, status: computeStatus(m) }))
      .filter((x) => x.status !== 'unavailable')
      .map(({ m, status }) => ({
        id: m.id,
        type: m.type,
        name: m.name,
        price: m.type === 'soup' ? 0 : Number(m.price) || 0,
        pricingType: m.pricingType === 'unit' ? 'unit' : 'fixed',
        unitName: m.pricingType === 'unit' ? m.unitName : null,
        status // "available" | "finished"
      }));
    ok(res, { restaurantName: data.settings.restaurantName, currency: data.settings.currency, items });
  })
);

/* -------------------------------- tables -------------------------------- */
// GET /api/public/table/:qrId — who is this QR code for?
router.get(
  '/table/:qrId',
  asyncHandler(async (req, res) => {
    const table = findTable(getData(), req.params.qrId);
    if (!table) return fail(res, 404, 'This QR code is not recognised. Please ask a staff member for help.');
    if (!table.active) return fail(res, 403, 'This table is not taking orders right now.');
    ok(res, { number: table.number, name: table.name });
  })
);

/* -------------------------------- orders -------------------------------- */
// POST /api/public/orders  { table: <qrId>, items: [{foodId, soupId, proteinId, quantity}] }
router.post(
  '/orders',
  asyncHandler(async (req, res) => {
    const data = getData();
    const table = findTable(data, req.body.table);
    if (!table) return fail(res, 404, 'This QR code is not recognised. Please ask a staff member for help.');
    if (!table.active) return fail(res, 403, 'This table is not taking orders right now.');
    if (rateLimited(req.ip)) {
      return fail(res, 429, 'Too many orders from this device. Please ask a staff member for help.');
    }

    let order;
    try {
      order = createCustomerOrder(data, table, req.body.items);
    } catch (err) {
      return fail(res, err.status || 400, err.message);
    }
    await persist();
    created(
      res,
      {
        orderId: order.orderId,
        trackKey: order.trackKey,
        tableName: order.tableName,
        total: order.total,
        status: order.status,
        createdAt: order.createdAt,
        items: order.items
      },
      'Order placed.'
    );
  })
);

// GET /api/public/orders/:orderId?key=<trackKey> — the customer's own order status
router.get(
  '/orders/:orderId',
  asyncHandler(async (req, res) => {
    const order = getData().orders.find((o) => o.orderId === req.params.orderId);
    if (!order || !req.query.key || order.trackKey !== req.query.key) return fail(res, 404, 'Order not found.');
    ok(res, {
      orderId: order.orderId,
      tableName: order.tableName,
      total: order.total,
      status: order.status,
      createdAt: order.createdAt,
      items: order.items
    });
  })
);

module.exports = router;
