param([Parameter(Mandatory=$true)][string]$HostConfig, [switch]$RegisterLoginTask, [string]$Proxy)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:NODE_TLS_REJECT_UNAUTHORIZED='1'
$root=$PSScriptRoot
$manifest=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'release.json') | ConvertFrom-Json
foreach($file in $manifest.files) {
  if($file.path -match '(^/|\\|(^|/)\.\.(/|$)|:)'){throw 'Invalid package path'}
  $path=Join-Path $root $file.path
  if((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne $file.sha256){throw "Package verification failed: $($file.path)"}
}
$node=Join-Path $root 'node.exe'
$yarn=Join-Path $root '.yarn\releases\yarn-4.12.0.cjs'
if($Proxy){$env:YARN_HTTP_PROXY=$Proxy;$env:YARN_HTTPS_PROXY=$Proxy}
$env:PATH="$root;$env:PATH"
Push-Location $root
try {
  & $node $yarn workspaces focus '@yesimbot/distribution-app' --production
  if($LASTEXITCODE -ne 0){throw 'Runtime dependency installation failed'}
} finally {Pop-Location}
$configPath=(Resolve-Path -LiteralPath $HostConfig).Path
try {$config=Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json -ErrorAction Stop}
catch {throw 'Invalid local host configuration'}
if($config.version -ne 1 -or $config.node -ne $node -or $config.entry -ne (Join-Path $root 'entry.cjs')){throw 'Host config does not match this runtime'}
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach($directory in @($config.stateRoot,$config.appRoot)){
  New-Item -ItemType Directory -Force -Path $directory|Out-Null
  & icacls.exe $directory /inheritance:r /grant:r "${user}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Private directory ACL failed'}
}
if($RegisterLoginTask){
  $action=New-ScheduledTaskAction -Execute $node -Argument ('"'+(Join-Path $root 'host.mjs')+'" "'+$configPath+'"') -WorkingDirectory $root
  $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
  Register-ScheduledTask -TaskName ('YesImBot-local-'+$config.id) -Action $action -Principal $principal -Settings $settings -Trigger $trigger -Force | Out-Null
}
Write-Output 'Local runtime installed; existing chat processes were not started or stopped.'
