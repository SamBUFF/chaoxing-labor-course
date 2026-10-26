/**
 * lib-cdp.mjs — 学习通脚本共用的原生 CDP 连接层
 *
 * 为什么不走 web-access proxy：
 *   proxy 会对自己创建的 tab 常驻 attach，之后再从别的连接 flatten attach 会报
 *   `No target with given id found`。所以驱动器自建 tab 并独占它。
 *
 * 关键能力：Emulation.setFocusEmulationEnabled(true)
 *   让后台 tab 的 document.visibilityState 变成 visible，视频不会因窗口被遮挡而暂停，
 *   也不需要 Page.bringToFront 抢用户焦点（焦点模拟随连接断开而失效，需每次连接后重设）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function devtoolsWs() {
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
  throw new Error('找不到 DevToolsActivePort：Chrome 需以调试端口启动（先跑 web-access 的 check-deps.mjs）');
}

/**
 * 连接（必要时新建）工作 tab。
 * @param {string} targetFile 保存 targetId 的文件，便于下次复用
 */
export async function connect(targetFile) {
  const ws = new WebSocket(devtoolsWs());
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msgId = ++id;
    pending.set(msgId, { res, rej });
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });

  let targetId = '';
  const saved = targetFile && fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8').trim() : '';
  if (saved) {
    try {
      await send('Target.attachToTarget', { targetId: saved, flatten: true });
      targetId = saved;
    } catch { /* tab 已关闭，下面新建 */ }
  }
  if (!targetId) {
    const r = await send('Target.createTarget', { url: 'about:blank', background: true });
    targetId = r.targetId;
    if (targetFile) fs.writeFileSync(targetFile, targetId);
  }
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  const call = (method, params) => send(method, params, sessionId);
  const ev = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
    return r.result.value;
  };
  const focusOn = () => call('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await focusOn();

  return { send, call, ev, focusOn, targetId, sessionId, close: () => ws.close() };
}

/** 导航并等到 readyJs 为真 */
export async function navigate(s, url, { readyJs = 'true', timeoutMs = 30000, settleMs = 1200 } = {}) {
  await s.call('Page.navigate', { url });
  await sleep(settleMs);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await s.ev(`document.readyState==='complete' && (${readyJs})`)) return true;
    } catch { /* 导航中 */ }
    await sleep(700);
  }
  return false;
}
