# AI Gateway

一个 OpenAI 兼容格式的 **AI 网关（中转服务）**。它自己不跑模型，只做两件事：

1. **转发**：把客户端的请求转发给多个上游 AI 供应商（OpenAI、Claude、各种中转站等）
2. **记录**：每轮收发信息，把「用户输入」和「AI 回复」各写一条到 Supabase

目标是**开箱即用、零代码适配**：所有配置通过环境变量完成，部署到 Zeabur / Docker 即可上线。

---

## ✨ 功能特性

- ✅ **多供应商接入**：支持 OpenAI、Claude/Anthropic、各种中转站（OneAPI / NewAPI 等），想加几个加几个
- ✅ **分开配置**：每个供应商用独立的 `PROVIDER_1_URL` / `PROVIDER_1_KEY` ... 环境变量，**不用写 JSON**
- ✅ **模型自动获取**：`MODELS` 不填时，网关自动调用供应商的 `/v1/models` 接口拉取模型列表，每 5 分钟刷新，**换模型不用改配置**
- ✅ **轮询负载均衡**：同一个模型配了多个供应商时，请求自动轮流分配
- ✅ **双格式兼容**：对外同时暴露 OpenAI 兼容（`/v1/chat/completions`）和 Anthropic 原生（`/v1/messages`）两个端点
- ✅ **格式自动转换**：OpenAI ↔ Anthropic 双向转换，**含流式 SSE**；OpenAI 格式的中转站可以直接服务 Claude 客户端，反之亦然
- ✅ **收发信息入库**：每轮请求后，用户消息（`role=user`）和 AI 回复（`role=assistant`）各写一条到 Supabase，字段支持请求头动态传入 + 自动兜底
- ✅ **访问鉴权**：可选 `GATEWAY_API_KEY`，保护网关不被白嫖
- ✅ **Zeabur 一键部署**：Docker 化，全部配置走环境变量

---

## 🏗️ 架构流程

```
客户端 (OpenAI SDK / Claude SDK / 任意兼容客户端)
        │
        ▼
   AI Gateway (Node.js + Express)
   ├─ 鉴权：GATEWAY_API_KEY（可选）
   ├─ 路由：X-Provider 头 / model 匹配
   ├─ 多供应商轮询负载均衡
   ├─ 格式转换：OpenAI ↔ Anthropic（含流式 SSE）
   ├─ 转发到上游供应商
   └─ 请求结束后写入 Supabase
```

---

## 🚀 快速开始（本地）

```bash
# 1. 安装依赖
npm install

# 2. 复制环境变量模板并编辑
cp .env.example .env

# 3. 启动（开发模式）
npm run dev
```

生产构建：

```bash
npm run build
npm start
```

---

## ⚙️ 环境变量说明

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `PORT` | 否 | `3000` | 服务端口 |
| `GATEWAY_API_KEY` | 否 | 空 | 网关访问密钥；不填则完全开放，填了则必须带对密钥才能调用 |
| `DEFAULT_ASSISTANT_ID` | 否 | `gateway` | `assistant_id` 兜底值（前端不传 `X-Assistant-Id` 时使用） |
| `SUPABASE_URL` | 否* | 空 | Supabase 项目 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 否* | 空 | Supabase Service Role Key（绕过 RLS 写入） |
| `SUPABASE_TABLE` | 否 | `chat_messages` | 写入的表名 |
| `SUPABASE_EXTRA_FIELDS` | 否 | `{}` | 额外固定字段（JSON 对象），会合并进每条记录 |
| `PROVIDER_N_URL` | 是 | - | 第 N 个供应商地址（统一到 `/v1` 这一级） |
| `PROVIDER_N_KEY` | 是 | - | 第 N 个供应商 API Key |
| `PROVIDER_N_MODELS` | 否 | `*` | 模型列表，逗号分隔；`*` 或不填 = 自动从供应商拉取 |
| `PROVIDER_N_FORMAT` | 否 | `openai` | 供应商格式：`openai` 或 `anthropic` |
| `PROVIDER_N_NAME` | 否 | `provider-N` | 供应商名字（用于 `X-Provider` 头指定） |

> *：不配置 Supabase 时网关仍可正常转发，只是不记录收发信息。

### 供应商配置示例（推荐，分开配置）

```env
# 供应商 1：你的中转站
PROVIDER_1_URL=https://your-relay.com/v1
PROVIDER_1_KEY=sk-your-relay-key
PROVIDER_1_MODELS=*

# 供应商 2：OpenAI
PROVIDER_2_URL=https://api.openai.com/v1
PROVIDER_2_KEY=sk-openai-key
PROVIDER_2_MODELS=*

# 供应商 3：Claude（原生格式）
PROVIDER_3_URL=https://api.anthropic.com/v1
PROVIDER_3_KEY=sk-ant-key
PROVIDER_3_FORMAT=anthropic
PROVIDER_3_MODELS=*
```

**注意**：`PROVIDER_N_URL` 统一写到 `/v1` 这一级（OpenAI 填 `https://api.openai.com/v1`，Anthropic 填 `https://api.anthropic.com/v1`）。

### 兼容旧版 JSON 配置

也可以用单个 `PROVIDERS` 环境变量写 JSON 数组（优先级低于分开配置）：

```env
PROVIDERS=[{"name":"relay","base_url":"https://xxx.com/v1","api_key":"sk-xxx","models":["*"],"format":"openai"}]
```

---

## 🤖 模型自动获取

当 `PROVIDER_N_MODELS` 为 `*` 或未填写时，网关会：

1. **启动时**自动调用该供应商的 `/v1/models` 接口，拉取全部模型
2. **每 5 分钟**自动刷新一次，供应商上新模型也能同步
3. `GET /v1/models` 返回自动获取的模型列表

这样**换模型、加模型都不用改任何配置**。

如果某供应商没有 `/v1/models` 接口（或地址错误），自动获取会失败，但**转发功能不受影响**（`*` 通配仍然兜底所有请求）。

---

## 🔀 路由与轮询

- **按模型匹配**：请求里的 `model` 字段命中某供应商的模型列表，就发给它
- **通配兜底**：`MODELS=*` 的供应商会接住所有未精确匹配的模型
- **轮询负载均衡**：同一模型配了多个供应商时，连续请求轮流分配（如第 1 次走 A、第 2 次走 B、第 3 次走 A...）
- **显式指定**：请求头 `X-Provider: provider-1` 可强制路由到指定供应商，忽略匹配和轮询

---

## 📝 记录到 Supabase

每轮请求结束后，网关写入两条记录，通过 `role` 字段区分：

```json
{ "role": "user", "content": "用户输入的内容" }
{ "role": "assistant", "content": "AI 回复的内容" }
```

### 字段优先级

写入的每条记录字段按以下优先级合并：

1. **请求头动态值**（最高）
2. `SUPABASE_EXTRA_FIELDS` 静态兜底
3. **自动兜底**（保证必填字段不空）

| 字段 | 请求头来源 | 自动兜底 |
|------|-----------|---------|
| `assistant_id` | `X-Assistant-Id` | `DEFAULT_ASSISTANT_ID`（默认 `gateway`） |
| `conversation_id` | `X-Conversation-Id` | 自动生成 `relay-` + 32 位随机 hex |

这意味着：**前端传了就用自己的值，不传也能正常写入**，永远不会因为缺字段而失败。

### 最小表结构

只需 `role` + `content` 即可工作：

```sql
create table chat_messages (
  id bigint generated always as identity primary key,
  role text not null,
  content text,
  created_at timestamptz default now()
);
```

如果表有额外必填字段（如 `assistant_id`、`conversation_id`），无需改代码：

- 方式一：前端请求头传入（`X-Assistant-Id` / `X-Conversation-Id`）
- 方式二：`SUPABASE_EXTRA_FIELDS` 配静态值
- 方式三：什么都不配，网关自动兜底（推荐）

---

## 🔒 访问鉴权

配置 `GATEWAY_API_KEY` 后，调用 `/v1/chat/completions` 和 `/v1/messages` 必须带密钥，否则返回 `401`：

```bash
# 方式一：Authorization 头（OpenAI SDK 默认方式）
-H "Authorization: Bearer 你的密钥"

# 方式二：x-api-key 头（Anthropic SDK 风格）
-H "x-api-key: 你的密钥"

# 方式三：x-gateway-key 头
-H "x-gateway-key: 你的密钥"
```

`/health`、`/`、`/v1/models` 不需要鉴权（用于探活和查看模型列表）。

> 不配置 `GATEWAY_API_KEY` 时网关完全开放，适合内网自用；公网部署强烈建议配置。

---

## ☁️ 部署到 Zeabur

1. 把本项目代码推送到你的 GitHub 仓库
2. 打开 [Zeabur](https://zeabur.com)，创建新项目，选择「从 GitHub 导入」该仓库
3. Zeabur 会自动识别 `Dockerfile` 并构建（如未识别，手动指定 Docker 部署方式）
4. 在服务的「变量」中配置环境变量，至少需要：
   - `PROVIDER_1_URL`、`PROVIDER_1_KEY`
   - `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（要记录才配）
   - `GATEWAY_API_KEY`（要鉴权才配）
5. 部署完成后，在「网络」中绑定域名
   - 免费默认域名 `xxx.zeabur.app` 自动支持 HTTPS（控制台显示 http 时，手动把地址改成 https:// 即可）
   - 绑定自己的域名，Zeabur 会自动签发 TLS 证书

---

## 📡 使用示例

假设网关地址是 `https://gateway.example.com`，密钥是 `gw-123`：

### 查看模型列表

```bash
curl https://gateway.example.com/v1/models
```

### 调用 OpenAI 兼容端点

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer gw-123" \
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
  -H "x-api-key: gw-123" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### 配合 OpenAI SDK（Python）

```python
from openai import OpenAI

client = OpenAI(
    api_key="gw-123",          # 填网关密钥，不是上游的 key
    base_url="https://gateway.example.com/v1"
)

resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "你好"}]
)
print(resp.choices[0].message.content)
```

### 配合 Anthropic SDK（Python）

```python
import anthropic

client = anthropic.Anthropic(
    api_key="gw-123",          # 填网关密钥
    base_url="https://gateway.example.com"
)

resp = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}]
)
print(resp.content[0].text)
```

---

## ❓ 常见问题

**Q：`/v1/models` 返回空列表？**

A：确认 `PROVIDER_N_URL` 填对了（要带 `/v1`），且该供应商有 `/v1/models` 接口。自动获取失败不影响转发，也可以手动在 `PROVIDER_N_MODELS` 里填具体模型名。

**Q：Supabase 写入失败？**

A：先看网关日志里的 `[supabase] 写入失败` 报错。常见原因是表有必填字段（如 `assistant_id`、`conversation_id`），现在网关会自动兜底，正常不会再失败；如果还失败，用 `SUPABASE_EXTRA_FIELDS` 补固定值。

**Q：调用返回 401？**

A：你配置了 `GATEWAY_API_KEY`，但请求没带对密钥。检查 `Authorization: Bearer <key>` 头。

**Q：提示「未找到模型 xxx 对应的供应商」？**

A：把对应供应商的 `PROVIDER_N_MODELS` 设成 `*`，或在请求头加 `X-Provider: provider-N` 强制指定。

**Q：端口是多少？**

A：默认 3000。本地访问 `http://localhost:3000`；Zeabur 上自动处理，用域名直接访问。

---

## 📄 License

MIT
