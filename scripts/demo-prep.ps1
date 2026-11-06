# Run before each recorded take: .\scripts\demo-prep.ps1
# After Task C:                    .\scripts\demo-prep.ps1 -AfterTaskC
#
# Checks TrueForge is up (starts it if not), resets the Flask folder, shows the models ForgeLens will use, checks
# that the broken-primary provider exists but is not the primary, shows free RAM and disk, and prints READY.
# -AfterTaskC puts the real primary back first in forgelens.models (the status-bar pick saves the broken one there).
param(
  [string]$Flask = (Join-Path $PSScriptRoot '..\..\flask'),
  [string]$TrueForge = 'http://localhost:8790',
  [string]$Primary = 'google-gemini/gemini-3-8-flash',
  [string]$Fallback = 'google-gemini/gemini-3-6-flash',
  [string]$Settings = (Join-Path $env:APPDATA 'Code\User\settings.json'),
  [switch]$AfterTaskC
)

$ErrorActionPreference = 'Stop'
$resolved = Resolve-Path -Path $Flask -ErrorAction SilentlyContinue
if ($resolved) { $Flask = $resolved.Path }
$problems = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { Write-Host $text }
function Problem([string]$text) { $problems.Add($text); Write-Host "  PROBLEM: $text" -ForegroundColor Red }

function Get-Json([string]$path) {
  try { return Invoke-RestMethod -Uri ($TrueForge + $path) -TimeoutSec 5 } catch { return $null }
}

# Reads a value from VS Code's settings.json, which allows comments, so it is not parsed as JSON.
function Get-SettingText([string]$key) {
  if (-not (Test-Path $Settings)) { return $null }
  $text = Get-Content -Raw -Path $Settings
  $match = [regex]::Match($text, '"' + [regex]::Escape($key) + '"\s*:\s*(\[[^\]]*\]|"[^"]*"|[^,\r\n}]+)')
  if ($match.Success) { return $match.Groups[1].Value.Trim() } else { return $null }
}

if ($AfterTaskC) {
  Say 'Putting the real primary back in forgelens.models...'
  $list = '[' + [Environment]::NewLine + '    "' + $Primary + '",' + [Environment]::NewLine + '    "' + $Fallback + '"' + [Environment]::NewLine + '  ]'
  if (Test-Path $Settings) {
    $text = Get-Content -Raw -Path $Settings
    $pattern = '"forgelens\.models"\s*:\s*\[[^\]]*\]'
    if ([regex]::IsMatch($text, $pattern)) {
      $text = [regex]::Replace($text, $pattern, '"forgelens.models": ' + $list)
      # Keep the file as VS Code wrote it: UTF-8 without a byte order mark.
      [System.IO.File]::WriteAllText($Settings, $text, (New-Object System.Text.UTF8Encoding($false)))
      Say "  forgelens.models is now [$Primary, $Fallback]. VS Code picks it up at once."
    } else {
      Say '  forgelens.models is not set, so the defaults apply. Nothing to change.'
    }
  }
}

# 1. TrueForge.
Say "TrueForge at ${TrueForge}:"
$models = Get-Json '/api/v1/models'
if (-not $models) {
  Say '  not running. Starting it in a new window...'
  $start = Join-Path $PSScriptRoot 'start-trueforge.ps1'
  Start-Process powershell -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $start) -WorkingDirectory (Join-Path $PSScriptRoot '..')
  for ($i = 0; $i -lt 60 -and -not $models; $i++) { Start-Sleep -Seconds 2; $models = Get-Json '/api/v1/models' }
}
if ($models) {
  $names = @($models.data | ForEach-Object { $_.name })
  Say "  up, $($names.Count) models."
} else {
  $names = @()
  Problem 'TrueForge did not start. Run .\scripts\start-trueforge.ps1 and read its window.'
}

# 2. Flask.
Say "Flask at ${Flask}:"
if (-not (Test-Path (Join-Path $Flask '.git'))) {
  Problem "No Flask checkout at $Flask. See the README, section The three fixed tasks."
} else {
  & git -C $Flask checkout -- . 2>$null
  & git -C $Flask clean -fdq -e .venv 2>$null
  $status = (& git -C $Flask status --porcelain) -join "`n"
  if ($status) { Problem "git status is not clean:`n$status" } else { Say '  reset, git status clean.' }
  if (-not (Test-Path (Join-Path $Flask '.venv\Scripts\python.exe'))) { Problem 'No .venv in the Flask folder.' }
}

# 3. Models and reasoning effort.
Say 'ForgeLens settings (user settings.json):'
$configured = Get-SettingText 'forgelens.models'
$chain = if ($configured) { @([regex]::Matches($configured, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }) } else { @($Primary, $Fallback) }
$effort = Get-SettingText 'forgelens.reasoningEffort'
$effortShown = if ($effort) { $effort.Trim('"') } else { 'low (default)' }
Say ('  forgelens.models: ' + ($chain -join ', ') + $(if ($configured) { '' } else { ' (default)' }))
Say "  forgelens.reasoningEffort: $effortShown"
$primaryNow = $chain | Where-Object { $names -contains $_ } | Select-Object -First 1
if (-not $primaryNow) { Problem 'None of forgelens.models is in TrueForge.' }
elseif ($primaryNow -like 'broken-*') { Problem "The primary is $primaryNow. Run .\scripts\demo-prep.ps1 -AfterTaskC, or pick $Primary in the status bar." }
else { Say "  primary: $primaryNow" }
if ($effort -and $effort.Trim('"') -ne 'low') { Problem "forgelens.reasoningEffort is $effortShown; the measured timings are for low." }

# 4. The broken provider for Task C.
$broken = $names | Where-Object { $_ -like 'broken-primary/*' }
if ($broken) { Say "  Task C provider present: $($broken -join ', ') (not the primary)." }
else { Problem 'No broken-primary provider. See the README, Recording Task C, or run npm run rehearse:c once.' }

# 5. Saved agents.
$agents = Get-Json '/api/v1/agents'
if ($agents) {
  foreach ($agent in $agents.data) {
    $model = $agent.manifest.model.name
    $params = if ($agent.manifest.model.params) { ' ' + ($agent.manifest.model.params | ConvertTo-Json -Compress) } else { '' }
    Say "  saved agent $($agent.name): $model$params"
  }
  Say '  (ForgeLens saves the agents again before each request, from the settings above.)'
}

# 6. Memory and disk.
$os = Get-CimInstance Win32_OperatingSystem
$freeMb = [math]::Round($os.FreePhysicalMemory / 1024)
Say "Free RAM: $freeMb MB"
if ($freeMb -lt 1300) { Problem 'Under 1.3 GB of RAM free. Close other apps before recording.' }
foreach ($drive in @('C', 'D')) {
  $psDrive = Get-PSDrive -Name $drive -ErrorAction SilentlyContinue
  if ($psDrive) {
    $freeGb = [math]::Round($psDrive.Free / 1GB, 1)
    Say "Free disk ${drive}: $freeGb GB"
    if ($freeGb -lt 2) { Problem "Under 2 GB free on ${drive}:." }
  }
}

Say ''
if ($problems.Count -eq 0) { Write-Host 'READY' -ForegroundColor Green } else { Write-Host "NOT READY: $($problems.Count) problem(s) above." -ForegroundColor Red; exit 1 }
