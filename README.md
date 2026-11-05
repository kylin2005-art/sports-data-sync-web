# Sports Data Sync Web · 骑行数据同步

Sports Data Sync Web 是一个可以自托管的骑行数据工作台。它支持 Garmin Connect（佳明中国区和国际区）及多个运动平台之间的活动同步，也能把 FIT / GPX 原文件保存在自己的电脑或 NAS 上。支持 Windows 本机运行和 Docker Compose 部署，已在 Unraid 上实际安装验证。

[详细使用说明](docs/使用说明.md) · [平台接入范围](#平台接入范围) · [部署与升级](#部署与升级)

## 同步骑行活动

- **佳明跨区同步**。分别连接佳明中国区和国际区，可将任一区域设为来源或目标。两步验证在佳明官网完成。部署时请按使用说明选择适用的授权方式。
- **FIT / GPX 原文件**。可以从来源下载、导入已有文件，或一次发送到多个目标。工作台记录各目标的发送状态，跳过已确认或待核对的活动。佳明导入可按目标活动 ID 回查。
- **全量历史和定时增量**。在「数据同步」选择来源和目标后，点「设置全量骑行同步」。首次逐页扫描来源开放的历史，只发送识别为骑行的活动。后续仍会检查列表，传输新增和可重试的记录。

## 轨迹表、3D 地图和骑行战报

「轨迹工具」按页列出活动日期、骑行用时、里程、平均功率、平均心率、平均速度和累计爬升。点击表头可排序当前页。单选进入骑行分析，多选可以预览、叠加或合并轨迹。

分析页可主动加载 MapLibre 真实地图，用速度或功率给轨迹着色。带连续海拔数据的活动还可以生成可旋转的 **3D 海拔轨迹**，在全窗口查看，单独导出 PNG，或嵌入骑行战报。

战报支持 3:4 和 9:16，默认隐藏路线和日期。显示路线时，可以选择完整轨迹或裁去起终点附近，再下载 PNG 或通过受支持的浏览器分享。

<img src="docs/images/3d-ride-report.png" width="360" alt="使用合成骑行数据生成的 3D 海拔轨迹战报示例">

## 快速开始

### Windows 本机运行

1. 安装 Node.js 22.13 或更新版本，并准备 Chrome 或 Edge。
2. 在项目目录双击 `start.cmd`。首次运行会安装依赖并构建工作台。
3. 打开 [本机工作台](http://127.0.0.1:8766/)，在「平台账号」连接来源和目标。
4. 到「数据同步」先读一页活动，勾选一条测试下载，再同步到所选目标。

也可在项目目录执行 `npm ci` 和 `npm start`。运行 `npm test` 可执行离线测试。

### Docker Compose 自托管

使用支持 Linux 容器的 Docker 主机和 Compose v2。Unraid、Linux 主机和运行 Linux 容器的 Docker Desktop 可使用同一份 Compose 配置。按手册准备 `.env` 和凭据加密密钥，再运行 `docker compose up -d --build`。个人版首次打开时创建工作台账号。邀请制由管理员生成注册链接，各账号的数据独立保存。

主机本机试用、Unraid 内网访问和佳明授权所需的 HTTPS 配置见 [部署与使用手册](docs/使用说明.md)。

## 平台接入范围

| 能力 | 平台 |
| --- | --- |
| 读取与上传 | 佳明中国区 / 国际区、iGPSPORT 中国区 / 国际区、行者、迈金、黑鸟单车、高驰中国区 / 国际区、Intervals.icu、Wahoo、Suunto、Komoot、骑行市 |
| 读取活动 | 百锐腾、MyWhoosh、Zwift |
| 读取与手动导入 | Keep 可读取带 GPS 的骑行，作为目标时下载 FIT 后到 Keep App 导入 |
| 上传 | 捷安特、Outbase |
| 训练课表 | 从 Intervals.icu 下载计划 FIT，推送兼容课表到 iGPSPORT 中国区 / 国际区或百锐腾国际区 |
| 本机文件 | FIT / GPX 导入、归档、下载和转存 |

活动的读取、下载和上传权限取决于平台与当前账号。部分目标只返回接收回执，工作台会将它与已确认结果区分。各平台的接入步骤和限制见 [详细使用说明](docs/使用说明.md)。

## 部署与升级

Docker 卷保存工作台账号、原始活动文件、任务和同步回执。平台凭据使用单独的密钥加密。升级前备份数据卷、密钥和部署配置，保留同一个 Compose 项目及其挂载，再执行 `docker compose up -d --build`。Windows 版本更新源码后执行 `npm ci`，随后重新启动。

3D 海拔轨迹和战报 PNG 在浏览器内绘制。主动开启真实地图时，浏览器向地图服务请求当前区域的地图瓦片。 [OpenFreeMap](https://openfreemap.org/) · [Mapterhorn](https://mapterhorn.com/)

## 来源与依赖

工作台流程和平台适配参考了 Anathleticbicyclist 的 Android 项目。`fit-coordinate.mjs` 的坐标换算参考并改编自其 `FitGcj02Fixer.kt`。 [原项目](https://github.com/Anathleticbicyclist/sports-data-sync-multiplatform) · [参考源码](https://github.com/Anathleticbicyclist/sports-data-sync-multiplatform/blob/38204ab682e5169bbb2af78974fc3c802fcbafe1/app/src/main/java/com/jichi/ob/util/FitGcj02Fixer.kt)

界面使用 Vue 3 和 Element Plus。地图使用 MapLibre GL JS，FIT 编解码使用 Garmin FIT JavaScript SDK。各依赖适用各自的许可。 [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) · [Garmin FIT JavaScript SDK](https://github.com/garmin/fit-javascript-sdk)
