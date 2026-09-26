#!/usr/bin/env bash
# Petri stage demo:
#   1. Verify       a second key re-runs a version and signs the result.
#   2. Selfie Check the World ID page opens. Its section 2 runs a real Selfie Check
#                   through IDKit and World App.
#
#   ./demo/verify-demo.sh [nodeId]        # default: ae0acec3
#
# Before the demo, run `npm run dev` at the repository root.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE="${1:-ae0acec3}"
KEY="${PETRI_DEMO_KEY:-$HOME/petri-demo-keys/k3}"
URL="http://localhost:3000/world"

P=$'\033[35m'; B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
step () { printf '\n%s━━ %s %s\n\n' "$P$B" "$1" "$R"; }

step "1/2  Verify $NODE"
echo "${D}\$ PETRI_HOME=$KEY pnpm petri verify $NODE${R}"
PETRI_HOME="$KEY" pnpm -s petri verify "$NODE" | grep -v '^world id\|^selfie '

step "2/2  Selfie Check"
echo "Opening $URL"
echo "Run the Selfie Check in section 2 of the page."
if command -v open >/dev/null 2>&1; then open "$URL"; fi
