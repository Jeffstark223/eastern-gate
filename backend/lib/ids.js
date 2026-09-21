/* =========================================================================
   Eastern Gate — ID generation

   Sellers and transactions get short, human-readable sequential IDs
   (EG-1001, EG-20260918-0001) because staff read and say these out loud.
   Everything else (menu items, option groups, options, admin record) gets
   a short opaque ID — nothing about them needs to be human-friendly.
   ========================================================================= */

const crypto = require('crypto');

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function nextSellerId(data) {
  data.meta.sellerSeq += 1;
  return `EG-${data.meta.sellerSeq}`;
}

function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function nextTransactionId(data, date = new Date()) {
  const key = todayKey(date);
  const current = data.meta.txSeq[key] || 0;
  const next = current + 1;
  data.meta.txSeq[key] = next;
  return `EG-${key}-${String(next).padStart(4, '0')}`;
}

module.exports = { genId, nextSellerId, nextTransactionId, todayKey };
