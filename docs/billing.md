# 计费与支付（Stripe Checkout）

## 当前实现
- 支付通道：仅 Stripe Checkout Session（测试模式）
- 旧版微信/支付宝/手动 confirm-paid 演示链路：已停用
- 套餐模型：Pro 订阅（月付/年付）
- 价格：
  - Pro Monthly — $6/month
  - Pro Yearly — $60/year

## 支付闭环
1. 前端调用 `POST /api/billing/create-checkout-session`
2. 后端创建 Stripe Checkout Session，并返回结账 URL
3. 前端跳转 Stripe 托管支付页
4. Stripe 回跳到成功页 `billing-success.html`
5. 成功页调用 `POST /api/billing/checkout-complete` 完成验单
6. 后端将用户套餐状态更新为已支付（Pro）
7. 写入周期状态：`billing_cycle=monthly|yearly`

## API
- `GET /api/billing/plan?userId=...`
- `GET /api/payment/options`
- `POST /api/billing/create-checkout-session`
- `POST /api/billing/checkout-complete`
- `POST /api/billing/create-portal-session`
- `POST /api/billing/stripe/webhook`（可选但推荐）

## 关键环境变量
- `APP_BASE_URL`
- `STRIPE_PAY_ENABLED=1`
- `STRIPE_PUBLISHABLE_KEY`（测试公钥）
- `STRIPE_SECRET_KEY`（测试密钥）
- `STRIPE_PRICE_ID_MONTHLY`
- `STRIPE_PRICE_ID_YEARLY`
- `STRIPE_WEBHOOK_SECRET`（可选）

## 本地联调
详见 [Stripe 测试模式文档](./stripe.md)。
