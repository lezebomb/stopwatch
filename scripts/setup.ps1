$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force '.deps','.tools' | Out-Null
$env:UV_PYTHON_INSTALL_DIR = Join-Path (Get-Location) '.tools/python'
$env:UV_CACHE_DIR = Join-Path (Get-Location) '.tools/uv-cache'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'Install the portable uv utility first (https://docs.astral.sh/uv/); no administrator installation is needed.' }
uv python install 3.12
$lock = Get-Content upstream.lock.json -Raw | ConvertFrom-Json
if (-not (Test-Path '.deps/muse/.git')) { git -c http.sslBackend=openssl clone $lock.muse.url .deps/muse; if ($LASTEXITCODE -ne 0) { throw 'Muse clone failed' } }
git -c "safe.directory=$((Get-Location).Path.Replace('\','/'))/.deps/muse" -C .deps/muse checkout $lock.muse.commit
if (-not (Test-Path '.deps/esp-idf/.git')) { git -c http.sslBackend=openssl clone --depth 1 --branch $lock.espIdf.tag --recursive --shallow-submodules $lock.espIdf.url .deps/esp-idf; if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF clone failed' } }
$env:IDF_PATH = Join-Path (Get-Location) '.deps/esp-idf'
$env:IDF_TOOLS_PATH = Join-Path (Get-Location) '.tools/espressif'
$env:IDF_GITHUB_ASSETS = 'dl.espressif.com/github_assets'
$python = Get-ChildItem .tools/python -Directory | Where-Object Name -Like 'cpython-3.12*' | Select-Object -First 1
& (Join-Path $python.FullName 'python.exe') .deps/esp-idf/tools/idf_tools.py --non-interactive install --targets esp32s3
if ($LASTEXITCODE -ne 0) { throw 'Toolchain install failed' }
& (Join-Path $python.FullName 'python.exe') .deps/esp-idf/tools/idf_tools.py --non-interactive install-python-env
if ($LASTEXITCODE -ne 0) { throw 'Python environment install failed' }
npm.cmd ci --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Node dependency installation failed' }
uv pip install --python (Join-Path $python.FullName 'python.exe') --target .tools/host ziglang==0.14.1
if ($LASTEXITCODE -ne 0) { throw 'Host C test compiler installation failed' }
node scripts/assets.mjs
Write-Output 'Project-only environment ready. Run scripts/build-firmware.ps1 next.'
