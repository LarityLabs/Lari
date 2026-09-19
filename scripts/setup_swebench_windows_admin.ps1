param(
  [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"

function Step($Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

Step "Enable Windows features required by WSL2 and Docker Desktop"
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
dism.exe /online /enable-feature /featurename:HypervisorPlatform /all /norestart

Step "Enable Windows hypervisor at boot"
bcdedit /set hypervisorlaunchtype auto

Step "Verify feature and hypervisor state"
foreach ($featureName in @("Microsoft-Windows-Subsystem-Linux", "VirtualMachinePlatform", "Microsoft-Hyper-V-All", "HypervisorPlatform")) {
  $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName -ErrorAction SilentlyContinue
  if ($feature) {
    Write-Host "$($feature.FeatureName): $($feature.State)"
  }
}
bcdedit /enum "{current}" | Select-String -Pattern "hypervisorlaunchtype|description"

Step "Set WSL default version to 2"
wsl --set-default-version 2

Step "Install Linux distro if none is registered"
$registered = (wsl -l -q 2>$null) -join ""
if (-not $registered.Trim()) {
  wsl --install $Distro --no-launch
} else {
  Write-Host "WSL distro already registered:"
  wsl -l -v
}

Step "Start Docker Desktop"
$dockerDesktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
if (Test-Path $dockerDesktop) {
  Start-Process -FilePath $dockerDesktop
} else {
  Write-Warning "Docker Desktop executable not found at $dockerDesktop"
}

Step "Done"
Write-Host "If Windows reports that a restart is required, reboot, then rerun:"
Write-Host "  npm run benchmark:lari-swebench-official-readiness"
Write-Host ""
Write-Host "If Docker still says virtualization is unavailable after reboot, run:"
Write-Host "  systeminfo | findstr /i `"hyper-v virtualization hypervisor`""
Write-Host ""
Write-Host "After WSL first launch, install Linux-side deps with:"
Write-Host "  sudo apt update && sudo apt install -y python3 python3-pip git docker.io"
Write-Host "  python3 -m pip install --user swebench datasets"
