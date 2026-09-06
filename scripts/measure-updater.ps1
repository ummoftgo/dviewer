$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $repo 'src-tauri')
cargo build --offline --example update
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Set-Location $repo
$root = Join-Path $repo '.agent-works/m22-e2e'
$context = Get-Content "$root/context.json" | ConvertFrom-Json
$server = Get-Content "$root/server.json" | ConvertFrom-Json
$rows = @()
foreach ($size in @(1,100)) {
    node scripts/test-updater-windows.mjs --payload-mib $size
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Invoke-WebRequest -Uri "$($server.origin)/latest.json" -OutFile "$root/perf-warmup.json"
    foreach ($mode in @('check','download')) {
        foreach ($run in 1..3) {
            $name = "perf-$size-$mode-$run"
            $p = Start-Process -FilePath (Join-Path $repo 'src-tauri/target/debug/examples/update.exe') -WindowStyle Hidden -ArgumentList "--$mode","$($server.origin)/latest.json",('"'+$context.key+'.pub"') -RedirectStandardOutput "$root/$name.json" -RedirectStandardError "$root/$name.err" -PassThru
            $peak = 0L
            while (-not $p.WaitForExit(10)) {
                $p.Refresh()
                $peak = [Math]::Max($peak,$p.PeakWorkingSet64)
            }
            if ($p.ExitCode -ne 0) { throw "probe failed: $name" }
            $result = Get-Content "$root/$name.json" | ConvertFrom-Json
            $rows += [PSCustomObject]@{assetMiB=$size;mode=$mode;run=$run;peakBytes=$peak;manifestMs=$result.manifestMs;totalMs=$result.totalMs;bytes=$result.bytes}
        }
    }
}
$rows | ConvertTo-Json | Set-Content "$root/perf-results.json"
$rows | Format-Table
Set-Content "$root/scenario.json" '{}'
exit 0
