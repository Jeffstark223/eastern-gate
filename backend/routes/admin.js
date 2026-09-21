const express = require('express');
const { getData, persist } = require('../lib/db');
const { hash } = require('../lib/auth');
const { genId, nextSellerId } = require('../lib/ids');
const { findMenuItem } = require('../lib/pricing');
const { computeStatus, todayStr, withStatus } = require('../lib/menuStatus');
const { ok, created, fail, asyncHandler } = require('../lib/respond');

const router = express.Router();

const PIN_RE = /^\d{4}$/;

function publicSeller(s) {
  const { pinHash, ...rest } = s;
  return rest;
}

/* ============================== Sellers ============================== */

router.get(
  '/sellers',
  asyncHandler(async (req, res) => {
    const data = getData();
    ok(res, data.sellers.map(publicSeller));
  })
);

router.post(
  '/sellers',
  asyncHandler(async (req, res) => {
    const data = getData();
    const fullName = (req.body.fullName || '').trim();
    const phone = (req.body.phone || '').trim();
    const pin = (req.body.pin || '').trim();
    const status = req.body.status === 'inactive' ? 'inactive' : 'active';

    if (!fullName) return fail(res, 400, 'Seller name is required.');
    if (!phone) return fail(res, 400, 'Phone number is required.');
    if (!PIN_RE.test(pin)) return fail(res, 400, 'PIN must be exactly 4 digits.');

    const seller = {
      id: nextSellerId(data),
      fullName,
      phone,
      pinHash: hash(pin),
      status,
      createdAt: new Date().toISOString()
    };
    data.sellers.push(seller);
    await persist();
    created(res, publicSeller(seller), 'Seller created.');
  })
);

router.patch(
  '/sellers/:id',
  asyncHandler(async (req, res) => {
    const data = getData();
    const seller = data.sellers.find((s) => s.id === req.params.id);
    if (!seller) return fail(res, 404, 'Seller not found.');

    if (req.body.fullName !== undefined) {
      const fullName = String(req.body.fullName).trim();
      if (!fullName) return fail(res, 400, 'Seller name is required.');
      seller.fullName = fullName;
    }
    if (req.body.phone !== undefined) {
      const phone = String(req.body.phone).trim();
      if (!phone) return fail(res, 400, 'Phone number is required.');
      seller.phone = phone;
    }
    if (req.body.pin) {
      const pin = String(req.body.pin).trim();
      if (!PIN_RE.test(pin)) return fail(res, 400, 'PIN must be exactly 4 digits.');
      seller.pinHash = hash(pin);
    }
    if (req.body.status !== undefined) {
      seller.status = req.body.status === 'inactive' ? 'inactive' : 'active';
    }

    await persist();
    ok(res, publicSeller(seller), 'Seller updated.');
  })
);

router.post(
  '/sellers/:id/reset-pin',
  asyncHandler(async (req, res) => {
    const data = getData();
    const seller = data.sellers.find((s) => s.id === req.params.id);
    if (!seller) return fail(res, 404, 'Seller not found.');
    const pin = String(req.body.pin || '').trim();
    if (!PIN_RE.test(pin)) return fail(res, 400, 'PIN must be exactly 4 digits.');

    seller.pinHash = hash(pin);
    await persist();
    ok(res, publicSeller(seller), 'PIN reset.');
  })
);

router.post(
  '/sellers/:id/activate',
  asyncHandler(async (req, res) => {
    const data = getData();
    const seller = data.sellers.find((s) => s.id === req.params.id);
    if (!seller) return fail(res, 404, 'Seller not found.');
    seller.status = 'active';
    await persist();
    ok(res, publicSeller(seller), 'Seller activated.');
  })
);

router.post(
  '/sellers/:id/deactivate',
  asyncHandler(async (req, res) => {
    const data = getData();
    const seller = data.sellers.find((s) => s.id === req.params.id);
    if (!seller) return fail(res, 404, 'Seller not found.');
    seller.status = 'inactive';
    await persist();
    ok(res, publicSeller(seller), 'Seller deactivated.');
  })
);

/* ================================ Menu ================================ */
/* Menu items are one permanent Master Menu, split into three types the
   Admin picks when adding a genuinely new item (POST /menu below):
     - "food"     : has its own price.
     - "soup"     : a choice attached to a food, never priced on its own
                    (price is always forced to 0, regardless of input).
     - "protein"  : may add its own extra price on top of the food.
   Every day after an item is added, the Admin just flips its `available`
   flag on/off — no retyping.

   Availability has two independent layers, kept deliberately separate:
     - `available`     : the Admin's ongoing decision to sell this at all.
     - `finishedDate`  : set by a *seller* when it runs out on a given day
                         (see routes/seller.js). Restoring here only clears
                         that seller-set flag; it does not touch `available`. */

const MENU_TYPES = ['food', 'soup', 'protein'];

router.post(
  '/menu',
  asyncHandler(async (req, res) => {
    const data = getData();
    const name = (req.body.name || '').trim();
    const type = req.body.type;

    if (!name) return fail(res, 400, 'Item name is required.');
    if (!MENU_TYPES.includes(type)) return fail(res, 400, 'Choose whether this is a Food, a Soup/Stew, or a Protein.');

    let price = 0;
    if (type === 'soup') {
      price = 0; // soups/stews never have their own price
    } else {
      price = Number(req.body.price);
      if (Number.isNaN(price) || price < 0) return fail(res, 400, 'Price must be a valid non-negative number.');
    }

    const item = {
      id: genId('ITEM'),
      type,
      name,
      price,
      available: req.body.available !== false,
      finishedDate: null,
      finishedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.menu.push(item);
    await persist();
    created(res, withStatus(item), 'Menu item created.');
  })
);

router.patch(
  '/menu/:id',
  asyncHandler(async (req, res) => {
    const data = getData();
    const item = findMenuItem(data, req.params.id);
    if (!item) return fail(res, 404, 'Menu item not found.');

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return fail(res, 400, 'Item name is required.');
      item.name = name;
    }
    if (req.body.price !== undefined) {
      if (item.type === 'soup') {
        item.price = 0; // soups/stews never have their own price
      } else {
        const price = Number(req.body.price);
        if (Number.isNaN(price) || price < 0) return fail(res, 400, 'Price must be a valid non-negative number.');
        item.price = price;
      }
    }
    if (req.body.available !== undefined) {
      item.available = !!req.body.available;
    }
    item.updatedAt = new Date().toISOString();

    await persist();
    ok(res, withStatus(item), 'Menu item updated.');
  })
);

// POST /api/admin/menu/:id/restore
// Clears a seller-set "finished today" flag, independent of the Admin's
// own `available` flag — restoring does not force `available` to true if
// the Admin had separately turned it off.
router.post(
  '/menu/:id/restore',
  asyncHandler(async (req, res) => {
    const data = getData();
    const item = findMenuItem(data, req.params.id);
    if (!item) return fail(res, 404, 'Menu item not found.');

    item.finishedDate = null;
    item.finishedBy = null;
    item.updatedAt = new Date().toISOString();
    await persist();
    ok(res, withStatus(item), 'Availability restored.');
  })
);

/* =============================== Sales ================================ */

router.get(
  '/sales',
  asyncHandler(async (req, res) => {
    const data = getData();
    const { from, to, seller, paymentMethod, status } = req.query;

    let list = data.sales;
    if (from) list = list.filter((s) => s.date >= from);
    if (to) list = list.filter((s) => s.date <= to);
    if (seller) list = list.filter((s) => s.sellerId === seller);
    if (paymentMethod) list = list.filter((s) => s.paymentMethod === paymentMethod);
    if (status) list = list.filter((s) => s.status === status);

    list = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    ok(res, list);
  })
);

router.post(
  '/sales/:id/cancel',
  asyncHandler(async (req, res) => {
    const data = getData();
    const sale = data.sales.find((s) => s.transactionId === req.params.id);
    if (!sale) return fail(res, 404, 'Transaction not found.');
    if (sale.status !== 'completed') return fail(res, 400, 'Only completed transactions can be cancelled.');

    sale.status = 'cancelled';
    sale.cancelledAt = new Date().toISOString();
    await persist();
    ok(res, sale, 'Transaction cancelled.');
  })
);

/* ============================ Dashboard ================================ */

function computeItemPopularity(sales) {
  const itemCounts = new Map(); // dish name -> { name, quantity }
  for (const sale of sales) {
    for (const line of sale.items) {
      const key = line.name;
      const existing = itemCounts.get(key) || { name: line.name, quantity: 0 };
      existing.quantity += line.quantity;
      itemCounts.set(key, existing);
    }
  }
  const popularItems = [...itemCounts.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5);
  return { mostPurchasedItem: popularItems[0] || null, popularItems };
}

function salesBySellerFor(sales) {
  const bySeller = new Map(); // sellerId -> { sellerName, orders, revenue }
  for (const sale of sales) {
    const existing = bySeller.get(sale.sellerId) || { sellerName: sale.sellerName, orders: 0, revenue: 0 };
    existing.orders += 1;
    existing.revenue += sale.total;
    bySeller.set(sale.sellerId, existing);
  }
  return [...bySeller.values()].sort((a, b) => b.revenue - a.revenue);
}

router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const data = getData();
    const today = todayStr();

    const completedAllTime = data.sales.filter((s) => s.status === 'completed');
    const completedToday = completedAllTime.filter((s) => s.date === today);

    const todayRevenue = Math.round(completedToday.reduce((sum, s) => sum + s.total, 0) * 100) / 100;
    const { mostPurchasedItem, popularItems } = computeItemPopularity(completedAllTime);

    const recentTransactions = [...data.sales]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10);

    // "Today's menu": every item with its live status, so the Admin can
    // see at a glance what's Available / Not Available / Finished by
    // Seller (and by whom) without cross-referencing anything else.
    const menuStatus = data.menu.map((item) => withStatus(item, today)); // Master Menu order

    const sumOf = (list) => Math.round(list.reduce((sum, s) => sum + s.total, 0) * 100) / 100;
    const cashToday = completedToday.filter((s) => s.paymentMethod === 'cash');
    const momoToday = completedToday.filter((s) => s.paymentMethod === 'momo');

    ok(res, {
      today: {
        revenue: todayRevenue,
        orders: completedToday.length,
        cash: { count: cashToday.length, total: sumOf(cashToday) },
        momo: { count: momoToday.length, total: sumOf(momoToday) }
      },
      mostPurchasedItem,
      popularItems,
      salesBySeller: salesBySellerFor(completedToday),
      recentTransactions,
      menuStatus
    });
  })
);

/* ============================== Reports ================================ */

router.get(
  '/reports/end-of-day',
  asyncHandler(async (req, res) => {
    const data = getData();
    const date = req.query.date || todayStr();

    const dayAll = data.sales.filter((s) => s.date === date);
    const completed = dayAll.filter((s) => s.status === 'completed');
    const cancelled = dayAll.filter((s) => s.status === 'cancelled');

    const totalRevenue = Math.round(completed.reduce((sum, s) => sum + s.total, 0) * 100) / 100;
    const { mostPurchasedItem, popularItems } = computeItemPopularity(completed);

    const cashSales = completed.filter((s) => s.paymentMethod === 'cash');
    const momoSales = completed.filter((s) => s.paymentMethod === 'momo');

    ok(res, {
      date,
      totalRevenue,
      completedOrders: completed.length,
      cancelledOrders: cancelled.length,
      mostPurchasedItem,
      popularItems,
      salesBySeller: salesBySellerFor(completed),
      cash: { count: cashSales.length, total: Math.round(cashSales.reduce((sum, s) => sum + s.total, 0) * 100) / 100 },
      momo: { count: momoSales.length, total: Math.round(momoSales.reduce((sum, s) => sum + s.total, 0) * 100) / 100 },
      transactions: [...dayAll].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    });
  })
);

/* =============================== Export ================================ */

function csvEscape(value) {
  const str = String(value === undefined || value === null ? '' : value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// GET /api/admin/sales/export?date=YYYY-MM-DD
// Reached via a direct browser navigation (window.location.href), not
// fetch — the httpOnly session cookie is still sent automatically on
// same-origin navigations, so requireAuth('admin') still applies normally.
// A CSV is the simplest file that opens cleanly in Excel for a demo;
// no extra spreadsheet-writing dependency is needed for that.
router.get(
  '/sales/export',
  asyncHandler(async (req, res) => {
    const data = getData();
    const date = req.query.date || todayStr();
    const rows = data.sales.filter((s) => s.date === date).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const header = ['Transaction ID', 'Date', 'Time', 'Seller', 'Items', 'Quantity', 'Total', 'Payment Method', 'Status'];
    const lines = [header.join(',')];

    for (const sale of rows) {
      const itemNames = sale.items.map((i) => `${i.name} x${i.quantity}`).join('; ');
      const totalQty = sale.items.reduce((sum, i) => sum + i.quantity, 0);
      const time = new Date(sale.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      lines.push(
        [
          sale.transactionId,
          sale.date,
          time,
          sale.sellerName,
          itemNames,
          totalQty,
          sale.total.toFixed(2),
          sale.paymentMethod === 'cash' ? 'Cash' : 'Mobile Money',
          sale.status
        ]
          .map(csvEscape)
          .join(',')
      );
    }

    const csv = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="eastern-gate-sales-${date}.csv"`);
    res.status(200).send(csv);
  })
);

module.exports = router;
