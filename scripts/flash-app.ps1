param([string]$Port = '-', [switch]$CaptureBoot, [switch]$Release, [switch]$Realtime)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$python = (Resolve-Path '.tools/espressif/python_env/idf6.0_py3.12_env/Scripts/python.exe').Path
$sessionPath = Join-Path (Get-Location) '.data/hardware-session.json'
$session = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
if (-not $session.backupVerified) { throw 'Verified original factory backup required.' }
$backup = Join-Path $session.backup 'original-16MB.bin'
$expectedHash = (Get-Content -LiteralPath (Join-Path $session.backup 'sha256.txt') -Raw).Split()[0]
if ((Get-Item -LiteralPath $backup).Length -ne 16777216 -or (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Original backup is missing or damaged.' }
$plan = Get-Content -LiteralPath $session.firstInstallPlan -Raw | ConvertFrom-Json
$partition = $plan | Where-Object file -EQ 'partition_table/partition-table.bin'
$build = if ($Release) { 'firmware/build-release' } else { 'firmware/build' }
if ($Realtime) { $build += '-realtime' }
$table = Join-Path $build 'partition_table/partition-table.bin'
if ((Get-FileHash -LiteralPath $table -Algorithm SHA256).Hash -ne $partition.sha256) { throw 'Partition layout changed; migration assessment required.' }
$image = (Resolve-Path (Join-Path $build 'muse-gadget.bin')).Path
if ((Get-Item -LiteralPath $image).Length -gt 4194304) { throw 'Application exceeds 4MiB OTA slot.' }
$security = Get-Content -LiteralPath (Join-Path $session.backup 'device-security.log') -Raw
$identity = [regex]::Match($security, '(?m)^MAC:\s+([0-9a-fA-F:]+)').Groups[1].Value
if (-not $identity) { throw 'Original device identity is not recorded.' }
$detect = @'
import sys
from serial.tools.list_ports import comports
matches=[p.device for p in comports() if p.vid==0x303a and p.pid==0x1001 and (p.serial_number or '').replace(':','').lower()==sys.argv[2].replace(':','').lower() and (sys.argv[1]=='-' or p.device==sys.argv[1])]
if len(matches)!=1:raise SystemExit('Original StopWatch USB device not uniquely connected')
print(matches[0])
'@
$selectedPort = (& $python -c $detect $Port $identity | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Device identity check failed.' }
$verifyKey = if ($Release) {
    (Get-Content -LiteralPath 'release/config.json' -Raw | ConvertFrom-Json).productionPublicKey
} else { '.deps/muse/esp32/dev_signing_key.pem' }
& $python -m espsecure verify-signature --version 2 --keyfile $verifyKey $image *> .data/app-signature-check.log
if ($LASTEXITCODE -ne 0) { throw 'Image signature does not match the selected release or development trust profile.' }
& $python scripts/flash-slot.py $selectedPort $table $image *> .data/app-slot-check.log
if ($LASTEXITCODE -ne 0) { throw 'Live safety checks failed; see .data/app-slot-check.log. No application was written.' }
$slotLine = @(Get-Content -LiteralPath .data/app-slot-check.log | Where-Object { $_ -match '^@slot ' })
if ($slotLine.Count -ne 1) { throw 'Could not identify the stable boot slot.' }
$slot = $slotLine[0].Substring(6) | ConvertFrom-Json
if ($slot.offset -notin @('0x20000', '0x420000')) { throw 'Invalid application offset.' }
$offset = $slot.offset
$digest = (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash
if ($slot.identical) {
    Write-Output "Existing application at $offset verified identical; no Flash write performed."
    exit 0
}
# Never consume flash_args here: it may still contain FIRST-install assets.
$after = if ($CaptureBoot) { 'no-reset' } else { 'hard-reset' }
& $python -m esptool --chip esp32s3 --port $selectedPort --baud 921600 --after $after write-flash --flash-size keep $offset $image *> .data/app-last-write.log
if ($LASTEXITCODE -ne 0) { throw 'Application write failed; private log retained in .data.' }
$session | Add-Member -NotePropertyName lastFlashedSha256 -NotePropertyValue $digest -Force
[IO.File]::WriteAllText($sessionPath, ($session | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Write-Output "Application written and verified on $selectedPort at $offset."
if ($CaptureBoot) {
    & $python scripts/serial-capture.py --port $selectedPort --reset --seconds 38 --log .data/app-last-boot.log
    if ($LASTEXITCODE -ne 0) { throw 'Application verified, but boot capture failed.' }
    if (-not (Select-String -LiteralPath .data/app-last-boot.log -Quiet -SimpleMatch "Loaded app from partition at offset $offset")) {
        throw 'Application verified, but the expected slot was not confirmed in the boot log.'
    }
}
