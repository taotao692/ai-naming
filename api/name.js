// 流式起名接口（Vercel Edge Function）
// 支持豆包 / DeepSeek / 通义千问 / Kimi 四家，统一走 OpenAI 兼容的 /chat/completions
// 1) 逐字把增量文本回传给前端
// 2) 流结束后把「需求 + 结果 + 实际使用的模型」写入 Supabase

export const config = { runtime: 'edge' };

import { createClient } from '@supabase/supabase-js';

const SYSTEM_PROMPT = `你是一位资深中文起名顾问，擅长为人物、品牌、店铺、产品、作品与宠物起名。

请严格按下面的格式输出，不要写开场白、不要写总结、不要写多余说明：
1. 名字：×××
寓意：用 2–3 句话说明字面含义、意象或典故来源，并说明它为什么贴合这次需求
2. 名字：×××
寓意：……
3. 名字：×××

硬性要求：
- 恰好 3 组，编号从 1 到 3 连续，不要多也不要少；
- “名字：”后面只写名字本身，不加书名号、引号、拼音、英文；
- 名字符合用户指定的字数与风格，避开生僻字和谐音歧义；
- 每组寓意都要讲清意象来源与适用场景，不要空泛吹捧；
- 全程使用简体中文。`;

// 各家配置集中在这张表里：改地址、换模型、加第五家，都只动这里
const modelConfigMap = {
  doubao: {
    label: '豆包 · 火山方舟',
    keyEnv: 'DOUBAO_API_KEY',
    resolveKey: () => process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || '',
    resolveBase: () => process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    // 方舟要填接入点 ID（ep-xxx）或已开通的模型名
    resolveModel: () => process.env.ARK_MODEL || '',
    // 默认关掉深度思考：开着时首字要等 30 秒以上，起名不需要推理
    resolveExtra: () => ({
      thinking: { type: process.env.DOUBAO_THINKING === 'on' ? 'enabled' : 'disabled' }
    })
  },
  deepseek: {
    label: 'DeepSeek',
    keyEnv: 'DEEPSEEK_API_KEY',
    resolveKey: () => process.env.DEEPSEEK_API_KEY || '',
    resolveBase: () => process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    resolveModel: () => process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    resolveExtra: () => ({})
  },
  qwen: {
    label: '通义千问 · DashScope',
    keyEnv: 'DASHSCOPE_API_KEY',
    resolveKey: () => process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '',
    resolveBase: () => process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    resolveModel: () => process.env.QWEN_MODEL || 'qwen-plus',
    resolveExtra: () => ({})
  },
  kimi: {
    label: 'Kimi · Moonshot',
    keyEnv: 'MOONSHOT_API_KEY',
    resolveKey: () => process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || '',
    resolveBase: () => process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1',
    resolveModel: () => process.env.KIMI_MODEL || 'moonshot-v1-8k',
    resolveExtra: () => ({})
  }
};

function resolveModel(family) {
  const cfg = modelConfigMap[family];
  if (!cfg) return null;
  return {
    id: family,
    label: cfg.label,
    keyEnv: cfg.keyEnv,
    apiKey: String(cfg.resolveKey() || '').trim(),
    baseUrl: String(cfg.resolveBase() || '').replace(/\/+$/, ''),
    model: String(cfg.resolveModel() || '').trim(),
    extra: typeof cfg.resolveExtra === 'function' ? cfg.resolveExtra() : {}
  };
}

function listModels() {
  return Object.keys(modelConfigMap).map((id) => {
    const cfg = resolveModel(id);
    return {
      id: cfg.id,
      label: cfg.label,
      model: cfg.model,
      keyEnv: cfg.keyEnv,
      available: Boolean(cfg.apiKey && cfg.model)
    };
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function buildRequirement(input) {
  const scene = String(input.scene || '人名').trim();
  const subject = String(input.subject || '').trim();
  const style = String(input.style || '').trim();
  const length = String(input.length || '不限').trim();

  const parts = [`起名用途：${scene}`, `字数要求：${length}`];
  if (subject) parts.push(`${scene.includes('人名') ? '姓氏/姓名线索' : '主体名称或关键信息'}：${subject}`);
  if (style) parts.push(`风格与期望：${style}`);
  parts.push('请给出 3 组名字，并解释每组的寓意');
  return parts.join('；');
}

// 四家都是 OpenAI 兼容 SSE，用同一段解析
function extractText(lines) {
  let out = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') out += delta;
    } catch {
      // 忽略无法解析的行（心跳、注释）
    }
  }
  return out;
}

async function saveRecord({ requirement, result, model }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.warn('[supabase] 未配置 SUPABASE_URL / SUPABASE_ANON_KEY，本条记录未写入');
    return false;
  }
  if (!result.trim()) return false;

  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { error } = await supabase.from('name_history').insert({
      user_requirement: requirement,
      name_result: result,
      model_name: model
    });
    if (error) {
      console.error('[supabase] 写入失败：', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[supabase] 写入异常：', err?.message || err);
    return false;
  }
}

export default async function handler(req) {
  if (req.method === 'GET') {
    return json({ models: listModels() });
  }
  if (req.method !== 'POST') {
    return json({ error: '只支持 GET / POST 请求' }, 405);
  }

  let input;
  try {
    input = await req.json();
  } catch {
    return json({ error: '请求体不是合法的 JSON' }, 400);
  }

  const family = String(input?.model || 'doubao').trim();
  const cfg = resolveModel(family);
  if (!cfg) {
    return json({ error: `未知的模型：${family}`, models: listModels() }, 400);
  }
  if (!cfg.apiKey) {
    return json({ error: `${cfg.label} 未配置密钥，请先在环境变量里填 ${cfg.keyEnv}` }, 400);
  }
  if (!cfg.model) {
    return json({ error: `${cfg.label} 未配置模型，请填 ${cfg.id === 'doubao' ? 'ARK_MODEL（接入点 ID）' : '模型名'}` }, 400);
  }

  const scene = String(input?.scene || '').trim();
  const style = String(input?.style || '').trim();
  if (!scene) return json({ error: '请先选择起名用途' }, 400);
  if (!style && !String(input?.subject || '').trim()) {
    return json({ error: '至少填写姓氏或风格关键词，方便模型起名' }, 400);
  }

  const requirement = buildRequirement(input);
  const modelTag = `${cfg.id}:${cfg.model}`;

  const providerRes = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      ...cfg.extra,
      model: cfg.model,
      stream: true,
      temperature: 0.8,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: requirement }
      ]
    })
  });

  if (!providerRes.ok || !providerRes.body) {
    const detail = (await providerRes.text().catch(() => '')).slice(0, 600);
    return json({ error: `${cfg.label} 调用失败（HTTP ${providerRes.status}）`, detail }, 502);
  }

  const reader = providerRes.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = '';
  let fullText = '';

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();

          if (value) buffer += decoder.decode(value, { stream: true });

          const lastBreak = buffer.lastIndexOf('\n');
          let piece = '';
          if (lastBreak >= 0) {
            piece = extractText(buffer.slice(0, lastBreak + 1).split('\n'));
            buffer = buffer.slice(lastBreak + 1);
          }

          if (done) {
            if (buffer) {
              piece += extractText([buffer]);
              buffer = '';
            }
            if (piece) {
              fullText += piece;
              controller.enqueue(encoder.encode(piece));
            }

            const saved = await saveRecord({ requirement, result: fullText, model: modelTag });
            controller.enqueue(encoder.encode(`\n<!--saved:${saved ? 1 : 0}-->`));
            controller.close();
            return;
          }

          if (piece) {
            fullText += piece;
            controller.enqueue(encoder.encode(piece));
            return;
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Model': encodeURIComponent(modelTag),
      'X-Provider': cfg.id
    }
  });
}
