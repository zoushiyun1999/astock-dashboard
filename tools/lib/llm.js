#!/usr/bin/env node
'use strict';
/**
 * tools/lib/llm.js —— 大模型调用层（OpenAI 兼容协议，零依赖，只用 Node 内置模块）
 *
 * 为什么自建而不引 SDK：
 *   · 项目全链路零第三方依赖（AGENTS 硬性规则 7），引 openai-sdk 会破例；
 *   · 只需要 chat/completions 一个端点，Node 18+ 的全局 fetch 足够；
 *   · 换厂商（百炼 / DeepSeek / 智谱）只改环境变量，不动代码。
 *
 * 配置（全部走环境变量；**禁止把 key 写进代码或仓库**）：
 *   LLM_BASE_URL      默认 https://open.bigmodel.cn/api/paas/v4（智谱 BigModel）
 *   LLM_API_KEY       必填。缺失时**直接报错，不静默降级**。
 *                     智谱的 `<id>.<secret>` 与百炼 / DeepSeek 的 `sk-xxx` 两种格式都能用，
 *                     鉴权方式自动适配（见 authHeader）
 *   LLM_TEXT_MODEL    默认 glm-4.7-flash  （文本任务；智谱免费档）
 *   LLM_VISION_MODEL  默认 glm-4.6v-flash （读图任务；智谱免费档，128K 上下文）
 *   LLM_TIMEOUT_MS    默认 180000
 *   LLM_MAX_RETRY     默认 3
 *   LLM_MAX_TOKENS    默认 8192
 *   LLM_JSON_MODE     置 1 时启用 response_format=json_object（部分 provider 不支持，默认关闭）
 *   LLM_VERBOSE       置 1 时每次调用打印耗时与 token 用量
 *
 * 用法：
 *   const llm = require('./lib/llm');
 *   const txt = await llm.askText({ system, user });
 *   const obj = await llm.askJson({ system, user });                  // 文本 → JSON
 *   const obj2 = await llm.askJson({ system, user, images: [p1, p2] }); // 视觉 → JSON
 *
 * CLI 自检：
 *   node tools/lib/llm.js --check    # 只校验配置，不发请求（缺 key 退 1）
 *   node tools/lib/llm.js --ping     # 真实调用一次，验证连通与鉴权
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_ENV = 'LLM_API_KEY';
const MAX_IMG_BYTES = 8 * 1024 * 1024;   // 单图 8MB 上限（超出须先压缩/切片）

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function cfg() {
  return {
    // 默认走智谱 BigModel：文本与视觉各有一个**永久免费**模型，零成本起步。
    // 想换阿里云百炼只改环境变量即可（认证方式已自动适配，见 authHeader）。
    baseUrl: String(process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
    apiKey: String(process.env[KEY_ENV] || '').trim(),
    // glm-4.7-flash 是「思考模型」：**必须同时关掉思考**（LLM_THINKING=disabled，已默认），
    // 否则 message.content 恒为空、token 全被 reasoning 吃掉。
    // 实测（2026-09-21）：关掉思考后，早报的 8 只个股代码与板块判断全部正确，
    // 质量与线上人工产出基本一致；不关思考则完全不可用（content 恒空）。
    textModel: String(process.env.LLM_TEXT_MODEL || 'glm-4.7-flash').trim(),
    // ⚠️ 不要用免费的 glm-4.6v-flash：实测（2026-09-21）免费档连发请求会被持久 429
    //    （「该模型当前访问量过大」，连续 5 次、累计等 135s 才成功一次），
    //    而晚报要发 10~25 次视觉请求，免费档根本跑不动。
    //    改用 glm-4.6v-flashx（0.15 / 1.5 元每百万 token）→ 全天不到 5 分钱，且不限流。
    visionModel: String(process.env.LLM_VISION_MODEL || 'glm-4.6v-flashx').trim(),
    timeoutMs: intEnv('LLM_TIMEOUT_MS', 180000),
    maxRetry: intEnv('LLM_MAX_RETRY', 5),
    maxTokens: intEnv('LLM_MAX_TOKENS', 8192),
    jsonMode: String(process.env.LLM_JSON_MODE || '') === '1',
    // 智谱「思考模型」（GLM-4.7 系列）默认把 token 花在 reasoning_content 上、
    // 导致 message.content 为空。设成 disabled 显式关闭思考。
    // ⚠️ 不支持该参数的模型不要设此变量，否则可能 400。
    // 默认 disabled：默认文本模型 glm-4.7-flash 是思考模型，不关就拿不到正文。
    // 若换成非思考模型（如 glm-4-flash），请显式设 LLM_THINKING='' 以免 400。
    thinking: process.env.LLM_THINKING === ''
      ? ''
      : String(process.env.LLM_THINKING || 'disabled').trim(),
    verbose: String(process.env.LLM_VERBOSE || '') === '1',
  };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/**
 * 按**文件魔数**判断图片类型。
 * 为什么不能信扩展名：淘股吧的图片 URL 形如 `xxx.png_max.png`，实测返回的却是 JPEG
 * （魔数 ff d8 ff e0）。按扩展名标成 image/png 会让部分网关拒绝，且与实际不符。
 */
function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('ascii'))) return 'image/gif';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
  return '';
}

/** 本地图片 → base64 data URI（OpenAI 兼容的 image_url 只吃 URL 或 data URI）。 */
function dataUri(file) {
  const buf = fs.readFileSync(file);
  if (!buf.length) throw new Error('图片为空（0 字节）：' + file);
  const mime = sniffMime(buf) || MIME[path.extname(String(file)).toLowerCase()];
  if (!mime) {
    throw new Error('无法识别的图片格式（魔数 ' + buf.slice(0, 4).toString('hex') + '）：' + file +
      '；可能下载到了错误页，请先确认文件内容');
  }
  if (buf.length > MAX_IMG_BYTES) {
    throw new Error('图片 ' + (buf.length / 1048576).toFixed(1) + 'MB 超过 ' +
      (MAX_IMG_BYTES / 1048576) + 'MB 上限，须先压缩或切片：' + file);
  }
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

/**
 * 生成 Authorization 头。两个平台的鉴权方式不同，这里统一适配：
 *  · 智谱 BigModel：key 形如 `<id>.<secret>`，**必须用 secret 做 HS256 签一个短时 JWT**——
 *    直接把 key 当 Bearer 传会 401（第三方工具普遍需要做这层转换）。
 *  · 阿里云百炼 / DeepSeek / 其他：key 形如 `sk-xxx`，直接作为 Bearer 使用。
 */
function authHeader(apiKey) {
  const dot = apiKey.indexOf('.');
  if (dot < 0) return 'Bearer ' + apiKey;               // 非智谱格式 → 原样
  const id = apiKey.slice(0, dot);
  const secret = apiKey.slice(dot + 1);
  if (!id || !secret) return 'Bearer ' + apiKey;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', sign_type: 'SIGN', typ: 'JWT' }))
    .toString('base64url');
  const payload = Buffer.from(JSON.stringify({ api_key: id, exp: now + 3600, timestamp: now }))
    .toString('base64url');
  const data = header + '.' + payload;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return 'Bearer ' + data + '.' + sig;
}

/** 单次请求（不含重试）。 */
async function callOnce(c, body) {
  const ac = new AbortController();
  const timer = setTimeout(function () { ac.abort(); }, c.timeoutMs);
  try {
    const res = await fetch(c.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader(c.apiKey),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status + '：' + text.slice(0, 500));
      err.status = res.status;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('响应不是合法 JSON：' + text.slice(0, 300));
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 是否值得重试：网络层错误 / 超时 / 429 / 5xx 重试；4xx（除 429）是请求本身有问题，不重试。 */
function retriable(e) {
  if (e && e.name === 'AbortError') return true;
  const s = e && e.status;
  if (!s) return true;
  if (s === 429) return true;
  return s >= 500;
}

/**
 * 底层调用。
 * @param {object} opts
 *   system   {string}  系统提示
 *   user     {string}  用户内容（纯文本）
 *   images   {string[]} 本地图片路径；非空时自动切到 visionModel
 *   model    {string}  显式指定模型（覆盖自动选择）
 *   json     {boolean} 要求 JSON 输出（受 LLM_JSON_MODE 约束）
 *   temperature {number}
 *   maxTokens   {number}
 *   maxRetry    {number}
 * @returns {Promise<{text:string, model:string, usage:object}>}
 */
async function chat(opts) {
  const o = opts || {};
  const c = cfg();
  if (!c.apiKey) {
    throw new Error('缺少环境变量 ' + KEY_ENV + '。它必须由部署环境提供（见 docs/上云部署方案.md），' +
      '不得写进仓库；本模块不提供默认值，避免误用他人配额。');
  }

  const images = Array.isArray(o.images) ? o.images : [];
  let userContent;
  if (images.length) {
    userContent = [{ type: 'text', text: String(o.user || '') }];
    images.forEach(function (f) {
      userContent.push({ type: 'image_url', image_url: { url: dataUri(f) } });
    });
  } else {
    userContent = String(o.user || '');
  }

  const messages = [];
  if (o.system) messages.push({ role: 'system', content: String(o.system) });
  messages.push({ role: 'user', content: userContent });

  const body = {
    model: o.model || (images.length ? c.visionModel : c.textModel),
    messages: messages,
    max_tokens: o.maxTokens || c.maxTokens,
  };
  if (typeof o.temperature === 'number') body.temperature = o.temperature;
  if (o.json && c.jsonMode) body.response_format = { type: 'json_object' };
  if (c.thinking) body.thinking = { type: c.thinking };

  const maxRetry = o.maxRetry != null ? o.maxRetry : c.maxRetry;
  let lastErr = null;

  for (let i = 0; i <= maxRetry; i++) {
    const t0 = Date.now();
    try {
      const res = await callOnce(c, body);
      const choice = (res.choices && res.choices[0]) || {};
      const msgObj = choice.message || {};
      let content = msgObj.content || '';
      // 兜底：部分模型（智谱 GLM-4.7 系列等「思考模型」）正文可能落在 reasoning_content
      // 而 content 为空。此处取 reasoning 兜底，避免把"能拿到内容"误判成"空返回"。
      if (!content && msgObj.reasoning_content) {
        content = String(msgObj.reasoning_content);
      }
      const usage = res.usage || {};
      if (c.verbose || o.verbose) {
        console.log('  [llm] ' + body.model + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's' +
          ' in=' + (usage.prompt_tokens || '?') + ' out=' + (usage.completion_tokens || '?') +
          ' imgs=' + images.length);
      }
      if (!content) {
        throw new Error('模型返回空内容（finish_reason=' + (choice.finish_reason || '?') + '）');
      }
      return { text: content, model: body.model, usage: usage, finishReason: choice.finish_reason || '' };
    } catch (e) {
      lastErr = e;
      if (i < maxRetry && retriable(e)) {
        // 429 是免费档的常态（「该模型当前访问量过大」）。退避要比其他错误更长，
        // 否则晚报要连发十几次请求时会被限流打穿。
        const base = (e && e.status === 429) ? 5000 : 2000;
        const wait = Math.min(60000, base * Math.pow(2, i));
        console.warn('  [llm] 第 ' + (i + 1) + ' 次失败：' + String(e.message).slice(0, 160) +
          ' → ' + (wait / 1000) + 's 后重试');
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('未知失败');
}

async function askText(opts) {
  const r = await chat(opts);
  return r.text;
}

/** 要求 JSON 输出并解析。解析失败抛错（**不返回空对象**，避免把空结构写进看板）。 */
async function askJson(opts) {
  const r = await chat(Object.assign({}, opts, { json: true }));
  try {
    return extractJson(r.text);
  } catch (e) {
    throw new Error(e.message + ' | 模型=' + r.model);
  }
}

/**
 * 修复模型常见的非法 JSON：**字符串值里出现裸换行 / 回车 / 制表符**。
 *
 * 为什么必须有：实测（2026-09-21）视觉模型转录长表格时，会在 `"content": "…"` 里直接
 * 输出真实换行（而不是 `\n`），JSON.parse 直接失败。表面症状是「模型输出截断 / 格式错误」，
 * 极易误判成 token 不够而去做无用的调参（本次就这样绕过一圈）。
 * 做法：逐字符扫描，只在「字符串内部」把控制字符转成转义形式，字符串外原样保留。
 */
function sanitizeJsonText(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += (ch === '\n') ? '\\n' : (ch === '\r' ? '\\r' : '\\t');
      continue;
    }
    out += ch;
  }
  return out;
}

/** 从模型输出里尽力取出 JSON：原文 → 剥 ``` 围栏 → 截取首尾大括号 → 修复裸换行后重试。 */
function extractJson(text) {
  const s = String(text || '').trim();
  const raw = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw.push(fence[1].trim());
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) raw.push(s.slice(a, b + 1));

  const tried = [];
  for (let i = 0; i < raw.length; i++) {
    const cands = [raw[i], sanitizeJsonText(raw[i])];
    for (let k = 0; k < cands.length; k++) {
      if (tried.indexOf(cands[k]) >= 0) continue;
      tried.push(cands[k]);
      try { return JSON.parse(cands[k]); } catch (e) { /* 试下一个 */ }
    }
  }
  throw new Error('无法解析模型输出为 JSON（已尝试：原文 / 剥围栏 / 截大括号 / 修复裸换行 共 ' +
    tried.length + ' 种）。原始输出前 300 字：' + s.slice(0, 300));
}

/* ───────────────────────── CLI ───────────────────────── */

async function mainCli() {
  const argv = process.argv.slice(2);
  const c = cfg();

  if (argv.includes('--check')) {
    console.log('baseUrl     = ' + c.baseUrl);
    console.log('textModel   = ' + c.textModel);
    console.log('visionModel = ' + c.visionModel);
    console.log('jsonMode    = ' + (c.jsonMode ? 'on' : 'off'));
    console.log('apiKey      = ' + (c.apiKey
      ? '已配置（' + c.apiKey.slice(0, 6) + '…，长 ' + c.apiKey.length + '）'
      : '✗ 未配置'));
    process.exit(c.apiKey ? 0 : 1);
  }

  if (argv.includes('--ping')) {
    const t0 = Date.now();
    const r = await askText({ user: '只回复两个字：连通', maxTokens: 32 });
    console.log('✔ ' + ((Date.now() - t0) / 1000).toFixed(1) + 's | ' + r.trim());
    process.exit(0);
  }

  console.log('用法: node tools/lib/llm.js (--check | --ping)');
}

if (require.main === module) {
  mainCli().catch(function (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  });
}

module.exports = { chat, askText, askJson, extractJson, dataUri, sniffMime, authHeader, cfg };
