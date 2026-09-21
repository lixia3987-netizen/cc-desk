#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
command -v npm >/dev/null || { echo '请先安装 Node.js 22.12+。'; exit 1; }
if [[ ! -d node_modules ]]; then npm ci; fi
if [[ ! -f dist/main/index.cjs ]]; then npm run build; fi
exec npm start
