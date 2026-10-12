#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
