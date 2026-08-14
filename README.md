# AI Gateway

一个 OpenAI 兼容格式的 **AI 网关（中转服务）**。它自己不跑模型，只做两件事：

1. **转发**：把客户端的请求转发给多个上游 AI 供应商
2. **记录**：每轮收发信息，把「用户输入」和「AI 回复」各写一条到 Supabase

## 功能特性

- ✅ **多供应商接入**：支持 OpenAI、Claude/Anthropic、各种中转站（OneAPI 等）
- ✅ **分开配置**：每个供应商用独立的 `PROVIDER_1_URL` / `PROVIDER_1_KEY` ... 环境变量，不用写 JSON
- ✅ **轮询负载均衡**：同一个模型配置了多个供应商时，自动轮流分配
- ✅ **双格式兼容**：对外同时暴露 OpenAI 兼容（`/v1/chat/completions`）和 Anthropic 原生（`/v1/messages`）两个端点
- ✅ **格式自动转换**：OpenAI ↔ Anthropic 双向转换，含流式 SSE
- ✅ **收发信息入库**：每轮请求后，用户消息（`role=user`）和 AI 回复（`role=assistant`）各写一条到 Supabase
- ✅ **Zeabur 一键部署**：Docker 化，通过环境变量即可完成全部配置

## 架构流程

```
客户端 (OpenAI SDK / Claude SDK)
        │
        ▼
   AI Gateway (Node.js)
   ├─ 路由：X-Provider 头 / model 匹配
   ├─ 多个供应商之间轮询
   ├─ 格式转换：OpenAI ↔ Anthropic（含流式）
   ├─ 转发到上游供应商
   └─ 请求结束后写入 Supabase
```

## 环境变量配置

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否 | 服务端口，默认 3000 |
| `SUPABASE_URL` | 否* | Supabase 项目 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 否* | Supabase Service Role Key（用于绕过 RLS 写入） |
| `SUPABASE_TABLE` | 否 | 写入的表名，默认 `chat_messages` |
| `PROVIDER_N_URL` | 是 | 第 N 个供应商的地址（统一到 `/v1` 这一级） |
| `PROVIDER_N_KEY` | 是 | 第 N 个供应商的 API Key |
| `PROVIDER_N_MODELS` | 否 | 第 N 个供应商的模型列表，逗号分隔，默认 `*` |
| `PROVIDER_N_FORMAT` | 否 | 第 N 个供应商的格式，`openai` 或 `anthropic`，默认 `openai` |
| `PROVIDER_N_NAME` | 否 | 第 N 个供应商的名字，默认 `provider-N` |

> *：不配置 Supabase 时网关仍可正常转发，只是不记录收发信息。

### 供应商分开配置（推荐）

```bash
# 供应商 1
PROVIDER_1_URL=https://xxx.com/v1
PROVIDER_1_KEY=sk-xxx
PROVIDER_1_MODELS=*

# 供应商 2
PROVIDER_2_URL=https://yyy.com/v1
PROVIDER_2_KEY=sk-yyy
PROVIDER_2_MODELS=*
```

### 轮询

同一个模型配置在多个供应商里时，网关会**自动轮询**，把连续请求轮流分配到不同供应商，实现简单负载均衡。

### 兼容旧版 JSON 配置

也支持用一个 `PROVIDERS` 环境变量写 JSON 数组（优先级低于分开配置）：

```
PROVIDERS=[{"name":"relay","base_url":"https://xxx.com/v1","api_key":"sk-xxx","models":["*"],"format":"openai"}]
```

## 记录到 Supabase

网关在每轮请求结束后，写入两条记录，通过 `role` 字段区分：

```json
{ "role": "user", "content": "用户输入的内容" }
{ "role": "assistant", "content": "AI 回复的内容" }
```

### 动态字段（前端生成的值）

如果前端会动态生成 `assistant_id`、`conversation_id` 等值，可以通过请求头传入：

| 请求头 | 写入列 |
|--------|--------|
| `X-Assistant-Id` | `assistant_id` |
| `X-Conversation-Id` | `conversation_id` |

### 表结构

最简表结构（只需 `role` + `content` 即可工作）：

```sql
create table chat_messages (
  id bigint generated always as identity primary key,
  role text not null,
  content text,
  created_at timestamptz default now()
);
```

如果有额外必填字段，用 `SUPABASE_EXTRA_FIELDS` 补静态兜底值，或用请求头动态传入。

## 部署到 Zeabur

1. 把本项目代码推送到 GitHub 仓库
2. 打开 [Zeabur](https://zeabur.com)，创建新项目，选择「从 GitHub 导入」该仓库
3. Zeabur 会自动识别 `Dockerfile` 并构建（如未识别，手动指定 Docker 部署方式）
4. 在服务的「环境变量」中配置 `PROVIDER_1_URL`、`PROVIDER_1_KEY`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 等
5. 部署完成后，在「域名」中绑定自己的域名

## 使用示例

假设你的网关域名是 `https://gateway.example.com`：

### 调用 OpenAI 兼容端点

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Assistant-Id: my-assistant" \
  -H "X-Conversation-Id: conv-123" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

### 调用 Anthropic 原生端点

```bash
curl https://gateway.example.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: anything" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### 显式指定供应商（可选）

在请求头加 `X-Provider: provider-1` 可强制路由到指定供应商，忽略轮询。

### 配合 OpenAI SDK

把 SDK 的 `baseURL` 指向你的网关即可：

```python
from openai import OpenAI
client = OpenAI(api_key="anything", base_url="https://gateway.example.com/v1")
```

## 本地开发

```bash
npm install
cp .env.example .env   # 编辑 .env 填入配置
npm run dev            # 监听模式启动
```

构建与运行：

```bash
npm run build
npm start
```
