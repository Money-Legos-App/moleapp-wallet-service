#!/bin/bash

# Fix import statements in all TypeScript files
for file in $(find src -name "*.ts"); do
    echo "Fixing $file..."
    # Fix simple imports without destructuring
    sed -i '' 's/import \([A-Za-z_][A-Za-z0-9_]*\) '\'''\([^'\'']*\)'\'''/import \1 from '\''\2'\''/g' "$file"
    # Fix imports with destructuring (basic cases)
    sed -i '' 's/import { \([^}]*\) } '\'''\([^'\'']*\)'\'''/import { \1 } from '\''\2'\''/g' "$file"
    # Fix default + named imports
    sed -i '' 's/import \([A-Za-z_][A-Za-z0-9_]*\), { \([^}]*\) } '\'''\([^'\'']*\)'\'''/import \1, { \2 } from '\''\3'\''/g' "$file"
done
