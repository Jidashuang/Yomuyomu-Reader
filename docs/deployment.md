# 部署说明

## 1. 部署方式概览
当前仓库已提供以下部署基础：
- Docker：`Dockerfile` + `backend/start.sh`
- Render：`render.yaml`
- Railway：可直接使用仓库 Dockerfile 部署

服务健康检查接口：`/api/health`

## 2. Docker 本地运行
1. 准备环境变量：

```bash
cp .env.example .env
```

2. 构建镜像：

```bash
docker build -t yomuyomu-reader .
```

3. 运行容器：

```bash
docker run --rm -p 8000:8000 --env-file .env yomuyomu-reader
```

4. 浏览器访问：`http://127.0.0.1:8000`

如需持久化本地数据（推荐）：

```bash
docker run --rm \
  -p 8000:8000 \
  --env-file .env \
  -v "$(pwd)/backend/data:/app/backend/data" \
  yomuyomu-reader
```

## 3. Render 部署
仓库已提供 `render.yaml`（Docker runtime）。

建议流程：
1. 推送代码到 GitHub。
2. 在 Render 创建 `Web Service` 并连接仓库。
3. 使用仓库中的 Dockerfile 自动构建。
4. 在 Render 控制台配置环境变量（参考 `.env.example`）。
5. 部署完成后，访问 Render 分配的公网域名。

注意：免费实例通常有冷启动，且无持久磁盘时本地数据文件不保证长期保留。

## 4. Railway 部署
建议流程：
1. 新建 Railway Project，连接 GitHub 仓库。
2. 选择 Docker 部署（自动识别 Dockerfile）。
3. 配置环境变量（参考 `.env.example`）。
4. 部署后验证 `/api/health`。

如要保留 `backend/data` 中的数据，需在 Railway 配置持久化卷或改造外部存储。

## 5. 生产环境最小配置建议
- 基础：`APP_BASE_URL`、`PORT`
- 计费（按需）：`STRIPE_*` / `WECHAT_*` / `ALIPAY_*`
- 安全：`BILLING_NOTIFY_TOKEN`、`BILLING_ADMIN_TOKEN`
- 关闭演示行为：`BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM=0`
