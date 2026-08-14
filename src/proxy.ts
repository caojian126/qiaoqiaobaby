import { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { Config, Provider } from './types';
import { resolveProviders, pickProvider } from './config';
import { writeChatLog } from './supabase';
import { getProviderModels } from './models';
import {
  extractUserText,
  extractAssistantText,
  openaiToAnthropicReq,
  anthropicReqToOpenAI,
  anthropicResToOpenAI,
  openaiResToAnthropic,
  createAnthropicToOpenAIStream,
  createOpenAIToAnthropicStream,
  StreamTransformer,
} from './convert';

// ---------- 上游请求 ----------

async function callUpstream(
  provider: Provider,
  path: string,
  body: any,
  auth: 'bearer' | 'anthropic'
): Promise<Response> {
  const url = provider.base_url + path;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth === 'bearer') {
    headers['Authorization'] = `Bearer ${provider.api_key}`;
  } else {
    headers['x-api-key'] = provider.api_key;
    headers['anthropic-version'] = '2023-06-01';
  }
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// 上游报错时，把错误原样透传回客户端
async function forwardUpstreamError(upstream: Response, res: ExpressResponse): Promise<void> {
  const text = await upstream.text().catch(() => '');
  res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text);
}

function sendError(res: ExpressResponse, status: number, message: string): void {
  res.status(status).json({ error: { message, type: 'gateway_error' } });
}

// 从请求头收集动态字段（前端生成的值），映射到 Supabase 列
function collectDynamicFields(req: ExpressRequest): Record<string, any> {
  const fields: Record<string, any> = {};
  const assistantId = req.header('x-assistant-id');
  const conversationId = req.header('x-conversation-id');
  if (assistantId) fields.assistant_id = assistantId;
  if (conversationId) fields.conversation_id = conversationId;
  return fields;
}

// ---------- 流式 SSE 解析 ----------

// 按行切分流
export async function* streamLines(body: any): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      yield line;
    }
  }
  if (buffer) yield buffer.replace(/\r$/, '');
}

// 解析 SSE 事件块，产出 { event?, data }（data 为字符串）
async function* parseSSE(body: any): AsyncGenerator<{ event?: string; data: string }> {
  let pendingEvent: string | undefined;
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length) {
      const data = dataLines.join('\n');
      dataLines = [];
      const ev = { event: pendingEvent, data };
      pendingEvent = undefined;
      return ev;
    }
    pendingEvent = undefined;
    return null;
  };

  for await (const line of streamLines(body)) {
    if (line === '') {
      const ev = flush();
      if (ev) yield ev;
      continue;
    }
    if (line.startsWith('event:')) pendingEvent = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  const ev = flush();
  if (ev) yield ev;
}

// ---------- 流式处理 ----------

// 同格式透传（边转发边聚合文本用于记录）
async function pipeStreamPassthrough(
  upstream: Response,
  res: ExpressResponse,
  format: 'openai' | 'anthropic',
  config: Config,
  dynamicFields: Record<string, any>,
  userInput: string
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  (res as any).flushHeaders?.();

  const reader = (upstream.body as any).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let aggregated = '';
  let pendingEvent: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      res.write(text); // 原样透传
      buffer += text;

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);

        if (format === 'openai') {
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const o = JSON.parse(payload);
              const c = o.choices?.[0]?.delta?.content;
              if (c) aggregated += c;
            } catch {}
          }
        } else {
          if (line.startsWith('event:')) pendingEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (pendingEvent === 'content_block_delta') {
              try {
                const o = JSON.parse(payload);
                const t = o.delta?.text;
                if (t) aggregated += t;
              } catch {}
            }
            pendingEvent = undefined;
          }
        }
      }
    }
  } finally {
    res.end();
    await writeChatLog(config, dynamicFields, userInput, aggregated);
  }
}

// 跨格式流式转换
async function pipeStreamTransform(
  upstream: Response,
  res: ExpressResponse,
  transformer: StreamTransformer,
  config: Config,
  dynamicFields: Record<string, any>,
  userInput: string
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  (res as any).flushHeaders?.();

  try {
    for await (const ev of parseSSE(upstream.body)) {
      const out = transformer.handle(ev);
      if (out) res.write(out);
    }
    const fin = transformer.finish();
    if (fin) res.write(fin);
  } finally {
    res.end();
    await writeChatLog(config, dynamicFields, userInput, transformer.aggregated());
  }
}

// ---------- 非流式处理 ----------

async function pipeNonStream(
  upstream: Response,
  res: ExpressResponse,
  transform: (data: any) => any,
  config: Config,
  dynamicFields: Record<string, any>,
  userInput: string,
  assistantFormat: 'openai' | 'anthropic'
): Promise<void> {
  const data = await upstream.json().catch(() => ({}));
  const out = transform(data);
  const assistantText = extractAssistantText(out, assistantFormat);

  res.status(200).setHeader('Content-Type', 'application/json').send(JSON.stringify(out));
  await writeChatLog(config, dynamicFields, userInput, assistantText);
}

// ---------- 端点处理器 ----------

// OpenAI 兼容端点 /v1/chat/completions
export async function handleChatCompletion(
  req: ExpressRequest,
  res: ExpressResponse,
  config: Config
): Promise<void> {
  try {
    const body = req.body || {};
    const matched = resolveProviders(
      config.providers,
      body.model,
      req.header('x-provider')
    );
    const provider = pickProvider(body.model, matched);
    const userInput = extractUserText(body);
    const dynamicFields = collectDynamicFields(req);

    if (provider.format === 'openai') {
      const upstream = await callUpstream(provider, '/chat/completions', body, 'bearer');
      if (!upstream.ok) return forwardUpstreamError(upstream, res);
      if (body.stream) {
        return pipeStreamPassthrough(upstream, res, 'openai', config, dynamicFields, userInput);
      }
      return pipeNonStream(upstream, res, (d) => d, config, dynamicFields, userInput, 'openai');
    }

    // 供应商是 Anthropic 原生格式，需要转换
    const converted = openaiToAnthropicReq(body);
    const upstream = await callUpstream(provider, '/messages', converted, 'anthropic');
    if (!upstream.ok) return forwardUpstreamError(upstream, res);
    if (body.stream) {
      return pipeStreamTransform(
        upstream,
        res,
        createAnthropicToOpenAIStream(),
        config,
        dynamicFields,
        userInput
      );
    }
    return pipeNonStream(
      upstream,
      res,
      anthropicResToOpenAI,
      config,
      dynamicFields,
      userInput,
      'openai'
    );
  } catch (err: any) {
    sendError(res, 400, err?.message || '请求处理失败');
  }
}

// Anthropic 原生端点 /v1/messages
export async function handleMessages(
  req: ExpressRequest,
  res: ExpressResponse,
  config: Config
): Promise<void> {
  try {
    const body = req.body || {};
    const matched = resolveProviders(
      config.providers,
      body.model,
      req.header('x-provider')
    );
    const provider = pickProvider(body.model, matched);
    const userInput = extractUserText(body);
    const dynamicFields = collectDynamicFields(req);

    if (provider.format === 'anthropic') {
      const upstream = await callUpstream(provider, '/messages', body, 'anthropic');
      if (!upstream.ok) return forwardUpstreamError(upstream, res);
      if (body.stream) {
        return pipeStreamPassthrough(upstream, res, 'anthropic', config, dynamicFields, userInput);
      }
      return pipeNonStream(upstream, res, (d) => d, config, dynamicFields, userInput, 'anthropic');
    }

    // 供应商是 OpenAI 格式，需要转换
    const converted = anthropicReqToOpenAI(body);
    const upstream = await callUpstream(provider, '/chat/completions', converted, 'bearer');
    if (!upstream.ok) return forwardUpstreamError(upstream, res);
    if (body.stream) {
      return pipeStreamTransform(
        upstream,
        res,
        createOpenAIToAnthropicStream(body.model),
        config,
        dynamicFields,
        userInput
      );
    }
    return pipeNonStream(
      upstream,
      res,
      openaiResToAnthropic,
      config,
      dynamicFields,
      userInput,
      'anthropic'
    );
  } catch (err: any) {
    sendError(res, 400, err?.message || '请求处理失败');
  }
}

// 模型列表端点 /v1/models（自动从供应商拉取）
export async function handleModels(
  _req: ExpressRequest,
  res: ExpressResponse,
  config: Config
): Promise<void> {
  const seen = new Set<string>();
  const data: any[] = [];
  for (const p of config.providers) {
    const models = await getProviderModels(p);
    for (const m of models) {
      if (seen.has(m)) continue;
      seen.add(m);
      data.push({ id: m, object: 'model', created: 0, owned_by: p.name });
    }
  }
  res.json({ object: 'list', data });
}
