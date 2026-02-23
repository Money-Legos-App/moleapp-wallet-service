#!/bin/sh
set -e

echo "=== Wallet Service Production Startup ==="
echo "Environment: ${NODE_ENV:-production}"

# Safely push schema changes to database
# --skip-generate: client already generated at build time
# If Prisma detects destructive changes it will error out (safe default)
echo "Syncing Prisma schema to database..."
if npx prisma db push --skip-generate 2>&1; then
  echo "Schema sync complete."
else
  echo "WARNING: Schema sync failed. Starting with existing schema."
  echo "You may need to run migrations manually if this is a breaking change."
fi

# Start the application
echo "Starting wallet-service..."
exec node dist/index.js
