# 硬件与固件

主要组成：XIAO ESP32S3 Sense、Android ARM64 手机、NVIDIA GPU 电脑。

| 固件目录 | 作用 |
| --- | --- |
| `blind-vision-camera` | 基础摄像头与 BLE/Wi-Fi 接入 |
| `blind-vision-camera-app-led` | 通电 BLE 配网、App 控灯；LED 关闭不等于设备断电 |
| `blind-vision-camera-miaomiao` | 本地唤醒词探索，需额外模型 |

目录位于 `esp32-firmware/`。控灯版原始 FQBN：`esp32:esp32:XIAO_ESP32S3:CDCOnBoot=default,USBMode=hwcdc,PSRAM=opi`，8 MB Flash、OPI PSRAM。安装 Arduino ESP32 core，打开目标 .ino，选择板卡和配套分区配置，先编译再烧录。串口号按本机确认，不沿用历史 COM3。

调试顺序：供电/排线 → 摄像头初始化 → 手机 BLE 配网回执 → 网络可达性 → 鉴权视频帧更新 → Gateway 核验 → 语音反馈。Wi-Fi 在线不等于摄像头正常；不要绕过鉴权，也不要为安装演示擦除 NVS。

不同版本分区与固件不可混刷。历史固件使用说明是当时设备记录；本次没有重新编译、烧录或实测硬件。ESP32 不运行电脑 DINOv2，也不承担安全导航。
