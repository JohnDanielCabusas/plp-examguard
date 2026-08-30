param(
    [string]$PythonVersion = "3.11",
    [switch]$CpuOnly
)

$ErrorActionPreference = "Stop"
$YoloDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $YoloDir "..\..")
$VenvDir = Join-Path $RepoRoot ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
    throw "Python Launcher was not found. Install Python 3.10 or 3.11 from https://www.python.org/downloads/windows/ and enable Add Python to PATH."
}

$DetectedVersion = & py "-$PythonVersion" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ($DetectedVersion -notin @("3.10", "3.11")) {
    throw "TUKLAS YOLO requires Python 3.10 or 3.11; detected $DetectedVersion."
}

if (-not (Test-Path $VenvPython)) {
    & py "-$PythonVersion" -m venv $VenvDir
}

& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r (Join-Path $YoloDir "requirements.txt")

$HasNvidiaGpu = $null -ne (Get-Command nvidia-smi -ErrorAction SilentlyContinue)
$CudaAvailable = (& $VenvPython -c "import torch; print('true' if torch.cuda.is_available() else 'false')").Trim() -eq "true"
if ($HasNvidiaGpu -and -not $CpuOnly -and -not $CudaAvailable) {
    Write-Host "NVIDIA GPU detected; installing the official PyTorch CUDA 12.6 wheels..."
    & $VenvPython -m pip install --upgrade torch torchvision --index-url https://download.pytorch.org/whl/cu126
}

& $VenvPython -c "import fiftyone, PIL, torch, ultralytics; print('Python environment ready. CUDA available:', torch.cuda.is_available()); print('Torch:', torch.__version__)"

Write-Host "Environment ready: $VenvPython"
