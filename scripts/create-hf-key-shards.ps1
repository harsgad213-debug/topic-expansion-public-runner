param(
  [Parameter(Mandatory = $true)]
  [string]$InputFile,

  [Parameter(Mandatory = $true)]
  [int]$ShardCount,

  [string]$OutputDir = "C:\tmp\hf_key_shards"
)

if ($ShardCount -lt 1) {
  throw "ShardCount must be at least 1."
}

if (-not (Test-Path -LiteralPath $InputFile)) {
  throw "Input file not found: $InputFile"
}

$raw = Get-Content -Raw -LiteralPath $InputFile
$keys = $raw -split "[,;`r`n]+" |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ } |
  Select-Object -Unique

if ($keys.Count -eq 0) {
  throw "No keys found in input file."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$buckets = @()
for ($i = 0; $i -lt $ShardCount; $i++) {
  $buckets += ,@()
}

for ($i = 0; $i -lt $keys.Count; $i++) {
  $bucketIndex = $i % $ShardCount
  $buckets[$bucketIndex] += $keys[$i]
}

for ($i = 0; $i -lt $ShardCount; $i++) {
  $name = "GITHUB_KEYS_worker_{0:D2}.txt" -f $i
  $path = Join-Path $OutputDir $name
  Set-Content -LiteralPath $path -Value ($buckets[$i] -join "`n") -Encoding utf8
  Write-Host ("worker {0}: {1} keys -> {2}" -f $i, $buckets[$i].Count, $path)
}

Write-Host ("Total unique keys: {0}" -f $keys.Count)
Write-Host "Secret values were written only to the output files; they were not printed."
