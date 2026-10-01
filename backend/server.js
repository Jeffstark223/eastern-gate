/* =========================================================================
   Eastern Gate — backend server
   Node.js + Express + server-side data.json (no external database).

   Architecture note: this is modeled on CyberShield's server.js in the
   ways that actually carry over to a REST API —
     - Express serving the static frontend files from the project root
     - a single data.json file as "the database", loaded at startup and
       written back to disk on every change
     - process.env.PORT || 3000, listening on 0.0.0.0, with a friendly
       startup banner (including LAN addresses, handy for demoing on a
       restaurant's local WiFi)
   CyberShield itself has no REST routes, no authentication, and no
   per-request validation — it's a single Socket.io "sync this whole blob"
   relay with entirely client-side, unhashed-password "auth". Eastern
   Gate's brief explicitly requires hashed credentials, protected routes,
   and server-computed prices/totals, so those parts are built fresh here
   rather than reused from CyberShield.
   ========================================================================= */

require('dotenv').config();

const express = require('express');
const path = require('path');
const os = require('os');
const cookieParser = require('cookie-parser');

const db = require('./lib/db');
const { attachSession, requireAuth } = require('./lib/auth');
const { fail } = require('./lib/respond');

const authRoutes = require('./routes/auth');
const menuRoutes = require('./routes/menu');
const adminRoutes = require('./routes/admin');
const sellerRoutes = require('./routes/seller');
const publicRoutes = require('./routes/public');

db.load();

const app = express();
const PROJECT_ROOT = path.join(__dirname, '..');

// Behind Render's proxy: lets req.protocol / req.ip reflect the real visitor
// (needed for correct https QR-code links and the customer rate limit).
app.set('trust proxy', 1);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(attachSession);

/* --------------------------------- API ---------------------------------- */

// Storage health — lets the Admin screens warn if data.json is on a
// filesystem that will be wiped on redeploy. Reveals no paths or secrets.
app.get('/api/health', (req, res) => {
  const info = db.storageInfo();
  res.json({ success: true, message: 'OK', data: { persistent: info.persistent, reason: info.reason } });
});

app.use('/api/auth', authRoutes);

// Customer QR ordering — open to anyone holding a table's QR link.
app.use('/api/public', publicRoutes);

// Menu reads are shared by both roles; either being signed in is enough.
app.use(
  '/api/menu',
  (req, res, next) => {
    if (!req.user) return fail(res, 401, 'You must be signed in.');
    next();
  },
  menuRoutes
);

app.use('/api/admin', requireAuth('admin'), adminRoutes);

app.use('/api/seller', requireAuth('seller'), sellerRoutes.router);
app.post('/api/sales', requireAuth('seller'), sellerRoutes.createSale);
app.get('/api/sales/my', requireAuth('seller'), sellerRoutes.getMyHistory);

// Any other /api/* path: a clean JSON 404 instead of falling through to
// the static file server (which would otherwise return HTML for a typo'd
// API path and cause exactly the "Unexpected end of JSON input" bug the
// frontend has already hit once).
app.use('/api', (req, res) => fail(res, 404, 'API endpoint not found.'));

/* ------------------------------ Frontend --------------------------------- */

// Only the three page files are public. Serving the whole project folder
// would expose backend/data.json (password hashes, sales) over HTTP.
const PUBLIC_PAGES = ['login.html', 'admin.html', 'seller.html', 'customer.html'];
app.get('/:page', (req, res, next) => {
  if (!PUBLIC_PAGES.includes(req.params.page)) return next();
  res.sendFile(path.join(PROJECT_ROOT, req.params.page));
});

// A table's QR code points here: /t/<qrId> -> the customer menu, table attached.
app.get('/t/:qrId', (req, res) => {
  res.redirect(302, `/customer.html?t=${encodeURIComponent(req.params.qrId)}`);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, 'login.html'));
});

/* --------------------------- Error handling ------------------------------ */

// Centralized error handler: guarantees every unhandled error still comes
// back as valid JSON on API routes, never an empty/broken response.
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  if (req.path.startsWith('/api')) {
    return fail(res, err.status || 500, err.message || 'Something went wrong. Please try again.');
  }
  res.status(err.status || 500).send('Something went wrong.');
});

/* --------------------------------- Boot ----------------------------------- */

const PORT = process.env.PORT || 3000;

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address);
    }
  }
  return addresses;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('\nEastern Gate server is running.\n');
  const storage = db.storageInfo();
  console.log(`  Data file: ${db.DATA_FILE}`);
  if (!storage.persistent) {
    console.warn('\n  !!! WARNING: data is NOT stored on a persistent disk. !!!');
    console.warn(`  ${storage.reason}`);
    console.warn('  Accounts, menu and sales WILL be lost on the next deploy/restart.');
    console.warn('  See DEPLOY-RENDER.md.\n');
  }
  console.log(`  On this computer: http://localhost:${PORT}`);
  const lan = getLanAddresses();
  if (lan.length) {
    lan.forEach((ip) => console.log(`  On other devices: http://${ip}:${PORT}`));
  }
  console.log('\nOpen login.html (or just the root URL) on any device on the same WiFi network.\n');
});
