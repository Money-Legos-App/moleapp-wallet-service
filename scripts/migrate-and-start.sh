#!/bin/bash

# Exit on any error
set -e

echo "Starting Wallet Service v2.0.0..."
echo "Environment: $NODE_ENV"

# Generate Prisma client (schema already pushed by db-migrate init container)
echo "Generating Prisma client..."
npx prisma generate

# Start the application
echo "Starting Wallet Service..."
if [ "$NODE_ENV" = "production" ]; then
  npm run build && npm start
else
  npm run dev
fi
