# YomuYomu 日语原著阅读器（MVP/Beta）

## 项目简介
YomuYomu 是一个面向日语原著阅读学习的 Web 阅读器 MVP/Beta。项目已经实现核心阅读流程（导入 -> 阅读 -> 点词 -> 复习/进度），并提供前后端一体化运行方式。

当前状态定位：
- 已实现核心阅读体验与基础学习工具。
- 已接入词典、分词、同步、计费等基础能力。
- 部分高级能力仍在持续完善（如支付渠道完整化、数据持久化策略、运营流程）。

## 核心功能
- 多格式导入：`TXT`、`EPUB`、`PDF`、`MOBI`
- 阅读流程：目录跳转、连续阅读、翻页与自动翻页
- 点词查义：后端分词 + 词典查询，支持外部词典联动
- 难度辅助：JLPT 级别标注、难词速览、词频统计
- 学习记录：生词本、批注、书签、基础复习能力
- 账户与同步：基础账号流程、阅读数据同步接口
- 订阅基础：Free/Pro 功能门禁、Stripe/微信/支付宝订单闭环（开发可手动确认，生产需官方网关）

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

支付联调提示：
- 本地开发可通过 `BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM=1` 验证“下单 -> 查单 -> 确认到账 -> 套餐生效”闭环。
- 生产环境请配置微信/支付宝官方参数并关闭手动确认（`BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM=0`）。

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
