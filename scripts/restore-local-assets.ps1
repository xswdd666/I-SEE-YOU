param([Parameter(Mandatory=$true)][string]$SourceDirectory)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $SourceDirectory).Path
$targetRoot = Split-Path -Parent $PSScriptRoot
if ($sourceRoot.TrimEnd('\') -eq $targetRoot.TrimEnd('\')) { throw 'Source must be the original handoff, not this repository' }
$items = @('models/yolo','pc-gateway/models/yolo11s.pt','pc-gateway/models/dinov2_vits14_pretrain.pth','pc-gateway/vendor/xfeat/weights','android/app/libs','android/app/src/main/assets/speech','esp32-firmware/blind-vision-camera-miaomiao/wake-model')
foreach ($relative in $items) {
    $source = Join-Path $sourceRoot $relative
    $target = Join-Path $targetRoot $relative
    if (-not (Test-Path -LiteralPath $source)) { Write-Warning "Not found: $relative"; continue }
    if ((Get-Item -LiteralPath $source).PSIsContainer) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Get-ChildItem -LiteralPath $source -File -Recurse | Where-Object { $_.Extension -in '.bin','.tflite','.pt','.pth','.jar','.aar','.so' -or $_.Name -eq 'LICENSE' } | ForEach-Object {
            $suffix = $_.FullName.Substring($source.Length).TrimStart('\','/')
            $destination = Join-Path $target $suffix
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination
        }
    } else {
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
    }
    Write-Output "Restored: $relative"
}
foreach ($relative in @('pc-gateway/models/manifest.json','pc-gateway/models/dinov2-manifest.json')) {
    $manifestPath = Join-Path $targetRoot $relative
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $file = if ($manifest.file) { $manifest.file } else { 'dinov2_vits14_pretrain.pth' }
    $path = Join-Path (Split-Path -Parent $manifestPath) $file
    if (Test-Path -LiteralPath $path) {
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw "Checksum mismatch: $file" }
        Write-Output "Verified: $file"
    }
}
Write-Output 'Run node scripts/build-android-assets.mjs to verify and restore Android TFLite.'
