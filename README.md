# YomuYomu 日语原著阅读器（MVP/Beta）

## 项目简介
YomuYomu 是一个面向日语原著阅读学习的 Web 阅读器。项目已提供前后端一体运行方式，支持从导入、阅读、点词到账号同步的完整学习流程。

## 核心功能
- 多格式导入：`TXT`、`EPUB`、`PDF`、`MOBI`
- 阅读流程：目录跳转、连续阅读、翻页与自动翻页
- 点词查义：后端分词 + 词典查询，支持外部词典联动
- 难度辅助：JLPT 级别标注、难词速览、词频统计
- 学习记录：生词本、批注、书签、基础复习能力
- 账户与同步：基础账号流程、阅读数据同步接口
- 订阅与支付：Free/Pro 门禁 + Stripe Checkout（测试模式）闭环

## 技术栈
- 前端：Vanilla JavaScript + HTML + CSS
- 后端：Python 3（`http.server` + 模块化 service/repository）
- 数据层：SQLite + 本地 JSON 文件
- 测试：`unittest`（后端）+ Playwright（E2E）
- 部署：Docker，支持 Render / Railway

## 快速开始
1. 准备环境：Python 3.11+、Node.js 18+
2. 复制配置模板：

```bash
cp .env.example .env
```

3. 安装依赖：

```bash
python3 -m pip install -r backend/requirements.txt
npm install
```

4. 本地启动：

```bash
npm run dev
```

5. 打开浏览器访问：`http://127.0.0.1:8000`

## 本地支付测试（Stripe 测试模式）
1. 在 `.env` 填写测试配置：
- `APP_BASE_URL=http://127.0.0.1:8000`
- `STRIPE_PAY_ENABLED=1`
- `STRIPE_PUBLISHABLE_KEY=pk_test_...`（前端公开密钥）
- `STRIPE_SECRET_KEY=sk_test_...`
- `STRIPE_PRICE_ID_MONTHLY=price_1T9eA2JbnGpXlXVwu6k3xjjt`（Pro Monthly — $6/month）
- `STRIPE_PRICE_ID_YEARLY=price_1T9eDYJbnGpXlXVwvcUaSGsG`（Pro Yearly — $60/year）

2. 启动服务后，注册账号并在套餐区选择月付或年付，然后点击“订阅 Pro”。
3. 前端会调用 `/api/billing/create-checkout-session`，并使用 `STRIPE_PUBLISHABLE_KEY` 跳转 Stripe Checkout 测试支付页。
4. 使用测试卡支付：
- 卡号：`4242 4242 4242 4242`
- 有效期：任意未来日期
- CVC：任意 3 位
5. 支付成功后会回到 `/billing-success.html`，该页面会调用后端完成验单并同步套餐状态。
6. 支付取消会回到 `/billing-cancel.html`。
7. 只有 `/api/billing/checkout-complete` 验单成功后，用户才会被标记为 `plan=pro` 与对应 `billing_cycle`。

## 运行测试
```bash
npm run test:backend
npm run test:e2e
npm run test
```

首次执行 E2E 测试前可先安装浏览器：

```bash
npx playwright install
```

## 部署概览
项目已提供 Docker 化部署基础，可直接部署到 Render / Railway，或本地 Docker 运行。详细步骤见：

- [部署文档](./docs/deployment.md)

## 文档索引
- [架构说明](./docs/architecture.md)
- [部署说明](./docs/deployment.md)
- [词典与词表](./docs/dictionary.md)
- [计费与支付](./docs/billing.md)
- [Stripe 测试模式](./docs/stripe.md)
