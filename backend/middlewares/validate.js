/**
 * Zod validation middleware. Parsed output replaces the raw input, so
 * controllers always see coerced, trimmed, defaulted values.
 * A ZodError thrown here is turned into a 400 by errorHandler.
 */
export const validate = ({ body, query, params }) => (req, res, next) => {
  try {
    if (body) req.body = body.parse(req.body ?? {});
    if (query) req.validatedQuery = query.parse(req.query ?? {});
    if (params) req.params = params.parse(req.params ?? {});
    next();
  } catch (err) {
    next(err);
  }
};

/** Wraps an async controller so a rejected promise reaches errorHandler. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
