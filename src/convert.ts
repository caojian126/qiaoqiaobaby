// 格式转换工具：OpenAI 兼容格式 <-> Anthropic 原生格式
// 以及流式 SSE 的双向转换状态机

// ---------- 基础工具 ----------

export function extractText(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && typeof c.text === 'string') return c.text;
        return '';
      })
      .join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return String(content);
}

// 从请求体里提取最后一条用户消息文本（用于记录）
export function extractUserText(body: any): string {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return '';
  const userMsgs = messages.filter((m: any) => m.role === 'user');
  const last = userMsgs[userMsgs.length - 1];
  return last ? extractText(last.content) : '';
}

// 从响应体里提取 AI 回复文本（用于记录）
export function extractAssistantText(res: any, format: 'openai' | 'anthropic'): string {
  if (format === 'anthropic') {
    return extractText(res?.content);
  }
  const msg = res?.choices?.[0]?.message;
  if (msg?.content != null) return extractText(msg.content);
  return '';
}

// ---------- 停止原因映射 ----------

export function anthropicStopToOpenAIFinish(stop: string | null | undefined): string | null {
  switch (stop) {
    case 'end_turn': return 'stop';
    case 'max_tokens': return 'length';
    case 'stop_sequence': return 'stop';
    case 'tool_use': return 'tool_calls';
    case 'refusal': return 'content_filter';
    default: return stop ?? null;
  }
}

export function openAIFinishToAnthropicStop(finish: string | null | undefined): string {
  switch (finish) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'function_call': return 'tool_use';
    case 'content_filter': return 'refusal';
    default: return 'end_turn';
  }
}

// ---------- 非流式请求/响应转换 ----------

// OpenAI 请求 -> Anthropic 请求
export function openaiToAnthropicReq(body: any): any {
  const messages = body.messages || [];
  const systemParts = messages
    .filter((m: any) => m.role === 'system')
    .map((m: any) => extractText(m.content));
  const rest = messages.filter((m: any) => m.role !== 'system');

  const out: any = {
    model: body.model,
    messages: rest.map((m: any) => ({ role: m.role, content: m.content })),
    stream: !!body.stream,
  };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop != null) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return out;
}

// Anthropic 请求 -> OpenAI 请求
export function anthropicReqToOpenAI(body: any): any {
  const messages: any[] = [];
  if (body.system) {
    messages.push({ role: 'system', content: extractText(body.system) });
  }
  for (const m of body.messages || []) {
    messages.push({ role: m.role, content: m.content });
  }

  const out: any = { model: body.model, messages, stream: !!body.stream };
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences != null) out.stop = body.stop_sequences;
  return out;
}

// Anthropic 响应 -> OpenAI 响应
export function anthropicResToOpenAI(res: any): any {
  const text = extractText(res?.content);
  return {
    id: res?.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: res?.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: anthropicStopToOpenAIFinish(res?.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: res?.usage?.input_tokens ?? 0,
      completion_tokens: res?.usage?.output_tokens ?? 0,
      total_tokens: (res?.usage?.input_tokens ?? 0) + (res?.usage?.output_tokens ?? 0),
    },
  };
}

// OpenAI 响应 -> Anthropic 响应
export function openaiResToAnthropic(res: any): any {
  const choice = res?.choices?.[0];
  return {
    id: res?.id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: extractText(choice?.message?.content) }],
    model: res?.model,
    stop_reason: openAIFinishToAnthropicStop(choice?.finish_reason),
    usage: {
      input_tokens: res?.usage?.prompt_tokens ?? 0,
      output_tokens: res?.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------- SSE 片段构造 ----------

function sse(obj: any): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function evt(name: string, obj: any): string {
  return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
}

// ---------- 流式转换状态机 ----------

// 流式转换器统一接口
export interface StreamTransformer {
  handle(ev: { event?: string; data: string }): string;
  finish(): string;
  aggregated(): string;
}

// Anthropic 流式事件 -> OpenAI 流式 chunk（用于：客户端是 OpenAI，供应商是 Anthropic）
export function createAnthropicToOpenAIStream(): StreamTransformer {
  let msgId = '';
  let model = '';
  const created = Math.floor(Date.now() / 1000);
  let started = false;
  let aggregatedText = '';
  let finishReason: string | null = null;

  return {
    handle(ev) {
      let data: any = null;
      if (ev.data) {
        try { data = JSON.parse(ev.data); } catch { return ''; }
      }
      if (!data || typeof data !== 'object') return '';

      switch (data.type) {
        case 'message_start':
          msgId = data.message?.id || '';
          model = data.message?.model || model;
          return '';
        case 'content_block_delta': {
          const text = data.delta?.text || '';
          aggregatedText += text;
          if (!started) {
            started = true;
            return sse({
              id: msgId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                { index: 0, delta: { role: 'assistant', content: text }, finish_reason: null },
              ],
            });
          }
          return sse({
            id: msgId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          });
        }
        case 'message_delta':
          finishReason = anthropicStopToOpenAIFinish(data.delta?.stop_reason);
          return '';
        default:
          return '';
      }
    },
    finish() {
      return (
        sse({
          id: msgId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason || 'stop' }],
        }) + 'data: [DONE]\n\n'
      );
    },
    aggregated() {
      return aggregatedText;
    },
  };
}

// OpenAI 流式 chunk -> Anthropic 流式事件（用于：客户端是 Anthropic，供应商是 OpenAI）
export function createOpenAIToAnthropicStream(model: string): StreamTransformer {
  let msgId = '';
  let aggregatedText = '';
  let finishReason = 'end_turn';
  let blockStarted = false;

  return {
    handle(ev) {
      const raw = ev.data;
      if (raw === '[DONE]') return '';

      let obj: any = null;
      try { obj = JSON.parse(raw); } catch { return ''; }

      const delta = obj?.choices?.[0]?.delta || {};
      const content = delta.content ?? '';
      const fr = obj?.choices?.[0]?.finish_reason ?? null;

      if (!msgId) {
        msgId = obj.id || 'chatcmpl-' + Math.random().toString(36).slice(2);
        let out = '';
        out += evt('message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        out += evt('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        blockStarted = true;
        if (content) {
          aggregatedText += content;
          out += evt('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: content },
          });
        }
        return out;
      }

      if (content) {
        aggregatedText += content;
        return evt('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: content },
        });
      }
      if (fr) {
        finishReason = openAIFinishToAnthropicStop(fr);
      }
      return '';
    },
    finish() {
      let out = '';
      if (blockStarted) {
        out += evt('content_block_stop', { type: 'content_block_stop', index: 0 });
      }
      out += evt('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: finishReason, stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      out += evt('message_stop', { type: 'message_stop' });
      return out;
    },
    aggregated() {
      return aggregatedText;
    },
  };
}
