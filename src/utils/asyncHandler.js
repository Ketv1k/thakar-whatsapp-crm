// Wraps an async Express handler so a rejected promise is forwarded to the
// error-handling middleware instead of becoming an unhandled rejection.
// (Express 4 doesn't await route handlers, so without this a thrown error -
// e.g. a CastError from a malformed :id - would hang the request.)
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
