# 计费与支付（Stripe Checkout）

## 1. 当前支付模型

- 支付主通道：Stripe Checkout（测试模式/正式模式同链路）
- 套餐：`free` / `pro`
- 周期：`monthly` / `yearly`
- 前端回跳页：
  - 成功：`/billing-success.html`
  - 取消：`/billing-cancel.html`

旧版手动 confirm-paid/演示链路在当前主流程中已停用。

## 2. Checkout -> Callback 流程

1. 用户在阅读器点击“订阅 Pro”。
2. 前端调用 `POST /api/billing/create-checkout-session`。
3. 后端创建 Stripe Checkout Session，返回 `sessionId` 与 `checkoutUrl`。
4. 前端跳转 Stripe 页面完成支付。
5. Stripe 回跳 `billing-success.html?session_id=...`。
6. 成功页脚本调用 `POST /api/billing/checkout-complete`（callback 验单）。
7. 后端拉取并校验 Session，更新订单和套餐状态（`plan=pro` + `billingCycle`）。
8. 成功页显示“支付成功，订阅状态已同步”。

取消支付时仅回到 `billing-cancel.html`，套餐保持原状态。

## 3. 关键 API

### 3.1 查询支付可用性

`GET /api/payment/options`

- 用途：前端判断 Stripe 是否启用、是否具备 checkout 能力。

### 3.2 创建 Checkout Session

`POST /api/billing/create-checkout-session`

请求体示例：

```json
{
  "userId": "reader_001",
  "interval": "monthly"
}
```

成功返回示例：

```json
{
  "ok": true,
  "sessionId": "cs_test_xxx",
  "checkoutUrl": "https://checkout.stripe.com/...",
  "interval": "monthly",
  "billing": {
    "plan": "free"
  }
}
```

### 3.3 Callback 验单

`POST /api/billing/checkout-complete`

请求体示例：

```json
{
  "sessionId": "cs_test_xxx",
  "userId": "reader_001"
}
```

成功返回示例：

```json
{
  "ok": true,
  "billing": {
    "userId": "reader_001",
    "plan": "pro",
    "billingCycle": "monthly"
  },
  "billingCycle": "monthly",
  "order": {
    "orderId": "..."
  },
  "session": {
    "id": "cs_test_xxx",
    "paymentStatus": "paid"
  }
}
```

### 3.4 管理订阅

`POST /api/billing/create-portal-session`

- 用途：为已绑定 Stripe customer 的用户生成 portal 管理链接。

### 3.5 Webhook（推荐）

`POST /api/billing/stripe/webhook`

- 处理事件：
  - `checkout.session.completed`
  - `customer.subscription.*`
  - `invoice.paid`
  - `invoice.payment_failed`

## 4. 环境变量

最小可运行配置（Checkout）：

- `APP_BASE_URL`
- `STRIPE_PAY_ENABLED=1`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID_MONTHLY`
- `STRIPE_PRICE_ID_YEARLY`

推荐补充：

- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_WEBHOOK_TOLERANCE_SECONDS`
- `STRIPE_PORTAL_RETURN_URL`

完整变量请以仓库根目录 `.env.example` 为准。

## 5. 本地联调步骤

1. `cp .env.example .env` 并填入 Stripe 测试密钥与 Price ID。
2. 启动服务：`npm run dev`。
3. 注册账号后在“套餐与支付”发起订阅。
4. 支付成功后确认页面地址带 `session_id`，且成功页提示同步完成。
5. 回到阅读器确认套餐已变更为 Pro。

## 6. 常见问题

### 6.1 `STRIPE_NOT_READY`

通常是 `STRIPE_SECRET_KEY` 或价格 ID 缺失，检查：

- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID_MONTHLY`
- `STRIPE_PRICE_ID_YEARLY`

### 6.2 成功页提示“缺少 session_id”

回跳 URL 未携带 `session_id`，需检查 Stripe Checkout 的 success URL 配置。

### 6.3 已支付但套餐未更新

先检查 `POST /api/billing/checkout-complete` 返回，再核对：

- 请求中的 `sessionId` 是否正确
- Stripe Session 是否 `payment_status=paid`
- 后端日志是否有 webhook/验单错误
