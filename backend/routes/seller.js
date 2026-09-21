const express = require('express');
const { getData, persist } = require('../lib/db');
const { nextTransactionId } = require('../lib/ids');
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

  const now = new Date();
  const transactionId = nextTransactionId(data, now);

  const sale = {
    transactionId,
    sellerId: req.user.id,
    sellerName: req.user.fullName,
    items: priced.items,
    subtotal: priced.subtotal,
    total: priced.total,
    paymentMethod,
    status: 'completed',
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 16),
    createdAt: now.toISOString(),
    cancelledAt: null
  };

  data.sales.push(sale);
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
