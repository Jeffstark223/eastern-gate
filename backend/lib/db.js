/* =========================================================================
   Eastern Gate — data.json data layer

   Modeled on CyberShield's server.js approach: read the whole dataset into
   memory once at startup, keep it there for the life of the process, and
   persist it back to disk on every change. CyberShield does this because
   it's relaying one big state blob over Socket.io to browsers; here we
   apply the same "data.json is the database" idea to a normal REST API —
   many small route handlers mutate the in-memory object and call persist()
   instead of one big client-driven "update" event.

   Because a REST API can have multiple requests overlapping (unlike
   CyberShield's single broadcast-on-update model), writes are queued so
   two requests can never interleave writes to data.json and corrupt it.
   ========================================================================= */

const fs = require('fs');
const path = require('path');
const { genId } = require('./ids');

// WHERE THE DATA LIVES
// Locally the file sits next to the code (backend/data.json) as before. On a
// host with a throw-away filesystem (Render's default) that is NOT safe: the
// file is wiped on every deploy/restart. Set DATA_DIR to a directory on a
// persistent disk (e.g. /var/data on Render) and the file lives there instead.
const LEGACY_FILE = path.join(__dirname, '..', 'data.json');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const BACKUP_FILE = DATA_FILE + '.bak';
const TMP_FILE = DATA_FILE + '.tmp';

const DEFAULT_DATA = {
  admin: null,
  sellers: [],
  menu: [],
  sales: [],
  tables: [],
  orders: [],
  settings: { restaurantName: 'Eastern Gate', currency: 'GHS' },
  meta: { sellerSeq: 1000, txSeq: {}, orderSeq: 1000 }
};

let data = null;

function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

// Moves an unreadable file aside instead of overwriting it, so a bad write
// or a hand-edit can never silently destroy the restaurant's records.
function quarantine(file) {
  try {
    const dest = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, dest);
    console.error(`[eastern-gate] Unreadable data file moved aside to ${dest}`);
  } catch (err) {
    console.error('[eastern-gate] Could not move corrupt file aside:', err.message);
  }
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // One-time carry-over: if a persistent DATA_DIR is new/empty but an older
  // data.json sits beside the code, start from that instead of from nothing.
  if (!fs.existsSync(DATA_FILE) && DATA_FILE !== LEGACY_FILE && fs.existsSync(LEGACY_FILE)) {
    try {
      fs.copyFileSync(LEGACY_FILE, DATA_FILE);
      console.log('[eastern-gate] Copied existing backend/data.json into DATA_DIR.');
    } catch (err) {
      console.error('[eastern-gate] Could not copy legacy data.json:', err.message);
    }
  }

  data = null;
  if (fs.existsSync(DATA_FILE)) {
    try {
      data = readJsonFile(DATA_FILE);
      if (data) console.log(`Loaded existing data.json (${DATA_FILE})`);
    } catch (err) {
      console.error('[eastern-gate] data.json is corrupt:', err.message);
      quarantine(DATA_FILE);
      if (fs.existsSync(BACKUP_FILE)) {
        try {
          data = readJsonFile(BACKUP_FILE);
          if (data) console.warn('[eastern-gate] Recovered from data.json.bak (the last good save).');
        } catch (e2) {
          console.error('[eastern-gate] Backup is unreadable too:', e2.message);
        }
      }
    }
  } else {
    console.log(`No data.json found at ${DATA_FILE} — starting with a fresh dataset`);
  }
  if (!data) data = structuredClone(DEFAULT_DATA);

  // Backfill any keys an older/partial data.json might be missing so the
  // rest of the app can always assume the full shape exists.
  for (const key of Object.keys(DEFAULT_DATA)) {
    if (data[key] === undefined) data[key] = structuredClone(DEFAULT_DATA[key]);
  }
  if (!data.meta) data.meta = structuredClone(DEFAULT_DATA.meta);
  if (typeof data.meta.sellerSeq !== 'number') data.meta.sellerSeq = 1000;
  if (typeof data.meta.orderSeq !== 'number') data.meta.orderSeq = 1000;
  if (!data.meta.txSeq) data.meta.txSeq = {};

  migrateMenuToFlat(data);
  seedMasterMenu(data);

  // Make sure the file exists on disk from the very first boot.
  persistSync();
  return data;
}

// Menu redesign history: items started as a full dish name with optional
// dropdown "option groups" (e.g. a Meat dropdown on a soup), then briefly
// moved to a flat Master Menu with no categories at all. The current
// (final) design sits between those two: every item still lives in one
// permanent Master Menu, but each is typed as "food", "soup" or
// "protein" so a sale can compose one Food + an optional Soup/Stew
// (never priced on its own) + an optional Protein (its own extra price)
// into a single dish line — see lib/pricing.js. This brings any menu
// item saved under an older shape up to the current one, in place,
// without touching sales history (a sale already stores its own
// snapshot, so old sales are left exactly as they are regardless of
// this migration).
function migrateMenuToFlat(data) {
  for (const item of data.menu) {
    if (item.price === undefined && item.basePrice !== undefined) {
      item.price = item.basePrice;
    }
    delete item.basePrice;
    delete item.optionGroups;
    if (item.type === undefined) {
      // Old "category" field (when present) used the same names.
      item.type = item.category === 'soup' || item.category === 'protein' ? item.category : 'food';
    }
    delete item.category;
    if (item.type === 'soup') item.price = 0; // soups/stews never carry their own price
    // Pricing model: foods are either a fixed price per portion ("fixed") or a
    // price per unit sold by quantity ("unit", e.g. GHS 5 per ball). Soups and
    // proteins are always "fixed"; existing items default to "fixed" so
    // nothing already on the menu changes.
    if (item.pricingType !== 'unit' || item.type !== 'food') item.pricingType = 'fixed';
    if (item.pricingType !== 'unit') item.unitName = null;
    else if (!item.unitName) item.unitName = 'unit';
    if (item.finishedDate === undefined) item.finishedDate = null;
    if (item.finishedBy === undefined) item.finishedBy = null;
  }
}


// The permanent Master Menu. Seeded exactly once, on the very first boot
// with an empty menu (tracked by meta.menuSeeded so it can never come back
// after the Admin changes things). Prices are the ones given in the
// Eastern Gate brief; the Admin can edit any of them, add new items, and
// turn items ON/OFF for today. Soups/stews carry no price.
const MASTER_MENU = [
  { type: 'food', name: 'Fufu', price: 25, available: true },
  { type: 'food', name: 'Banku', price: 20, available: true },
  { type: 'food', name: 'Omotuo', price: 25, available: false },
  { type: 'food', name: 'Kokonte', price: 20, available: true },
  { type: 'food', name: 'Rice', price: 25, available: true },
  { type: 'soup', name: 'Palmnut Soup', price: 0, available: true },
  { type: 'soup', name: 'Groundnut Soup', price: 0, available: true },
  { type: 'soup', name: 'Light Soup', price: 0, available: false },
  { type: 'soup', name: 'Okro Soup', price: 0, available: true },
  { type: 'soup', name: 'Kontomire Stew', price: 0, available: false },
  { type: 'protein', name: 'Goat', price: 15, available: true },
  { type: 'protein', name: 'Beef', price: 10, available: true },
  { type: 'protein', name: 'Chicken', price: 10, available: true },
  { type: 'protein', name: 'Fish', price: 20, available: false }
];

function seedMasterMenu(data) {
  if (data.meta.menuSeeded || data.menu.length > 0) {
    data.meta.menuSeeded = true;
    return;
  }
  const now = new Date().toISOString();
  for (const m of MASTER_MENU) {
    data.menu.push({
      id: genId('ITEM'),
      type: m.type,
      name: m.name,
      price: m.price,
      pricingType: 'fixed',
      unitName: null,
      available: m.available,
      finishedDate: null,
      finishedBy: null,
      createdAt: now,
      updatedAt: now
    });
  }
  data.meta.menuSeeded = true;
}

// Atomic save: write the whole file to a temp file, fsync it, keep the last
// good copy as data.json.bak, then rename the temp file over data.json. A
// crash or power cut at any point leaves either the old or the new complete
// file on disk — never a half-written one.
function writeAtomic() {
  const json = JSON.stringify(data, null, 2);
  const fd = fs.openSync(TMP_FILE, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(DATA_FILE)) {
    try {
      fs.copyFileSync(DATA_FILE, BACKUP_FILE);
    } catch (err) {
      console.error('[eastern-gate] Could not refresh data.json.bak:', err.message);
    }
  }
  fs.renameSync(TMP_FILE, DATA_FILE);
}

// Saves are synchronous (the file is small), so two requests can never
// interleave a write. If saving fails the caller gets a real error instead
// of a false "success" — the old code swallowed write errors.
function persist() {
  try {
    writeAtomic();
    return Promise.resolve();
  } catch (err) {
    console.error('[eastern-gate] FAILED to save data.json:', err.message);
    const e = new Error('Could not save your changes to disk. Please try again.');
    e.status = 500;
    return Promise.reject(e);
  }
}

function persistSync() {
  try {
    writeAtomic();
  } catch (err) {
    console.error('[eastern-gate] Failed to write data.json:', err.message);
  }
}

// Is the folder holding data.json going to survive a redeploy/restart?
// On Render the container filesystem is wiped every deploy and every
// spin-down; only a mounted Persistent Disk survives. A mounted disk shows
// up as a different filesystem device from "/", so we check for that.
function storageInfo() {
  const onRender = process.env.RENDER === 'true' || !!process.env.RENDER_SERVICE_ID;
  if (process.env.DATA_PERSISTENT === 'true') return { persistent: true, onRender, reason: 'DATA_PERSISTENT=true' };
  if (!onRender) return { persistent: true, onRender, reason: 'Local/standard filesystem' };
  if (!process.env.DATA_DIR) {
    return { persistent: false, onRender, reason: 'DATA_DIR is not set — data.json is on Render\'s temporary filesystem.' };
  }
  let mounted = false;
  try {
    mounted = fs.statSync(DATA_DIR).dev !== fs.statSync('/').dev;
  } catch (e) { /* fall through */ }
  return mounted
    ? { persistent: true, onRender, reason: 'DATA_DIR is on a mounted persistent disk' }
    : { persistent: false, onRender, reason: 'DATA_DIR is not on a mounted persistent disk — attach a Render Disk and mount it there.' };
}

function getData() {
  if (!data) load();
  return data;
}

module.exports = { load, getData, persist, storageInfo, DATA_FILE };
