/* =========================================================================
   Eastern Gate — server-side pricing (Food + Soup/Stew + Protein design)

   A seller's order is a list of "dish" lines, not a flat list of separate
   menu items. Each line is: one Food (has its own price), an optional
   Soup/Stew (never adds to the price — it's just a choice), and an
   optional Protein (adds its own extra price), at some quantity. The
   frontend never sends a price — every line is priced here from the
   current menu, and only items whose *live* status is "available" (admin
   available AND not marked finished today) can be sold. The resulting
   numbers are what get saved on the sale record, which is what makes them
   "historical prices" — a later price edit, or a later finished/available
   flip, never touches a sale that already happened.
   ========================================================================= */

const { computeStatus, todayStr } = require('./menuStatus');

const MAX_QTY = 200;
const MAX_LINES = 30;
const MAX_PROTEINS = 6;
const MAX_SOUPS = 6;
const MAX_PROTEIN_QTY = 50;

function findMenuItem(data, itemId) {
  return data.menu.find((m) => m.id === itemId);
}

// Looks up a menu item by id, checks it's the expected type, and checks
// it's currently sellable (available today, not finished). Throws a
// { status, message } style error on any problem. Returns null if id is
// falsy and the slot is optional (soup/protein).
function resolveSlot(data, id, type, label, today, required) {
  if (!id) {
    if (required) {
      const err = new Error(`${label} is required.`);
      err.status = 400;
      throw err;
    }
    return null;
  }

  const item = findMenuItem(data, id);
  if (!item) {
    const err = new Error(`One of the items in your order is no longer on the menu.`);
    err.status = 400;
    throw err;
  }
  if (item.type !== type) {
    const err = new Error(`${item.name} is not a ${label.toLowerCase()}.`);
    err.status = 400;
    throw err;
  }

  const status = computeStatus(item, today);
  if (status === 'unavailable') {
    const err = new Error(`${item.name} is not available today.`);
    err.status = 400;
    throw err;
  }
  if (status === 'finished') {
    const err = new Error(`${item.name} has been marked finished for today.`);
    err.status = 400;
    throw err;
  }

  return item;
}

// Reads the proteins on a line. New clients send
//   proteins: [{ proteinId, quantity }, ...]   (several proteins, each with its own quantity)
// Older clients sent a single proteinId, which still works (quantity 1).
function readProteins(line) {
  let list = Array.isArray(line.proteins) ? line.proteins : [];
  if (!list.length && line.proteinId) list = [{ proteinId: line.proteinId, quantity: 1 }];
  const merged = new Map();
  for (const p of list) {
    if (!p || !p.proteinId) continue;
    merged.set(p.proteinId, (merged.get(p.proteinId) || 0) + Number(p.quantity === undefined ? 1 : p.quantity));
  }
  if (merged.size > MAX_PROTEINS) {
    const err = new Error(`Choose at most ${MAX_PROTEINS} different proteins per dish.`);
    err.status = 400;
    throw err;
  }
  return [...merged.entries()].map(([proteinId, quantity]) => ({ proteinId, quantity }));
}

// Soups/stews on a line work the same way: soups: [{ soupId, quantity }, ...]
// so "2 Fufu — 1 Palmnut, 1 Groundnut" is one line. (Old clients sent one soupId.)
function readSoups(line) {
  let list = Array.isArray(line.soups) ? line.soups : [];
  if (!list.length && line.soupId) list = [{ soupId: line.soupId, quantity: 1 }];
  const merged = new Map();
  for (const s of list) {
    if (!s || !s.soupId) continue;
    merged.set(s.soupId, (merged.get(s.soupId) || 0) + Number(s.quantity === undefined ? 1 : s.quantity));
  }
  if (merged.size > MAX_SOUPS) {
    const err = new Error(`Choose at most ${MAX_SOUPS} different soups/stews per dish.`);
    err.status = 400;
    throw err;
  }
  return [...merged.entries()].map(([soupId, quantity]) => ({ soupId, quantity }));
}

// Prices one dish line — a Food, an optional Soup/Stew, and any number of
// Proteins, each with its own quantity.
//
//   total = food price x food quantity  +  sum of (protein price x protein quantity)
//
// Proteins are counted separately from the food, so "2 Fufu + 1 Goat" (two
// people sharing one goat) and "Banku x6 + Goat + Chicken" both price
// naturally. A soup/stew never adds to the price.
function priceLine(data, line, today = todayStr()) {
  const { foodId, quantity } = line || {};

  const food = resolveSlot(data, foodId, 'food', 'Food', today, true);

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    const err = new Error(`Invalid quantity for ${food.name}.`);
    err.status = 400;
    throw err;
  }

  // Soups/stews are free; they only say which soup goes with the food.
  const soups = readSoups(line || {}).map(({ soupId, quantity: sq }) => {
    const item = resolveSlot(data, soupId, 'soup', 'Soup/Stew', today, true);
    if (!Number.isInteger(sq) || sq < 1 || sq > MAX_PROTEIN_QTY) {
      const err = new Error(`Invalid quantity for ${item.name}.`);
      err.status = 400;
      throw err;
    }
    return { id: item.id, name: item.name, quantity: sq };
  });
  // For a plated food (e.g. Fufu), each plate gets at most one soup.
  if (food.pricingType !== 'unit' && soups.reduce((n, x) => n + x.quantity, 0) > qty) {
    const err = new Error(`You chose more soups than ${food.name} plates (${qty}).`);
    err.status = 400;
    throw err;
  }

  const proteins = readProteins(line || {}).map(({ proteinId, quantity: pq }) => {
    const item = resolveSlot(data, proteinId, 'protein', 'Protein', today, true);
    if (!Number.isInteger(pq) || pq < 1 || pq > MAX_PROTEIN_QTY) {
      const err = new Error(`Invalid quantity for ${item.name}.`);
      err.status = 400;
      throw err;
    }
    const price = Number(item.price) || 0;
    return { id: item.id, name: item.name, price, quantity: pq, subtotal: Math.round(price * pq * 100) / 100 };
  });

  const foodPrice = Number(food.price) || 0;
  const pricingType = food.pricingType === 'unit' ? 'unit' : 'fixed';
  const unitName = pricingType === 'unit' ? food.unitName || 'unit' : null;
  const proteinsTotal = proteins.reduce((sum, p) => sum + p.subtotal, 0);
  const subtotal = Math.round((foodPrice * qty + proteinsTotal) * 100) / 100;

  const nameParts = [food.name];
  for (const x of soups) nameParts.push(x.quantity > 1 ? `${x.name} x${x.quantity}` : x.name);
  for (const p of proteins) nameParts.push(p.quantity > 1 ? `${p.name} x${p.quantity}` : p.name);

  return {
    foodId: food.id,
    foodName: food.name,
    foodPrice,
    pricingType,
    unitName,
    soups, // a soup/stew is never priced
    proteins,
    proteinsTotal: Math.round(proteinsTotal * 100) / 100,
    quantity: qty,
    unitPrice: foodPrice,
    subtotal,
    name: nameParts.join(' + ')
  };
}

function priceCart(data, items, today = todayStr()) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('Your cart is empty.');
    err.status = 400;
    throw err;
  }
  if (items.length > MAX_LINES) {
    const err = new Error(`An order can have at most ${MAX_LINES} items.`);
    err.status = 400;
    throw err;
  }
  const pricedItems = items.map((line) => priceLine(data, line, today));
  const total = Math.round(pricedItems.reduce((sum, l) => sum + l.subtotal, 0) * 100) / 100;
  return { items: pricedItems, subtotal: total, total };
}

module.exports = { findMenuItem, priceLine, priceCart };
