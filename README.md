# newapi-relay-demo

一个本地/云端学习用的迷你 API 中转站，模拟 new-api 的基础思路：

```text
下游客户端 / 酒馆 / 网页测试
  -> 本中转站 /v1
  -> 使用服务端环境变量里的主上游 API Key
  -> 请求真实上游模型服务
```

## 功能

- 管理台首页：`GET /`
- 创建下游 API Key：`POST /api/keys`
- 查看下游 API Key：`GET /api/keys`
- 停用下游 API Key：`DELETE /api/keys/:id`
- 聊天中转：`POST /v1/chat/completions`
- 模型列表：`GET /v1/models`
- 请求摘要日志：`GET /logs`

## Railway 变量示例

普通 OpenAI-compatible 上游：

```text
UPSTREAM_BASE_URL=https://api.inprior.com/v1
UPSTREAM_API_KEY=你的上游主key
LOCAL_API_KEY=你的管理员key
DOWNSTREAM_API_KEYS=tavern:sk-relay-给酒馆用的下游key
MODELS=gpt-4o,gpt-4o-mini,claude-3-5-sonnet-20241022,claude-3-7-sonnet-20250219
MODEL_LIST_MODE=merge
```

说明：

- `UPSTREAM_BASE_URL` 可以填 `https://api.example.com`，也可以填已经带 `/v1` 的 `https://api.example.com/v1`。
- `UPSTREAM_API_KEY` 是你的主上游 key，只放在 Railway Variables 或本地 `.env`。
- `LOCAL_API_KEY` 是管理台 key，用来创建下游 key、看日志。
- `DOWNSTREAM_API_KEYS` 是固定下游 key，适合云端部署；酒馆里填这里的 `sk-relay-...`。
- `MODELS` 是本地补充模型列表。如果上游 `/v1/models` 没把 Claude 暴露出来，可以在这里手动加。
- `MODEL_LIST_MODE=merge` 会读取上游模型，然后追加 `MODELS`。

## 模型列表模式

```text
MODEL_LIST_MODE=merge
```

可选值：

- `merge`：读取上游 `/v1/models`，再追加 `MODELS`
- `upstream`：只使用上游 `/v1/models`
- `fallback`：只使用 `MODELS`

## 本地启动

```powershell
Copy-Item .env.example .env
node src/server.js
```

打开：

```text
http://localhost:3000
```

## 酒馆配置

Railway 生成域名后，例如：

```text
https://your-app.up.railway.app
```

酒馆里填：

```text
API Base URL: https://your-app.up.railway.app/v1
API Key: DOWNSTREAM_API_KEYS 里设置的 sk-relay-...
Model: 选择 /v1/models 里暴露出来的模型
```

## 安全提醒

不要提交 `.env`，不要把真实上游 key 发给别人。`data/` 已经被 `.gitignore` 忽略；云端部署建议使用 `DOWNSTREAM_API_KEYS` 预设下游 key。
