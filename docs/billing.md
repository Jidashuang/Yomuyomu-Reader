# 计费与支付

## 当前实现边界
- 项目已实现订单、状态查询、手动确认、套餐同步的完整链路。
- 微信/支付宝官方网关为可选接入项，默认模板未内置可直接收款配置。
- 代码会屏蔽 `.example` 占位域名，避免前端跳转到无效支付链接。

## 支付最小闭环（开发/演示可验证）
1. 前端选择微信或支付宝，调用 `POST /api/billing/create-order` 创建订单。
2. 订单信息会返回 `orderId/status/paymentMode/orderStatusPath`，前端显示当前状态与下一步操作。
3. 使用 `GET /api/billing/order-status?orderId=...&userId=...` 查询订单状态。
4. 开发/演示环境可通过 `POST /api/billing/confirm-paid` 手动确认到账（需开启 `BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM=1`，或配置 `BILLING_NOTIFY_TOKEN`）。
5. 订单变为 `paid` 后，后端同步 Pro 套餐；前端可通过 `GET /api/billing/plan` 验证套餐状态。

说明：系统不会自动伪造支付成功。只有官方回调成功，或你显式调用 `confirm-paid` 后，订单才会变为 `paid`。

## 关键 API
- 套餐查询：`GET /api/billing/plan?userId=...`
- 支付能力：`GET /api/payment/options`
- 创建订单：`POST /api/billing/create-order`
- 订单状态：`GET /api/billing/order-status?orderId=...&userId=...`
- 手动确认到账：`POST /api/billing/confirm-paid`
- 微信通知：`POST /api/billing/wechat/notify`
- 支付宝通知：`POST /api/billing/alipay/notify`
- Stripe Checkout：`POST /api/billing/create-checkout-session`
- Stripe 回跳验单：`POST /api/billing/checkout-complete`

## 环境变量（与当前行为一致）
完整模板见根目录 `.env.example`。

### 支付开关
- `WECHAT_PAY_ENABLED`
- `ALIPAY_PAY_ENABLED`
- `STRIPE_PAY_ENABLED`

### 微信/支付宝跳转页（可选）
- `WECHAT_PAY_ENTRY_URL`
- `ALIPAY_PAY_ENTRY_URL`

注意：
- 留空表示不使用跳转页。
- 使用 `.example` 占位域名会被后端判定为无效配置并忽略，不会返回给前端。

### 开发/演示验证
- `BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM=1`：允许手动 `confirm-paid`，便于联调闭环。

### 生产安全建议
- `BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM=0`
- 配置 `BILLING_NOTIFY_TOKEN`
- 完成微信/支付宝官方网关参数配置：
  - 微信：`WECHAT_APP_ID` / `WECHAT_MCH_ID` / `WECHAT_MCH_SERIAL` / `WECHAT_MCH_PRIVATE_KEY_PATH` / `WECHAT_API_V3_KEY` / `WECHAT_NOTIFY_URL`
  - 支付宝：`ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY_PATH` / `ALIPAY_PUBLIC_KEY_PATH` / `ALIPAY_NOTIFY_URL` / `ALIPAY_RETURN_URL`

## 生产接入清单（微信/支付宝）
1. 配置官方商户参数与密钥文件路径。
2. 打开对应渠道开关（`WECHAT_PAY_ENABLED=1` 或 `ALIPAY_PAY_ENABLED=1`）。
3. 配置公网可访问的 `notify` 回调地址。
4. 联调回调签名与订单状态落库。
5. 关闭手动确认开关，使用官方回调作为唯一到账来源。
