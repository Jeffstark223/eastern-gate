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

const DATA_FILE = path.join(__dirname, '..', 'data.json');

const DEFAULT_DATA = {
  admin: null,
  sellers: [],
  menu: [],
  sales: [],
  settings: { restaurantName: 'Eastern Gate', currency: 'GHS' },
  meta: { sellerSeq: 1000, txSeq: {} }
};

let data = null;

function load() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      data = raw.trim() ? JSON.parse(raw) : structuredClone(DEFAULT_DATA);
      console.log('Loaded existing data.json');
    } catch (err) {
      console.error('Could not parse data.json, starting fresh:', err.message);
      data = structuredClone(DEFAULT_DATA);
    }
  } else {
    console.log('No data.json found — starting with a fresh dataset');
    data = structuredClone(DEFAULT_DATA);
  }

  // Backfill any keys an older/partial data.json might be missing so the
  // rest of the app can always assume the full shape exists.
  for (const key of Object.keys(DEFAULT_DATA)) {
    if (data[key] === undefined) data[key] = structuredClone(DEFAULT_DATA[key]);
  }
  if (!data.meta) data.meta = structuredClone(DEFAULT_DATA.meta);
  if (typeof data.meta.sellerSeq !== 'number') data.meta.sellerSeq = 1000;
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
      available: m.available,
      finishedDate: null,
      finishedBy: null,
      createdAt: now,
      updatedAt: now
    });
  }
  data.meta.menuSeeded = true;
}

let writeQueue = Promise.resolve();

function persist() {
  // Serialize writes: chain each write after the previous one finishes so
  // concurrent requests can't interleave and corrupt the file.
  writeQueue = writeQueue
    .then(
      () =>
        new Promise((resolve) => {
          fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => {
            if (err) console.error('Failed to write data.json:', err.message);
            resolve();
          });
        })
    )
    .catch((err) => console.error('data.json write queue error:', err.message));
  return writeQueue;
}

function persistSync() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to write data.json:', err.message);
  }
}

function getData() {
  if (!data) load();
  return data;
}

module.exports = { load, getData, persist };
