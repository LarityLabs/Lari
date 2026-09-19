$ErrorActionPreference = "Stop"

function Step($Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

Step "Ensure an Ubuntu WSL distro is registered"
$distros = (wsl -l -q 2>$null | Where-Object { $_ -and $_.Trim() -and $_ -notmatch "Windows Subsystem" })
if (-not $distros) {
  if (Get-Command ubuntu2204.exe -ErrorAction SilentlyContinue) {
    ubuntu2204.exe install --root
  } else {
    wsl --install Ubuntu-24.04 --no-launch
  }
}
wsl -l -v

Step "Install Linux dependencies inside WSL"
$distro = (wsl -l -q | Where-Object { $_ -and $_.Trim() } | Select-Object -First 1).Trim()
wsl -d $distro -u root -- bash -lc "apt-get update && apt-get install -y python3 python3-pip python3-venv git curl ca-certificates"
wsl -d $distro -u root -- bash -lc "python3 -m pip install --break-system-packages swebench datasets docker"

Step "Check Docker daemon from Windows"
docker info

Step "Run Lari SWE-bench readiness gate"
npm run benchmark:lari-swebench-official-readiness

Step "Done"
Write-Host "If Docker works in Windows but not WSL, open Docker Desktop > Settings > Resources > WSL Integration and enable integration for $distro."
