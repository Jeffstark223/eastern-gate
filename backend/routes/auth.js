const express = require('express');
const { getData, persist } = require('../lib/db');
const { hash, verify, issueSession, clearSession } = require('../lib/auth');
const { genId } = require('../lib/ids');
const { ok, fail, asyncHandler } = require('../lib/respond');

const router = express.Router();

// GET /api/auth/setup-status
router.get(
  '/setup-status',
  asyncHandler(async (req, res) => {
    const data = getData();
    ok(res, { completed: !!data.admin });
  })
);

// POST /api/auth/setup  { fullName, username, password, confirmPassword }
router.post(
  '/setup',
  asyncHandler(async (req, res) => {
    const data = getData();
    if (data.admin) {
      return fail(res, 409, 'Admin setup has already been completed.');
    }

    const fullName = (req.body.fullName || '').trim();
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const confirmPassword = req.body.confirmPassword || '';

    if (!fullName) return fail(res, 400, 'Full name is required.');
    if (!username) return fail(res, 400, 'Username/email is required.');
    if (password.length < 8) return fail(res, 400, 'Password must be at least 8 characters.');
    if (password !== confirmPassword) return fail(res, 400, 'Passwords do not match.');

    data.admin = {
      id: genId('ADMIN'),
      fullName,
      username,
      passwordHash: hash(password),
      createdAt: new Date().toISOString()
    };
    await persist();

    issueSession(res, { role: 'admin', id: data.admin.id, username: data.admin.username, fullName: data.admin.fullName });
    ok(res, { role: 'admin', username: data.admin.username, fullName: data.admin.fullName }, 'Admin account created.');
  })
);

// POST /api/auth/admin-login  { username, password }
router.post(
  '/admin-login',
  asyncHandler(async (req, res) => {
    const data = getData();
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    if (!data.admin || data.admin.username.toLowerCase() !== username.toLowerCase() || !verify(password, data.admin.passwordHash)) {
      return fail(res, 401, 'Incorrect username or password.');
    }

    issueSession(res, { role: 'admin', id: data.admin.id, username: data.admin.username, fullName: data.admin.fullName });
    ok(res, { role: 'admin', username: data.admin.username, fullName: data.admin.fullName }, 'Signed in.');
  })
);

// POST /api/auth/seller-login  { sellerId, pin }
router.post(
  '/seller-login',
  asyncHandler(async (req, res) => {
    const data = getData();
    const sellerId = (req.body.sellerId || '').trim();
    const pin = (req.body.pin || '').trim();

    const seller = data.sellers.find((s) => s.id.toLowerCase() === sellerId.toLowerCase());
    if (!seller || !verify(pin, seller.pinHash)) {
      return fail(res, 401, 'Seller ID or PIN is incorrect.');
    }
    if (seller.status !== 'active') {
      return fail(res, 403, 'This seller account has been deactivated. See your admin.');
    }

    issueSession(res, { role: 'seller', id: seller.id, fullName: seller.fullName });
    ok(res, { role: 'seller', id: seller.id, fullName: seller.fullName }, 'Signed in.');
  })
);

// GET /api/auth/me
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    if (!req.user) return fail(res, 401, 'Not signed in.');
    const data = getData();

    if (req.user.role === 'admin') {
      if (!data.admin) return fail(res, 401, 'Not signed in.');
      return ok(res, { role: 'admin', username: data.admin.username, fullName: data.admin.fullName });
    }

    if (req.user.role === 'seller') {
      const seller = data.sellers.find((s) => s.id === req.user.id);
      if (!seller) return fail(res, 401, 'Not signed in.');
      if (seller.status !== 'active') {
        clearSession(res);
        return fail(res, 403, 'This seller account has been deactivated. See your admin.');
      }
      return ok(res, { role: 'seller', id: seller.id, fullName: seller.fullName });
    }

    fail(res, 401, 'Not signed in.');
  })
);

// POST /api/auth/logout
router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    clearSession(res);
    ok(res, null, 'Signed out.');
  })
);

module.exports = router;
