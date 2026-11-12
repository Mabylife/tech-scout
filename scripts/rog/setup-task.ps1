# One-time setup on ROG Windows. From the repo root, in PowerShell 7:
#   pwsh -File scripts/rog/setup-task.ps1
#
# 1. Stores a fine-grained GitHub token for this repo only, under a separate
#    username, so it does not replace your normal GitHub login.
# 2. Registers a Task Scheduler job: Mon/Thu 05:30, wakes the PC if asleep.

param(
    [string]$Time = '05:30',
    [string]$TaskName = 'tech-scout reddit',
    # Re-register the task only, keeping the token stored earlier.
    [switch]$SkipToken
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runner = Join-Path $PSScriptRoot 'run-reddit.ps1'
$pwsh = (Get-Command pwsh).Source

# --- 1. Credential -----------------------------------------------------------
# Create the token at https://github.com/settings/personal-access-tokens/new
#   Repository access: Only select repositories -> Mabylife/tech-scout
#   Permissions: Contents -> Read and write (nothing else)
if (-not $SkipToken) {
    $user = 'tech-scout-rog'
    git -C $repo remote set-url origin "https://$user@github.com/Mabylife/tech-scout.git"
    $token = Read-Host 'Paste the fine-grained token' -MaskInput
    "protocol=https`nhost=github.com`nusername=$user`npassword=$token`n" | git credential approve
    Remove-Variable token

    git -C $repo push --dry-run
    if ($LASTEXITCODE -ne 0) { throw 'Token check failed: git push --dry-run was rejected.' }
    Write-Host 'Token works.'
}

# --- 2. Scheduled task -------------------------------------------------------
# conhost --headless runs the console with no window at all; launching pwsh
# directly opens an empty Windows Terminal window for the whole run.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
    -Argument "--headless `"$pwsh`" -NoProfile -NonInteractive -File `"$runner`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Thursday -At $Time
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'tech-scout: fetch Reddit from home and push inbox/reddit.json' -Force | Out-Null

Write-Host "Registered '$TaskName' (Mon/Thu $Time)."
Write-Host "Test it now:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Log:          $(Join-Path $repo 'inbox\rog-run.log')"
