#!/usr/bin/env bash
# Regenerates the tracked IDL copy (app/idl/) from the Anchor build output in target/ (git-ignored),
# so CI and containers that never run `anchor build` can still build the app and the backend's
# layout lookup (backend/src/layout.ts). Run this after building the DEMO feature set:
#
#   export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
#   make program-keypair && anchor build -- --features demo
#   scripts/sync-idl.sh
#
# Refuses a release-build IDL (CLAIM_WINDOW_SECS must be 10, DISPUTE_WINDOW_SECS must be 30 -- a
# release build has 1_209_600 for both, docs/contracts/program-interface.md §5), so a stale or
# wrongly-featured build fails here instead of silently shipping the wrong timing to the app.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_IDL="$REPO_ROOT/target/idl/relstate.json"
TARGET_TYPES="$REPO_ROOT/target/types/relstate.ts"
OUT_DIR="$REPO_ROOT/app/idl"

if [[ ! -f "$TARGET_IDL" ]] || [[ ! -f "$TARGET_TYPES" ]]; then
  echo "error: $TARGET_IDL or $TARGET_TYPES not found." >&2
  echo "       build the demo IDL first:" >&2
  echo "         export PATH=\"\$HOME/.cargo/bin:\$HOME/.local/share/solana/install/active_release/bin:\$HOME/.local/bin:\$PATH\"" >&2
  echo "         make program-keypair && anchor build -- --features demo" >&2
  exit 1
fi

read_constant() {
  node -e '
    const idl = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const c = (idl.constants ?? []).find((c) => c.name === process.argv[2]);
    if (!c) { console.error(`${process.argv[2]} not found in the IDL`); process.exit(1); }
    console.log(c.value);
  ' "$TARGET_IDL" "$1"
}

CLAIM_WINDOW_SECS="$(read_constant CLAIM_WINDOW_SECS)"
DISPUTE_WINDOW_SECS="$(read_constant DISPUTE_WINDOW_SECS)"

if [[ "$CLAIM_WINDOW_SECS" != "10" ]]; then
  echo "error: target/idl/relstate.json has CLAIM_WINDOW_SECS=$CLAIM_WINDOW_SECS, expected 10 (the demo build)." >&2
  echo "       this looks like a release build, or a stale one. Rebuild with: anchor build -- --features demo" >&2
  exit 1
fi
if [[ "$DISPUTE_WINDOW_SECS" != "30" ]]; then
  echo "error: target/idl/relstate.json has DISPUTE_WINDOW_SECS=$DISPUTE_WINDOW_SECS, expected 30 (the demo build)." >&2
  echo "       this looks like a release build, or a stale one. Rebuild with: anchor build -- --features demo" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cp "$TARGET_IDL" "$OUT_DIR/relstate.json"
cp "$TARGET_TYPES" "$OUT_DIR/relstate.ts"

echo "synced app/idl/relstate.json and app/idl/relstate.ts from target/ (CLAIM_WINDOW_SECS=10, DISPUTE_WINDOW_SECS=30)"
