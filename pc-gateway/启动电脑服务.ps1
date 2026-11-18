param([ValidateRange(1024,65535)][int]$Port = 8765)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if(-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')){throw 'Run the environment preparation script first'}
$env:ISEEYOU_PYTHON=(Resolve-Path -LiteralPath '.venv/Scripts/python.exe').Path
$env:APPEARANCE_PYTHON=$env:ISEEYOU_PYTHON
$env:ISEEYOU_DEVICE='0'
$env:ISEEYOU_MATCHER='appearance_mvp'
$env:ISEEYOU_PORT=[string]$Port
$env:PYTHONUTF8='1'
& $env:ISEEYOU_PYTHON -c 'import torch; assert torch.version.cuda and torch.cuda.is_available(), "CUDA GPU unavailable"; print(torch.cuda.get_device_name(0))'
if($LASTEXITCODE -ne 0){throw 'CUDA GPU unavailable; check driver and PyTorch installation'}
& node --env-file-if-exists=.env src/server.mjs
if($LASTEXITCODE -ne 0){throw 'Gateway exited with an error'}
