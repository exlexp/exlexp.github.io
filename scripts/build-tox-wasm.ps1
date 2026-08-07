$ErrorActionPreference = 'Stop'

$WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Drive = $WorkspaceRoot.Substring(0, 1).ToLowerInvariant()
$UnixPath = $WorkspaceRoot.Substring(2).Replace('\', '/')
$WslWorkspace = "/mnt/$Drive$UnixPath"

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw 'WSL2 is required for the reproducible Emscripten build on Windows.'
}

wsl.exe -d ubuntu -- bash -lc "cd '$WslWorkspace' && sh scripts/build-tox-wasm-wsl.sh"
if ($LASTEXITCODE -ne 0) {
  throw "Tox WebAssembly build failed with exit code $LASTEXITCODE."
}

Write-Host 'Built public/tox/toxcore.mjs and public/tox/toxcore.wasm.'
