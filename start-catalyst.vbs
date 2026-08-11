Set WshShell = CreateObject("WScript.Shell")
strPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = strPath
WshShell.Run "cmd /c node --watch server.js", 0, False
WScript.Sleep 2000
WshShell.Run "http://localhost:4200", 0, False
