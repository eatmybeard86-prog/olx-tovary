# Створює завдання Windows, яке щогодини запускає run_local.ps1 (поки комп'ютер увімкнений).
$script = Join-Path $PSScriptRoot "run_local.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 50)
Register-ScheduledTask -TaskName "OLX пошук товарів" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Завдання «OLX пошук товарів» створено: щогодини о :05."
