#!/bin/sh
set -e

echo "=== Wallet Service Production Startup ==="
echo "Environment: ${NODE_ENV:-production}"
echo "Database URL set: ${DATABASE_URL:+yes}"
echo "Port: ${PORT:-3002}"

# Safely push schema changes to database
# --skip-generate: client already generated at build time
# Timeout after 90s to prevent blocking startup
echo "Syncing Prisma schema to database..."
if timeout 90 npx prisma db push --skip-generate 2>&1; then
  echo "Schema sync complete."
else
  echo "WARNING: Schema sync failed or timed out. Starting with existing schema."
  echo "You may need to run migrations manually if this is a breaking change."
fi

# Start the application
echo "Starting wallet-service..."
exec node dist/index.js
