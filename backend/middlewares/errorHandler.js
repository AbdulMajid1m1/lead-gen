import { ZodError } from "zod";
import { logger } from "../utils/logger.js";
import { NODE_ENV } from "../configs/envConfig.js";

/**
 * Terminal error middleware. Every response in this API is
 * `{ success, message, data? }` — errors keep the same envelope so the
 * frontend never has to branch on shape.
 */
export const errorHandler = (err, req, res, next) => {
  // A streamed response (CSV export) may have already flushed headers; writing
  // JSON on top would corrupt the stream. Let Express finalise instead.
  if (res.headersSent) return next(err);

  // Zod failures are always caller error, never 500.
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return res.status(400).json({
      success: false,
      message: first ? `${first.path.join(".") || "body"}: ${first.message}` : "Invalid request.",
      code: "VALIDATION_ERROR",
      field: first?.path?.join("."),
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const status = err.status || 500;
  const message = status === 500 && NODE_ENV === "production"
    ? "Internal Server Error"
    : err.message || "Internal Server Error";

  // 5xx is a bug in our code and gets a stack; 4xx is expected traffic.
  if (status >= 500) {
    logger.error({ err, url: req.originalUrl, method: req.method }, "request failed");
  } else {
    logger.debug({ status, url: req.originalUrl, message }, "request rejected");
  }

  const payload = { success: false, message };
  if (err.field) payload.field = err.field;
  if (err.code) payload.code = err.code;
  if (err.details) payload.details = err.details;
  res.status(status).json(payload);
};

/** 404 fallthrough — mounted after all routes, before errorHandler. */
export const notFoundHandler = (req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
};
