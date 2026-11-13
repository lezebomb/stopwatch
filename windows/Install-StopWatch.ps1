param([switch]$PlanOnly,[string]$InstallRoot)
$ErrorActionPreference='Stop'
if (-not $InstallRoot) { $InstallRoot=Join-Path $env:LOCALAPPDATA 'StopWatchCompanion' }
$packageRoot=Split-Path $PSScriptRoot -Parent
if ($PlanOnly) { [PSCustomObject]@{Root=$InstallRoot;Scope='CurrentUser';Admin=$false;Startup='Opt-in per-user shortcut';Executed=$false} | ConvertTo-Json; exit 0 }
$installProfile=Get-Content -LiteralPath (Join-Path $packageRoot 'install-profile.json') -Raw|ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Security
$form=New-Object Windows.Forms.Form
$form.Text='StopWatch 伴侣 · 首次安装与授权';$form.Size=New-Object Drawing.Size(540,530);$form.StartPosition='CenterScreen'
$heading=New-Object Windows.Forms.Label;$heading.Text='一次安装，以后自动陪伴。';$heading.Location=New-Object Drawing.Point(25,20);$heading.Size=New-Object Drawing.Size(470,35);$heading.Font=New-Object Drawing.Font('Microsoft YaHei',15);$form.Controls.Add($heading)
$controls=@{}
$fields=@(@('Relay','控制台地址（https://）'),@('Code','控制台生成的两分钟电脑授权码'),@('Workspace','工作区目录（多个目录用 | 分隔）'),@('Codex','本机 Codex CLI 路径（codex.exe）'))
$row=75
foreach($field in $fields){$label=New-Object Windows.Forms.Label;$label.Text=$field[1];$label.Location=New-Object Drawing.Point(25,$row);$label.Size=New-Object Drawing.Size(470,22);$form.Controls.Add($label);$text=New-Object Windows.Forms.TextBox;$text.Location=New-Object Drawing.Point(25,($row+24));$text.Size=New-Object Drawing.Size(470,26);if($field[0] -eq 'Code'){$text.UseSystemPasswordChar=$true};$form.Controls.Add($text);$controls[$field[0]]=$text;$row+=72}
foreach($kind in @('Workspace','Codex')){
 $controls[$kind].Width=365;$browse=New-Object Windows.Forms.Button;$browse.Text='浏览…';$browse.Tag=$kind;$browse.Location=New-Object Drawing.Point(400,$controls[$kind].Top);$browse.Size=New-Object Drawing.Size(95,26)
 $browse.Add_Click({if($this.Tag -eq 'Workspace'){$dialog=New-Object Windows.Forms.FolderBrowserDialog;if($dialog.ShowDialog() -eq 'OK'){$controls.Workspace.Text=if($controls.Workspace.Text){$controls.Workspace.Text+'|'+$dialog.SelectedPath}else{$dialog.SelectedPath}}}else{$dialog=New-Object Windows.Forms.OpenFileDialog;$dialog.Filter='Codex 程序 (codex.exe)|codex.exe';if($dialog.ShowDialog() -eq 'OK'){$controls.Codex.Text=$dialog.FileName}};$dialog.Dispose()});$form.Controls.Add($browse)
}
$found=Get-Command codex.exe -ErrorAction SilentlyContinue;if($found){$controls.Codex.Text=$found.Source}
if($installProfile.origin){$controls.Relay.Text=$installProfile.origin;$controls.Relay.ReadOnly=$true}
$consent=New-Object Windows.Forms.CheckBox;$consent.Text='授权在此工作区远程使用 Codex；每次敏感操作仍需审批';$consent.Location=New-Object Drawing.Point(25,370);$consent.Size=New-Object Drawing.Size(480,24);$form.Controls.Add($consent)
$startup=New-Object Windows.Forms.CheckBox;$startup.Text='登录 Windows 后自动在后台运行';$startup.Checked=$true;$startup.Location=New-Object Drawing.Point(25,400);$startup.Size=New-Object Drawing.Size(470,24);$form.Controls.Add($startup)
$button=New-Object Windows.Forms.Button;$button.Text='安装并完成一次性配对';$button.Location=New-Object Drawing.Point(25,438);$button.Size=New-Object Drawing.Size(470,36);$form.Controls.Add($button)
$button.Add_Click({try{
 if(-not $consent.Checked){throw '请明确授权所选工作区的远程 Codex 操作。'}
 if($installProfile.localInstallation){
  if([Windows.Forms.MessageBox]::Show('本地联调安装包尚未配置正式自动更新。授权的工作区将可由手机控制。是否继续？','StopWatch 本地安装','YesNo') -ne 'Yes'){return}
 }
 $button.Enabled=$false
 & (Join-Path $PSScriptRoot 'Install-Core.ps1') -PackageRoot $packageRoot -InstallRoot $InstallRoot -Portal $controls.Relay.Text.Trim() -Code $controls.Code.Text.Trim() -Workspace ($controls.Workspace.Text -split '\|') -Codex $controls.Codex.Text.Trim() -AuthorizeExecution -Startup:$startup.Checked -AcceptLocalBuild:$installProfile.localInstallation | Out-Null
 [Windows.Forms.MessageBox]::Show('已安装。后台状态和停止/卸载入口在开始菜单的“StopWatch 设置”。','StopWatch');$form.Close()
 }catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message,'安装未完成');$button.Enabled=$true}})
[void]$form.ShowDialog()
