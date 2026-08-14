import { Provider } from './types';

// 模型列表缓存：provider.name -> 模型名数组
const cache = new Map<string, string[]>();
// 防止重复拉取
const inflight = new Map<string, Promise<string[]>>();

// 从供应商的 /models 接口拉取模型列表
async function fetchModels(provider: Provider): Promise<string[]> {
  try {
    const url = provider.base_url + '/models';
    const headers: Record<string, string> = {};
    if (provider.format === 'anthropic') {
      headers['x-api-key'] = provider.api_key;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${provider.api_key}`;
    }
    const resp = await fetch(url, { headers });
    if (!resp.ok) return [];
    const data: any = await resp.json();
    if (data && Array.isArray(data.data)) {
      return data.data
        .map((m: any) => m?.id)
        .filter((x: any): x is string => typeof x === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

// 获取供应商的模型列表
// 配置了具体模型名 → 直接用；配置了 * 或空 → 用缓存 / 自动拉取
export async function getProviderModels(provider: Provider): Promise<string[]> {
  const concrete = provider.models.filter((m) => m !== '*');
  if (concrete.length) return concrete;

  const cached = cache.get(provider.name);
  if (cached) return cached;

  if (!inflight.has(provider.name)) {
    const p = fetchModels(provider).then((models) => {
      cache.set(provider.name, models);
      return models;
    });
    inflight.set(provider.name, p);
  }
  return inflight.get(provider.name)!;
}

// 刷新所有通配供应商的模型缓存
async function refreshAllModels(providers: Provider[]): Promise<void> {
  const tasks = providers
    .filter((p) => p.models.includes('*'))
    .map(async (p) => {
      const models = await fetchModels(p);
      cache.set(p.name, models);
      console.log(`[models] ${p.name} 自动获取到 ${models.length} 个模型`);
    });
  await Promise.all(tasks);
}

// 启动时立即拉取 + 定期刷新（默认 5 分钟）
export function startModelRefresh(
  providers: Provider[],
  intervalMs = 5 * 60 * 1000
): void {
  refreshAllModels(providers).catch(() => {});
  setInterval(() => {
    refreshAllModels(providers).catch(() => {});
  }, intervalMs);
}
