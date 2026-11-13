$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Security
$root=Join-Path $env:LOCALAPPDATA 'StopWatchCompanion'
function Test-OwnedBridgeProcess($bridgeProcessId) {
 if (!$bridgeProcessId) { return $false }
 $process = Get-Process -Id $bridgeProcessId -ErrorAction SilentlyContinue
 return $process -and $process.Path -eq (Join-Path $root 'runtime/node.exe')
}
function Stop-OwnedBridge {
 Set-Content -LiteralPath (Join-Path $root 'stop.request') -Value 'stop' -Encoding ascii
 Start-Sleep -Seconds 2
 $file=Join-Path $root 'status.json'
 if(Test-Path -LiteralPath $file){
  $state=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
  foreach($processId in @($state.pid,$state.supervisorPid)){
   if(Test-OwnedBridgeProcess $processId){Stop-Process -Id $processId}
  }
 }
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
function Edit-Workspaces {
 $file=Join-Path $root 'config.json';$configuration=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
 $editor=New-Object Windows.Forms.Form;$editor.Text='授权工作区';$editor.Size=New-Object Drawing.Size(600,330);$editor.StartPosition='CenterScreen'
 $hint=New-Object Windows.Forms.Label;$hint.Text='每行一个完整目录；仅这些工作区可执行远程任务。移除的工作区将停止恢复。';$hint.SetBounds(20,15,550,42);$editor.Controls.Add($hint)
 $input=New-Object Windows.Forms.TextBox;$input.Multiline=$true;$input.SetBounds(20,62,540,135);$input.Text=($configuration.workspaces.path -join "`r`n");$editor.Controls.Add($input)
 $save=New-Object Windows.Forms.Button;$save.Text='明确授权这些工作区并重启后台';$save.SetBounds(20,217,540,35);$editor.Controls.Add($save)
 $save.Add_Click({try{
  $entries=@();$seen=@{}
  foreach($line in ($input.Text -split '[\r\n]+' | Where-Object {$_.Trim()})){
   $folder=(Resolve-Path -LiteralPath $line.Trim()).Path
   if(-not(Test-Path -LiteralPath $folder -PathType Container)){throw '必须选择现有文件夹。'}
   if($seen.ContainsKey($folder)){continue};$seen[$folder]=$true
   $old=$configuration.workspaces|Where-Object {$_.path -eq $folder}|Select-Object -First 1
   $workspaceId=if($old){$old.id}else{'workspace-'+[Guid]::NewGuid().ToString('N').Substring(0,12)}
   $entries+=@{id=$workspaceId;name=[IO.Path]::GetFileName($folder);path=$folder}
  }
  if($entries.Count -lt 1 -or $entries.Count -gt 8){throw '需要 1 至 8 个工作区。'}
  Stop-OwnedBridge;$configuration.workspaces=$entries
  $temporary=$file+'.new';[IO.File]::WriteAllText($temporary,($configuration|ConvertTo-Json -Depth 7),(New-Object Text.UTF8Encoding($false)));Move-Item -LiteralPath $temporary -Destination $file -Force
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/wscript.exe') -ArgumentList ('"'+(Join-Path $root 'app/Launch.vbs')+'"') -WindowStyle Hidden
  $editor.Close()
 }catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message,'授权未保存')|Out-Null}})
 [void]$editor.ShowDialog();$editor.Dispose()
}
$form=New-Object Windows.Forms.Form;$form.Text='StopWatch 后台设置';$form.Size=New-Object Drawing.Size(480,400);$form.StartPosition='CenterScreen'
$label=New-Object Windows.Forms.Label;$label.Location=New-Object Drawing.Point(25,20);$label.Size=New-Object Drawing.Size(420,120);$form.Controls.Add($label)
$timer=New-Object Windows.Forms.Timer
$timer.Interval=2000
$timer.Add_Tick({
 try {
  $status=Get-Content -LiteralPath (Join-Path $root 'status.json') -Raw|ConvertFrom-Json
  $online=$status.online -and (Test-OwnedBridgeProcess $status.supervisorPid) -and (Test-OwnedBridgeProcess $status.pid)
  $state=if($status.online -and !$online){'后台进程已退出'}else{$status.state}
  $label.Text='状态：'+$state+"`n实际在线："+$online+"`n"+$status.detail
 } catch {
  $label.Text='尚未启动或没有状态记录。'
 }
})
$timer.Start()
$y=150
foreach($item in @(@('管理授权工作区',{Edit-Workspaces}),@('启动',{Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/wscript.exe') -ArgumentList ('"'+(Join-Path $root 'app/Launch.vbs')+'"') -WindowStyle Hidden}),@('停止',{Stop-OwnedBridge}),@('撤销本机与云端授权',{Stop-OwnedBridge;$message=Revoke-OwnedCredential;[Windows.Forms.MessageBox]::Show($message,'StopWatch') | Out-Null}),@('卸载程序（保留私人数据）',{Uninstall-OwnedProgram}))){$button=New-Object Windows.Forms.Button;$button.Text=$item[0];$button.Location=New-Object Drawing.Point(25,$y);$button.Size=New-Object Drawing.Size(420,30);$button.Add_Click({try{& $this.Tag}catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message,'操作未完成') | Out-Null}});$button.Tag=$item[1];$form.Controls.Add($button);$y+=35}
$form.Add_FormClosed({$timer.Stop()});[void]$form.ShowDialog()
