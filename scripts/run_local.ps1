# Збір оголошень на вашому комп'ютері (Windows) і відправка даних у гілку data на GitHub.
# Потрібні: Git for Windows (з входом у GitHub) і Python 3.
$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Join-Path $PSScriptRoot "..")
git pull -q --ff-only 2>$null
$work = ".data-work"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory $work | Out-Null
git ls-remote --exit-code --heads origin data *> $null
if ($LASTEXITCODE -eq 0) {
  git fetch -q --depth 1 origin data
  git --work-tree=$work checkout FETCH_HEAD -- .
  git reset -q
}
$py = if (Get-Command py -ErrorAction SilentlyContinue) { "py" } else { "python" }
& $py scraper/olx_scraper.py --config config.json --data $work
if ($LASTEXITCODE -ne 0) { throw "Збирач завершився з помилкою" }
$origin = git remote get-url origin
Push-Location $work
git init -q; git checkout -q -b data; git add -A
git -c user.name="olx-bot" -c user.email="olx-bot@localhost" commit -qm "Дані $(Get-Date -Format 'yyyy-MM-dd_HH:mm')"
git push -qf $origin data
Pop-Location
Remove-Item -Recurse -Force $work
Write-Host "Готово: $(Get-Date)"
