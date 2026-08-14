import { Config } from './types';

// 把一轮收发信息写入 Supabase：
// 一条 role=user（用户输入），一条 role=assistant（AI 回复）
// 表名和额外字段均可通过环境变量配置，不绑定任何特定表结构
export async function writeChatLog(
  config: Config,
  userInput: string,
  assistantText: string
): Promise<void> {
  if (!config.supabaseUrl || !config.supabaseKey) {
    console.warn('[supabase] 未配置 SUPABASE_URL / SERVICE_ROLE_KEY，跳过写入');
    return;
  }

  const rows = [
    { ...config.supabaseExtraFields, role: 'user', content: userInput },
    { ...config.supabaseExtraFields, role: 'assistant', content: assistantText },
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
