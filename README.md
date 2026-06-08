# LinuxDo Star - Tampermonkey

这是参考 [codedogQBY/LinuxDoStar](https://github.com/codedogQBY/LinuxDoStar) 移植的 Tampermonkey 用户脚本版本，用于在 [linux.do](https://linux.do/) 收藏帖子和评论。

## 安装

1. 安装 Tampermonkey。
2. 打开脚本地址：

   https://raw.githubusercontent.com/FULANmee/linuxdo-star-tampermonkey/main/linuxdo-star.user.js

3. Tampermonkey 会提示安装；确认后保存。
4. 打开 `https://linux.do/`，右下角会出现收藏管理入口。

## 功能

- 帖子标题旁星标收藏。
- 评论操作栏星标收藏。
- 鼠标悬停星标选择收藏夹。
- 收藏夹创建、编辑、删除和移动。
- 站内抽屉式收藏管理：搜索、排序、展开评论、批量删除、备注、标签。
- JSON 导入和导出。
- GitHub 私有 Gist 同步。

## 同步

同步使用 GitHub Personal Access Token，需要 `gist` 权限。

Token 创建地址：

https://github.com/settings/tokens/new?scopes=gist&description=LinuxDo+Star+Sync

连接后脚本会查找或创建名为 `linuxdo-stars.json` 的私有 Gist。自动同步策略为收藏变更 30 秒后同步一次，并每 30 分钟定时同步一次。

## 权限与隐私

脚本权限：

- `GM_getValue` / `GM_setValue`：保存收藏数据和同步配置。
- `GM_xmlhttpRequest`：访问 GitHub API 做 Gist 同步。
- `GM_registerMenuCommand`：在 Tampermonkey 菜单中提供快捷入口。
- `GM_addStyle`：注入脚本界面样式。
- `@connect api.github.com`：仅允许同步请求访问 GitHub API。

重要说明：

- GitHub Token 会保存在 Tampermonkey 的脚本存储中。它不会被写入导出的收藏 JSON，也不会发送到 GitHub 以外的域名，但 Tampermonkey 存储不是密码管理器。
- 建议使用只带 `gist` 权限的独立 Token，不要复用高权限 Token。
- 断开同步会清除本地保存的 Token，但不会删除本地收藏或远端 Gist。

## 安全性

脚本做了以下防护：

- 不使用 `eval`、`new Function`，不读取 Cookie。
- 导入 JSON 和远端 Gist 数据都会按白名单字段重建，过滤 `__proto__`、`constructor`、`prototype` 等危险键。
- 导入文件限制为 5 MB，远端响应限制为 10 MB。
- 收藏链接只允许 `https://linux.do/`，同步请求只允许 `https://api.github.com/user` 与 `https://api.github.com/gists...`。
- GitHub 请求限制为 `GET`、`POST`、`PATCH`，并设置 20 秒超时。

## 来源与许可

本项目基于 [codedogQBY/LinuxDoStar](https://github.com/codedogQBY/LinuxDoStar) 的功能设计和实现思路移植为 Tampermonkey 用户脚本。上游 README 声明许可证为 MIT，本仓库同样以 MIT License 发布，并保留上游项目链接与署名说明。

如果你是上游作者并希望调整署名、说明或授权表达，请通过 Issue 联系。
