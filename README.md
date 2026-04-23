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
   - `完整同步私信历史`
   - `导出完整历史 JSON`

## 当前实现

已完成：
- 完整历史数据模型（`message_id` 主键）
- `dialogs` + `messages` 双存储
- 按聊天列表遍历并抓取 `/notification/message/with/{userId}`
- 完整历史 JSON 导出

待继续增强：
- 增量同步优化
- 自动上传 WebDAV / R2
- UI 面板
- 失败重试和更细的限速控制
- 大数据量导出优化

## 文件

- `ns-df-chat-full-history.user.js`：主脚本
