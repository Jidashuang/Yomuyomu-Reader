# YomuYomu 日语阅读器

YomuYomu 是一个前后端同仓库的日语阅读学习项目，覆盖导入、阅读、点词、账号、同步和 Stripe 订阅支付闭环。

## 项目结构

```text
.
├── index.html / styles.css / app.js
├── reader.js / state.js / readerStore.js
├── features/                 # 阅读与日语功能模块
├── stores/                   # 前端状态层
├── services/                 # 前端 API/业务服务层
├── utils/
├── billing-success.html      # Stripe 成功回跳页（callback）
├── billing-cancel.html
├── backend/
│   ├── server.py             # 启动入口
│   ├── config.py             # 环境变量与运行配置
│   ├── api/                  # 路由分发层
│   ├── services/             # 后端服务层
│   ├── repositories/         # SQLite/文件仓储层
│   └── data/                 # 本地运行数据（已被 .gitignore 忽略）
├── tests/
│   ├── backend/              # Python unittest
│   └── e2e/                  # Playwright 端到端测试
└── docs/
```

## 本地启动方式

### 1. 准备环境

- Python 3.11+
- Node.js 18+

### 2. 初始化配置

```bash
cp .env.example .env
```

### 3. 安装依赖

```bash
python3 -m pip install -r backend/requirements.txt
npm install
```

### 4. 启动服务

```bash
npm run dev
```

默认地址：`http://127.0.0.1:8000`

## 环境变量

使用 `.env.example` 作为唯一模板，常用变量按场景分组如下：

### 运行基础

- `HOST`、`PORT`
- `APP_BASE_URL`
- `BACKUP_RETENTION_DAYS`

### Stripe 支付（最小可用集）

- `STRIPE_PAY_ENABLED=1`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID_MONTHLY`
- `STRIPE_PRICE_ID_YEARLY`
- `STRIPE_PORTAL_RETURN_URL`
- `STRIPE_WEBHOOK_SECRET`（建议配置）

### 账号/安全

- `BILLING_NOTIFY_TOKEN`
- `BILLING_ADMIN_TOKEN`
- `ADMIN_TOKEN`

### AI 解释（可选）

- `AI_EXPLAIN_ENABLED`
- `AI_EXPLAIN_PROVIDER`
- `AI_EXPLAIN_API_KEY`
- `AI_EXPLAIN_MODEL`

## 支付流程（Checkout -> Callback）

1. 前端点击“订阅 Pro”，调用 `POST /api/billing/create-checkout-session`。
2. 后端创建 Stripe Checkout Session，返回 `sessionId`/`checkoutUrl`。
3. 用户在 Stripe 托管页面支付。
4. 支付完成后回跳 `billing-success.html?session_id=...`。
5. 成功页调用 `POST /api/billing/checkout-complete`（callback 验单）。
6. 后端拉取 Stripe Session，同步订单与套餐状态（`plan=pro`，并写入 `billingCycle`）。
7. 前端刷新套餐 UI；取消支付则回跳 `billing-cancel.html`，不改套餐。

详细支付文档见 [docs/billing.md](./docs/billing.md)。

## API 服务说明

后端由 `backend/server.py` 启动，`backend/api/handler.py` 分发到各领域路由模块：

### 系统与健康

- `GET /api/health`：API、分词器、词典、支付通道状态

### 书籍与导入

- `GET /api/sample-book`
- `POST /api/books/import`：异步导入，返回 `jobId`
- `GET /api/import-jobs/{jobId}`：导入任务状态
- `GET /api/books/{bookId}`：书籍元数据
- `GET /api/books/{bookId}/chapters/{chapterId}`：章节内容
- `POST /api/books/{bookId}/progress`：保存阅读进度

### 词典与语言

- `POST /api/nlp/tokenize`
- `POST /api/dict/lookup`
- `POST /api/ai/explain`

### 账号与同步

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/cloud/delete`
- `POST /api/account/delete`
- `POST /api/sync/push`
- `GET /api/sync/pull`

### 计费与支付

- `GET /api/billing/plan`
- `GET /api/payment/options`
- `POST /api/billing/create-checkout-session`
- `POST /api/billing/checkout-complete`
- `POST /api/billing/create-portal-session`
- `POST /api/billing/stripe/webhook`

## 运行测试

```bash
npm run test:backend
npm run test:e2e
npm run test
```

首次运行 E2E：

```bash
npx playwright install
```

## 相关文档

- [架构说明](./docs/architecture.md)
- [部署说明](./docs/deployment.md)
- [词典说明](./docs/dictionary.md)
- [计费与支付](./docs/billing.md)
- [Stripe 测试模式](./docs/stripe.md)
