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

db.load();

const app = express();
const PROJECT_ROOT = path.join(__dirname, '..');

app.use(express.json());
app.use(cookieParser());
app.use(attachSession);

/* --------------------------------- API ---------------------------------- */

app.use('/api/auth', authRoutes);

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

app.use(express.static(PROJECT_ROOT));

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
  console.log(`  On this computer: http://localhost:${PORT}`);
  const lan = getLanAddresses();
  if (lan.length) {
    lan.forEach((ip) => console.log(`  On other devices: http://${ip}:${PORT}`));
  }
  console.log('\nOpen login.html (or just the root URL) on any device on the same WiFi network.\n');
});
