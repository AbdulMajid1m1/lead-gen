import { PrismaClient } from "@prisma/client";
import { NODE_ENV } from "./configs/envConfig.js";

const prisma = new PrismaClient({
  log: NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export default prisma;
