#!/bin/sh
set -e

echo "=== Wallet Service Production Startup ==="
echo "Environment: ${NODE_ENV:-production}"
echo "Port: ${PORT:-3002}"

# Apply pending Prisma migrations (safe, non-destructive, idempotent)
echo "Applying pending migrations..."
if npx prisma migrate deploy 2>&1; then
  echo "Migrations applied successfully."
else
  echo "WARNING: Migration failed. Starting with existing schema."
fi

# Start the application
echo "Starting wallet-service..."
exec node dist/index.js
