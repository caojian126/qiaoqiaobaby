# AI Gateway

一个 OpenAI 兼容格式的 **AI 网关（中转服务）**。它自己不跑模型，只做两件事：

1. **转发**：把客户端的请求转发给多个上游 AI 供应商
2. **记录**：每轮收发信息，把「用户输入」和「AI 回复」各写一条到 Supabase

## 功能特性

- ✅ **多供应商接入**：支持 OpenAI、Claude/Anthropic、各种中转站（OneAPI 等），每个供应商独立配置 `base_url` + `api_key`
- ✅ **双格式兼容**：对外同时暴露 OpenAI 兼容（`/v1/chat/completions`）和 Anthropic 原生（`/v1/messages`）两个端点
- ✅ **格式自动转换**：OpenAI ↔ Anthropic 双向转换，含流式 SSE；你的 OpenAI 格式中转站可以直接服务 Claude 客户端，反之亦然
- ✅ **智能路由**：`X-Provider` 请求头显式指定，或按 `model` 字段自动匹配到对应供应商，支持 `"*"` 通配兜底
- ✅ **收发信息入库**：每轮请求后，用户消息（`role=user`）和 AI 回复（`role=assistant`）各写一条到 Supabase
- ✅ **Zeabur 一键部署**：Docker 化，通过环境变量即可完成全部配置

## 架构流程

```
客户端 (OpenAI SDK / Claude SDK)
        │
        ▼
   AI Gateway (Node.js)
   ├─ 路由：X-Provider 头 / model 匹配
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
| `SUPABASE_EXTRA_FIELDS` | 否 | 额外固定字段（JSON），目标表有必填列时在这里补固定值 |
| `PROVIDERS` | 是 | 上游供应商 JSON 数组（见下） |

> *：不配置 Supabase 时网关仍可正常转发，只是不记录收发信息。

### PROVIDERS 格式（必须是一行 JSON）

```json
[
  {
    "name": "openai",
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-xxx",
    "models": ["gpt-4o", "gpt-4o-mini"],
    "format": "openai"
  },
  {
    "name": "claude",
    "base_url": "https://api.anthropic.com/v1",
    "api_key": "sk-ant-xxx",
    "models": ["claude-3-5-sonnet-20241022"],
    "format": "anthropic"
  },
  {
    "name": "relay",
    "base_url": "https://your-relay.com/v1",
    "api_key": "sk-relay-xxx",
    "models": ["*"],
    "format": "openai"
  }
]
```

字段说明：
- `name`：供应商唯一名称（用于 `X-Provider` 头指定）
- `base_url`：统一写到 `/v1` 这一级（OpenAI 填 `https://api.openai.com/v1`，Anthropic 填 `https://api.anthropic.com/v1`）
- `api_key`：上游 API Key
- `models`：该供应商支持的模型列表；填 `["*"]` 表示兜底供应商（未匹配到的模型都走它）
- `format`：上游原生格式，`openai` 或 `anthropic`

## 记录到 Supabase

网关在每轮请求结束后，写入两条记录，通过 `role` 字段区分：

```json
{ "role": "user", "content": "用户输入的内容" }
{ "role": "assistant", "content": "AI 回复的内容" }
```

- `SUPABASE_TABLE`：写入的表名，默认 `chat_messages`
- `SUPABASE_EXTRA_FIELDS`：可选的额外固定字段（JSON），会合并进每条记录

最简表结构（只需 `role` + `content` 即可工作）：

```sql
create table chat_messages (
  id bigint generated always as identity primary key,
  role text not null,
  content text,
  created_at timestamptz default now()
);
```

如果你的表有额外必填字段，用 `SUPABASE_EXTRA_FIELDS` 补固定值即可，例如：

```
SUPABASE_EXTRA_FIELDS={"assistant_id":"gateway","conversation_id":"default"}
```

## 部署到 Zeabur

1. 把本项目代码推送到 GitHub 仓库
2. 打开 [Zeabur](https://zeabur.com)，创建新项目，选择「从 GitHub 导入」该仓库
3. Zeabur 会自动识别 `Dockerfile` 并构建（如未识别，手动指定 Docker 部署方式）
4. 在服务的「环境变量」中配置 `PROVIDERS`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 等
5. 部署完成后，在「域名」中绑定自己的域名

## 使用示例

假设你的网关域名是 `https://gateway.example.com`：

### 调用 OpenAI 兼容端点

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Content-Type: application/json" \
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

在请求头加 `X-Provider: relay` 可强制路由到指定供应商，忽略 model 匹配。

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
