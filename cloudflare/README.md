# Cloudflare 免费额度部署

复用同一个播放器，使用 Workers 处理私人登录和音频请求，R2 保存音频。家里的 Mac 无需保持开机。这里提供的是部署代码，不代表已经上线。

## 账户条件

需要你自己的 Cloudflare 账号，并由你完成 R2 的订阅开通流程。不要为本项目升级 Workers 到付费套餐。R2 Standard 当前有 10 GB-month 免费额度、每月 100 万次 A 类/1000 万次 B 类操作，出站播放流量免费；超额可能计费，免费额度不是永久免费或硬性账单上限。账户里其他项目也可能消耗额度。

本应用限制单个上传 80 MB，书库按已存文件总量检查 8 GB 保护线。这是应用保护，不是 Cloudflare 账户硬预算（并发上传和账户其他资源不在此保护范围）。若需要绝对不可能产生费用，不应启用按量计费的 R2，改用私人网络或手机离线文件。

## 部署步骤

在当前目录使用最新 Wrangler（建议隔离安装），完成账号登录。

```sh
python3 prepare.py
wrangler r2 bucket create playrecap-private-audio
wrangler deploy
wrangler secret put ACCESS_CODE
```

`ACCESS_CODE` 使用至少 20 字符的随机口令，通过 secret 命令的标准输入设置，不写入代码或命令参数。不要开启 R2 公共访问或 r2.dev；所有音频经过 Worker 的登录检查。

Wrangler 返回正式 HTTPS 地址后，先验证未登录时音频为 401，再登录上传已下载的 M4A 文件。上传工具与网页均复用 `/api/upload` 接口。部署只包含 8 个网页与应用图标文件及 Worker，音频不进入 Git 或静态托管。

在仓库根目录运行 `python3 upload_library.py --site 'https://你的书库地址' --book '书名'` 可补传已下载的音频。后续直接使用 `import_youtube.py` 的 `--site` 参数，串联批量下载和上传；两步都可重跑续传。导入命令需在 Mac 上运行，完成后手机播放不需要 Mac 开机。

`wrangler.jsonc` 中存储桶名称为本项目建议的新名称；部署前检查账户中不存在同名的无关存储桶，若有则选择新的名字并更新配置，不复用无关数据。

## 验收

手机关闭 Wi-Fi，使用流量打开 HTTPS 地址。检查播放、进度拖动、自动下一章、重新打开续听，再检查锁屏半小时和锁屏跨章。浏览器进度仍按设备保存，尚无离线缓存。

参考：[R2 价格](https://developers.cloudflare.com/r2/pricing/)、[R2 开通](https://developers.cloudflare.com/r2/get-started/)、[Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)。
