#!/usr/bin/env bash
# CI and local macOS gate. Mirrors verify-windows.ps1.
set -euo pipefail

package=0
for argument in "$@"; do
  case "$argument" in
    --package) package=1 ;;
    *)
      echo "Unknown option: $argument" >&2
      exit 2
      ;;
  esac
done

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run test:ui -- --workers=2
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm audit --audit-level=low
node scripts/audit-dependencies.mjs
node scripts/generate-notices.mjs

if [ "$package" -eq 1 ]; then
  npm run tauri -- build --debug --bundles app
fi

echo 'PASS requested automatic checks. Mac device checks remain separate.'
