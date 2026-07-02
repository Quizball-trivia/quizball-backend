# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src/

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist/

# Migration runner + the .sql files it applies (used by the Railway
# preDeployCommand `npm run migrate:deploy`). Not compiled by tsc, so copy
# them into the image explicitly — otherwise the pre-deploy step fails with
# MODULE_NOT_FOUND / no migrations to read.
COPY scripts/run-migrations.mjs ./scripts/run-migrations.mjs
COPY supabase/migrations ./supabase/migrations/

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8000/health || exit 1

# Start the server
CMD ["node", "dist/bootstrap.js"]
