const express = require('express');
const { getData, persist } = require('../lib/db');
const { recordSale } = require('../lib/sales');
const { ACTIVE, changeOrderStatus, staffView } = require('../lib/orders');
const { priceCart, findMenuItem } = require('../lib/pricing');
const { computeStatus, todayStr, withStatus } = require('../lib/menuStatus');
const { ok, created, fail, asyncHandler } = require('../lib/respond');

const router = express.Router();

// POST /api/seller/menu/:id/finish
// A seller marks an item finished for *today only* — separate from the
// Admin's own "available" flag (see lib/menuStatus.js). This never
// deletes or permanently disables the menu item: it just records today's
// date and who marked it, so the status naturally stops applying once the
// date rolls over. Visible immediately to every other seller and to the
// Admin, since everyone reads the same data.json through GET /api/menu.
router.patch(
  '/menu/:id/finish',
  asyncHandler(async (req, res) => {
    const data = getData();
    const item = findMenuItem(data, req.params.id);
    if (!item) return fail(res, 404, 'Menu item not found.');

    const today = todayStr();
    const status = computeStatus(item, today);
    if (status === 'unavailable') {
      return fail(res, 400, `${item.name} is not on today's menu.`);
    }
    if (status === 'finished') {
      return ok(res, withStatus(item, today), `${item.name} is already marked finished for today.`);
    }

    item.finishedDate = today;
    item.finishedBy = req.user.fullName;
    await persist();
    ok(res, withStatus(item, today), `${item.name} marked finished for today.`);
  })
);

// GET /api/seller/orders
// Customer (QR table) orders that still need work — new, preparing or ready —
// oldest first so the longest-waiting table is at the top. Shared by every
// seller: whoever is on shift sees the same list.
router.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const data = getData();
    const list = data.orders
      .filter((o) => ACTIVE.includes(o.status))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map(staffView);
    ok(res, list);
  })
);

// PATCH /api/seller/orders/:id/status  { status, paymentMethod? }
// new -> preparing -> ready -> completed (or cancelled). Completing needs the
// payment method the seller actually received, and records a normal sale.
router.patch(
  '/orders/:id/status',
  asyncHandler(async (req, res) => {
    const data = getData();
    const order = data.orders.find((o) => o.orderId === req.params.id);
    if (!order) return fail(res, 404, 'Order not found.');
    try {
      changeOrderStatus(data, order, req.body.status, req.user, req.body.paymentMethod);
    } catch (err) {
      return fail(res, err.status || 400, err.message);
    }
    await persist();
    ok(res, staffView(order), 'Order updated.');
  })
);

// POST /api/sales  { items: [{itemId, quantity}], paymentMethod }
// Mounted separately at /api/sales — see server.js.
async function createSale(req, res) {
  const data = getData();
  const paymentMethod = req.body.paymentMethod;
  if (paymentMethod !== 'cash' && paymentMethod !== 'momo') {
    return fail(res, 400, 'Choose a payment method to continue.');
  }

  let priced;
  try {
    priced = priceCart(data, req.body.items);
  } catch (err) {
    return fail(res, err.status || 400, err.message);
  }

  const sale = recordSale(data, { seller: { id: req.user.id, fullName: req.user.fullName }, priced, paymentMethod });

  await persist();
  created(res, sale, 'Sale created successfully.');
}

// GET /api/sales/my — mounted separately at /api/sales.
async function getMyHistory(req, res) {
  const data = getData();
  const mine = data.sales
    .filter((s) => s.sellerId === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  ok(res, mine);
}

module.exports = { router, createSale: asyncHandler(createSale), getMyHistory: asyncHandler(getMyHistory) };
