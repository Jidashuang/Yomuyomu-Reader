# YomuYomu 日语原著阅读器

一个对标蒙哥阅读器能力的可运行原型，当前已支持：

- 多格式导入：`TXT`、`EPUB`、`PDF`（需 `pypdf`）、`MOBI`（需 Calibre `ebook-convert`）
- 连续阅读：章节自然衔接滚动，可从目录快速定位
- 翻页控制：上一页/下一页、自动翻页（可调间隔），支持 `PageUp/PageDown`
- 点词查义：优先走后端分词 + 词典查询
- 外部词典联动：点词后一键拉起 `MOJi`（日版/英版 URL Scheme，失败回退网页）
- 日语分词/词形还原：`SudachiPy` 或 `MeCab(fugashi)`，无依赖时自动回退
- 词典：`JMDict` SQLite 查询（可选）
- 难度呈现：`N1` 红色、`N2` 黄虚线、`N3` 绿色下划线（支持显示开关）
- 生词记忆强化：阅读中自动加亮生词本词汇
- 难词速览：自动检索当前章节高难词并在侧栏展示释义
- 词频统计：全书总词数、词汇量与高频词分布
- 生词本 + 间隔复习
- 批注与书签
- TTS（日语语音）
- 云同步（简易快照存储）

## 1. 目录

```text
.
├── index.html
├── styles.css
├── app.js
└── backend
    ├── server.py
    ├── build_jmdict_db.py
    ├── fetch_full_jlpt_wordlist.py
    ├── import_jlpt_levels.py
    ├── requirements.txt
    └── data
```

## 2. 启动方式（推荐）

在项目根目录运行：

```bash
python3 backend/server.py --host 127.0.0.1 --port 8000
```

打开：

`http://127.0.0.1:8000`

说明：
- 前端静态页面和 API 由同一个服务提供。
- 如果只用 `python3 -m http.server`，前端仍可跑，但 `EPUB/PDF/MOBI`、云同步、后端词典能力不可用。
- 服务启动时会自动读取项目根目录 `.env`（若存在）。

## 3. 让别人直接访问（Render 免费部署）

这个项目不是“只能你自己本机跑”的玩具。  
只要部署到云端，别人打开一个网址就能用你的阅读器。

本仓库已准备好部署文件：
- `Dockerfile`
- `render.yaml`
- `backend/requirements-deploy.txt`

按下面步骤做即可：

1. 把最新代码推到 GitHub（你已经做过这一步）。
2. 打开 [Render](https://render.com) 并用 GitHub 登录。
3. 进入 `New +` -> `Web Service` -> 选择你的仓库 `Jidashuang/Yomuyomu-Reader`。
4. Render 会自动识别 `Dockerfile`，保持默认配置，点击 `Create Web Service`。
5. 等待部署完成后，会得到一个公网地址，例如 `https://xxx.onrender.com`。
6. 把这个网址发给别人，别人直接打开就能使用。

说明（免费版常见现象）：
- 首次打开可能要等几十秒（冷启动）。
- 当前“云同步”仍是本地文件方案，免费容器重启后可能丢失同步数据。

## 4. 可选依赖安装

```bash
python3 -m pip install -r backend/requirements.txt
```

包含：
- `sudachipy` + `sudachidict_core`：分词和词形还原（推荐）
- `fugashi` + `unidic-lite`：MeCab 路线
- `pypdf`：PDF 文本提取
- `requests`：Stripe Checkout / Webhook 调用
- `cryptography`：微信/支付宝官方网关签名与验签（未安装则自动回退模板支付模式）

## 5. 构建 JMDict 词典库

推荐新手直接用内置脚本下载（会保存到 `backend/data/JMdict_e`）：

```bash
python3 backend/download_jmdict.py
```

然后执行构建：

```bash
python3 backend/build_jmdict_db.py --xml backend/data/JMdict_e
```

如果你已经有自己的 JMDict 源文件，也可以直接指定路径：

```bash
python3 backend/build_jmdict_db.py --xml /path/to/JMdict_e.xml
```

默认输出：

`backend/data/jmdict.db`

服务启动后会自动检测该库并启用查询。

说明：
- `backend/data/JMdict_e` 文件较大（~60MB），已默认加入 `.gitignore`，不会再上传到 GitHub。
- 若使用 `JMdict_e.xml`，通常只有英文释义（前端会标注为 `英释`）。
- 构建脚本已支持提取 `gloss_zh`（若源 XML 含中文释义，会优先显示中文）。

## 6. 导入能力说明

- `TXT`：前后端都支持
- `EPUB`：后端纯 Python 解析（zip + OPF + spine）
- `PDF`：后端 `pypdf` 解析
- `MOBI`：后端调用 Calibre `ebook-convert` 转 `EPUB` 再解析

四种格式现在都会统一输出 `NormalizedBook`：

```json
{
  "title": "Book title",
  "format": "epub",
  "chapterCount": 12,
  "normalizedVersion": 1,
  "sourceFileName": "demo.epub",
  "chapters": [
    {
      "id": "ch-1",
      "index": 0,
      "title": "Chapter 1",
      "text": "段落一\n\n段落二",
      "paragraphs": ["段落一", "段落二"],
      "sourceType": "epub-spine",
      "sourceRef": "OEBPS/chapter1.xhtml"
    }
  ]
}
```

如果 `MOBI` 报错，请先安装 Calibre 并确保命令行可执行：

`ebook-convert`

## 6.1 AI 句子解释

- 接口：`POST /api/ai/explain`
- 仅支持单句输入：`{"sentence":"..."}`
- 返回包含 `explanation`、`cached` 和 `stats`
- 不影响原有 `/api/dict/lookup` 点词流程

## 7. 云同步说明

当前为单机演示版云同步：

- 推送：`POST /api/sync/push`
- 拉取：`GET /api/sync/pull?userId=...`
- 存储位置：`backend/data/cloud/<userId>.json`

后续可替换为真实用户系统和对象存储/数据库。

## 8. JLPT 难度词表（必需）

前端会尝试加载：

`backend/data/jlpt_levels.json`

支持两种格式：

```json
{
  "語彙": "N1",
  "改札": "N2"
}
```

```json
[
  { "word": "語彙", "level": "N1" },
  { "word": "改札", "level": "N2" }
]
```

不提供该文件时，难度标注与难词速览不会生效。

推荐直接抓取更完整词表（N1-N5，多源合并）：

```bash
python3 backend/fetch_full_jlpt_wordlist.py
```

该脚本会从多个开源仓库抓取并合并去重，生成 `backend/data/jlpt_levels.json`。
当前数据源：
- `open-anki-jlpt-decks`（MIT）
- `Bluskyo/JLPT_Vocabulary`（Tanos 衍生完整表）

冲突处理策略：
- 同一词在多个来源等级冲突时，取“更简单”的等级（N5 优先于 N1），避免把常见词误标为高难词。

如果遇到 `SSL: CERTIFICATE_VERIFY_FAILED`：

```bash
python3 -m pip install certifi
python3 backend/fetch_full_jlpt_wordlist.py
```

或（临时方案）：

```bash
python3 backend/fetch_full_jlpt_wordlist.py --insecure
```

也可用导入脚本将 `csv/tsv/json` 转为标准词表：

```bash
python3 backend/import_jlpt_levels.py --input /path/to/jlpt.csv
```

可选参数（当列名不标准时）：

```bash
python3 backend/import_jlpt_levels.py \
  --input /path/to/jlpt.tsv \
  --word-col vocab \
  --level-col nlevel
```

## 9. 后续增强建议

1. 引入认证（JWT/OAuth）与多端冲突解决策略。
2. 加入段落级进度同步、阅读历史回放。
3. 增加 AI 句法解析、难句改写、上下文释义。
4. 将批注/词本导出为 Anki 兼容格式。

## 10. 商业化（第一阶段 + 第二阶段）

当前版本已完成：

- 第一阶段：Free / Pro 功能门禁（服务端强制）
- 第二阶段：Stripe Checkout 订阅 + 微信/支付宝订单流 + 支付回调 + 套餐自动开通

### 10.1 套餐能力

- Free：
  - 仅支持 `TXT` 导入
  - 禁用云同步
  - 生词 CSV 导出条数受限
- Pro：
  - 支持 `TXT/EPUB/PDF/MOBI` 导入
  - 开启云同步
  - 生词 CSV 可全量导出

### 10.2 计费接口

- 查询套餐：`GET /api/billing/plan?userId=...`
- Stripe 创建 Checkout Session：`POST /api/billing/create-checkout-session`
- Stripe 成功回跳验单：`POST /api/billing/checkout-complete`
- Stripe 创建管理页会话：`POST /api/billing/create-portal-session`
- Stripe Webhook：`POST /api/billing/stripe/webhook`
- 创建支付订单：`POST /api/billing/create-order`
- 查询订单状态：`GET /api/billing/order-status?orderId=...&userId=...`
- 微信支付通知：`POST /api/billing/wechat/notify`
- 支付宝支付通知：`POST /api/billing/alipay/notify`
- 手动确认到账（可选）：`POST /api/billing/confirm-paid`

说明：
- Stripe 订阅推荐走 `create-checkout-session` + `checkout-complete`，前端会跳转到 Stripe Hosted Checkout。
- `create-order` 仍保留给微信/支付宝流程。
- 当官方网关参数完整时，`create-order` 会优先返回官方支付链接（微信 Native / 支付宝 Page Pay）。
- 当官方网关参数不完整时，自动回退到 `WECHAT_PAY_ENTRY_URL` / `ALIPAY_PAY_ENTRY_URL` 模板跳转模式。

可选（仅管理员/本地调试）：
- 手动切换套餐：`POST /api/billing/set-plan`

### 10.3 必要环境变量

```bash
# 价格和时长
PRO_PRICE_CNY=39
PRO_PLAN_DAYS=31
PAY_ORDER_EXPIRE_MINUTES=30

# 支付渠道开关（1=开启，0=关闭）
STRIPE_PAY_ENABLED=1
WECHAT_PAY_ENABLED=1
ALIPAY_PAY_ENABLED=1

# Stripe 订阅（推荐）
STRIPE_SECRET_KEY=sk_live_or_test_xxx
STRIPE_PRICE_ID_MONTHLY=price_xxx
STRIPE_PRICE_ID_YEARLY=price_xxx
STRIPE_SUCCESS_URL=https://your-domain.com/
STRIPE_CANCEL_URL=https://your-domain.com/
STRIPE_PORTAL_RETURN_URL=https://your-domain.com/
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_WEBHOOK_TOLERANCE_SECONDS=300

# 可选：支付跳转链接模板（支持占位符 {orderId} {userId} {channel}）
WECHAT_PAY_ENTRY_URL=https://your-wechat-pay-page.example.com/pay?oid={orderId}
ALIPAY_PAY_ENTRY_URL=https://your-alipay-pay-page.example.com/pay?oid={orderId}
```

可选：

```bash
# ---- 微信官方支付（可选，启用后 create-order 走官方签名下单）----
WECHAT_APP_ID=wx_appid
WECHAT_MCH_ID=wechat_merchant_id
WECHAT_MCH_SERIAL=merchant_cert_serial_no
# 二选一：直接填 PEM 内容或给文件路径
WECHAT_MCH_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
WECHAT_MCH_PRIVATE_KEY_PATH=/etc/keys/wechat_mch_private_key.pem
WECHAT_PLATFORM_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
WECHAT_PLATFORM_PUBLIC_KEY_PATH=/etc/keys/wechat_platform_public_key.pem
WECHAT_API_V3_KEY=32_bytes_api_v3_key
WECHAT_NOTIFY_URL=https://your-domain.com/api/billing/wechat/notify
WECHAT_PAY_API_BASE=https://api.mch.weixin.qq.com

# ---- 支付宝官方支付（可选，启用后 create-order 走官方签名下单）----
ALIPAY_APP_ID=your_alipay_app_id
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
# 二选一：直接填 PEM 内容或给文件路径
ALIPAY_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
ALIPAY_PRIVATE_KEY_PATH=/etc/keys/alipay_private_key.pem
ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
ALIPAY_PUBLIC_KEY_PATH=/etc/keys/alipay_public_key.pem
ALIPAY_NOTIFY_URL=https://your-domain.com/api/billing/alipay/notify
ALIPAY_RETURN_URL=https://your-domain.com/?billing=success

# 支付通知令牌（网关/回调转发时建议开启）
BILLING_NOTIFY_TOKEN=your_notify_token

# 允许前端“我已支付”按钮直接确认到账（演示环境可开，生产建议关）
BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM=0

# 默认 0（禁用手动改套餐）
BILLING_ALLOW_MANUAL_PLAN_CHANGE=0

# 开启手动改套餐后可再加管理员令牌
BILLING_ADMIN_TOKEN=your_admin_token
```

### 10.4 Webhook 配置建议（Stripe / 微信 / 支付宝）

回调入口：

- `POST https://your-domain.com/api/billing/stripe/webhook`
- `POST https://your-domain.com/api/billing/wechat/notify`
- `POST https://your-domain.com/api/billing/alipay/notify`

关键校验：

- Stripe：校验 `Stripe-Signature`（`STRIPE_WEBHOOK_SECRET`）。
- 微信：校验 `Wechatpay-*` 头并解密 `resource`。
- 支付宝：校验 `sign`（RSA2）。

### 10.5 快速配置 Stripe（本地）

1. 复制模板并填写：

```bash
cp .env.example .env
```

2. 至少填写这些变量：

- `STRIPE_PAY_ENABLED=1`
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID_MONTHLY`（可选再配 `STRIPE_PRICE_ID_YEARLY`）
- `STRIPE_WEBHOOK_SECRET`

3. 在 Stripe Dashboard 把 webhook 指向：

`http://127.0.0.1:8000/api/billing/stripe/webhook`

4. 启动服务：

```bash
python3 backend/server.py --host 127.0.0.1 --port 8000
```

5. 前端点击“订阅 Pro”后会跳转到 Stripe Checkout，支付回跳后自动验单开通。

### 10.6 快速配置你的微信/支付宝（本地）

1. 复制模板并填写：

```bash
cp .env.example .env
```

2. 把证书/密钥文件放到目录：

`backend/keys/`

3. 在 `.env` 填写这 4 个路径（推荐路径模式，不直接写 PEM 到 env）：

- `WECHAT_MCH_PRIVATE_KEY_PATH`
- `WECHAT_PLATFORM_PUBLIC_KEY_PATH`
- `ALIPAY_PRIVATE_KEY_PATH`
- `ALIPAY_PUBLIC_KEY_PATH`

4. 启动服务：

```bash
python3 backend/server.py --host 127.0.0.1 --port 8000
```

5. 检查是否生效：

- 打开 `GET /api/health`
- 看 `officialGateway.wechat.order/notify` 与 `officialGateway.alipay.order/notify`
- 都为 `true` 说明官方网关配置完整
