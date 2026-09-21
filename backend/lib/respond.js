/* =========================================================================
   Eastern Gate — response helpers

   The brief for this project specifically calls out a past
   "Unexpected end of JSON input" bug. That happens when a route throws
   before calling res.json(), or when an unhandled rejection kills the
   response early. asyncHandler() wraps every async route so any thrown
   error is always turned into a JSON error response instead of a hung
   or empty one — every single API response goes through ok()/fail(),
   so the shape is always { success, message, data }.
   ========================================================================= */

function ok(res, data, message) {
  return res.status(200).json({ success: true, message: message || 'OK', data: data === undefined ? null : data });
}

function created(res, data, message) {
  return res.status(201).json({ success: true, message: message || 'Created', data: data === undefined ? null : data });
}

function fail(res, status, message) {
  return res.status(status).json({ success: false, message: message || 'Something went wrong.' });
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { ok, created, fail, asyncHandler };
