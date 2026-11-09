Option Explicit
Dim shell, fso, appRoot, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appRoot = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\StopWatchCompanion"
command = Chr(34) & appRoot & "\runtime\node.exe" & Chr(34) & " " & Chr(34) & appRoot & "\app\supervisor.mjs" & Chr(34) & " " & Chr(34) & appRoot & Chr(34)
shell.Run command, 0, False
