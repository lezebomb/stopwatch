param([ValidatePattern('^COM[1-9][0-9]*$')][string]$Port = 'COM5')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path $PSScriptRoot -Parent
$python = Join-Path $projectRoot '.tools/espressif/python_env/idf6.0_py3.12_env/Scripts/python.exe'
$helper = Join-Path $PSScriptRoot 'device-sync.py'
if (!(Test-Path -LiteralPath $python)) { throw 'ESP-IDF Python environment is missing.' }

$form = New-Object Windows.Forms.Form
$form.Text = 'StopWatch · Muse 授权'
$form.Size = New-Object Drawing.Size(530, 260)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$label = New-Object Windows.Forms.Label
$label.Text = '粘贴你在 Muse 账户创建的 SDK Token'
$label.SetBounds(22, 22, 470, 26)
$form.Controls.Add($label)
$inputBox = New-Object Windows.Forms.TextBox
$inputBox.UseSystemPasswordChar = $true
$inputBox.SetBounds(22, 58, 470, 28)
$form.Controls.Add($inputBox)
$status = New-Object Windows.Forms.Label
$status.SetBounds(22, 100, 470, 50)
$form.Controls.Add($status)
$button = New-Object Windows.Forms.Button
$button.Text = '保存到挂件'
$button.SetBounds(22, 164, 470, 34)
$form.Controls.Add($button)
$form.AcceptButton = $button

$button.Add_Click({
    if ($inputBox.Text.Trim() -cnotmatch '^mgst_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$') {
        $status.Text = '令牌格式不正确，请从 Muse 的 SDK tokens 页面完整复制。'
        return
    }
    $button.Enabled = $false
    $status.Text = '正在保存，请保持 USB 连接。'
    $form.Refresh()
    $process = $null
    try {
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $python
        $start.Arguments = '"' + $helper + '" --port ' + $Port + ' --set-muse-token --token-stdin'
        $start.WorkingDirectory = $projectRoot
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $start
        [void]$process.Start()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errorOutput = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.WriteLine($inputBox.Text.Trim())
        $process.StandardInput.Close()
        $inputBox.Clear()
        if (!$process.WaitForExit(35000)) {
            $process.Kill()
            throw '挂件没有及时确认，请保持连接后重试。'
        }
        [void]$errorOutput.Result
        if ($process.ExitCode -ne 0) {
            $status.Text = '保存未完成。请检查挂件的 USB 连接后重试。'
        } elseif ($output.Result -match 'already stored') {
            $status.Text = '挂件已保存令牌，已跳过重复写入。请在 Muse App 中完成配对。'
        } else {
            $status.Text = '保存成功，挂件正在静音重启。请在 Muse App 中完成配对。'
        }
    } catch {
        $status.Text = '保存未完成。请检查 USB 连接后重试。'
    } finally {
        $inputBox.Clear()
        if ($process) { $process.Dispose() }
        $button.Enabled = $true
    }
})
$form.Add_FormClosed({ $inputBox.Clear() })
[void]$form.ShowDialog()
