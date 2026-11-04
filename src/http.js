'use strict';
// Minimal HTTP toolkit on node:http — routing, JSON bodies, cookies, static files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

function readBody(req, limit = 12e6) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Body too large')); req.destroy(); } data += c; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

class Router {
  constructor() { this.routes = []; this.middleware = []; }
  use(fn) { this.middleware.push(fn); }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  patch(p, ...h) { this.add('PATCH', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const ctx = { req, res, url, path: url.pathname, query: Object.fromEntries(url.searchParams),
      cookies: parseCookies(req.headers.cookie), params: {}, body: {} };
    try {
      for (const m of this.middleware) await m(ctx);
      for (const r of this.routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(ctx.path);
        if (!m) continue;
        r.keys.forEach((k, i) => ctx.params[k] = decodeURIComponent(m[i + 1]));
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) ctx.body = await readBody(req);
        for (const h of r.handlers) {
          const out = await h(ctx);
          if (res.writableEnded) return;
          if (out !== undefined) { send(res, ctx.status || 200, out); return; }
        }
        return;
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      send(res, status, { error: e.message, ...(e.extra || {}) });
    }
  }
}

function serveStatic(root) {
  return (ctx) => {
    let p = ctx.path === '/' ? '/index.html' : ctx.path;
    if (p.includes('..')) throw new HttpError(400, 'Bad path');
    let file = path.join(root, p);
    if (!fs.existsSync(file)) file = path.join(root, 'index.html'); // SPA fallback
    const ext = path.extname(file);
    ctx.res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300' });
    fs.createReadStream(file).pipe(ctx.res);
  };
}

function createServer(router) { return http.createServer((req, res) => router.handle(req, res)); }

module.exports = { Router, HttpError, send, serveStatic, createServer };
