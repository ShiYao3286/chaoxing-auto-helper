// 模拟 OpenAI 兼容服务，用于测试扩展的模型拉取 / 连通测试 / 视觉接口
const http = require('http');

const PORT = Number(process.argv[2] || 9911);

/* 可切换的行为 */
let mode = {
  models: 'ok',      // ok | empty | 404 | notjson | noarray
  chat: 'ok',        // ok | 401 | 500 | notjson
  vision: 'ok'       // ok | reject | notjson
};

const MODEL_LIST = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4o-2024-08-06',
  'deepseek-chat',
  'deepseek-reasoner',
  'qwen-plus',
  'qwen-vl-max',
  'glm-4v-plus',
  'claude-3-5-sonnet-20241022',
  'text-embedding-3-small'
];

function readBody(req) {
  return new Promise(res => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => res(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const body = await readBody(req);

  const json = (obj, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  /* ---------- 控制端点 ---------- */
  if (url === '/__mode') {
    try { Object.assign(mode, JSON.parse(body || '{}')); } catch {}
    return json({ mode });
  }
  if (url === '/__ping') {
    return json({ ok: true, mode });
  }

  /* ---------- 模型列表 ---------- */
  if (url.endsWith('/models') && req.method === 'GET') {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.length < 12) {
      return json({ error: { message: 'invalid api key', type: 'invalid_request_error' } }, 401);
    }
    if (mode.models === '404') return json({ error: { message: 'not found' } }, 404);
    if (mode.models === 'notjson') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>this is not json</html>');
    }
    if (mode.models === 'empty') return json({ object: 'list', data: [] });
    if (mode.models === 'noarray') return json({ object: 'list', thing: 'weird' });

    return json({
      object: 'list',
      data: MODEL_LIST.map(id => ({ id, object: 'model', owned_by: 'mock' }))
    });
  }

  /* ---------- chat completions ---------- */
  if (url.endsWith('/chat/completions') && req.method === 'POST') {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.length < 12) {
      return json({ error: { message: 'invalid api key' } }, 401);
    }

    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}

    const msgs = parsed.messages || [];
    const firstUser = msgs.find(m => m.role === 'user');
    const contentRaw = firstUser ? firstUser.content : '';

    // 判断是不是视觉请求（content 是数组且含 image_url）
    const isVision = Array.isArray(contentRaw) &&
      contentRaw.some(c => c && c.type === 'image_url');

    if (isVision) {
      if (mode.vision === 'reject') {
        return json({ error: { message: 'model does not support image input' } }, 400);
      }
      if (mode.vision === 'notjson') {
        return json({ choices: [{ message: { content: '我不知道怎么回答这个。' } }] });
      }
      const answers = [
        { num: 1, type: 'single', answer: ['B'], confidence: 1.0 },
        { num: 2, type: 'multi', answer: ['A', 'B', 'C'], confidence: 0.95 },
        { num: 3, type: 'judge', answer: ['错'], confidence: 0.9 }
      ];
      return json({
        id: 'chatcmpl-mock', object: 'chat.completion', model: parsed.model || 'mock-vision',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({ answers, uncertain: false, note: '' })
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      });
    }

    if (mode.chat === '401') return json({ error: { message: 'bad key' } }, 401);
    if (mode.chat === '500') return json({ error: { message: 'server error' } }, 500);
    if (mode.chat === 'notjson') {
      return json({ choices: [{ message: { content: '抱歉我不太确定。' } }] });
    }

    // 普通文本请求：判断是不是"回复OK"探活
    const isProbe = /回复\s*OK/.test(JSON.stringify(contentRaw));

    let reply;
    if (isProbe) {
      reply = 'OK';
    } else {
      // 答题
      reply = JSON.stringify({
        answers: [
          { num: 1, type: 'single', answer: ['B'] },
          { num: 2, type: 'multi', answer: ['A', 'C'] }
        ]
      });
    }

    return json({
      id: 'chatcmpl-mock', object: 'chat.completion', model: parsed.model || 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 80, completion_tokens: 20 }
    });
  }

  json({ error: 'not found', path: url }, 404);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock api on http://127.0.0.1:' + PORT);
  console.log('  GET  /v1/models');
  console.log('  POST /v1/chat/completions');
  console.log('  POST /__mode  {"models":"ok|empty|404|notjson|noarray","chat":"ok|401|500|notjson","vision":"ok|reject|notjson"}');
  console.log('  GET  /__ping');
});
