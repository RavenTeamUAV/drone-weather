# ===== BUILD STAGE =====
FROM node:20-alpine AS base

WORKDIR /app

# Copy dependency manifests first (layer cache optimization)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# ===== RUNTIME =====
FROM node:20-alpine

WORKDIR /app

# Copy installed node_modules from build stage
COPY --from=base /app/node_modules ./node_modules

# Copy application source
COPY . .

# Create data directory (drones.json is part of source, but allow volume override)
RUN mkdir -p data

# Expose application port
EXPOSE 3000

# Health check — polls /api/config every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/config || exit 1

# Run as non-root user for security
USER node

CMD ["node", "server.js"]
