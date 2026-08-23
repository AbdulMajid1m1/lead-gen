process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rootRouter from "./routes/RootRoute.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
import { generalLimiter } from "./middlewares/rateLimiter.js";
import { PORT, NODE_ENV, ALLOWED_ORIGINS } from "./configs/envConfig.js";
import { logger } from "./utils/logger.js";
import prisma from "./prismaClient.js";

const app = express();

// This API serves JSON only and renders no HTML, so the CSP can be maximally
// tight — nothing is ever loaded from it by a browser directly.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
  }),
);

app.use(
  cors({
    origin: (origin, cb) => {
      // No Origin header means a server-to-server call or a curl — allowed.
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: ${origin} is not an allowed origin`));
    },
    credentials: true,
  }),
);

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Lightweight request logging: one line per request, with duration.
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "debug";
    logger[level]({ method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - startedAt }, "request");
  });
  next();
});

app.use("/api", generalLimiter);
app.use("/api", rootRouter);
app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, env: NODE_ENV }, "LeadSignal API listening");
});

// SSE streams hold connections open; give them a chance to close cleanly
// before tearing down the database pool.
const shutdown = async (signal) => {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
