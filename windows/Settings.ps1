$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Security
$root=Join-Path $env:LOCALAPPDATA 'StopWatchCompanion'
function Stop-OwnedBridge {
 Set-Content -LiteralPath (Join-Path $root 'stop.request') -Value 'stop' -Encoding ascii
 Start-Sleep -Seconds 2
 $file=Join-Path $root 'status.json'
 if(Test-Path -LiteralPath $file){$state=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json;foreach($processId in @($state.pid,$state.supervisorPid)){if($processId){$process=Get-Process -Id $processId -ErrorAction SilentlyContinue;if($process -and $process.Path -eq (Join-Path $root 'runtime/node.exe')){Stop-Process -Id $processId}}}}
 Remove-Item -LiteralPath (Join-Path $root 'supervisor.lock') -ErrorAction SilentlyContinue
}
function Revoke-OwnedCredential {
 $credential=Join-Path $root 'credential.dpapi';$remote=$false
 if(Test-Path -LiteralPath $credential){
  try {
   $config=Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw|ConvertFrom-Json
   $portal=[Uri]$config.portal;if($portal.Scheme -ne 'https' -or $portal.UserInfo){throw 'Invalid portal'}
   $plain=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($credential),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
   $token=[Text.Encoding]::UTF8.GetString($plain)
   Invoke-RestMethod -Uri ($portal.AbsoluteUri.TrimEnd('/')+'/api/bridge/revoke-self') -Method Post -Headers @{Authorization=('Bearer '+$token)} -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
   $remote=$true
  } catch { $remote=$false } finally {if($plain){[Array]::Clear($plain,0,$plain.Length)};$token=$null}
  Remove-Item -LiteralPath $credential -Force
 }
 if($remote){return '本机与中转授权已撤销。'}
 return '本机凭据已移除。当前无法确认云端撤销，请在手机控制台撤销这台电脑。'
}
function Uninstall-OwnedProgram {
 if([Windows.Forms.MessageBox]::Show('卸载当前用户的后台程序、运行时及自动启动？工作区、照片与任务数据会保留。','StopWatch 卸载','YesNo') -ne 'Yes'){return}
 Stop-OwnedBridge
 $result=Revoke-OwnedCredential
 foreach($entry in @(@('Startup','StopWatch Companion.lnk'),@('Programs','StopWatch 设置.lnk'))){Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath($entry[0])) $entry[1]) -ErrorAction SilentlyContinue}
 $expected=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'StopWatchCompanion'))
 if([IO.Path]::GetFullPath($root) -ne $expected){throw '安装路径检查失败，未删除文件。'}
 foreach($name in @('runtime','app')){
  $target=[IO.Path]::GetFullPath((Join-Path $root $name))
  if(-not $target.StartsWith($expected+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '卸载路径越界。'}
  if(Test-Path -LiteralPath $target){if((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '卸载目录不能是符号链接。'};Remove-Item -LiteralPath $target -Recurse -Force}
 }
 Remove-Item -LiteralPath (Join-Path $root 'release-public.pem') -ErrorAction SilentlyContinue
 [Windows.Forms.MessageBox]::Show(('程序已卸载，私人数据保留在用户目录。'+"`n"+$result),'StopWatch') | Out-Null
 $form.Close()
}
$form=New-Object Windows.Forms.Form;$form.Text='StopWatch 后台设置';$form.Size=New-Object Drawing.Size(480,360);$form.StartPosition='CenterScreen'
$label=New-Object Windows.Forms.Label;$label.Location=New-Object Drawing.Point(25,20);$label.Size=New-Object Drawing.Size(420,120);$form.Controls.Add($label)
$timer=New-Object Windows.Forms.Timer;$timer.Interval=2000;$timer.Add_Tick({try{$s=Get-Content -LiteralPath (Join-Path $root 'status.json') -Raw|ConvertFrom-Json;$label.Text='状态：'+$s.state+"`n实际在线："+$s.online+"`n"+$s.detail}catch{$label.Text='尚未启动或没有状态记录。'}});$timer.Start()
$y=150
foreach($item in @(@('启动',{Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/wscript.exe') -ArgumentList ('"'+(Join-Path $root 'app/Launch.vbs')+'"') -WindowStyle Hidden}),@('停止',{Stop-OwnedBridge}),@('撤销本机与云端授权',{Stop-OwnedBridge;$message=Revoke-OwnedCredential;[Windows.Forms.MessageBox]::Show($message,'StopWatch') | Out-Null}),@('卸载程序（保留私人数据）',{Uninstall-OwnedProgram}))){$button=New-Object Windows.Forms.Button;$button.Text=$item[0];$button.Location=New-Object Drawing.Point(25,$y);$button.Size=New-Object Drawing.Size(420,30);$button.Add_Click({try{& $this.Tag}catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message,'操作未完成') | Out-Null}});$button.Tag=$item[1];$form.Controls.Add($button);$y+=35}
$form.Add_FormClosed({$timer.Stop()});[void]$form.ShowDialog()