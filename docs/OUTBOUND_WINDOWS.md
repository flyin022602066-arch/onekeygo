# 谜镜 Studio Windows 外发包

## 推荐安装方式

双击 `Mijing-Studio-Setup-2.0.0-x64.exe`，按安装向导选择目录即可。安装完成后从桌面或开始菜单打开“谜镜 Studio”。

系统要求：Windows 10/11 64 位。安装包已内置桌面运行时、后端、FFmpeg/FFprobe 和 SQLite 原生模块，普通用户不需要另装 Node.js 或 FFmpeg。

## 免安装方式

解压 `Mijing-Studio-Portable-2.0.0-x64.zip`，运行目录中的 `谜镜 Studio.exe`。便携版会把用户数据保存到 Windows 用户数据目录，不要删除该目录中的数据库和素材。

## 首次使用

打开“设置 → AI 服务”，服务商下拉目前只保留“Eggfans 聚合站”和“谜镜”。填写对应 API Key 后再测试配置并保存。

## 用户数据位置

```text
%APPDATA%\onekeygo-studio-desktop\
```

其中包含数据库、上传素材、配置和桌面日志。卸载程序默认保留这些数据。

## 校验文件

同目录的 `SHA256SUMS.txt` 包含安装版和便携版 ZIP 的 SHA-256 校验值。
