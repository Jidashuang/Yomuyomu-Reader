# 架构说明（MVP/Beta）

## 1. 总体结构
YomuYomu 当前采用前后端同仓库、后端单进程服务静态文件与 API 的结构，适合 MVP/Beta 阶段的持续迭代。

```text
.
├── index.html / app.js / reader.js / state.js / readerStore.js
├── admin.html / admin.js
├── ops.html / ops.js
├── backend
│   ├── server.py
│   ├── api/handler.py
│   ├── config.py
│   ├── services/
│   ├── repositories/
│   ├── data/
│   └── keys/
└── tests
    ├── backend/
    └── e2e/
```

## 2. 前端层（Vanilla JS）
- 入口：`app.js`
- 核心阅读逻辑：`reader.js`
- 状态与常量：`state.js`、`readerStore.js`
- 辅助模块：`wordPopover.js`、`vocab.js`、`sync.js`
- 页面：`index.html`（阅读器）、`admin.html`（管理）、`ops.html`（运营）

## 3. 后端层（Python）
- 启动入口：`backend/server.py`
- 路由与 HTTP 处理：`backend/api/handler.py`
- 配置与环境变量：`backend/config.py`
- 服务层：`backend/services/*`
  - 负责导入、分析、AI 解释、账号、限流、运维等业务逻辑
- 仓储层：`backend/repositories/*`
  - 负责 SQLite/JSON 的读写访问

## 4. 数据存储（本地文件 + SQLite）
运行时主要使用 `backend/data/`：
- `app.db`：应用主数据（账号、阅读记录等）
- `jmdict.db`：JMDict 构建后的词典库（可选）
- `cloud/*.json`：同步快照
- `import_jobs/`：导入任务数据
- `backups/`：备份文件

说明：MVP/Beta 阶段默认本地存储，部署到无持久卷环境时，部分数据可能在容器重启后丢失。

## 5. 主要请求流
1. 阅读导入：前端上传文件 -> `/api/books/import` 或 `/api/import` -> 导入服务解析 -> 统一章节结构返回。
2. 点词查义：前端触发 -> `/api/nlp/tokenize` + `/api/dict/lookup` -> 返回词形与释义。
3. 同步：前端调用 `/api/sync/push` / `/api/sync/pull` -> 写入或读取 `backend/data/cloud/`。
4. 计费：前端调用 `/api/billing/*` -> 支付渠道/订单处理 -> 更新用户套餐状态。

## 6. 当前边界
- 已具备可运行的读书与学习闭环。
- 已接入基础测试与部署能力。
- 暂未扩展为多服务微服务架构，也未默认提供强一致的云端持久化。
