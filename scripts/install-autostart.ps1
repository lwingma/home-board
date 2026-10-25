# Registers the scheduled tasks that keep the board running unattended.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#
# Both run AT LOGON as the current user, interactively. Not at startup, and not
# "whether logged on or not":
#   - the usage scraper drives real Chrome with headless:false (the Cloudflare
#     workaround), so it needs a desktop session to draw into. Session 0 has none.
#   - the board is only doing anything once someone is logged in for iCUE to render it.
#
# ExecutionTimeLimit is zeroed deliberately. The Windows default stops a task after
# three days, which is exactly the sort of failure you would not notice on a wall.
#
# Every action launches through `conhost.exe --headless`. powershell.exe's own
# -WindowStyle Hidden is not enough on Windows 11: when Windows Terminal is the
# default console host it ignores the hidden style entirely and hands the task a real
# tab, focused. With the watchdog on a five-minute repetition that is a terminal
# window stealing focus twelve times an hour, over games and everything else.
# --headless forces the classic console host with no window at all. Keep both: the
# hidden style still applies if conhost is ever dropped.

param(
  [string] $BoardDir   = (Split-Path $PSScriptRoot -Parent),
  # the optional usage scraper, expected beside this project; -SkipScraper if you don't run it
  [string] $ScraperDir = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "xeneon-claude-usage"),
  [switch] $SkipScraper
)

$ErrorActionPreference = "Stop"
$npm = "C:\Program Files\nodejs\npm.cmd"
if (-not (Test-Path $npm)) { throw "npm not found at $npm" }

function Register-BoardTask {
  param($Name, $Dir, $Log, $DelaySeconds, $Description)

  if (-not (Test-Path $Dir)) { Write-Warning "skipping '$Name': $Dir not found"; return }

  $argline = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command " +
             "`"Set-Location '$Dir'; & '$npm' start *>> '$Log'`""

  $action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument $argline -WorkingDirectory $Dir

  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $trigger.Delay = "PT${DelaySeconds}S"

  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartInterval (New-TimeSpan -Minutes 5) -RestartCount 3 `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description $Description -Force | Out-Null

  Write-Output ("registered  {0,-22} -> {1}" -f $Name, $Dir)
  Write-Output ("  log       {0}" -f $Log)
}

Register-BoardTask -Name "Home Board" -Dir $BoardDir `
  -Log "$env:LOCALAPPDATA\home-board.log" -DelaySeconds 10 `
  -Description "Starts the Home Board server on 127.0.0.1:7879 at logon. The iCUE widget and the add page both read from it."

if (-not $SkipScraper) {
  Register-BoardTask -Name "Claude Usage Scraper" -Dir $ScraperDir `
    -Log "$env:LOCALAPPDATA\claude-usage-scraper.log" -DelaySeconds 30 `
    -Description "Starts the xeneon-claude-usage server on 127.0.0.1:7878 at logon. Home Board reads its usage.json for the usage meters."
}

# The watchdog. Restart-on-failure above did not survive contact with reality: on
# 2026-08-07 the board exited 0xC000013A and its task sat at Ready all morning while
# the wall showed a fixture that did not exist. See scripts\watchdog.ps1.
function Register-WatchdogTask {
  $script = Join-Path $PSScriptRoot "watchdog.ps1"
  if (-not (Test-Path $script)) { Write-Warning "skipping watchdog: $script not found"; return }

  $argline = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
  if ($SkipScraper) { $argline += " -SkipScraper" }

  $action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument $argline -WorkingDirectory $BoardDir

  # Duration must be left unset for "repeat forever". [TimeSpan]::MaxValue looks like
  # the obvious way to say that and is rejected: it serialises to P99999999DT23H59M59S,
  # which the scheduler refuses as out of range.
  $repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
  $repetition.Duration = $null
  $repetition.StopAtDurationEnd = $false

  # Two triggers, because either alone leaves a hole. AtLogOn matches the other tasks
  # and covers reboots, but a repetition hangs off its trigger firing - register the
  # watchdog mid-session with only that and it sits dormant until the next logon,
  # which is precisely when you don't want it dormant. The Once trigger starts the
  # five-minute cycle immediately. MultipleInstances IgnoreNew keeps them from
  # doubling up once both are live.
  $atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $atLogon.Delay = "PT3M"   # let the board have its 10s delay plus room to boot
  $atLogon.Repetition = $repetition

  $now = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
  $now.Repetition = $repetition

  $trigger = @($atLogon, $now)

  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

  # A watchdog that can pile up instances is worse than none: IgnoreNew, and a hard
  # time limit so a wedged probe cannot block every later run.
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
    -MultipleInstances IgnoreNew

  Register-ScheduledTask -TaskName "Home Board Watchdog" -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force `
    -Description "Every 5 minutes, probes 127.0.0.1:7879 and restarts the Home Board task if it has stopped answering. Logs to %LOCALAPPDATA%\home-board-watchdog.log." | Out-Null

  Write-Output ("registered  {0,-22} -> every 5 min" -f "Home Board Watchdog")
  Write-Output ("  log       {0}" -f "$env:LOCALAPPDATA\home-board-watchdog.log")
}

Register-WatchdogTask

Write-Output ""
Write-Output "To remove:  Unregister-ScheduledTask -TaskName 'Home Board' -Confirm:`$false"
