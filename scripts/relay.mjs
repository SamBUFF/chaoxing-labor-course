#!/usr/bin/env node
/**
 * relay.mjs — CDP 常驻中继（解决反复弹「允许调试」）
 *
 * 为什么需要它：Chrome 对每一次新建到调试端口的 WebSocket 都会弹「允许调试 / Allow remote
 * debugging」，脚本每跑一条命令就新建一条连接，用户要连点几十次授权。
 * 这里只跟 Chrome 建**一条**长连接，本地 127.0.0.1:9333 再开 WS 给脚本复用，
 * 脚本连的是本地中继，不触发 Chrome 授权。
 *
 * 用法（在工作目录后台常驻）：
 *   node "$SK/scripts/relay.mjs" [--port 9333]
 *
 * lib-cdp.mjs 的 connect() 默认先试 ws://127.0.0.1:9333，失败才直连 Chrome，
 * 所以中继起来之后所有脚本自动走它，无需改任何调用。
 * 浏览器 / 工具重启后中继退出，需要重新起一次（那一次仍会要求点一次允许）。
 *
 * 日志：.chaoxing/relay.log；自检：curl http://127.0.0.1:9333/ 应返回 cdp-relay ok
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = Number(process.env.RELAY_PORT || (portArg >= 0 ? argv[portArg + 1] : 9333));
const LOG = path.resolve('.chaoxing/relay.log');

try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); } catch { /* ignore */ }
const log = (m) => {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
};

function devtoolsWs() {
  const cands = [];
  if (process.env.LOCALAPPDATA) {
    cands.push(path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data/DevToolsActivePort'));
    cands.push(path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/User Data/DevToolsActivePort'));
  }
  const home = os.homedir();
  cands.push(
    path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
    path.join(home, '.config/google-chrome/DevToolsActivePort'),
  );
  for (const p of cands) {
    try {
      const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
      if (lines[0] && lines[1]) return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    } catch { /* next */ }
  }
  throw new Error('找不到 DevToolsActivePort（Chrome 未以调试端口启动，先跑 web-access 的 check-deps.mjs）');
}

let up = null;
let seq = 0;
const pending = new Map(); // upstreamId -> { client, origId }
const clients = new Set();
const queue = []; // 上游未就绪时暂存

function send(ws, obj) {
  try {
    if (ws instanceof ClientSocket) { ws.send(obj); return; }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch { /* ignore */ }
}

function connectUpstream() {
  let url;
  try { url = devtoolsWs(); } catch (e) {
    log('上游不可用: ' + e.message + '，10s 后重试');
    setTimeout(connectUpstream, 10000);
    return;
  }
  log('连接 Chrome: ' + url);
  const ws = new WebSocket(url);
  up = ws;
  ws.onopen = () => {
    log('上游已连接（若 Chrome 弹出授权，点这一次即可，之后不再弹）');
    while (queue.length) send(up, queue.shift());
  };
  ws.onerror = () => log('上游连接错误');
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id !== undefined && pending.has(m.id)) {
      const { client, origId } = pending.get(m.id);
      pending.delete(m.id);
      m.id = origId;
      send(client, m);
      return;
    }
    for (const c of clients) send(c, m); // 事件广播（脚本一般用不到）
  };
  ws.onclose = () => {
    log('上游断开，5s 后重连');
    if (up === ws) up = null;
    setTimeout(connectUpstream, 5000);
  };
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('cdp-relay ok\n');
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') log('端口 ' + PORT + ' 已被占用：多半已有中继在跑，无需重复启动');
  else log('HTTP 服务错误: ' + e.message);
  process.exit(1);
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const client = new ClientSocket(socket);
  clients.add(client);
  log('下游脚本接入（当前 ' + clients.size + '）');
  client.onmessage = (text) => {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.id !== undefined) {
      const upId = ++seq;
      pending.set(upId, { client, origId: m.id });
      m.id = upId;
    }
    if (up && up.readyState === 1) send(up, m);
    else queue.push(m);
  };
  client.onclose = () => { clients.delete(client); log('下游脚本断开（剩 ' + clients.size + '）'); };
});

// 极简 WebSocket 服务端帧处理（文本帧 / 分片 / ping / close）
class ClientSocket {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.closed = false;
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._close());
    socket.on('error', () => this._close());
  }
  _close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose && this.onclose();
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
  _sendFrame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.socket.write(Buffer.concat([head, payload])); } catch { /* ignore */ }
  }
  send(obj) { if (!this.closed) this._sendFrame(0x1, Buffer.from(JSON.stringify(obj))); }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      const b1 = this.buf[1];
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      const mask = masked ? this.buf.slice(off, off + 4) : null;
      const payload = Buffer.from(this.buf.slice(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      this.buf = this.buf.slice(off + maskLen + len);
      if (opcode === 0x1 || opcode === 0x0) {
        this.frag.push(payload);
        if (fin) {
          const text = Buffer.concat(this.frag).toString('utf8');
          this.frag = [];
          this.onmessage && this.onmessage(text);
        }
      } else if (opcode === 0x8) this._close();
      else if (opcode === 0x9) this._sendFrame(0xA, payload);
    }
  }
}

process.on('uncaughtException', (e) => log('未捕获异常（保持常驻）: ' + e.message));
process.on('unhandledRejection', (e) => log('未处理 Promise 拒绝: ' + e));

server.listen(PORT, '127.0.0.1', () => {
  log('CDP 中继已启动: ws://127.0.0.1:' + PORT);
  connectUpstream();
});
