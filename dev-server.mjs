// 本地预览（仅开发用，不影响 Vercel 部署）
// 作用：把 index.html 静态发出，并把 POST /api/name 直接交给 api/name.js 的 handler 处理，
// 这样不用 vercel login 也能跑通整条链路。
// 用法：
//   node dev-server.mjs                → 真实调用豆包（需要 DOUBAO_API_KEY）
//   MOCK_ARK=1 node dev-server.mjs     → 用内置假响应灌流，验证前端流式渲染

import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MOCK = process.env.MOCK_ARK === '1';

if (MOCK && !process.env.ARK_BASE_URL) {
  process.env.ARK_BASE_URL = `http://127.0.0.1:${PORT}/mock-ark`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const SAMPLE = `1. 名字：江砚舟
寓意：砚是旧时书生案头的石头，舟取行稳致远。二字都带旧物的分量，国风里有清简的筋骨，适合安静但肯下功夫的男孩。
2. 名字：江望舒
寓意：望舒是神话里为月亮驾车的神，笔画疏朗、读起来轻，把"不张扬却心气高"藏进名字里，写起来也好看。
3. 名字：江知白
寓意：取自"知其白，守其黑"，意为看得明白而不急于显露。字面干净，属于简约国风里最耐看的那一路。
`;

function serveMockArk(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache'
  });

  let i = 0;
  const tick = setInterval(() => {
    if (i >= SAMPLE.length) {
      clearInterval(tick);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const piece = SAMPLE.slice(i, i + 6);
    i += 6;
    const payload = { choices: [{ delta: { content: piece } }] };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }, 35);

  req.on('close', () => clearInterval(tick));
}

async function serveApi(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method,
    headers: { 'content-type': req.headers['content-type'] || 'application/json' },
    body: body || undefined
  });

  const { default: handler } = await import('./api/name.js');
  const response = await handler(request);

  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end(await response.text());
    return;
  }

  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${PORT}`).pathname);
  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  if (!filePath.startsWith(ROOT) || filePath.includes(`${path.sep}api${path.sep}`) || filePath.endsWith('.env')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;

  if (MOCK && pathname === '/mock-ark/chat/completions') {
    serveMockArk(req, res);
    return;
  }
  if (pathname === '/api/name' || pathname === '/api/models') {
    serveApi(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err?.message || 'internal error' }));
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`preview: http://127.0.0.1:${PORT}  ${MOCK ? '(mock ark)' : '(real ark)'}`);
});
