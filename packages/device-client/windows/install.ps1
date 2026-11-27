param(
  [string]$Gateway,
  [string]$State = (Join-Path $env:LOCALAPPDATA 'YesImBot-device'),
  [switch]$Autostart,
  [switch]$RemoveAutostart,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$State = [System.IO.Path]::GetFullPath($State)
if ($State -eq [System.IO.Path]::GetPathRoot($State)) { throw 'Use a dedicated state directory, not a drive root.' }
$State = $State.TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$digest = [System.Security.Cryptography.SHA256]::Create()
try { $stateTag = ([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($State.ToUpperInvariant())))).Replace('-', '').Substring(0, 12) }
finally { $digest.Dispose() }
$defaultState = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'YesImBot-device'))
$customState = ![string]::Equals($State, $defaultState, [StringComparison]::OrdinalIgnoreCase)
$taskName = 'YesImBot-device-' + $user.User.Value
$menuName = 'YesImBot'
if ($customState) { $taskName += '-' + $stateTag; $menuName += ' - ' + $stateTag }
if ($RemoveAutostart) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  Write-Output 'Autostart removed. Use the Exit shortcut to stop the running client. Pairing and data are preserved.'
  exit 0
}
# Check the entire bundle before executing or copying its runtime.
$entries = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $PSScriptRoot 'SHA256SUMS')) {
  if ($line -notmatch '^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9_.-]*)$') { throw 'Invalid bundle checksum manifest.' }
  $expected = $Matches[1]; $name = $Matches[2]
  if ($entries.ContainsKey($name)) { throw 'Duplicate bundle entry.' }
  $source = Join-Path $PSScriptRoot $name
  $item = Get-Item -LiteralPath $source
  if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Bundle files cannot be links.' }
  if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw ('Checksum mismatch: ' + $name) }
  $entries[$name] = $source
}
foreach ($required in @('client.cjs', 'LICENSE', 'THIRD_PARTY_NOTICES.txt')) {
  if (!$entries.ContainsKey($required)) { throw ('Missing bundle file: ' + $required) }
}
if ($entries.ContainsKey('node.exe')) { $node = $entries['node.exe'] }
else { $node = (Get-Command node -ErrorAction Stop).Source }
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Cannot read the Node.js version.' }
if ([version]$nodeVersion.Substring(1) -lt [version]'22.16.0') { throw 'Node.js 22.16 or newer is required. Use the Windows runtime bundle.' }
if (Test-Path $State) {
  if ((Get-Item $State).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'State directory cannot be a link.' }
} else { New-Item -ItemType Directory -Path $State | Out-Null }
# Credentials and ledgers belong only to the current Windows user, not the bundle.
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($user.User)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $State -AclObject $acl
# Graceful shutdown preserves journals. An older CLI without a control endpoint must be stopped by its owner.
& $node $entries['client.cjs'] quit --state $State
if ($LASTEXITCODE -ne 0) { throw 'Close the running client and retry. No runtime files have been replaced.' }
# New runtime directory keeps the previous installation available for rollback.
$runtime = Join-Path $State ('runtime-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runtime | Out-Null
foreach ($entry in $entries.GetEnumerator()) { Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $runtime $entry.Key) }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'SHA256SUMS') -Destination $runtime
if ($entries.ContainsKey('node.exe')) { $node = Join-Path $runtime 'node.exe' }
$installed = Join-Path $runtime 'client.cjs'
$config = Join-Path $State 'config.json'
if (!(Test-Path $config) -and $Gateway) {
  & $node $installed init --state $State --gateway $Gateway
  if ($LASTEXITCODE -ne 0) { throw 'Client initialization failed.' }
}
function Write-Launcher([string]$Name, [string]$Arguments) {
  $path = Join-Path $State $Name
  $command = '"' + $node + '" "' + $installed + '" ' + $Arguments + ' --state "' + $State + '"'
  $vbs = 'WScript.Quit CreateObject("WScript.Shell").Run("' + $command.Replace('"', '""') + '", 0, True)'
  [System.IO.File]::WriteAllText($path, $vbs, [System.Text.Encoding]::Unicode)
  return $path
}
$chatLauncher = Write-Launcher 'chat.vbs' 'ui --open-chat --auto-start'
$settingsLauncher = Write-Launcher 'settings.vbs' 'ui --open'
$backgroundLauncher = Write-Launcher 'run-hidden.vbs' 'ui --auto-start'
$exitLauncher = Write-Launcher 'exit.vbs' 'quit'
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) $menuName
New-Item -ItemType Directory -Path $menu -Force | Out-Null
$shell = New-Object -ComObject WScript.Shell
foreach ($shortcut in @(@('YesImBot', $chatLauncher), @('YesImBot Settings', $settingsLauncher), @('YesImBot Exit', $exitLauncher))) {
  $link = $shell.CreateShortcut((Join-Path $menu ($shortcut[0] + '.lnk')))
  $link.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $link.Arguments = '"' + $shortcut[1] + '"'
  $link.WorkingDirectory = $State
  $link.Save()
}
if ($Autostart) {
  if (!(Test-Path (Join-Path $State 'credential.json'))) { throw 'Pair the device in Settings, then run install.ps1 -Autostart again.' }
  $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ('"' + $backgroundLauncher + '"')
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user.Name
  $principal = New-ScheduledTaskPrincipal -UserId $user.Name -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Output 'Autostart registered for your next Windows login. Exiting the client will not restart it automatically.'
}
Write-Output ('Installed in ' + $runtime + '. Open Settings from the Start menu folder: ' + $menuName)
if (!$NoOpen) { Start-Process -FilePath "$env:WINDIR\System32\wscript.exe" -ArgumentList ('"' + $settingsLauncher + '"') }
