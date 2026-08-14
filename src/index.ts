import express from 'express';
import { loadConfig } from './config';
import {
  handleChatCompletion,
  handleMessages,
  handleModels,
} from './proxy';

const config = loadConfig();
const app = express();

// 简单 CORS（允许浏览器客户端跨域调用）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '50mb' }));

app.get('/', (_req, res) => {
  res.json({ name: 'AI Gateway', status: 'ok', providers: config.providers.map((p) => p.name) });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy' });
});

// 模型列表（OpenAI 兼容）
app.get('/v1/models', (req, res) => handleModels(req, res, config));

// OpenAI 兼容端点
app.post('/v1/chat/completions', (req, res) => handleChatCompletion(req, res, config));

// Anthropic 原生端点
app.post('/v1/messages', (req, res) => handleMessages(req, res, config));

app.listen(config.port, () => {
  console.log(`[gateway] AI Gateway 已启动，监听端口 ${config.port}`);
  console.log(`[gateway] 已加载 ${config.providers.length} 个上游供应商`);
  for (const p of config.providers) {
    console.log(`[gateway]   - ${p.name} (${p.format}) 模型: ${p.models.join(', ')}`);
  }
  if (config.supabaseUrl) {
    console.log(`[gateway] 收发信息记录已启用，写入表: ${config.supabaseTable}`);
  } else {
    console.log('[gateway] 未配置 Supabase，收发信息不会入库');
  }
});
