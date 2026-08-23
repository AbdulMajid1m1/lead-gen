// createError(status, message)
// createError(status, message, { field: "query", code: "INVALID_QUERY" })
//   → extras are forwarded by errorHandler into the JSON payload so the
//     frontend can route the message to a form field or branch on a code.
export const createError = (status, message, extras) => {
  const err = new Error(message);
  err.status = status;
  if (extras && typeof extras === "object") {
    if (extras.field) err.field = extras.field;
    if (extras.code) err.code = extras.code;
    if (extras.details) err.details = extras.details;
  }
  return err;
};
