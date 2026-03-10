# 计费与支付

## 1. 当前定位
计费模块处于 MVP/Beta 阶段：
- 已提供 Free/Pro 功能门禁与基础订单流。
- 已接入 Stripe / 微信 / 支付宝相关接口。
- 部分生产化能力（完整风控、对账自动化、企业级审计）仍需继续完善。

## 2. 套餐模型（当前实现）
- `Free`
  - 高级导入关闭（仅基础导入）
  - 云同步关闭
  - 导出条数限制较低
- `Pro`
  - 高级导入开启
  - 云同步开启
  - 导出条数上限更高

说明：具体门禁以服务端返回的 `features` 为准。

## 3. 主要 API
- 查询套餐：`GET /api/billing/plan?userId=...`
- 支付渠道选项：`GET /api/payment/options?userId=...`
- 创建订单：`POST /api/billing/create-order`
- 查询订单：`GET /api/billing/order-status?orderId=...&userId=...`
- Stripe Checkout：`POST /api/billing/create-checkout-session`
- Stripe 回跳验单：`POST /api/billing/checkout-complete`
- Stripe Portal：`POST /api/billing/create-portal-session`
- Stripe Webhook：`POST /api/billing/stripe/webhook`
- 微信通知：`POST /api/billing/wechat/notify`
- 支付宝通知：`POST /api/billing/alipay/notify`
- 手动确认（可选）：`POST /api/billing/confirm-paid`
- 管理员改套餐（可选）：`POST /api/billing/set-plan`

## 4. Webhook 路由
- Stripe：`/api/billing/stripe/webhook`
- WeChat：`/api/billing/wechat/notify`
- Alipay：`/api/billing/alipay/notify`

建议：
- 开启 `BILLING_NOTIFY_TOKEN`，为转发回调增加额外校验。
- 生产环境关闭 `BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM`。

## 5. 环境变量（核心）
完整模板见仓库根目录 `.env.example`。

### 5.1 基础计费
- `PRO_PRICE_CNY`
- `PRO_PLAN_DAYS`
- `PAY_ORDER_EXPIRE_MINUTES`
- `BILLING_GRACE_PERIOD_DAYS`

### 5.2 支付开关
- `STRIPE_PAY_ENABLED`
- `WECHAT_PAY_ENABLED`
- `ALIPAY_PAY_ENABLED`

### 5.3 Stripe
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID_MONTHLY`
- `STRIPE_PRICE_ID_YEARLY`
- `STRIPE_SUCCESS_URL`
- `STRIPE_CANCEL_URL`
- `STRIPE_PORTAL_RETURN_URL`
- `STRIPE_WEBHOOK_SECRET`

### 5.4 微信/支付宝官方网关
- `WECHAT_APP_ID` / `WECHAT_MCH_ID` / `WECHAT_API_V3_KEY`
- `WECHAT_MCH_PRIVATE_KEY_PATH` / `WECHAT_PLATFORM_PUBLIC_KEY_PATH`
- `ALIPAY_APP_ID` / `ALIPAY_GATEWAY`
- `ALIPAY_PRIVATE_KEY_PATH` / `ALIPAY_PUBLIC_KEY_PATH`

### 5.5 安全与管理
- `BILLING_NOTIFY_TOKEN`
- `BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM`
- `BILLING_ALLOW_MANUAL_PLAN_CHANGE`
- `BILLING_ADMIN_TOKEN`
- `ADMIN_TOKEN`

## 6. 本地联调建议
1. `cp .env.example .env`
2. 先只开启一个支付渠道进行调试。
3. 用测试密钥和测试 webhook 地址完成闭环。
4. 通过 `GET /api/health` 和订单状态接口验证配置是否生效。
