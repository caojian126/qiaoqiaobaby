// 上游供应商配置
export interface Provider {
  name: string;                              // 供应商唯一名称
  base_url: string;                          // 上游地址，统一到 /v1 这一级
  api_key: string;                           // 上游 API Key
  models: string[];                          // 该供应商提供的模型列表，"*" 表示兜底
  format: 'openai' | 'anthropic';            // 上游原生格式
}

// 网关全局配置
export interface Config {
  port: number;
  providers: Provider[];
  supabaseUrl: string;
  supabaseKey: string;
  supabaseTable: string;                     // 写入的表名
  supabaseExtraFields: Record<string, any>;  // 额外固定字段（可选）
  gatewayApiKey: string;                     // 网关访问密钥（空 = 不鉴权）
  defaultAssistantId: string;                // assistant_id 兜底值（前端不传时用）
}
