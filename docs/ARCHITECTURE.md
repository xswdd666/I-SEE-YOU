# I SEE YOU 架构与数据流

## 运行基线

整理自 2026-11-07 提交快照。Gateway package.json 保留旧工程版本号，`src/server.mjs` health 返回 0.20.11；行为以实际源码为准。默认 `appearance_mvp` 的 DINOv2 代码要求 CUDA GPU，名称不代表提供 CPU 回退。

| 层 | 主要模块 | 职责 |
| --- | --- | --- |
| 设备采集 | `esp32-firmware/*` | 摄像头、BLE、Wi-Fi 视频、设备指令与回执 |
| 手机交互 | `android/app/src/main/` | CameraX、语音入口、视频源切换、设备与 Gateway 配对 |
| 服务连接 | `server.mjs`, `discovery.mjs` | HTTPS、WebSocket、局域网发现、配对、证书、鉴权 |
| 任务状态 | `session.mjs`, `flows.mjs`, `intent.mjs`, `memory-dialogue.mjs` | 意图路由、四类流程边界、确认与取消 |
| 候选视觉 | `yolo.mjs`, `python/yolo-worker.py`, `target-locator.mjs` | YOLO 检测及指定类外目标语义定位协作 |
| 身份核验 | `appearance.mjs`, `python/appearance_model.py` | DINOv2、颜色、比例与可选 XFeat 比较 |
| 记忆与反馈 | `memory.mjs`, `archive.mjs`, `found-location.mjs`, `tracking.mjs` | 参考/历史存储、导入导出、当前方位与确认反馈 |
| 云模型 | `omni*.mjs`, `qwen-speech.mjs`, `providers.mjs` | 实时语义、视觉补充、语音生成 |

上述 Gateway JS 模块位于 `pc-gateway/src/`，Python 模块位于 `pc-gateway/python/`。

## 录入

明确记录意图 → 新画面目标 → 澄清名称/外观 → 保存参考和观察位置 → 返回保存回执。重拍保持本次目标；“用手机拍”中的手机不能变成新物品。旧记录选择不能劫持新录入。

## 寻找

寻找意图 → 读取目标参考 → 当前视频帧 → 候选检测 → 外观核验 → 帧/任务版本校验 → 语音输出本次画面中的区域和可见参照 → 结束本轮比较。

找到不等于拿到，不自动覆盖长期位置；用户纠错或再次寻找才启动新的核验。语义结束和无继续指令超时会收束任务。旧模型返回不能复活已取消任务。

## 特征与记忆

`appearance-config.json` 配置外观向量、颜色、比例的评分权重及歧义阈值，可选细节加分。阈值是工程参数，不是大样本准确率结论。DINOv2 采用 224×224 letterbox 预处理、384 维归一化 CLS 向量。

参考缓存键包含图像哈希、权重哈希、预处理版本与细节模块状态；参考变更失效，重启从本地索引恢复。历史位置不替代当前画面；当前候选描述必须来自本次图像。

## 边界

手机与 ESP32 是可切换来源，切换后旧 generation 的结果无效。ESP32 提供采集/连接，电脑提供 GPU 视觉计算，千问提供开放语义与反馈。TLS、配对凭据和记忆库在新机器生成；云备份可选且需自行配置。

历史 Android 本地 TFLite、Web 和云端实现保留作工程资料，不保证多种部署一次安装即可互通。逻辑测试、固定图片模型测试、真实硬件验收与用户效果必须分开解释。
