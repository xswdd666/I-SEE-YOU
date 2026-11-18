# 模型、SDK 与来源

| 资产 | 目标路径 | 来源 / 恢复方式 |
| --- | --- | --- |
| YOLO11s | `pc-gateway/models/yolo11s.pt` | Ultralytics 官方 YOLO11 资产，已有交接权重 SHA-256 见同目录 manifest.json |
| DINOv2 ViT-S/14 | `pc-gateway/models/dinov2_vits14_pretrain.pth` | https://dl.fbaipublicfiles.com/dinov2/dinov2_vits14/dinov2_vits14_pretrain.pth ，哈希见 dinov2-manifest.json |
| XFeat 可选细节模块 | `pc-gateway/vendor/xfeat/weights/xfeat.pt` | https://github.com/verlab/accelerated_features ，交接权重哈希见 appearance-runtime-manifest.json |
| 原手机 TFLite | `models/yolo/model-*.bin` → Android exp.tflite | 私有交接资产；manifest 记录分片及整体哈希，训练/许可来源未完整提供，因此不再分发 |
| AOQ 语音 SDK | `android/app/libs/AoqClientSdk-release.aar` 与配套 Opus so | 从千问官方实时通话渠道取得，或有权使用的原始交接包恢复 |
| Vosk/JNA | `android/app/libs` 中 jar、ARM64 so 及 speech 模型 | 原交接包或供应方官方渠道，遵守各自条款 |
| ESP32 唤醒模型 | `blind-vision-camera-miaomiao/wake-model` | 仅唤醒词固件需要，按目录中的 LICENSE 与原资产准备；控灯版不加载 |

`scripts/restore-local-assets.ps1` 从合法持有的交接根目录定向恢复上述资源，不复制 .env、runtime、证书或个人数据。恢复的二进制仍被 Git 排除；不能把此脚本当作通用公开模型下载器。

保留 vendor 中各自 LICENSE；Ultralytics 的模型、代码和商业使用条件需按上游许可确认。公开源码并不自动授予所有 SDK/模型再分发权。工程原有二进制清单记录不等于已确认可公开再分发。

GPU Python 依赖沿用 `pc-gateway/requirements-gpu.txt` 锁定版本，新机器安装和驱动适配未在本次发布重做。恢复资产后运行 `.venv/Scripts/python.exe scripts/gpu-smoke.py` 验证目标 GPU。

历史文档可能含旧部署域名及本机路径，当前 README 是运行入口；实际部署须使用自己的服务与认证配置。
