param(
 [Parameter(Mandatory=$true)][string]$PackageRoot,
 [Parameter(Mandatory=$true)][string]$InstallRoot,
 [Parameter(Mandatory=$true)][string]$Portal,
 [Parameter(Mandatory=$true)][string]$Code,
 [Parameter(Mandatory=$true)][string[]]$Workspace,
 [Parameter(Mandatory=$true)][string]$Codex,
 [switch]$AuthorizeExecution,[switch]$Startup,[switch]$AcceptLocalBuild
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
if(-not $AuthorizeExecution){throw '必须明确授权工作区。'}
$expectedRoot=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'StopWatchCompanion'))
if([IO.Path]::GetFullPath($InstallRoot) -ne $expectedRoot){throw '安装必须位于当前用户的 StopWatchCompanion 目录。'}
$profile=Get-Content -LiteralPath (Join-Path $PackageRoot 'install-profile.json') -Raw|ConvertFrom-Json
if(-not $profile.production){throw '开发演示包不能安装或绑定正式账号。'}
if($profile.localInstallation -and -not $AcceptLocalBuild){throw '本地联调包没有自动更新信任根，必须明确接受。'}
$origin=[Uri]$Portal
if($origin.Scheme -ne 'https' -or $origin.UserInfo -or $origin.GetLeftPart([UriPartial]::Authority) -cne $profile.origin){throw '控制台地址与安装包不符。'}
if(-not $profile.localInstallation -and -not $profile.updateManifestUrl){throw '正式包缺少更新渠道。'}
if(Test-Path -LiteralPath (Join-Path $InstallRoot 'config.json')){throw '已经安装，请从后台设置管理授权，避免覆盖已有配置。'}
$workspaces=@();$paths=@{}
foreach($entry in $Workspace){
 $folder=(Resolve-Path -LiteralPath $entry.Trim()).Path
 if(-not (Test-Path -LiteralPath $folder -PathType Container)){throw '工作区目录不存在。'}
 if($paths.ContainsKey($folder)){continue};$paths[$folder]=$true
 $workspaces+=@{id=('workspace-'+($workspaces.Count+1));name=[IO.Path]::GetFileName($folder);path=$folder}
}
if($workspaces.Count -lt 1 -or $workspaces.Count -gt 8){throw '请选择 1 至 8 个工作区。'}
$codexPath=(Resolve-Path -LiteralPath $Codex).Path
if([IO.Path]::GetExtension($codexPath) -ne '.exe'){throw '请选择 Codex 可执行程序。'}
$required=@('runtime/node.exe','app/supervisor.mjs','app/bridge.mjs','app/Launch.vbs','app/Settings.vbs','app/Settings.ps1','app/Decrypt-Credential.ps1')
if(-not $profile.localInstallation){$required+='release-public.pem'}
foreach($file in $required){if(-not(Test-Path -LiteralPath (Join-Path $PackageRoot $file) -PathType Leaf)){throw ('安装包缺少 '+$file)}}
$body=@{code=$Code.Trim();name=$env:COMPUTERNAME;protocol=1}|ConvertTo-Json -Compress
$paired=Invoke-RestMethod -Uri ($origin.AbsoluteUri.TrimEnd('/')+'/api/bridge/enroll') -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 20
if($paired.mode -ne 'production' -or $paired.token -notmatch '\A[A-Za-z0-9_-]{32}\z' -or $paired.bridgeId -notmatch '\A[a-f0-9]{16}\z'){throw '服务器未返回有效桥接授权。'}
New-Item -ItemType Directory -Force -Path $InstallRoot|Out-Null
foreach($folder in @('runtime','app')){Copy-Item -LiteralPath (Join-Path $PackageRoot $folder) -Destination $InstallRoot -Recurse -Force}
if(-not $profile.localInstallation){Copy-Item -LiteralPath (Join-Path $PackageRoot 'release-public.pem') -Destination $InstallRoot -Force}
$plain=[Text.Encoding]::UTF8.GetBytes($paired.token)
try{
 $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 [IO.File]::WriteAllBytes((Join-Path $InstallRoot 'credential.dpapi'),$cipher)
}finally{[Array]::Clear($plain,0,$plain.Length);$paired.token=$null}
$configuration=@{mode='production';executionAuthorized=$true;bridgeId=$paired.bridgeId;relayUrl=$origin.AbsoluteUri.TrimEnd('/').Replace('https://','wss://');portal=$origin.AbsoluteUri;workspaces=$workspaces;codex=$codexPath;version=$profile.version;updateManifestUrl=$profile.updateManifestUrl;localInstallation=[bool]$profile.localInstallation}
[IO.File]::WriteAllText((Join-Path $InstallRoot 'config.json'),($configuration|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'StopWatch 设置.lnk'))
$shortcut.TargetPath=Join-Path $env:SystemRoot 'System32/wscript.exe';$shortcut.Arguments='"'+(Join-Path $InstallRoot 'app/Settings.vbs')+'"';$shortcut.Save()
if($Startup){
 $shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'StopWatch Companion.lnk'))
 $shortcut.TargetPath=Join-Path $env:SystemRoot 'System32/wscript.exe';$shortcut.Arguments='"'+(Join-Path $InstallRoot 'app/Launch.vbs')+'"';$shortcut.Save()
}
Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/wscript.exe') -ArgumentList ('"'+(Join-Path $InstallRoot 'app/Launch.vbs')+'"') -WindowStyle Hidden
[PSCustomObject]@{installed=$true;scope='CurrentUser';startup=[bool]$Startup;workspaces=$workspaces.Count;localInstallation=[bool]$profile.localInstallation}
