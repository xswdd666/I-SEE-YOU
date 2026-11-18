param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'
if($LASTEXITCODE -ne 0){throw 'Install Node.js 24 or newer'}
& $Python -c 'import sys; assert sys.version_info[:2] == (3,11), "Python 3.11 required"'
if($LASTEXITCODE -ne 0){throw 'Use 64-bit Python 3.11'}
if(-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')){
    & $Python -m venv .venv
    if($LASTEXITCODE -ne 0){throw 'Cannot create virtual environment'}
}
& '.venv/Scripts/python.exe' -m pip install -r requirements-gpu.txt
if($LASTEXITCODE -ne 0){throw 'GPU dependency installation failed'}
& npm ci --ignore-scripts --no-audit --no-fund
if($LASTEXITCODE -ne 0){throw 'Node dependency installation failed'}
& '.venv/Scripts/python.exe' scripts/gpu-smoke.py
if($LASTEXITCODE -ne 0){throw 'GPU/model check failed'}
if(-not (Test-Path -LiteralPath '.env')){Copy-Item -LiteralPath '.env.example' -Destination '.env'}
Write-Output 'Environment ready. Fill in .env, then run the start script.'
