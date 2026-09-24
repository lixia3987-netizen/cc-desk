$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 22.12+。' }
  if (-not (Test-Path 'node_modules')) { npm ci; if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' } }
  if (-not (Test-Path 'apps/desktop/dist/main/index.cjs')) { npm run build; if ($LASTEXITCODE -ne 0) { throw '构建失败。' } }
  npm start
  if ($LASTEXITCODE -ne 0) { throw '启动失败，请检查上面的错误。' }
} finally { Pop-Location }
