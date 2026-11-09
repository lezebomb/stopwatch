$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$env:IDF_PATH = Join-Path $projectRoot '.deps/esp-idf'
$env:IDF_TOOLS_PATH = Join-Path $projectRoot '.tools/espressif'
$env:IDF_GITHUB_ASSETS = 'dl.espressif.com/github_assets'
$basePython = Get-ChildItem -LiteralPath (Join-Path $projectRoot '.tools/python') -Directory | Where-Object Name -Like 'cpython-3.12*' | Select-Object -First 1
if (-not $basePython) { throw 'Run scripts/setup.ps1 first.' }
$env:PATH = $basePython.FullName + ';' + $env:PATH
$env:GIT_CONFIG_COUNT = '3'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = $projectRoot.Replace('\','/')
$env:GIT_CONFIG_KEY_1 = 'safe.directory'
$env:GIT_CONFIG_VALUE_1 = (Join-Path $projectRoot '.deps/esp-idf').Replace('\','/')
$env:GIT_CONFIG_KEY_2 = 'safe.directory'
$env:GIT_CONFIG_VALUE_2 = (Join-Path $projectRoot '.deps/muse').Replace('\','/')
. (Join-Path $env:IDF_PATH 'export.ps1')
if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF export failed' }
