# newapi-relay-demo

一个本地学习用的迷你 API 中转站，模拟 new-api 的基础思路：

```text
下游客户端 / 网页测试
  -> 本地中转站 localhost:3000
  -> 使用你 .env 里的主上游 API Key
  -> 请求真实上游模型服务
```

## 当前功能

- 管理员主页：`http://localhost:3000`
- 创建下游 API Key：`POST /api/keys`
- 查看下游 API Key 列表：`GET /api/keys`
- 停用下游 API Key：`DELETE /api/keys/:id`
- 聊天中转：`POST /v1/chat/completions`
- 模型列表：`GET /v1/models`
- 请求摘要日志：`GET /logs`

## 配置

复制配置文件：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`：

```text
PORT=3000
UPSTREAM_BASE_URL=https://api.deepseek.com
UPSTREAM_API_KEY=你的上游主 API Key
LOCAL_API_KEY=你的管理员 Key
MODELS=deepseek-chat,deepseek-reasoner
```

说明：

- `UPSTREAM_API_KEY` 是你自己的主上游 key，只放在服务端 `.env`。
- `LOCAL_API_KEY` 是管理台 key，用来创建下游 API Key、看日志、管理 key。
- 下游用户不应该拿到 `UPSTREAM_API_KEY`，只拿你在主页创建的 `sk-relay-...` key。
- `/v1/models` 会优先请求 `${UPSTREAM_BASE_URL}/v1/models`，失败时才返回 `MODELS` 里的 fallback 列表。

## 启动

```powershell
node src/server.js
```

打开：

```text
http://localhost:3000
```

## 下游调用示例

创建下游 API Key 后，可以这样调用：

```powershell
Invoke-RestMethod http://localhost:3000/v1/chat/completions `
  -Method Post `
  -Headers @{ Authorization = "Bearer sk-relay-你的下游key" } `
  -ContentType "application/json" `
  -Body '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "user", "content": "用一句话介绍 API 中转站" }
    ]
  }'
```

## 文件结构

```text
newapi-relay-demo/
  src/server.js         # 后端：路由、鉴权、上游转发、模型读取、日志
  public/index.html     # 前端：管理台、创建 key、测试调用、摘要日志
  data/api-keys.json    # 本地生成，下游 key 的 hash 记录，不提交 Git
  .env                  # 本地真实配置，不提交 Git
  .env.example          # 配置示例
```

## 安全提醒

这个项目只适合个人本地学习。不要直接公网暴露，不要提交 `.env`，不要截图真实 API Key。`data/api-keys.json` 里保存的是下游 key 的 hash，但也建议当作敏感数据处理。
