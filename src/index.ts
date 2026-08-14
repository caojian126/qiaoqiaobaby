import express from 'express';
import { loadConfig } from './config';
import { startModelRefresh } from './models';
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

// 鉴权中间件：配了 GATEWAY_API_KEY 就校验，没配则完全开放
function requireAuth(req: any, res: any, next: any): void {
  const expected = config.gatewayApiKey;
  if (!expected) return next();

  const auth = String(req.header('authorization') || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const provided =
    bearer || req.header('x-api-key') || req.header('x-gateway-key') || '';

  if (provided === expected) return next();
  res.status(401).json({ error: { message: '网关访问密钥无效', type: 'unauthorized' } });
}

app.get('/', (_req, res) => {
  res.json({ name: 'AI Gateway', status: 'ok', providers: config.providers.map((p) => p.name) });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy' });
});

// 模型列表（OpenAI 兼容，自动从供应商拉取）
app.get('/v1/models', (req, res) => handleModels(req, res, config));

// OpenAI 兼容端点（需要鉴权）
app.post('/v1/chat/completions', requireAuth, (req, res) => handleChatCompletion(req, res, config));

// Anthropic 原生端点（需要鉴权）
app.post('/v1/messages', requireAuth, (req, res) => handleMessages(req, res, config));

// 启动时自动拉取模型列表 + 定期刷新
startModelRefresh(config.providers);

app.listen(config.port, () => {
  console.log(`[gateway] AI Gateway 已启动，监听端口 ${config.port}`);
  console.log(`[gateway] 已加载 ${config.providers.length} 个上游供应商`);
  for (const p of config.providers) {
    console.log(`[gateway]   - ${p.name} (${p.format}) 模型: ${p.models.join(', ')}`);
  }
  if (config.gatewayApiKey) {
    console.log('[gateway] 已启用访问鉴权');
  } else {
    console.log('[gateway] 未配置 GATEWAY_API_KEY，网关完全开放');
  }
  if (config.supabaseUrl) {
    console.log(`[gateway] 收发信息记录已启用，写入表: ${config.supabaseTable}`);
  } else {
    console.log('[gateway] 未配置 Supabase，收发信息不会入库');
  }
});
