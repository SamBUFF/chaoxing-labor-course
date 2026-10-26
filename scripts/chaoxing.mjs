#!/usr/bin/env node
/**
 * chaoxing.mjs — 超星学习通（mooc1/mooc2-ans）课程流程驱动器
 *
 * 依赖：web-access skill 的 CDP proxy（http://localhost:3456）
 *
 * 子命令：
 *   init <课程页URL>            解析 courseid/clazzid/cpi/enc 等参数并落盘
 *   chapters                    拉章节树（小节名 + knowledgeId），可选落盘 JSON
 *   verify                      读「已完成任务点 N/M」核对进度
 *   study --pick "4.*,5.*"      逐个小节播放视频到 100%（2 倍速 + 心跳保活）
 *                               ⚠️ 已弃用：只处理「单卡片、单视频」的老结构，
 *                               多卡片/多任务点/文档任务点请改用 drive.mjs run
 *   works                       列作业（id/标题/状态）
 *   quiz --work "3-4多选题"     拉题目到 .chaoxing/quiz-<workId>.json（只读，不提交）
 *   fill --file answers.json    按题目序号填答案（不提交）
 *   submit --yes                提交作业（确认弹窗一并点掉），回读分数
 *   review                      解析详情页「正确答案/我的答案/得分」，导出 correct-<workId>.json
 *   redo --yes                  点重做并回到作答页
 *   close                       关掉本脚本创建的 tab
 *
 * 所有产物写在当前目录的 .chaoxing/ 下。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROXY = process.env.CX_PROXY || 'http://localhost:3456';
const WORK = path.resolve('.chaoxing');
const STATE_FILE = path.join(WORK, 'state.json');

// ---------- 基础设施 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureWork() { fs.mkdirSync(WORK, { recursive: true }); }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { ensureWork(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function log(msg) { console.log(msg); }

async function api(pathname, { method = 'GET', body, query } = {}) {
  const url = new URL(PROXY + pathname);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { method, body });
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function ev(target, js) {
  const r = await api('/eval', { method: 'POST', body: js, query: { target } });
  if (r.error) throw new Error('eval 失败: ' + r.error);
  return r.value;
}
async function nav(target, url) { return api('/navigate', { method: 'POST', body: url, query: { target } }); }
async function newTab(url) { return api('/new', { method: 'POST', body: url }); }
async function closeTab(target) { return api('/close', { query: { target } }); }
async function info(target) { return api('/info', { query: { target } }); }

/** 直连浏览器级 CDP，用于 Page.bringToFront（proxy 未暴露该能力） */
function devtoolsWs() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const home = os.homedir();
  const cands = process.platform === 'win32'
    ? [path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
       path.join(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort')]
    : [path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
       path.join(home, '.config/google-chrome/DevToolsActivePort')];
  for (const p of cands) {
    try {
      const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
      if (lines[0] && lines[1]) return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    } catch { /* next */ }
  }
  return null;
}

function rawSession(targetId) {
  return new Promise((resolve) => {
    const url = devtoolsWs();
    if (!url) return resolve(null);
    const ws = new WebSocket(url);
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
    ws.onerror = () => resolve(null);
    ws.onopen = async () => {
      try {
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        resolve({ send, sessionId, close: () => ws.close() });
      } catch { resolve(null); }
    };
  });
}

async function bringToFront(targetId) {
  const s = await rawSession(targetId);
  if (!s) return false;
  try { await s.send('Page.bringToFront', {}, s.sessionId); return true; }
  catch { return false; }
  finally { s.close(); }
}

async function isVisible(targetId) {
  try { return (await ev(targetId, 'document.visibilityState')) === 'visible'; } catch { return false; }
}

// ---------- 参数 ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[k] = next; i++; }
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// ---------- 页面内脚本片段 ----------

const JS_CHAPTERS = `(()=>{
  const pick = (el) => (el.innerText||'').replace(/\\s+/g,' ').trim();
  const groups=[...document.querySelectorAll('.chapter_unit')];
  const out=[];
  groups.forEach((u,gi)=>{
    const numEl = u.querySelector('.catalog_num em') || u.querySelector('.catalog_num');
    const nameEl = u.querySelector('.catalog_name span[title]') || u.querySelector('.catalog_name') || u.querySelector('.chapter_head');
    const num = numEl ? pick(numEl) : String(gi + 1);
    const head = (nameEl ? (nameEl.getAttribute('title') || pick(nameEl)) : '').replace(/\\s+/g, ' ').trim();
    const label = head ? (num + ' ' + head) : '';
    const items=[...u.querySelectorAll('[onclick*="toOld"]')].map(a=>{
      const oc=a.getAttribute('onclick')||'';
      const m=oc.match(/toOld\\(\\s*['"]([^'"]+)['"]\\s*,\\s*['"]([^'"]+)['"]/);
      const name=pick(a).replace(/\\s*\\b\\d+$/,'');
      const cnt=(pick(a).match(/(\\d+)\\s*$/)||[])[1];
      return { name, kid: m?m[2]:null, badge: cnt?Number(cnt):null };
    }).filter(x=>x.kid);
    out.push({ group: gi+1, head: label, items });
  });
  return JSON.stringify({ total: out.reduce((n,g)=>n+g.items.length,0), groups: out });
})()`;

const JS_VIDEO_PICK = `(()=>{try{
  const f1=document.querySelector('#iframe')||[...document.querySelectorAll('iframe')].find(f=>/knowledge\\/cards/.test(f.src||''));
  if(!f1||!f1.contentDocument) return 'waiting';
  const f2=[...f1.contentDocument.querySelectorAll('iframe')].find(f=>/ananas\\/modules\\/video/.test(f.src||''));
  if(!f2||!f2.contentDocument) return 'novideo';
  const v=f2.contentDocument.querySelector('video');
  if(!v) return 'novideo';
  if(!v.duration || isNaN(v.duration)) return 'meta';
  window.__cxv=v;
  return 'ok';
}catch(e){return 'ERR:'+e.message}})()`;

const JS_HEARTBEAT = `(()=>{
  if(window.__cxhb) return 'already';
  function getV(){
    try{
      const f1=document.querySelector('#iframe')||[...document.querySelectorAll('iframe')].find(f=>/knowledge\\/cards/.test(f.src||''));
      if(!f1||!f1.contentDocument) return null;
      const f2=[...f1.contentDocument.querySelectorAll('iframe')].find(f=>/ananas\\/modules\\/video/.test(f.src||''));
      if(!f2||!f2.contentDocument) return null;
      return f2.contentDocument.querySelector('video');
    }catch(e){return null}
  }
  window.__cxhb=setInterval(()=>{
    const v=getV(); if(!v) return;
    window.__cxv=v;
    try{ v.muted=true; }catch(e){}
    if(v.ended) return;
    if(v.paused){ v.play().catch(()=>{}); }
    if(v.playbackRate!==2){ try{ v.playbackRate=2; }catch(e){} }
  },500);
  return 'installed';
})()`;

const JS_KILL_HB = `(()=>{ if(window.__cxhb){clearInterval(window.__cxhb);window.__cxhb=null;} return 'killed' })()`;

const JS_VSTATE = `(()=>{try{const v=window.__cxv;
  if(!v) return 'novideo';
  return JSON.stringify({t:v.currentTime,d:v.duration,p:v.paused,r:v.playbackRate,ended:v.ended,vis:document.visibilityState});
}catch(e){return 'ERR:'+e.message}})()`;

const JS_QUESTIONS = `(()=>{
  const qs=[...document.querySelectorAll('.questionLi')].filter(q=>q.getAttribute('data'));
  const mode = /\\/work\\/view/.test(location.pathname) ? 'view' : 'edit';
  const out=qs.map((q,i)=>{
    const stemEl=q.querySelector('.mark_name .qtContent')||q.querySelector('.mark_name')||q;
    const stem=stemEl.innerText.replace(/\\s+/g,' ').trim();
    let opts=[...q.querySelectorAll('.answerBg')].map(b=>{
      const l=b.querySelector('span[data]');
      const txt=(b.querySelector('.answer_p')||b).innerText.replace(/\\s+/g,' ').trim();
      return { letter: l?l.getAttribute('data'):'?', text: txt };
    });
    if(!opts.length){
      opts=[...q.querySelectorAll('ul.mark_letter li')].map(li=>{
        const t=li.innerText.replace(/\\s+/g,' ').trim();
        const m=t.match(/^([A-D])[\\.、]\\s*([\\s\\S]*)$/);
        return { letter: m?m[1]:'?', text: m?m[2].trim():t };
      });
    }
    const inp=document.getElementById('answer'+q.getAttribute('data'));
    return { index:i+1, qid:q.getAttribute('data'), type:q.getAttribute('typename'), stem, options:opts, current: inp?inp.value:'', mode };
  });
  return JSON.stringify(out);
})()`;

// ---------- 流程 ----------

function courseUrls(st) {
  return {
    course: `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=${st.courseid}&clazzid=${st.clazzid}&cpi=${st.cpi}&enc=${st.enc}&v=2&hideHead=0`,
    chapters: `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=${st.courseid}&clazzid=${st.clazzid}&cpi=${st.cpi}&ut=s&stuenc=${st.enc}`,
    works: `https://mooc1.chaoxing.com/mooc2/work/list?courseId=${st.courseid}&classId=${st.clazzid}&cpi=${st.cpi}&ut=s&stuenc=${st.enc}&enc=${st.workenc}`,
    study: (kid) => `https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=${kid}&courseId=${st.courseid}&clazzid=${st.clazzid}&cpi=${st.cpi}&enc=${st.oldenc}&mooc2=1&hidetype=0&fanyaVersion=0`,
  };
}

async function ensureTab(st, url) {
  let t = st.target;
  if (t) {
    const i = await info(t);
    if (!i || !i.title) t = null;
  }
  if (!t) {
    const r = await newTab(url);
    t = r.targetId;
    st.target = t;
    saveState(st);
    await sleep(2500);
  } else {
    await nav(t, url);
    await sleep(2500);
  }
  return t;
}

const CMD = {};

CMD.init = async (args) => {
  const url = args._[1];
  if (!url || !/chaoxing\.com/.test(url)) throw new Error('用法: init <课程页URL>');
  const q = new URL(url).searchParams;
  const st = {
    courseid: q.get('courseid') || q.get('courseId'),
    clazzid: q.get('clazzid') || q.get('classId'),
    cpi: q.get('cpi'),
    enc: q.get('enc'),
    target: null,
  };
  if (!st.courseid || !st.clazzid) throw new Error('URL 里缺少 courseid/clazzid');
  const r = await newTab(url);
  st.target = r.targetId;
  await sleep(3000);
  const extra = await ev(st.target, `(()=>{
    const g=(id)=>{const e=document.getElementById(id);return e?e.value:''};
    return JSON.stringify({oldenc:g('oldenc'),workenc:g('workEnc'),examenc:g('examEnc'),userId:g('userId')});
  })()`);
  Object.assign(st, JSON.parse(extra));
  st.courseName = (await info(st.target)).title || '';
  saveState(st);
  log(`课程：${st.courseName}`);
  log(JSON.stringify(st, null, 2));
};

CMD.chapters = async (args) => {
  const st = loadState();
  if (!st.courseid) throw new Error('先跑 init');
  const t = await ensureTab(st, courseUrls(st).chapters);
  for (let i = 0; i < 15; i++) {
    if ((await ev(t, 'document.querySelectorAll("[onclick*=toOld]").length')) > 0) break;
    await sleep(1000);
  }
  const tree = JSON.parse(await ev(t, JS_CHAPTERS));
  ensureWork();
  fs.writeFileSync(path.join(WORK, 'chapters.json'), JSON.stringify(tree, null, 2));
  log(`共 ${tree.total} 个小节，已存 .chaoxing/chapters.json`);
  for (const g of tree.groups) {
    log(`\n[${g.group}] ${g.head}`);
    for (const it of g.items) log(`   ${it.name}  kid=${it.kid}`);
  }
};

CMD.verify = async (args) => {
  const st = loadState();
  const t = await ensureTab(st, courseUrls(st).chapters);
  await sleep(2000);
  const txt = await ev(t, '(document.body.innerText.match(/已完成任务点[^\\n]*/)||["未找到"])[0]');
  log(txt);
};

CMD.study = async (args) => {
  const st = loadState();
  if (!st.courseid) throw new Error('先跑 init');
  let tree;
  const cache = path.join(WORK, 'chapters.json');
  if (fs.existsSync(cache)) tree = JSON.parse(fs.readFileSync(cache, 'utf8'));
  else { await CMD.chapters(args); tree = JSON.parse(fs.readFileSync(cache, 'utf8')); }

  const all = tree.groups.flatMap((g) => g.items);
  const QUIZ_RE = /(章节测验|单选题|多选题|判断题|期末考试|小测|考试)/;
  const picks = (args.pick ? String(args.pick).split(',') : []).map((s) => s.trim()).filter(Boolean);
  let targets = picks.length
    ? all.filter((it) => picks.some((p) => (p.endsWith('*') ? it.name.startsWith(p.slice(0, -1)) : it.name.startsWith(p))))
    : all;
  if (!args['include-quiz']) targets = targets.filter((it) => !QUIZ_RE.test(it.name));

  if (!targets.length) { log('没有匹配到小节，检查 --pick 写法（按小节名前缀，如 "4.*,5.*"）'); return; }

  log(`准备学习 ${targets.length} 个小节：`);
  targets.forEach((it) => log('  - ' + it.name));
  if (args.dry) { log('（--dry 只列清单，不实际播放）'); return; }

  const URLs = courseUrls(st);
  const tab = await ensureTab(st, URLs.study(targets[0].kid));
  await bringToFront(tab);

  const logPath = path.join(WORK, 'study.log');
  ensureWork();
  fs.writeFileSync(logPath, '');
  const rec = (m) => { const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${m}`; console.log(line); fs.appendFileSync(logPath, line + '\n'); };

  for (let i = 0; i < targets.length; i++) {
    const it = targets[i];
    rec(`[${i + 1}/${targets.length}] ${it.name}  kid=${it.kid}`);
    await nav(tab, URLs.study(it.kid));

    let ready = false;
    for (let w = 0; w < 40; w++) {
      await sleep(1000);
      const s = await ev(tab, JS_VIDEO_PICK);
      if (s === 'ok') { ready = true; break; }
      if (s === 'meta' || s === 'novideo') await ev(tab, JS_HEARTBEAT);
    }
    if (!ready) { rec('  !! 未出现可播放视频，跳过'); continue; }

    await ev(tab, JS_KILL_HB);
    await ev(tab, JS_HEARTBEAT);
    if (!(await isVisible(tab))) { await bringToFront(tab); await sleep(800); }

    let last = -1, stall = 0, hideTries = 0;
    for (let tick = 0; tick < 5000; tick++) {
      await sleep(15000);
      const raw = await ev(tab, JS_VSTATE);
      if (!raw || raw === 'novideo' || raw.startsWith('ERR')) {
        await ev(tab, JS_KILL_HB); await ev(tab, JS_HEARTBEAT); continue;
      }
      let o; try { o = JSON.parse(raw); } catch { continue; }
      const dur = o.d || 0;
      if (o.ended || (dur && o.t >= dur - 1.5)) { rec(`  ✓ 完成 ${it.name} ${Math.round(o.t)}/${Math.round(dur)}s`); break; }
      if (o.vis !== 'visible' && hideTries < 40) { await bringToFront(tab); hideTries++; }
      if (o.t > last + 1) { last = o.t; stall = 0; } else stall++;
      if (stall >= 3) { rec('  !! 停滞，重装心跳'); await ev(tab, JS_KILL_HB); await ev(tab, JS_HEARTBEAT); stall = 0; }
      if (tick % 4 === 0) rec(`  .. ${it.name} ${Math.round(o.t)}/${Math.round(dur)}s rate=${o.r} vis=${o.vis}`);
    }
  }
  rec('=== 全部完成 ===');
  log('提示：跑 `chaoxing.mjs verify` 核对「已完成任务点 N/M」是否增加。');
};

CMD.works = async (args) => {
  const st = loadState();
  const t = await ensureTab(st, courseUrls(st).works);
  await sleep(2500);
  const html = await ev(t, 'document.documentElement.outerHTML');
  const re = /<li[^>]*data="([^"]*workId=(\d+)[^"]*)"[^>]*>([\s\S]{0,1200}?)<\/li>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const seg = m[3];
    const title = (seg.match(/class="overHidden2 fl"[^>]*>([^<]+)</) || [])[1] || '';
    const status = (seg.match(/class="status fl"[^>]*>([^<]+)</) || [])[1] || '';
    out.push({ workId: m[2], title: title.trim(), status: status.trim(), data: m[1].replace(/&amp;/g, '&') });
  }
  ensureWork();
  fs.writeFileSync(path.join(WORK, 'works.json'), JSON.stringify(out, null, 2));
  log(`共 ${out.length} 项，已存 .chaoxing/works.json`);
  out.forEach((w) => log(`  ${w.workId}  ${w.title}  [${w.status}]`));
};

CMD.quiz = async (args) => {
  const st = loadState();
  const want = args.work;
  if (!want) throw new Error('用法: quiz --work "3-4多选题"');

  let works = [];
  const wf = path.join(WORK, 'works.json');
  if (fs.existsSync(wf)) works = JSON.parse(fs.readFileSync(wf, 'utf8'));
  if (!works.length) { await CMD.works(args); works = JSON.parse(fs.readFileSync(wf, 'utf8')); }

  const hit = works.find((w) => w.title === want) || works.find((w) => w.title.includes(want));
  if (!hit) throw new Error('没找到作业：' + want + '；先跑 works 看清单');

  const t = await ensureTab(st, hit.data);
  await sleep(3000);
  const qs = JSON.parse(await ev(t, JS_QUESTIONS));
  ensureWork();
  const file = path.join(WORK, `quiz-${hit.workId}.json`);
  fs.writeFileSync(file, JSON.stringify({ workId: hit.workId, title: hit.title, questions: qs }, null, 2));
  log(`${hit.title}（workId=${hit.workId}）共 ${qs.length} 题 → ${file}`);
  if (qs[0] && qs[0].mode === 'view') log('⚠️ 当前是「作业详情」只读页（该作业已提交）。要取标准答案请用 review。');
  for (const q of qs) {
    log(`\n${q.index}. ${q.stem}`);
    if (q.options.length) log('   ' + q.options.map((o) => `${o.letter}.${o.text}`).join('  '));
    if (q.current) log('   已选: ' + q.current);
  }
};

CMD.fill = async (args) => {
  const st = loadState();
  const f = args.file;
  if (!f) throw new Error('用法: fill --file answers.json   （格式 {"1":"ABD","2":"ABCD"}）');
  const plan = JSON.parse(fs.readFileSync(f, 'utf8'));
  const t = st.target;
  const js = `(()=>{
    const plan=${JSON.stringify(plan)};
    const qs=[...document.querySelectorAll('.questionLi')].filter(q=>q.getAttribute('data'));
    const log=[];
    qs.forEach((q,i)=>{
      const want=(plan[i+1]||plan[String(i+1)]||'').toUpperCase().split('').filter(Boolean);
      if(!want.length){ log.push((i+1)+'=SKIP'); return; }
      [...q.querySelectorAll('.answerBg')].forEach(b=>{
        const letter=b.querySelector('span[data]').getAttribute('data');
        const sel=/\bcheck/.test(b.querySelector('.num_option_dx').className);
        if(want.includes(letter)&&!sel) b.click();
        if(!want.includes(letter)&&sel) b.click();
      });
      const inp=document.getElementById('answer'+q.getAttribute('data'));
      log.push((i+1)+'='+(inp?inp.value:'?'));
    });
    return log.join(' | ');
  })()`;
  log('填写结果：' + await ev(t, js));
  log('（未提交。确认无误后跑 submit --yes）');
};

CMD.submit = async (args) => {
  const st = loadState();
  if (!args.yes) { log('提交不可逆。确认无误后加 --yes 再跑一次。'); return; }
  const t = st.target;
  const clicked = await ev(t, `(()=>{
    const b=[...document.querySelectorAll('a,button,div,span')].filter(e=>(e.innerText||'').trim()==='提交'&&e.offsetParent!==null);
    if(!b.length) return 'none';
    b[0].click(); return 'clicked';
  })()`);
  log('提交按钮: ' + clicked);
  await sleep(2500);
  const conf = await ev(t, `(()=>{
    const b=[...document.querySelectorAll('a.jb_btn')].filter(e=>(e.innerText||'').trim()==='提交');
    if(!b.length) return 'no-dialog';
    b[0].click(); return 'confirmed';
  })()`);
  log('确认弹窗: ' + conf);
  await sleep(5000);
  log(await ev(t, 'document.body.innerText.replace(/\\n{2,}/g,"\\n").trim().slice(0,200)'));
};

CMD.review = async (args) => {
  const st = loadState();
  const t = st.target;
  const onView = await ev(t, '/\\/work\\/view/.test(location.pathname)');
  if (!onView) {
    const clicked = await ev(t, `(()=>{
      const a=[...document.querySelectorAll('a,button,div,span')].filter(e=>(e.innerText||'').trim()==='查看详情'&&e.offsetParent!==null);
      if(!a.length) return 'none';
      a[0].click(); return 'clicked';
    })()`);
    if (clicked === 'none') { log('当前页没有「查看详情」，先 submit 或打开详情页'); return; }
    await sleep(4000);
  }
  const txt = await ev(t, 'document.body.innerText.replace(/\\n{2,}/g,"\\n")');
  const rows = [];
  const re = /(\d+)\.\s*\(多选题\)([\s\S]*?)我的答案:([A-D]*)[\s\S]*?正确答案:([A-D]*)[\s\S]*?(?=\n\d+\.\s*\(|\n一\.|$)/g;
  let m;
  while ((m = re.exec(txt))) rows.push({ index: Number(m[1]), mine: m[3], correct: m[4] });
  ensureWork();
  fs.writeFileSync(path.join(WORK, 'review.json'), JSON.stringify(rows, null, 2));
  const answers = {};
  rows.forEach((r) => { if (r.correct) answers[r.index] = r.correct; });
  fs.writeFileSync(path.join(WORK, 'answers-correct.json'), JSON.stringify(answers, null, 2));
  log('题号  我的   正确');
  let score = 0;
  rows.forEach((r) => { if (r.mine === r.correct) score++; log(`  ${r.index}    ${r.mine.padEnd(4)}  ${r.correct}`); });
  log(`\n全对 ${score}/${rows.length}；标准答案已存 .chaoxing/answers-correct.json`);
  if (score < rows.length) log('若允许重做，可用 redo --yes 后再 fill --file .chaoxing/answers-correct.json');
};

CMD.redo = async (args) => {
  const st = loadState();
  if (!args.yes) { log('重做会覆盖上一次成绩。确认后加 --yes。'); return; }
  const t = st.target;
  await ev(t, `(()=>{const a=[...document.querySelectorAll('a.redo, a,span,div')].filter(e=>(e.innerText||'').trim()==='重做'&&e.offsetParent!==null); if(a.length) a[0].click(); return 1})()`);
  await sleep(2500);
  const conf = await ev(t, `(()=>{const b=[...document.querySelectorAll('a.jb_btn')].filter(e=>(e.innerText||'').trim()==='重做'); if(!b.length) return 'no-dialog'; b[0].click(); return 'confirmed';})()`);
  log('重做: ' + conf);
  await sleep(6000);
  log('当前页：' + await ev(t, 'location.href'));
};

CMD.close = async (args) => {
  const st = loadState();
  if (!st.target) { log('没有记录的 tab'); return; }
  await closeTab(st.target);
  st.target = null;
  saveState(st);
  log('已关闭脚本创建的 tab');
};

// ---------- 入口 ----------

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || !CMD[cmd]) {
    console.log('可用子命令: ' + Object.keys(CMD).join(' | '));
    process.exit(0);
  }
  try { await CMD[cmd](args); }
  catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
})();
