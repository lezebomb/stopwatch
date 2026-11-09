param([switch]$Realtime, [switch]$FactoryAssets, [switch]$Release)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if ($Release) { $env:SW_PRODUCTION='1' } else { $env:SW_PRODUCTION='0' }
node scripts/prepare-firmware.mjs
if ($LASTEXITCODE -ne 0) { throw 'Firmware preparation failed' }
. "$PSScriptRoot/idf-env.ps1"
$sdkRoot = (Resolve-Path '.deps/muse/esp32').Path
$buildRoot = Join-Path (Get-Location) 'firmware/build'
$defaults = 'sdkconfig.defaults;devices/sdkconfig.muse;devices/sdkconfig.muse-m5stack-stopwatch;sdkconfig.companion'
if ($Release) { $defaults += ';sdkconfig.release'; $buildRoot += '-release' }
$version = (Get-Content release/config.json -Raw | ConvertFrom-Json).version
$factory = if ($FactoryAssets) { 'ON' } else { 'OFF' }
$env:SW_ALLOW_FACTORY_ASSETS = if ($FactoryAssets) { '1' } else { '' }
if ($Realtime) {
    Set-Content -LiteralPath (Join-Path $sdkRoot 'sdkconfig.realtime') -Value 'CONFIG_MUSE_REALTIME_VOICE=y' -Encoding utf8
    $defaults += ';sdkconfig.realtime'
    $buildRoot += '-realtime'
}
Push-Location $sdkRoot
try {
    $buildArguments = @('-B', $buildRoot)
    $cacheFile = Join-Path $buildRoot 'CMakeCache.txt'
    $reuseConfiguration = (Test-Path -LiteralPath $cacheFile) -and (Test-Path -LiteralPath (Join-Path $buildRoot 'build.ninja')) -and -not $Release
    if ($reuseConfiguration) {
        $cacheText = [IO.File]::ReadAllText($cacheFile)
        foreach ($entry in @{IDF_TARGET='esp32s3';PROJECT_VER=$version;SW_FACTORY_ASSETS=$factory;SDKCONFIG_DEFAULTS=$defaults}.GetEnumerator()) {
            $pattern = '(?m)^' + [regex]::Escape($entry.Key) + ':[^=]+=' + [regex]::Escape($entry.Value) + '\r?$'
            if ($cacheText -notmatch $pattern) { $reuseConfiguration = $false; break }
        }
    }
    if ($reuseConfiguration) {
        Write-Output 'Using matching CMake configuration; incremental build without forced dependency resolution.'
    } else {
        $buildArguments += @('-D', 'IDF_TARGET=esp32s3', '-D', "PROJECT_VER=$version", '-D', "SW_FACTORY_ASSETS=$factory", '-D', "SDKCONFIG_DEFAULTS=$defaults")
    }
    python "$env:IDF_PATH/tools/idf.py" @buildArguments build
    if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF firmware build failed' }
} finally { Pop-Location }
Copy-Item -LiteralPath (Join-Path $buildRoot 'muse-gadget.bin') -Destination 'artifacts/stopwatch.bin'
node scripts/check-firmware-config.mjs $buildRoot
if ($LASTEXITCODE -ne 0) { throw 'Firmware security/layout check failed' }
Write-Output 'Built artifacts/stopwatch.bin. No flash or device operation was performed.'
