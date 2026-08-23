import pino from "pino";
import { LOG_LEVEL, NODE_ENV } from "../configs/envConfig.js";

// Structured JSON in production (ships straight to a log aggregator), colourised
// single-line output in development.
const transport =
  NODE_ENV === "production"
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
      };

export const logger = pino({
  level: LOG_LEVEL,
  transport,
  // Never let a stray credential reach the log stream.
  redact: {
    paths: ["req.headers.authorization", "*.apiKey", "*.password", "*.token"],
    censor: "[redacted]",
  },
});

/** Child logger tagged with a subsystem name, e.g. log("crawler"). */
export const log = (subsystem) => logger.child({ subsystem });
