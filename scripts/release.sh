#!/usr/bin/env bash
set -euo pipefail

version=$(bun -e "console.log(require('./package.json').version)")
tag="v${version}"

# Pre-flight checks.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree is dirty" >&2
  exit 1
fi

if [ "$(git branch --show-current)" != "main" ]; then
  echo "error: must be on main branch" >&2
  exit 1
fi

if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "error: tag $tag already exists. Bump version in package.json first." >&2
  exit 1
fi

# Build the bundle (includes typecheck + tests + clean dist/).
bun run bundle

# Ensure bundle/check did not introduce uncommitted changes.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree became dirty during bundle/check" >&2
  echo "error: commit generated changes before running release" >&2
  git status --short >&2
  exit 1
fi

# Find the .mcpb file produced by mcpb pack.
# dist/ is cleaned at the start of bundle, so there is exactly one .mcpb file.
mcpb_files=(dist/*.mcpb)
if [ ${#mcpb_files[@]} -ne 1 ]; then
  echo "error: expected exactly one .mcpb file in dist/, found: ${mcpb_files[*]}" >&2
  exit 1
fi
mcpb_file="${mcpb_files[0]}"

# Tag, create release, and upload artifact.
git tag "$tag"
git push origin "$tag"
gh release create "$tag" \
  --title "$tag" \
  --generate-notes \
  "$mcpb_file"
