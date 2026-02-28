#!/bin/sh
set -e

echo "=== Wallet Service Production Startup ==="
echo "Environment: ${NODE_ENV:-production}"
echo "Port: ${PORT:-3002}"

# TEMPORARY: Skip migration to diagnose startup failure
# TODO: Re-enable prisma migrate deploy after fixing root cause
echo "Skipping migration (diagnostic mode)..."

# Start the application
echo "Starting wallet-service..."
exec node dist/index.js
