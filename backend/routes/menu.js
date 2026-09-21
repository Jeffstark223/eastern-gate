const express = require('express');
const { getData } = require('../lib/db');
const { withStatus } = require('../lib/menuStatus');
const { ok, asyncHandler } = require('../lib/respond');

const router = express.Router();

// GET /api/menu — used by both Admin (menu management, dashboard) and
// Seller (ordering screen). Any authenticated role may read the menu;
// only the admin routes (mounted separately) can create/edit/delete items,
// and only the seller routes can mark an item finished for today.
//
// Every item comes back annotated with a live `status` field —
// "available" | "unavailable" | "finished" — computed fresh against
// today's date server-side, so both frontends always agree on what's
// actually sellable right now without doing their own date math.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const data = getData();
    ok(res, data.menu.map((item) => withStatus(item)));
  })
);

module.exports = router;
