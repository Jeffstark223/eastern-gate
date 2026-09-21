/* =========================================================================
   Eastern Gate — authentication

   CyberShield's own "auth" is entirely client-side (plaintext passwords
   compared in the browser, no server involvement at all), so there is
   nothing security-relevant to reuse from it here. Eastern Gate's spec
   explicitly requires server-side hashing and protected routes, so this
   file builds a normal, small Express auth setup instead:

     - bcrypt hashing for the Admin password and Seller PINs
     - a signed JWT stored in an httpOnly cookie (the frontend's own code
       comments say "session is carried via an httpOnly cookie", so the
       three HTML files already assume this)
     - requireAuth(role) middleware for protecting routes
   ========================================================================= */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const COOKIE_NAME = 'eg_session';
const TOKEN_TTL = '8h';
const COOKIE_MAX_AGE = 8 * 60 * 60 * 1000;

// Never hard-code the JWT secret. Use JWT_SECRET from the environment; if
// it's missing (e.g. first local run before a .env is set up) generate a
// random one for this process only, so the demo still boots, but warn
// loudly since it means sessions won't survive a restart and this must
// not be relied on in production/Render.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn(
    '\n[eastern-gate] WARNING: JWT_SECRET is not set in the environment.\n' +
      '  Generated a temporary secret for this run only — all sessions will\n' +
      '  be invalidated on restart. Set JWT_SECRET in backend/.env (see\n' +
      '  .env.example) before deploying, e.g. on Render.\n'
  );
}

const SALT_ROUNDS = 10;

function hash(plain) {
  return bcrypt.hashSync(plain, SALT_ROUNDS);
}

function verify(plain, hashed) {
  if (!plain || !hashed) return false;
  return bcrypt.compareSync(plain, hashed);
}

function issueSession(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
}

// Reads the cookie (if any) and attaches the decoded session to req.user.
// Never rejects the request itself — routes decide what to do with an
// absent/invalid req.user via requireAuth().
function attachSession(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return next();
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    req.user = null;
  }
  next();
}

function requireAuth(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'You must be signed in.' });
    }
    if (role && req.user.role !== role) {
      return res.status(403).json({ success: false, message: 'You do not have access to this resource.' });
    }
    next();
  };
}

module.exports = {
  COOKIE_NAME,
  hash,
  verify,
  issueSession,
  clearSession,
  attachSession,
  requireAuth
};
