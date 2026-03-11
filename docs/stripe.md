# Stripe 测试模式（订阅制）

## 当前实现
- 仅接入 Stripe Checkout Session（`mode=subscription`）
- 套餐周期：
  - `Pro Monthly — $6/month`
  - `Pro Yearly — $60/year`（比月付更优惠）
- 前端只使用公开变量：`STRIPE_PUBLISHABLE_KEY`、`APP_BASE_URL`
- 后端使用服务端密钥：`STRIPE_SECRET_KEY`
- 支付成功后必须调用服务端验单接口 `/api/billing/checkout-complete`，验单通过才开通 Pro

## 必填环境变量
```bash
APP_BASE_URL=http://127.0.0.1:8000
STRIPE_PAY_ENABLED=1
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PRICE_ID_MONTHLY=price_1T9eA2JbnGpXlXVwu6k3xjjt
STRIPE_PRICE_ID_YEARLY=price_1T9eDYJbnGpXlXVwvcUaSGsG
```

可选兼容（不推荐，仅历史 fallback）：
```bash
STRIPE_PRICE_ID=price_1T9eA2JbnGpXlXVwu6k3xjjt
```

说明：
- 价格金额不在代码中动态创建，代码仅根据月付/年付选择你在 Stripe 后台已创建的 Price ID。
- 不要把 `sk_test_...` 放到前端。

## 本地运行与测试
1. 复制配置：
```bash
cp .env.example .env
```
2. 安装依赖并启动：
```bash
python3 -m pip install -r backend/requirements.txt
npm install
npm run dev
```
3. 打开 `http://127.0.0.1:8000`，注册账号。
4. 在套餐区选择月付或年付，点击“订阅 Pro”。
5. 跳转到 Stripe Checkout（测试模式），使用测试卡：
   - `4242 4242 4242 4242`
   - 任意未来有效期
   - 任意 3 位 CVC
   - 任意邮编

## 回跳路径
- 成功：`/billing-success.html?session_id={CHECKOUT_SESSION_ID}`
- 取消：`/billing-cancel.html`

## 服务端验单与状态写入
- 成功页会调用 `POST /api/billing/checkout-complete`
- 后端根据 `session_id` 向 Stripe 查询 Checkout Session，并验证：
  - `mode=subscription`
  - `status=complete`
  - `payment_status=paid|no_payment_required`
  - `customer` / `subscription` 存在
- 验单通过后写入用户状态：
  - `plan=pro`
  - `billing_cycle=monthly|yearly`
  - `subscription_status=active|...`

## Webhook 现状
- 已实现：`POST /api/billing/stripe/webhook`
- 最小可用版本即使不配置 webhook，也可通过成功页验单完成闭环。
- 生产建议配置 webhook，避免用户未回跳时状态不同步。
- 本地可用 Stripe CLI 转发：
```bash
stripe listen --forward-to http://127.0.0.1:8000/api/billing/stripe/webhook
```
