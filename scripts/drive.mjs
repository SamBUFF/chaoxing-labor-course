#!/usr/bin/env node
/**
 * drive.mjs — 学习通「章节任务点」驱动器（原生 CDP，自建工作 tab）
 *
 * 处理三种任务点：
 *   video/audio —— muted + 2x + 500ms 心跳，真实播放到结尾（完成条件：观看时长 ≥ 90%）
 *   doc(PPT/PDF) —— 走页面自身的阅读遮罩流程 unMaskAndFinishJob()，用 checkJobFinish() 校验
 *   work(章节测验) —— 不自动作答，转 quizcard.mjs
 *
 * 子命令：
 *   init <课程页URL>   解析 courseid/clazzid/cpi/enc + 隐藏域 oldenc/workEnc/examEnc → .chaoxing/state.json
 *   verify             读「已完成任务点 N/M」+ 绿勾数 + 待完成小节清单
 *   run                [--only kid1,kid2] [--max N] [--pass 2] 逐小节处理待完成任务点
 *   visit              把「无任务点」的小节逐个打开一次（目录里才会从橙色 0 变成绿勾）
 *
 * 产物都在当前目录的 .chaoxing/ 下：state.json / worker-tab.txt / todo.json / study.log / progress.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect, navigate, sleep, devtoolsWs } from './lib-cdp.mjs';

const WORK = path.resolve('.chaoxing');
const STATE_FILE = path.join(WORK, 'state.json');
const TAB_FILE = path.join(WORK, 'worker-tab.txt');
const LOG_FILE = path.join(WORK, 'study.log');
const PROGRESS_FILE = path.join(WORK, 'progress.json');

const nowStr = () => new Date().toLocaleString('zh-CN', { hour12: false });
function log(msg) {
  const line = `[${nowStr()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

const STATE = loadJson(STATE_FILE, null);
const progress = loadJson(PROGRESS_FILE, { done: {}, failed: {} });
const saveProgress = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

// ---------------- 页面片段 ----------------

const READY_SECTION = `!!document.getElementById('iframe') && !!document.getElementById('iframe').contentDocument`;

const JS_TABS = `(()=>{
  const lis=[...document.querySelectorAll('#prev_tab li')];
  return JSON.stringify(lis.map((li,i)=>({i:i+1,title:(li.getAttribute('title')||li.innerText||'').replace(/\\s+/g,' ').trim()})));
})()`;

// 一个小节里可能有多个附件卡片，一个卡片里又可能有多个任务点（如 3 个视频）
const JS_JOBS = `(()=>{
  const f1=document.getElementById('iframe');
  if(!f1||!f1.contentDocument) return 'noframe';
  const d=f1.contentDocument;
  const cts=[...d.querySelectorAll('.ans-attach-ct')];
  return JSON.stringify(cts.map((c,i)=>{
    const f=c.querySelector('iframe');
    const icon=c.querySelector('.ans-job-icon');
    const src=f?(f.getAttribute('src')||''):'';
    let type='other';
    if(/modules\\/video/.test(src)) type='video';
    else if(/modules\\/audio/.test(src)) type='audio';
    else if(/modules\\/pdf|modules\\/doc|insertdoc/.test(src)) type='doc';
    else if(/api\\/work|modules\\/work/.test(src)) type='work';
    return {
      i:i+1,type,
      finished:/ans-job-finished/.test(c.className),
      cond:icon?(icon.innerText||'').replace(/\\s+/g,' ').trim().slice(0,70):'',
      jobid:f?(f.getAttribute('jobid')||''):'',
      hasCd:!!(f&&f.contentDocument)
    };
  }));
})()`;

const jsHeartbeat = (idx) => `(()=>{
  window.__drvIdx=${idx};
  if(window.__drvHB) clearInterval(window.__drvHB);
  function pick(){
    try{
      const d=document.getElementById('iframe').contentDocument;
      const c=[...d.querySelectorAll('.ans-attach-ct')][window.__drvIdx];
      if(!c) return null;
      const f=c.querySelector('iframe'); if(!f||!f.contentDocument) return null;
      return f.contentDocument.querySelector('video,audio');
    }catch(e){return null}
  }
  window.__drvHB=setInterval(()=>{
    const v=pick(); if(!v) return;
    window.__drvV=v;
    try{ v.muted=true; }catch(e){}
    if(!v.ended && v.paused){ v.play().catch(()=>{}); }
    if(v.playbackRate!==2){ try{ v.playbackRate=2; }catch(e){} }
  },500);
  return 'hb';
})()`;

const JS_STOP_HB = `(()=>{ if(window.__drvHB){clearInterval(window.__drvHB);window.__drvHB=null;} window.__drvV=null; return 'off' })()`;

const jsVState = (idx) => `(()=>{
  try{
    const d=document.getElementById('iframe').contentDocument;
    const c=[...d.querySelectorAll('.ans-attach-ct')][${idx}]; if(!c) return 'nojob';
    const f=c.querySelector('iframe'); if(!f||!f.contentDocument) return 'noframe';
    const v=f.contentDocument.querySelector('video,audio');
    if(!v) return 'novideo';
    return JSON.stringify({t:v.currentTime,d:v.duration,p:v.paused,r:v.playbackRate,ended:v.ended,vis:document.visibilityState,
      icon:/ans-job-finished/.test(c.className)?'ans-job-finished':''});
  }catch(e){return 'ERR:'+e.message}
})()`;

const jsScrollTo = (idx) => `(()=>{try{
  const d=document.getElementById('iframe').contentDocument;
  const c=[...d.querySelectorAll('.ans-attach-ct')][${idx}];
  if(c&&c.scrollIntoView) c.scrollIntoView({block:'center'});
  return 'ok';
}catch(e){return 'err'}})()`;

// 文档任务点：页面自己的遮罩 onclick 就是 unMaskAndFinishJob()，等价于人工点「阅读」
const jsDocFinish = (idx) => `(()=>{
  try{
    const d=document.getElementById('iframe').contentDocument;
    const c=[...d.querySelectorAll('.ans-attach-ct')][${idx}];
    const w=c.querySelector('iframe').contentWindow;
    let cj=null; try{ cj=w.checkJobFinish?w.checkJobFinish():null }catch(e){ cj='err' }
    if(cj===true) return 'already';
    if(!w.unMaskAndFinishJob) return 'no-handler';
    try{ w.unMaskAndFinishJob(); }catch(e){ return 'ERR:'+e.message }
    let cj2=null; try{ cj2=w.checkJobFinish?w.checkJobFinish():null }catch(e){ cj2='err' }
    return JSON.stringify({after:cj2});
  }catch(e){return 'ERR:'+e.message}
})()`;

const JS_CATALOG = `(()=>{
  const total=(document.body.innerText.match(/已完成任务点[^\\n]*/)||['?'])[0];
  const items=[...document.querySelectorAll('.chapter_item')].filter(it=>it.id);
  const rows=items.map(it=>{
    const t=it.querySelector('.catalog_task');
    const yi=it.querySelector('.catalog_points_yi');
    return {
      kid:it.id.replace('cur',''),
      name:(it.querySelector('.catalog_name')||it).innerText.replace(/\\s+/g,' ').trim(),
      green:!!(t&&/icon_yiwanc/.test(t.innerHTML)),
      pending:yi?Number(yi.innerText.trim()):0
    };
  });
  const todo=rows.filter(r=>r.pending>0);
  return JSON.stringify({total,green:rows.filter(r=>r.green).length,all:rows.length,rows,todo,sum:todo.reduce((a,b)=>a+b.pending,0)});
})()`;

// ---------------- 业务 ----------------

const secUrl = (kid) => `https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=${kid}&courseId=${STATE.courseid}&clazzid=${STATE.clazzid}&cpi=${STATE.cpi}&enc=${STATE.oldenc}&mooc2=1&hidetype=0&fanyaVersion=0`;
const catalogUrl = () => `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=${STATE.courseid}&clazzid=${STATE.clazzid}&cpi=${STATE.cpi}&ut=s&stuenc=${STATE.enc}`;

async function readJobs(s, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const raw = await s.ev(JS_JOBS).catch(() => 'noframe');
    if (raw && raw !== 'noframe') {
      const arr = JSON.parse(raw);
      if (arr.length && arr.every((j) => j.type !== 'other' || j.hasCd)) return arr;
    }
    await sleep(700);
  }
  return null;
}

async function playVideo(s, idx, label) {
  await s.ev(jsScrollTo(idx));
  await sleep(600);
  await s.ev(jsHeartbeat(idx));
  const t0 = Date.now();
  let last = -1, stall = 0, maxDur = 0;
  for (let tick = 0; tick < 4000; tick++) {
    await sleep(6000);
    const raw = await s.ev(jsVState(idx)).catch(() => 'novideo');
    if (!raw || !raw.startsWith('{')) {
      if (++stall > 10) { await s.ev(JS_STOP_HB); return { ok: false, why: 'no-video: ' + raw }; }
      await s.ev(jsHeartbeat(idx));
      continue;
    }
    const o = JSON.parse(raw);
    const d = o.d || 0;
    if (d > maxDur) maxDur = d;
    if (/ans-job-finished/.test(o.icon)) { await s.ev(JS_STOP_HB); return { ok: true, why: 'icon', dur: d, sec: (Date.now() - t0) / 1000 }; }
    if (o.ended || (d && o.t >= d - 1.5)) {
      for (let k = 0; k < 8; k++) {
        await sleep(1500);
        const st = await s.ev(jsVState(idx)).catch(() => '');
        if (st && st.startsWith('{') && /ans-job-finished/.test(JSON.parse(st).icon)) {
          await s.ev(JS_STOP_HB);
          return { ok: true, why: 'ended', dur: d, sec: (Date.now() - t0) / 1000 };
        }
      }
      await s.ev(JS_STOP_HB);
      // 播放器不一定即时回写 DOM，服务端多半已记录；最终以目录 N/M 为准
      return { ok: true, why: 'ended-unverified', dur: d, sec: (Date.now() - t0) / 1000 };
    }
    if (o.t > last + 1) { last = o.t; stall = 0; } else stall++;
    if (stall >= 5) {
      await s.ev(jsHeartbeat(idx));
      await s.focusOn();
      stall = 0;
      log(`      ! ${label} 停滞，已重装心跳（${Math.round(o.t)}/${Math.round(d)}s）`);
    }
    if (maxDur && (Date.now() - t0) / 1000 > (maxDur / 2) * 3 + 300) {
      await s.ev(JS_STOP_HB);
      return { ok: false, why: 'timeout', dur: maxDur, sec: (Date.now() - t0) / 1000 };
    }
    if (tick % 5 === 0) log(`      .. ${label} ${Math.round(o.t)}/${Math.round(d)}s ×${o.r} ${o.vis}`);
  }
  await s.ev(JS_STOP_HB);
  return { ok: false, why: 'loop-exhausted' };
}

async function doSection(s, kid, name) {
  log(`▶ ${name} (kid=${kid})`);
  if (!await navigate(s, secUrl(kid), { readyJs: READY_SECTION })) { log('  !! 页面未就绪'); return; }
  await s.focusOn();
  await sleep(1500);

  let tabs = [];
  for (let i = 0; i < 12; i++) {
    tabs = JSON.parse(await s.ev(JS_TABS).catch(() => '[]'));
    if (tabs.length) break;
    await sleep(900);
  }
  if (!tabs.length) tabs = [{ i: 1, title: '默认' }];
  log(`  卡片 ${tabs.length} 个：${tabs.map((t) => t.title).join(' / ')}`);

  for (const tab of tabs) {
    if (tabs.length > 1) {
      await s.ev(`changeDisplayContent(${tab.i},${tabs.length},'${kid}','${STATE.courseid}','${STATE.clazzid}','')`);
      await sleep(1500);
    }
    const jobs = await readJobs(s);
    if (!jobs) { log(`  !! [${tab.i}] 卡片内容读取超时`); continue; }
    const pending = jobs.filter((j) => !j.finished && j.jobid);
    if (!pending.length) { log(`  ✓ [${tab.i}/${tabs.length}] ${tab.title} 无待完成任务点`); continue; }

    for (const job of pending) {
      const key = `${kid}#${tab.i}#${job.i}`;
      const label = `${tab.title}#${job.i}`;
      log(`  · [${tab.i}/${tabs.length}] ${label} type=${job.type}${job.cond ? ' 条件: ' + job.cond : ''}`);

      if (job.type === 'video' || job.type === 'audio') {
        const r = await playVideo(s, job.i - 1, label);
        if (r.ok) {
          progress.done[key] = { title: label, type: job.type, dur: r.dur, at: nowStr() };
          log(`  ✓ ${label} 完成（${Math.round((r.dur || 0) / 60)} 分钟视频，用时 ${Math.round((r.sec || 0) / 60)} 分钟${r.why === 'ended-unverified' ? '，完成标记待目录核对' : ''}）`);
        } else {
          progress.failed[key] = { title: label, type: job.type, why: r.why, at: nowStr() };
          log(`  ✗ ${label} 未完成：${r.why}`);
        }
        saveProgress();
      } else if (job.type === 'doc') {
        const r = await s.ev(jsDocFinish(job.i - 1)).catch((e) => 'ERR:' + e.message);
        await sleep(2000);
        if (/already|"after":true/.test(String(r))) {
          progress.done[key] = { title: label, type: 'doc', at: nowStr() };
          log(`  ✓ ${label} 文档任务点完成`);
        } else {
          progress.failed[key] = { title: label, type: 'doc', why: String(r), at: nowStr() };
          log(`  ✗ ${label} 文档未判定完成：${r}`);
        }
        saveProgress();
      } else if (job.type === 'work') {
        log(`  · ${label} 是章节测验/作业卡，需单独作答 → 用 quizcard.mjs`);
      } else {
        log(`  · ${label} 未知类型（${job.type}），跳过`);
      }
    }
  }
}

async function readCatalog(s) {
  await navigate(s, catalogUrl(), { readyJs: `!!document.querySelector('.chapter_item')` });
  await sleep(1500);
  return JSON.parse(await s.ev(JS_CATALOG));
}

// ---------------- main ----------------

const args = process.argv.slice(2);
const mode = args[0] || 'verify';
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };

if (mode === 'init') {
  const url = args[1];
  if (!url || !/chaoxing\.com/.test(url)) { console.error('用法: drive.mjs init "<课程页URL>"'); process.exit(1); }
  const q = new URL(url).searchParams;
  const st = {
    courseid: q.get('courseid') || q.get('courseId'),
    clazzid: q.get('clazzid') || q.get('classId'),
    cpi: q.get('cpi'),
    enc: q.get('enc'),
  };
  if (!st.courseid || !st.clazzid) { console.error('URL 里缺少 courseid/clazzid'); process.exit(1); }
  fs.mkdirSync(WORK, { recursive: true });
  const s = await connect(TAB_FILE);
  await navigate(s, url, { readyJs: `!!document.getElementById('oldenc')`, timeoutMs: 40000 });
  const extra = JSON.parse(await s.ev(`(()=>{const g=(id)=>{const e=document.getElementById(id);return e?e.value:''};
    return JSON.stringify({oldenc:g('oldenc'),workenc:g('workEnc'),examenc:g('examEnc'),userId:g('userId')})})()`));
  Object.assign(st, extra);
  st.courseName = await s.ev('document.title').catch(() => '');
  st.target = s.targetId;
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  console.log('课程：' + st.courseName);
  console.log(JSON.stringify(st, null, 2));
  s.close();
  process.exit(0);
}

if (!STATE || !STATE.courseid) { console.error('先跑 drive.mjs init "<课程页URL>"'); process.exit(1); }

const s = await connect(TAB_FILE);

if (mode === 'verify') {
  const v = await readCatalog(s);
  console.log(`${v.total} ｜ 绿勾 ${v.green}/${v.all}`);
  console.log(`待完成小节 ${v.todo.length} 个，合计 ${v.sum} 个任务点`);
  v.todo.forEach((t) => console.log(` ${t.kid} ${t.pending} ${t.name}`));
  fs.writeFileSync(path.join(WORK, 'todo.json'), JSON.stringify(v, null, 2));
}

if (mode === 'run') {
  const only = opt('only');
  const max = Number(opt('max') || 0);
  const maxPass = Number(opt('pass') || 2);
  for (let pass = 1; pass <= maxPass; pass++) {
    const v = await readCatalog(s);
    log(`=== 第 ${pass} 轮：${v.total} ｜ 绿勾 ${v.green}/${v.all} ｜ 待完成 ${v.sum} 个任务点 / ${v.todo.length} 小节 ===`);
    if (!v.todo.length) break;
    let list = v.todo;
    if (only) list = list.filter((t) => only.split(',').includes(t.kid));
    if (max) list = list.slice(0, max);
    if (!list.length) break;
    for (const it of list) {
      try { await doSection(s, it.kid, it.name); } catch (e) { log(`  !! 小节异常：${e.message}`); }
      await s.focusOn();
    }
    if (only || max) break;
  }
  const v2 = await readCatalog(s);
  log(`=== 收工：${v2.total} ｜ 绿勾 ${v2.green}/${v2.all} ｜ 剩余 ${v2.sum} 个任务点 ===`);
  v2.todo.forEach((t) => log(`  剩余 ${t.pending}  ${t.name}`));
  fs.writeFileSync(path.join(WORK, 'todo.json'), JSON.stringify(v2, null, 2));
}

if (mode === 'visit') {
  const v = await readCatalog(s);
  const rest = v.rows.filter((r) => !r.green);
  log(`待访问 ${rest.length} 个小节（无任务点的白色资料小节，打开一次才会变绿）`);
  for (let k = 0; k < rest.length; k++) {
    const it = rest[k];
    if (!await navigate(s, secUrl(it.kid), { readyJs: READY_SECTION, timeoutMs: 20000 })) { log(`  !! ${it.name} 打不开`); continue; }
    await sleep(2500);
    const n = Number(await s.ev(`document.querySelectorAll('#prev_tab li').length`)) || 1;
    for (let i = 1; i <= n; i++) {
      if (n > 1) { await s.ev(`changeDisplayContent(${i},${n},'${it.kid}','${STATE.courseid}','${STATE.clazzid}','')`); await sleep(1600); }
    }
    log(`${k + 1}/${rest.length} ${it.name}（${n} 卡片）`);
  }
  const v2 = await readCatalog(s);
  log(`=== 收工：${v2.total} ｜ 绿勾 ${v2.green}/${v2.all} ===`);
}

s.close();
process.exit(0);
