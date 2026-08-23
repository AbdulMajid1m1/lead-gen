FROM node:22-slim

# openssl is required by Prisma's query engine; curl backs the container
# healthcheck. Everything else the crawler needs is pure JS.
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so a code-only change reuses the cached install layer.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY prisma ./prisma
RUN npx prisma generate --schema=prisma/schema

COPY . .

# The WhatsApp credential directory is a named volume in production. Docker
# creates a missing mount point as root, which would leave it unwritable once
# we drop to `node` below — so it has to exist, owned correctly, in the image.
RUN mkdir -p /app/.baileys_auth

# Never run the crawler as root: it processes untrusted third-party content.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 4100 4101

CMD ["node", "index.js"]
