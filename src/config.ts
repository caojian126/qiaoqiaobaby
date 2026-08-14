import dotenv from 'dotenv';
import { Config, Provider } from './types';

dotenv.config();

// 加载供应商配置
// 方式一（推荐）：分开配置 PROVIDER_1_URL / PROVIDER_1_KEY / ...，PROVIDER_2_...
// 方式二（兼容旧版）：PROVIDERS=[...] JSON 数组
function loadProviders(): Provider[] {
  const providers: Provider[] = [];

  // 方式一：分开配置
  let i = 1;
  while (true) {
    const url = process.env[`PROVIDER_${i}_URL`];
    if (!url) break;
    providers.push({
      name: process.env[`PROVIDER_${i}_NAME`] || `provider-${i}`,
      base_url: url.replace(/\/$/, ''),
      api_key: process.env[`PROVIDER_${i}_KEY`] || '',
      models: (process.env[`PROVIDER_${i}_MODELS`] || '*')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
      format:
        process.env[`PROVIDER_${i}_FORMAT`] === 'anthropic' ? 'anthropic' : 'openai',
    });
    i++;
  }

  // 方式二：JSON（如果没配分开的）
  if (!providers.length) {
    const raw = process.env.PROVIDERS;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const p of parsed) {
            providers.push({
              name: String(p.name || ''),
              base_url: String(p.base_url || '').replace(/\/$/, ''),
              api_key: String(p.api_key || ''),
              models: Array.isArray(p.models) ? p.models.map((m: any) => String(m)) : [],
              format: p.format === 'anthropic' ? 'anthropic' : 'openai',
            });
          }
        }
      } catch (e) {
        console.warn('[config] PROVIDERS 不是合法 JSON，已忽略');
      }
    }
  }

  return providers;
}

export function loadConfig(): Config {
  const providers = loadProviders();

  if (!providers.length) {
    console.warn('[config] 警告：未配置任何供应商，网关无法路由请求');
  }

  // 解析额外固定字段（可选）
  let supabaseExtraFields: Record<string, any> = {};
  const extraRaw = process.env.SUPABASE_EXTRA_FIELDS;
  if (extraRaw) {
    try {
      const parsed = JSON.parse(extraRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        supabaseExtraFields = parsed;
      }
    } catch (e) {
      console.warn('[config] SUPABASE_EXTRA_FIELDS 不是合法 JSON，已忽略');
    }
  }

  return {
    port: Number(process.env.PORT) || 3000,
    providers,
    supabaseUrl: String(process.env.SUPABASE_URL || ''),
    supabaseKey: String(
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''
    ),
    supabaseTable: String(process.env.SUPABASE_TABLE || 'chat_messages'),
    supabaseExtraFields,
    gatewayApiKey: String(process.env.GATEWAY_API_KEY || ''),
    defaultAssistantId: String(process.env.DEFAULT_ASSISTANT_ID || 'gateway'),
  };
}

// 找到所有匹配的供应商（可能多个，用于轮询）
export function resolveProviders(
  providers: Provider[],
  model: string | undefined,
  headerProvider: string | undefined
): Provider[] {
  if (headerProvider) {
    const p = providers.find(
      (x) => x.name.toLowerCase() === headerProvider.toLowerCase()
    );
    if (p) return [p];
    throw new Error(`供应商 "${headerProvider}" 未配置`);
  }

  if (!model) {
    throw new Error('请求缺少 model 字段，且未通过 X-Provider 头指定供应商');
  }

  const exact = providers.filter((x) => x.models.includes(model));
  if (exact.length) return exact;

  const wildcards = providers.filter((x) => x.models.includes('*'));
  if (wildcards.length) return wildcards;

  throw new Error(`未找到模型 "${model}" 对应的供应商`);
}

// 轮询计数器（按 model 维度轮询）
const rrIndex: Record<string, number> = {};

// 从多个匹配的供应商里轮询选一个
// 只有 1 个直接返回；多个则轮流分配
export function pickProvider(model: string, matched: Provider[]): Provider {
  if (matched.length === 1) return matched[0];
  const idx = rrIndex[model] ?? 0;
  rrIndex[model] = (idx + 1) % matched.length;
  return matched[idx];
}
