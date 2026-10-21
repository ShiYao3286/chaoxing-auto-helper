/**
 * 极简静态文件服务器（替代 http-server）
 *
 * 为什么自己写：http-server 依赖 npx，在某些环境里启动慢/不稳。
 * 测试只需要把 tests/ 目录的 html/mp4/ttf 发出去，几十行足够。
 *
 * 用法：node tests/static-server.cjs [port] [dir]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8793);
const ROOT = path.resolve(process.argv[3] || path.join(__dirname));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // CORS：测试页面和 API 不同端口，必须放开
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // 防目录穿越
  const target = path.normalize(path.join(ROOT, urlPath));
  if (!target.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }

  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + urlPath);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length
    });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('static server on http://127.0.0.1:' + PORT + ' → ' + ROOT);
});

server.on('error', (e) => {
  console.error('server error: ' + e.message);
  process.exit(1);
});
