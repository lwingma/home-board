# Probes the board and restarts it if it has stopped answering. Registered by
# install-autostart.ps1 as a task repeating every five minutes.
#
#   powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1
#
# Why a probe rather than Task Scheduler's own restart-on-failure: that setting was
# already on the Home Board task (-RestartCount 3, -RestartInterval 5min) and it did
# not save it. On 2026-08-07 the board exited 0xC000013A (terminated) and the task
# simply sat at Ready for hours. A task whose process exits has *completed* as far as
# the scheduler is concerned, whatever the exit code, so nothing retriggered it.
#
# A probe also catches the failure restart-on-failure can never see: a process still
# running but no longer answering. That one matters more here than a clean death,
# because the board goes on displaying its last payload either way.

param(
  [int]    $BoardPort   = 7879,
  [int]    $ScraperPort = 7878,
  [switch] $SkipScraper,
  [string] $Log = "$env:LOCALAPPDATA\home-board-watchdog.log"
)

function Write-Log {
  param($Message)
  "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message |
    Add-Content -Path $Log -Encoding utf8
}

function Test-Endpoint {
  param($Url)
  try {
    Invoke-WebRequest -Uri $Url -TimeoutSec 10 -UseBasicParsing | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Restore-Task {
  param($TaskName, $Url)

  if (Test-Endpoint -Url $Url) { return }

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Log "'$TaskName' is not registered - cannot restart it"
    return
  }

  # Running but not answering. Start-ScheduledTask on a running task is a no-op
  # (MultipleInstances is IgnoreNew), so the hung instance has to go first.
  if ($task.State -eq "Running") {
    Write-Log "'$TaskName' is running but $Url is not answering - stopping it"
    try { Stop-ScheduledTask -TaskName $TaskName } catch { Write-Log "  stop failed: $($_.Exception.Message)" }
    Start-Sleep -Seconds 3
  }

  try {
    Start-ScheduledTask -TaskName $TaskName
    Write-Log "restarted '$TaskName' - $Url was not answering"
  } catch {
    Write-Log "failed to restart '$TaskName': $($_.Exception.Message)"
  }
}

# /api/data serves cached state and kicks off no fetches, so probing it every five
# minutes costs nothing at either end.
Restore-Task -TaskName "Home Board" -Url "http://127.0.0.1:$BoardPort/api/data"

# The scraper died in the same minute as the board on 2026-08-07, so it gets the same
# treatment. The board itself treats a missing scraper as normal and hides the usage
# block, so this is convenience, not correctness.
if (-not $SkipScraper) {
  Restore-Task -TaskName "Claude Usage Scraper" -Url "http://127.0.0.1:$ScraperPort/usage.json"
}
