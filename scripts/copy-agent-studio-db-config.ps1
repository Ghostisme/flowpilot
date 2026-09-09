param(
  [string]$SourceEnv = (Join-Path $PSScriptRoot '..\..\agent-studio\server\.env'),
  [string]$TargetEnv = (Join-Path $PSScriptRoot '..\.env')
)

$ErrorActionPreference = 'Stop'
$keys = @('MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DB', 'MYSQL_SSL')

if (-not (Test-Path -LiteralPath $SourceEnv)) {
  throw "Agent Studio environment file was not found: $SourceEnv"
}

$sourceValues = @{}
foreach ($line in Get-Content -LiteralPath $SourceEnv -Encoding UTF8) {
  if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') {
    $sourceValues[$Matches[1]] = $Matches[2]
  }
}

$missing = @($keys | Where-Object { -not $sourceValues.ContainsKey($_) })
if ($missing.Count -gt 0) {
  throw "Agent Studio is missing required database variables: $($missing -join ', ')"
}

if (-not (Test-Path -LiteralPath $TargetEnv)) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\.env.example') -Destination $TargetEnv
}

$lines = [System.Collections.Generic.List[string]]::new()
$existing = @{}
foreach ($line in Get-Content -LiteralPath $TargetEnv -Encoding UTF8) {
  if ($line -match '^\s*([A-Z0-9_]+)=') {
    $key = $Matches[1]
    if ($keys -contains $key) {
      $lines.Add("$key=$($sourceValues[$key])")
      $existing[$key] = $true
      continue
    }
    if ($key -eq 'PERSISTENCE_DRIVER') {
      $lines.Add('PERSISTENCE_DRIVER=mysql')
      $existing[$key] = $true
      continue
    }
    if ($key -eq 'FLOWPILOT_TABLE_PREFIX') {
      $lines.Add('FLOWPILOT_TABLE_PREFIX=flowpilot_')
      $existing[$key] = $true
      continue
    }
  }
  $lines.Add($line)
}

foreach ($key in $keys) {
  if (-not $existing.ContainsKey($key)) { $lines.Add("$key=$($sourceValues[$key])") }
}
if (-not $existing.ContainsKey('PERSISTENCE_DRIVER')) { $lines.Add('PERSISTENCE_DRIVER=mysql') }
if (-not $existing.ContainsKey('FLOWPILOT_TABLE_PREFIX')) { $lines.Add('FLOWPILOT_TABLE_PREFIX=flowpilot_') }

Set-Content -LiteralPath $TargetEnv -Value $lines -Encoding UTF8
Write-Output "Copied Agent Studio database settings into FlowPilot .env."
Write-Output "Only MYSQL_* values were copied; values were not printed."
Write-Output "FlowPilot will use tables prefixed with flowpilot_ in the shared database."
