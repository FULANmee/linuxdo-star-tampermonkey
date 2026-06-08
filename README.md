# LinuxDo Star - Tampermonkey

LinuxDo Star - Tampermonkey 是参考 [codedogQBY/LinuxDoStar](https://github.com/codedogQBY/LinuxDoStar) 移植和整理的用户脚本版本，用于在 [linux.do](https://linux.do/) 收藏帖子和评论。

相比原 Chrome 扩展版本，这个版本可以直接通过 Tampermonkey 安装使用，不需要加载浏览器扩展；同时补充了右下角悬浮星标入口、站内抽屉式收藏管理、标签与备注、导入导出、安全数据清洗，以及收藏夹删除后的同步删除记录，避免删除收藏夹后再次同步又被远端旧数据恢复。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开脚本地址：

   https://raw.githubusercontent.com/FULANmee/linuxdo-star-tampermonkey/main/linuxdo-star.user.js

3. Tampermonkey 会提示安装，确认后保存。
4. 打开 `https://linux.do/`，页面右下角会出现星标收藏管理入口。

## 功能

- 在帖子标题旁添加星标按钮，可收藏或取消收藏当前帖子。
- 在评论操作栏添加星标按钮，可单独收藏或取消收藏评论。
- 鼠标悬停星标可选择收藏夹，也可以在选择器里快速新建收藏夹。
- 右下角常驻悬浮星标入口，显示当前收藏数量，点击打开收藏管理面板。
- 收藏管理面板支持按收藏夹浏览、搜索、排序、展开评论、多选和批量删除。
- 帖子和评论都支持移动收藏夹、查看详情、添加标签和备注。
- 支持新建、编辑和删除收藏夹；删除收藏夹时其中的收藏会移动到默认收藏夹。
- 支持 JSON 导入和导出，方便备份或迁移数据。
- 支持 GitHub 私有 Gist 同步，可手动同步，也可自动同步。
- 提供 Tampermonkey 菜单命令：打开收藏管理、立即同步。
- 适配 Discourse 单页路由和虚拟滚动，滚动加载后的评论也会补充星标状态。

## 同步

同步使用 GitHub Personal Access Token，需要 `gist` 权限。

Token 创建地址：

https://github.com/settings/tokens/new?scopes=gist&description=LinuxDo+Star+Sync

连接后，脚本会查找或创建一个包含 `linuxdo-stars.json` 的私有 Gist，用来保存收藏数据。自动同步策略是收藏数据变更后延迟同步，并每 30 分钟定时拉取远端数据。

同步合并会保留较新的修改，并使用删除记录处理帖子、评论和收藏夹的删除状态。特别是收藏夹删除后会写入同步删除记录，因此再次同步时不会被远端旧收藏夹恢复。

## 权限与隐私

脚本权限：

- `GM_getValue` / `GM_setValue`：保存收藏数据和同步配置。
- `GM_xmlhttpRequest`：访问 GitHub API 做 Gist 同步。
- `GM_registerMenuCommand`：提供 Tampermonkey 菜单快捷入口。
- `GM_addStyle`：注入脚本界面样式。
- `@connect api.github.com`：仅允许同步请求访问 GitHub API。

重要说明：

- GitHub Token 会保存在 Tampermonkey 的脚本存储中。
- Token 不会写入导出的收藏 JSON，也不会发送到 GitHub 以外的域名。
- 建议使用只带 `gist` 权限的独立 Token，不要复用高权限 Token。
- 断开同步会清除本地保存的 Token，但不会删除本地收藏或远端 Gist。

## 安全性

脚本做了以下防护：

- 不使用 `eval` 或 `new Function`，不读取 Cookie。
- 导入 JSON 和远端 Gist 数据都会按字段白名单重建。
- 过滤 `__proto__`、`constructor`、`prototype` 等危险键。
- 导入文件限制为 5 MB，GitHub API 响应限制为 10 MB。
- 收藏链接只允许 `https://linux.do/`。
- 同步请求只允许访问 `https://api.github.com/user` 和 `https://api.github.com/gists...`。
- GitHub 请求方法限制为 `GET`、`POST`、`PATCH`，并设置 20 秒超时。

## 数据说明

收藏数据保存在 Tampermonkey 的脚本存储中，主要包括：

- `collections`：收藏夹信息。
- `bookmarks`：帖子收藏、评论收藏、标签和备注。
- 同步删除记录：用于在多设备同步时保留删除状态，避免远端旧数据回流。

导出的 JSON 只包含收藏数据，不包含 GitHub Token。

## 来源与许可

本项目基于 [codedogQBY/LinuxDoStar](https://github.com/codedogQBY/LinuxDoStar) 的功能设计和实现思路移植为 Tampermonkey 用户脚本。上游 README 声明许可证为 MIT，本仓库同样以 MIT License 发布，并保留上游项目链接与署名说明。
