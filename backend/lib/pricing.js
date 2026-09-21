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

// Prices one dish line — a Food, plus an optional Soup/Stew and an
// optional Protein, at some quantity.
function priceLine(data, line, today = todayStr()) {
  const { foodId, soupId, proteinId, quantity } = line || {};

  const food = resolveSlot(data, foodId, 'food', 'Food', today, true);
  const soup = resolveSlot(data, soupId, 'soup', 'Soup/Stew', today, false);
  const protein = resolveSlot(data, proteinId, 'protein', 'Protein', today, false);

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    const err = new Error(`Invalid quantity for ${food.name}.`);
    err.status = 400;
    throw err;
  }

  const foodPrice = Number(food.price) || 0;
  const proteinPrice = protein ? Number(protein.price) || 0 : 0;
  const unitPrice = foodPrice + proteinPrice; // a soup/stew never adds to the price
  const subtotal = Math.round(unitPrice * qty * 100) / 100;

  const nameParts = [food.name];
  if (soup) nameParts.push(soup.name);
  if (protein) nameParts.push(protein.name);

  return {
    foodId: food.id,
    foodName: food.name,
    foodPrice,
    soupId: soup ? soup.id : null,
    soupName: soup ? soup.name : null,
    soupPrice: 0, // a soup/stew is never priced
    proteinId: protein ? protein.id : null,
    proteinName: protein ? protein.name : null,
    proteinPrice,
    quantity: qty,
    unitPrice,
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
  const pricedItems = items.map((line) => priceLine(data, line, today));
  const total = Math.round(pricedItems.reduce((sum, l) => sum + l.subtotal, 0) * 100) / 100;
  return { items: pricedItems, subtotal: total, total };
}

module.exports = { findMenuItem, priceLine, priceCart };
