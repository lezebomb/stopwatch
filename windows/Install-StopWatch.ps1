param([switch]$PlanOnly,[string]$InstallRoot)
$ErrorActionPreference='Stop'
if (-not $InstallRoot) { $InstallRoot=Join-Path $env:LOCALAPPDATA 'StopWatchCompanion' }
$packageRoot=Split-Path $PSScriptRoot -Parent
if ($PlanOnly) { [PSCustomObject]@{Root=$InstallRoot;Scope='CurrentUser';Admin=$false;Startup='Opt-in per-user shortcut';Executed=$false} | ConvertTo-Json; exit 0 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Security
$form=New-Object Windows.Forms.Form
$form.Text='StopWatch 伴侣 · 首次安装与授权';$form.Size=New-Object Drawing.Size(540,530);$form.StartPosition='CenterScreen'
$heading=New-Object Windows.Forms.Label;$heading.Text='一次安装，以后自动陪伴。';$heading.Location=New-Object Drawing.Point(25,20);$heading.Size=New-Object Drawing.Size(470,35);$heading.Font=New-Object Drawing.Font('Microsoft YaHei',15);$form.Controls.Add($heading)
$controls=@{}
$fields=@(@('Relay','控制台地址（https://）'),@('Code','控制台生成的两分钟电脑授权码'),@('Workspace','允许 Codex 操作的工作区目录'),@('Codex','本机 Codex CLI 路径（codex.exe）'))
$row=75
foreach($field in $fields){$label=New-Object Windows.Forms.Label;$label.Text=$field[1];$label.Location=New-Object Drawing.Point(25,$row);$label.Size=New-Object Drawing.Size(470,22);$form.Controls.Add($label);$text=New-Object Windows.Forms.TextBox;$text.Location=New-Object Drawing.Point(25,($row+24));$text.Size=New-Object Drawing.Size(470,26);if($field[0] -eq 'Code'){$text.UseSystemPasswordChar=$true};$form.Controls.Add($text);$controls[$field[0]]=$text;$row+=72}
foreach($kind in @('Workspace','Codex')){
 $controls[$kind].Width=365;$browse=New-Object Windows.Forms.Button;$browse.Text='浏览…';$browse.Tag=$kind;$browse.Location=New-Object Drawing.Point(400,$controls[$kind].Top);$browse.Size=New-Object Drawing.Size(95,26)
 $browse.Add_Click({if($this.Tag -eq 'Workspace'){$dialog=New-Object Windows.Forms.FolderBrowserDialog;if($dialog.ShowDialog() -eq 'OK'){$controls.Workspace.Text=$dialog.SelectedPath}}else{$dialog=New-Object Windows.Forms.OpenFileDialog;$dialog.Filter='Codex 程序 (codex.exe)|codex.exe';if($dialog.ShowDialog() -eq 'OK'){$controls.Codex.Text=$dialog.FileName}};$dialog.Dispose()});$form.Controls.Add($browse)
}
$found=Get-Command codex.exe -ErrorAction SilentlyContinue;if($found){$controls.Codex.Text=$found.Source}
$consent=New-Object Windows.Forms.CheckBox;$consent.Text='授权在此工作区远程使用 Codex；每次敏感操作仍需审批';$consent.Location=New-Object Drawing.Point(25,370);$consent.Size=New-Object Drawing.Size(480,24);$form.Controls.Add($consent)
$startup=New-Object Windows.Forms.CheckBox;$startup.Text='登录 Windows 后自动在后台运行';$startup.Checked=$true;$startup.Location=New-Object Drawing.Point(25,400);$startup.Size=New-Object Drawing.Size(470,24);$form.Controls.Add($startup)
$button=New-Object Windows.Forms.Button;$button.Text='安装并完成一次性配对';$button.Location=New-Object Drawing.Point(25,438);$button.Size=New-Object Drawing.Size(470,36);$form.Controls.Add($button)
$button.Add_Click({try{
 if(-not $consent.Checked){throw '请明确授权所选工作区的远程 Codex 操作。'}
$installProfile=Get-Content -LiteralPath (Join-Path $packageRoot 'install-profile.json') -Raw|ConvertFrom-Json
 if(-not $installProfile.production){throw '这是开发安装包，禁止用于正式账户授权。维护者应发布已配置生产信任根的安装包。'}
 $origin=[Uri]$controls.Relay.Text.Trim();if($origin.Scheme -ne 'https' -or $origin.UserInfo -or $origin.AbsolutePath -ne '/'){throw '请输入仅含域名的 HTTPS 控制台地址。'}
 $workspace=(Resolve-Path -LiteralPath $controls.Workspace.Text).Path;if(-not (Test-Path -LiteralPath $workspace -PathType Container)){throw '请选择存在的工作区目录。'}
 $codex=(Resolve-Path -LiteralPath $controls.Codex.Text).Path;if([IO.Path]::GetExtension($codex) -ne '.exe'){throw '请选择 Codex 可执行程序。'}
 $button.Enabled=$false
 $body=@{code=$controls.Code.Text.Trim();name=$env:COMPUTERNAME;protocol=1}|ConvertTo-Json
 $paired=Invoke-RestMethod -Uri ($origin.AbsoluteUri.TrimEnd('/')+'/api/bridge/enroll') -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15
 if(-not $paired.token -or -not $paired.bridgeId){throw '中转服务没有返回有效设备授权。'}
 New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
 if(-not (Test-Path -LiteralPath (Join-Path $packageRoot 'runtime/node.exe'))){throw '安装包缺少 Node 运行时；无需自行安装 Node，请重新下载完整安装包。'}
 Copy-Item -LiteralPath (Join-Path $packageRoot 'runtime') -Destination $InstallRoot -Recurse -Force
 Copy-Item -LiteralPath (Join-Path $packageRoot 'app') -Destination $InstallRoot -Recurse -Force
 Copy-Item -LiteralPath (Join-Path $packageRoot 'release-public.pem') -Destination $InstallRoot -Force
 $plain=[Text.Encoding]::UTF8.GetBytes($paired.token);$cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Array]::Clear($plain,0,$plain.Length);[IO.File]::WriteAllBytes((Join-Path $InstallRoot 'credential.dpapi'),$cipher)
 @{mode='production';executionAuthorized=$true;bridgeId=$paired.bridgeId;relayUrl=$origin.AbsoluteUri.TrimEnd('/').Replace('https://','wss://');portal=$origin.AbsoluteUri;workspaces=@(@{id='primary';name=[IO.Path]::GetFileName($workspace);path=$workspace});codex=$codex;version=$installProfile.version;updateManifestUrl='https://github.com/lezebomb/stopwatch/releases/latest/download/bridge-manifest.json'}|ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $InstallRoot 'config.json') -Encoding utf8
 $shortcutRoot=[Environment]::GetFolderPath('Programs');$shell=New-Object -ComObject WScript.Shell;$shortcut=$shell.CreateShortcut((Join-Path $shortcutRoot 'StopWatch 设置.lnk'));$shortcut.TargetPath=Join-Path $env:SystemRoot 'System32/wscript.exe';$shortcut.Arguments='"'+(Join-Path $InstallRoot 'app/Settings.vbs')+'"';$shortcut.Save()
 if($startup.Checked){$shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'StopWatch Companion.lnk'));$shortcut.TargetPath=Join-Path $env:SystemRoot 'System32/wscript.exe';$shortcut.Arguments='"'+(Join-Path $InstallRoot 'app/Launch.vbs')+'"';$shortcut.Save()}
 Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/wscript.exe') -ArgumentList ('"'+(Join-Path $InstallRoot 'app/Launch.vbs')+'"') -WindowStyle Hidden
 [Windows.Forms.MessageBox]::Show('已安装。后台状态和停止/卸载入口在开始菜单的“StopWatch 设置”。','StopWatch');$form.Close()
 }catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message,'安装未完成');$button.Enabled=$true}})
[void]$form.ShowDialog()
