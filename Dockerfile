# --- Stage 1: Builder ---
FROM oven/bun:latest AS builder

WORKDIR /app

# Copy package configuration files
COPY package.json bun.lock ./

# Install all dependencies (including devDependencies needed for static compilation)
RUN bun install --frozen-lockfile

# Copy the rest of the application files
COPY . .

# Compile/build the static frontend assets
RUN bun run build

# --- Stage 2: Final ---
FROM oven/bun:latest

WORKDIR /app

# Install only production dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy built frontend assets and required server files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Expose server port
EXPOSE 6474

# Configure production environment
ENV NODE_ENV=production

# Run the Bun server, listening on port 6474
CMD ["bun", "src/server.tsx", "--port", "6474"]
