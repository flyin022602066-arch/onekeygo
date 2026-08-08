# OneKeyGo Studio Windows 桌面版

桌面版使用 Electron 承载现有 Nuxt 界面，并在同一应用进程内启动 Hono 后端。安装后无需 Docker，也不需要用户另装 Node.js 或 FFmpeg。

## 系统要求

- Windows 10/11 64 位
- 开发与打包需要 Node.js 20 或更高版本
- 安装包运行需要网络访问已配置的 AI 服务

## 开发运行

在项目根目录执行：

```powershell
npm run setup
npm run desktop:dev
```

## 构建 Windows 安装包

双击根目录的 `build-windows.bat`，或者执行：

```powershell
npm run desktop:dist
```

安装包输出到 `desktop/release/`。NSIS 安装器允许用户自选安装目录，并创建桌面和开始菜单快捷方式。

## 用户数据

数据库、配置、生成素材和日志不会写入安装目录，而是保存在：

```text
%APPDATA%\onekeygo-studio-desktop\
```

主要目录：

- `data/eggfans_drama.db`：SQLite 数据库
- `data/static/`：上传与生成素材
- `configs/config.yaml`：本地配置
- `logs/desktop.log`：桌面启动与后端日志

卸载应用默认保留该目录，避免误删用户项目。应用菜单中的 `Help > Open Data Folder` 可直接打开数据目录。

## 桌面端特性

- 单实例启动，重复双击只聚焦现有窗口
- 本地后端只监听 `127.0.0.1`，端口占用时自动选择空闲端口
- 内置 FFmpeg/FFprobe，用于配音、字幕、视频合成与导出
- 自动保存窗口位置和大小，并处理多显示器变化
- 外部网页使用系统默认浏览器打开
- Electron 渲染进程启用上下文隔离、沙箱并禁用 Node 集成
