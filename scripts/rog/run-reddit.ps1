# Runs on ROG Windows (scheduled by setup-task.ps1): fetch Reddit from the
# home connection and push inbox/reddit.json before the GitHub Actions run.
# Requires PowerShell 7, Node 24 and git on PATH.

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$log = Join-Path $repo 'inbox\rog-run.log'   # gitignored
Start-Transcript -Path $log -Append | Out-Null
try {
    Set-Location $repo
    git pull --rebase --quiet
    if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }

    node scripts/fetch-reddit.js
    if ($LASTEXITCODE -ne 0) { Write-Warning 'fetch-reddit failed for every subreddit' }

    git add inbox/reddit.json
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mmZ')
        git commit --quiet -m "inbox: reddit $stamp"
        git push --quiet
        if ($LASTEXITCODE -ne 0) { throw 'git push failed' }
    }
}
catch {
    Write-Error $_
    exit 1
}
finally {
    Stop-Transcript | Out-Null
}
