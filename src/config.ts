import dotenv from 'dotenv';
import { Config, Provider } from './types';

dotenv.config();

// 从环境变量加载配置
export function loadConfig(): Config {
  const providersRaw = process.env.PROVIDERS;
  let providers: Provider[] = [];

  if (providersRaw) {
    let parsed: any[];
    try {
      parsed = JSON.parse(providersRaw);
    } catch (e) {
      throw new Error('PROVIDERS 不是合法的 JSON 数组，请检查环境变量配置');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('PROVIDERS 必须是一个 JSON 数组');
    }
    providers = parsed.map((p: any) => ({
      name: String(p.name || ''),
      base_url: String(p.base_url || '').replace(/\/$/, ''),
      api_key: String(p.api_key || ''),
      models: Array.isArray(p.models) ? p.models.map((m: any) => String(m)) : [],
      format: p.format === 'anthropic' ? 'anthropic' : 'openai',
    }));
  }

  if (!providers.length) {
    console.warn('[config] 警告：未配置 PROVIDERS，网关无法路由任何请求');
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
  };
}

// 路由：决定请求发给哪个供应商
// 优先级：X-Provider 请求头 > model 字段匹配 > "*" 通配兜底
export function resolveProvider(
  providers: Provider[],
  model: string | undefined,
  headerProvider: string | undefined
): Provider {
  if (headerProvider) {
    const p = providers.find(
      (x) => x.name.toLowerCase() === headerProvider.toLowerCase()
    );
    if (p) return p;
    throw new Error(`供应商 "${headerProvider}" 未在 PROVIDERS 中配置`);
  }

  if (!model) {
    throw new Error('请求缺少 model 字段，且未通过 X-Provider 头指定供应商');
  }

  const exact = providers.find((x) => x.models.includes(model));
  if (exact) return exact;

  const wildcard = providers.find((x) => x.models.includes('*'));
  if (wildcard) return wildcard;

  throw new Error(
    `未找到模型 "${model}" 对应的供应商，可通过 X-Provider 头显式指定`
  );
}
