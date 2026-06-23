# syntax=docker/dockerfile:1

# ── Stage 1: build the React client → client/dist ─────────────────────────────
FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ── Stage 2: runtime — Express serves the API + the built client ──────────────
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# Server production dependencies only.
COPY package*.json ./
RUN npm ci --omit=dev

# Server source + the client build, so app.js finds client/dist/index.html.
COPY server/ ./server/
COPY --from=client /app/client/dist ./client/dist

# Bake the .env into the image root, where server.js expects it
# (server.js loads ../.env relative to server/, i.e. /app/.env).
# NOTE: this puts secrets in the image — fine for now, but prefer ECS task-def
# secrets (Secrets Manager / SSM) later, and keep the image registry private.
COPY .env ./.env

EXPOSE 5000
CMD ["npm", "run", "start"]
