param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$cipher=[System.IO.File]::ReadAllBytes((Join-Path $Root 'credential.dpapi'))
$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
try { [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain)) } finally { [Array]::Clear($plain,0,$plain.Length) }
