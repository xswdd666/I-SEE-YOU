# 本地 SDK 与原生库

二进制不进入公开 Git。构建前按 app/build.gradle.kts 准备 AoqClientSdk-release.aar、vosk.jar、jna.jar 及配套 ARM64 原生库。

可从有权使用的交接根目录运行 `scripts/restore-local-assets.ps1`，或依据根目录 docs/DEPENDENCIES.md 的供应方渠道取得。勿在 APK 中嵌入 API Key。
