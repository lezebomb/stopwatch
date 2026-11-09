param([string]$Port = '-')
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
if ((Get-FileHash -LiteralPath 'firmware/build/partition_table/partition-table.bin' -Algorithm SHA256).Hash -ne $partition.sha256) { throw 'Partition layout changed; migration assessment required.' }
$image = (Resolve-Path 'firmware/build/muse-gadget.bin').Path
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
# A development-only helper: production keys are never silently substituted.
& $python -m espsecure verify-signature --version 2 --keyfile .deps/muse/esp32/dev_signing_key.pem $image *> .data/app-signature-check.log
if ($LASTEXITCODE -ne 0) { throw 'Development image signature check failed.' }
& $python -m esptool --chip esp32s3 --port $selectedPort --baud 921600 --after hard-reset get-security-info *> .data/app-security-check.log
if ($LASTEXITCODE -ne 0) { throw 'Could not read device security state.' }
$currentSecurity = Get-Content -LiteralPath .data/app-security-check.log -Raw
if ($currentSecurity -notmatch 'Secure Boot: Disabled' -or $currentSecurity -notmatch 'Flash Encryption: Disabled') { throw 'Protected device: stop and assess the existing security configuration.' }
$digest = (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash
if ($session.lastFlashedSha256 -eq $digest) {
    & $python -m esptool --chip esp32s3 --port $selectedPort --baud 921600 --after hard-reset verify-flash 0x20000 $image *> .data/app-verify-identical.log
    if ($LASTEXITCODE -eq 0) { Write-Output 'Existing application verified identical; no Flash write performed.'; exit 0 }
}
# Never consume flash_args here: it may still contain FIRST-install assets.
& $python -m esptool --chip esp32s3 --port $selectedPort --baud 921600 --after hard-reset write-flash --flash-size keep 0x20000 $image *> .data/app-last-write.log
if ($LASTEXITCODE -ne 0) { throw 'Application write failed; private log retained in .data.' }
$session | Add-Member -NotePropertyName lastFlashedSha256 -NotePropertyValue $digest -Force
[IO.File]::WriteAllText($sessionPath, ($session | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Write-Output ('Application written and verified on ' + $selectedPort + '; no NVS, photos, partition-table, Bootloader or eFuse writes.')
