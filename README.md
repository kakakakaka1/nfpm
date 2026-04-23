# nfpm

NodeSeek / DeepFlood 私信**完整历史备份版**脚本。

## 这是什么

这是一个 Tampermonkey 用户脚本，用来修复 `likesrt/ns-df-chat-backup` 只保存“每个联系人最后一条消息”的问题。

原版的问题：
- 以 `member_id` 为主键
- 同一联系人后来的消息会覆盖前面的消息
- 导出的只是聊天列表快照，不是完整私信历史

这个版本改成：
- 以 `message_id` 为主键保存消息
- 按联系人逐个拉取会话详情
- 每条私信单独存档
- 支持导出完整历史 JSON
- 支持增量同步 / 全量同步
- 支持断点续跑
- 支持本地 JSON 导入 / 导出
- 支持关键词搜索后导出命中消息
- 支持 WebDAV / R2 备份
- 支持分片导出
- 支持自动定时备份骨架
- 内置基础重试和限速

## 支持站点

- NodeSeek
- DeepFlood

## 使用方法

1. 安装 Tampermonkey
2. 新建脚本
3. 粘贴 `ns-df-chat-full-history.user.js` 的内容
4. 打开私信页面：
   - `https://www.nodeseek.com/notification`
   - `https://www.deepflood.com/notification`
5. 从 Tampermonkey 菜单执行：
   - `增量同步私信历史`
   - `全量同步私信历史`
   - `导出完整历史 JSON`
   - `分片导出完整历史 JSON`
   - `导出会话摘要 JSON`
   - `导入完整历史 JSON`
   - `搜索并导出命中消息`
   - `配置 WebDAV`
   - `备份完整历史到 WebDAV`
   - `配置 R2`
   - `备份完整历史到 R2`
   - `配置自动定时备份`

## 当前实现

已完成：
- 完整历史数据模型（`message_id` 主键）
- `dialogs` + `messages` 双存储
- 按聊天列表遍历并抓取 `/notification/message/with/{userId}`
- 增量同步（根据会话最后时间跳过未变化对话）
- 断点续跑（中断后从 checkpoint 继续）
- 完整历史 JSON 导出
- 分片导出完整历史 JSON
- 会话摘要 JSON 导出
- 本地 JSON 导入
- 关键词搜索并导出命中消息
- WebDAV 手动备份
- R2 手动备份
- 自动定时备份骨架（页面保持打开时可触发）
- 基础失败重试和限速

待继续增强：
- UI 面板
- 更细粒度的增量策略
- 云端备份清单/恢复
- 真正后台化的定时调度

## 文件

- `ns-df-chat-full-history.user.js`：主脚本
