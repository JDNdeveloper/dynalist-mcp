#!/usr/bin/env bash
set -euo pipefail

# Typecheck and test.
bun run typecheck
bun test

# Clean build directory.
rm -rf dist
mkdir dist

# Bundle server into a single JS file.
bun build src/index.ts --target=node --outfile=dist/index.js

# Generate manifest from package.json.
bun scripts/generate-manifest.ts

# Copy icon, validate, and pack.
cp assets/icon-512.png assets/icon-256.png assets/icon-128.png dist/
bunx mcpb validate dist/manifest.json

version=$(bun -e "console.log(require('./package.json').version)")
bunx mcpb pack dist "dist/dynalist-${version}.mcpb"
