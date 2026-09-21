/* =========================================================================
   Eastern Gate — menu item status

   Two independent flags live on every menu item:
     - available     (admin-controlled): does the restaurant intend to sell
                      this today at all? Persists until the admin changes it.
     - finishedDate  (seller-controlled): the date (YYYY-MM-DD) on which a
                      seller ran out of it. Only counts for *that* date, so
                      it automatically stops applying once the date rolls
                      over — no daily reset job needed, just a date compare.

   These combine into one status a UI can show directly:
     not available                       -> "unavailable"
     available, finishedDate === today   -> "finished"
     available, otherwise                -> "available"

   Only "available" items can be ordered.
   ========================================================================= */

function todayStr(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function computeStatus(item, today = todayStr()) {
  if (!item.available) return 'unavailable';
  if (item.finishedDate === today) return 'finished';
  return 'available';
}

// Returns a copy of the item annotated with its live status, for API
// responses. Does not mutate the stored item or write anything to disk —
// status is always derived fresh from today's date.
function withStatus(item, today = todayStr()) {
  return { ...item, status: computeStatus(item, today) };
}

module.exports = { todayStr, computeStatus, withStatus };
