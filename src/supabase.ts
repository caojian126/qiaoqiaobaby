import { Config } from './types';

// 把一轮收发信息写入 Supabase：
// 一条 role=user（用户输入），一条 role=assistant（AI 回复）
// 额外字段 = 环境变量静态兜底 + 请求头动态传入（动态优先）
export async function writeChatLog(
  config: Config,
  dynamicFields: Record<string, any>,
  userInput: string,
  assistantText: string
): Promise<void> {
  if (!config.supabaseUrl || !config.supabaseKey) {
    console.warn('[supabase] 未配置 SUPABASE_URL / SERVICE_ROLE_KEY，跳过写入');
    return;
  }

  const base = { ...config.supabaseExtraFields, ...dynamicFields };

  const rows = [
    { ...base, role: 'user', content: userInput },
    { ...base, role: 'assistant', content: assistantText },
  ].filter((r) => r.content);

  if (!rows.length) return;

  try {
    const url =
      config.supabaseUrl.replace(/\/$/, '') + `/rest/v1/${config.supabaseTable}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    });

    if (!resp.ok) {
      console.error('[supabase] 写入失败', resp.status, await resp.text());
    }
  } catch (e) {
    console.error('[supabase] 写入异常', e);
  }
}
