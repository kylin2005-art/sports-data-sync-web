# 运动数据同步 · 本机网页版 0.2.2

本机工作台参照 `sports-data-sync-multiplatform` 的同步、平台账号、任务、记录中心与轨迹工具流程实现。

## 开始使用

1. 安装 Node.js 22.13 或更新版本，并准备 Microsoft Edge 或 Google Chrome。
2. 双击 `start.cmd`，保持启动窗口运行。首次启动会安装依赖。
3. 打开 [同步工作台](http://127.0.0.1:8766/)。在「平台账号」连接来源和目标。
4. 在「数据同步」选择来源和目标，读取并勾选活动。可先测试下载一条，再开始同步。

也可在项目目录运行 `npm.cmd ci` 和 `npm.cmd start`。`npm.cmd test` 运行离线测试。

## 佳明中国 → 国际

点工作台上的「佳明中国 → 国际」选择路线。两区在独立浏览器配置中登录，在佳明官网输入密码和两步验证码，回到工作台验证登录。显示「已保存」后可以关闭佳明登录窗口。后续由服务在后台恢复会话，并核对账号。活动列表遇到 HTTP 403 时会刷新佳明网页并核对账号，再读取一次。遇到 HTTP 304 时会用新请求重试一次。

原始文件下载允许佳明返回 ZIP 或 FIT，并校验包内原始 FIT。连续两条活动的下载都返回 HTTP 406 时，停止本批任务。

工作台保存原始 FIT。每个活动发往多个目标时共享一次下载。佳明上传前登记发送状态，获得目标活动编号后立即保存。按该编号在目标账号读回记录后才计为确认。目标短暂返回 404 时只重试读回。再次运行同一活动时，已有编号的待确认记录只回查。没有编号的待确认记录会等待人工核对。

同步记忆按来源和目标账号区分。即使换来源或更改文件名，同一份原始文件发往同一目标已有发送记录时也会跳过。佳明网页接口返回稳定账号标识时，重启后可继续回查。历史连接无法与当前账号匹配时，工作台会保留旧回执并跳过发送，等待核对。

## 平台接入

以下为已实现的连接方向。账号要求和完整覆盖表见「平台账号」。

| 能力 | 平台 |
| --- | --- |
| 读取与上传 | 佳明中国、佳明国际、iGPSPORT、行者、迈金、Intervals.icu、Wahoo、Suunto、Komoot |
| 读取原始 FIT | 高驰中国、高驰国际（含欧洲区域） |
| 上传 | 黑鸟单车、捷安特、Outbase |
| 本机文件 | FIT / GPX 导入、保存和下载 |

佳明、iGPSPORT、行者、迈金、黑鸟、Outbase 与高驰提供官网登录入口。其他入口按平台要求配置已有会话、API Key 或开发者授权。部分平台只提供异步接收回执，这些会显示为「平台已接收」。

百锐腾、Keep、咕咚、Zepp、MyWhoosh、Zwift、骑行市、两步路和实验室平台，以及高驰上传和黑鸟读取，仍有接口待移植。原版训练课表、蓝牙传感器、完整码表和 3D 轨迹样式也尚未覆盖。

## 本机任务与文件

- 同步任务可保存来源、多个目标、同步数量、跳过数量和 15/30/60 分钟间隔。定时任务由本机服务执行。官网登录窗口和工作台标签页都可以关闭。会话失效后，相关任务等待重新连接。
- 活动原文件、任务、最近一次任务日志和逐活动同步记录写入 `%LOCALAPPDATA%\GarminCnTransferWeb\sync.sqlite`。独立登录配置保存在同一目录下的 `workbench-profiles`。连接凭据用当前 Windows 用户的 DPAPI 加密保存，同一用户重启服务后可以继续使用有效会话。
- 轨迹工具可预览、叠加 FIT/GPX 轨迹、导出透明 PNG，以及按时间合并为 GPX。FIT 转 GPX 只保留可表示的字段。上传到仅接收 FIT 的目标时，可以从包含原始时间的 GPX 生成 FIT，同时保留源文件。
- 临时定位记录使用浏览器定位权限，可记录骑行、跑步或徒步并保存 GPX。记录期间需要设备定位和页面持续运行。
- 迈金 WGS84 原文件可直接同步。已知使用 GCJ-02 的备用 FIT 会先保留原件，再在可校验的文件副本上纠偏。遇到压缩时间戳、开发者字段或无法确认的布局时会停在文件校验阶段。

离线测试覆盖请求格式、回执、佳明读回、重启后确认和文件处理。各平台真实账号连接、上传和定位硬件仍需实际验证。

## 来源与依赖

工作台和平台接口适配参考了 Anathleticbicyclist 的 Android 项目。`fit-coordinate.mjs` 的坐标换算参考并改编了该项目的 `FitGcj02Fixer.kt`。 [原项目](https://github.com/Anathleticbicyclist/sports-data-sync-multiplatform) · [坐标转换源码](https://github.com/Anathleticbicyclist/sports-data-sync-multiplatform/blob/38204ab682e5169bbb2af78974fc3c802fcbafe1/app/src/main/java/com/jichi/ob/util/FitGcj02Fixer.kt)

FIT 编解码使用 Garmin FIT JavaScript SDK。Playwright、fflate、xmldom 和 FIT SDK 由 `npm ci` 安装，分别适用各自的许可。 [Garmin FIT JavaScript SDK](https://github.com/garmin/fit-javascript-sdk)
