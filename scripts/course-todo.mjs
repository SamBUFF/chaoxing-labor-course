#!/usr/bin/env node
/**
 * course-todo.mjs — 收尾核查：作业列表 + 考试列表
 *
 * 为什么需要：章节任务点全绿 ≠ 整门课完成。作业列表（work/list）和考试是独立入口，
 * 不计入章节任务点。代学收尾时必须各看一眼，避免漏交。
 *
 * 用法（在 drive.mjs init 过的工作目录执行）：
 *   node "$SK/scripts/course-todo.mjs"          # 作业 + 考试都查
 *   node "$SK/scripts/course-todo.mjs" works    # 只查作业
 *   node "$SK/scripts/course-todo.mjs" exams    # 只查考试
 *
 * 实现要点：work/list 与 exam-list 的 URL 带一次性 enc/stuenc/t，手拼容易 404 或「无效的参数」。
 * 所以先打开课程首页，点击顶部「作业 / 考试」导航让页面自己算出地址，再读 iframe 内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect, navigate, sleep } from './lib-cdp.mjs';

const WORK = path.resolve('.chaoxing');
const STATE = JSON.parse(fs.readFileSync(path.join(WORK, 'state.json'), 'utf8'));
const TAB_FILE = path.join(WORK, 'aux-tab.txt');
const mode = process.argv[2] || 'all';

const home = STATE.home ||
  `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=${STATE.courseid}&clazzid=${STATE.clazzid}&cpi=${STATE.cpi}&enc=${STATE.enc}${STATE.t ? '&t=' + STATE.t : ''}&pageHeader=1&v=2&hideHead=0`;

const s = await connect(TAB_FILE);
await s.call('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
if (!await navigate(s, home, { readyJs: `document.querySelectorAll('span.nav_content').length>0`, timeoutMs: 40000 })) {
  console.error('课程首页未就绪（state.json 里的 home/enc 可能已过期，重新 drive.mjs init 一次）');
  process.exit(1);
}
await sleep(2500);

async function openNav(label) {
  const clicked = await s.ev(`(()=>{const el=[...document.querySelectorAll('span.nav_content')].find(e=>(e.innerText||'').trim()===${JSON.stringify(label)});if(!el)return 'none';el.click();return 'clicked'})()`);
  if (clicked !== 'clicked') { console.log(label + '：找不到导航入口'); return; }
  await sleep(6000);
  const src = await s.ev(`(()=>{const f=document.querySelector('iframe');return f?f.getAttribute('src'):''})()`);
  if (!src) { console.log(label + '：没有取到列表地址'); return; }
  await navigate(s, src.startsWith('http') ? src : ('https://mooc2-ans.chaoxing.com' + src), { readyJs: 'document.body.innerText.length>10', timeoutMs: 25000 });
  await sleep(2500);
  const txt = await s.ev(`(()=>{
    const lis=[...document.querySelectorAll('li')].map(e=>(e.innerText||'').replace(/\\s+/g,' ').trim()).filter(t=>t.length>6);
    return JSON.stringify({list:lis.slice(0,30), text:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,900)});
  })()`);
  const o = JSON.parse(txt);
  console.log('\n=== ' + label + ' ===');
  console.log(o.text);
  // 回到课程首页再点下一个导航
  await navigate(s, home, { readyJs: `document.querySelectorAll('span.nav_content').length>0`, timeoutMs: 40000 });
  await sleep(2500);
}

if (mode === 'all' || mode === 'works') await openNav('作业');
if (mode === 'all' || mode === 'exams') await openNav('考试');

try { await s.send('Target.closeTarget', { targetId: s.targetId }); } catch { /* ignore */ }
try { fs.unlinkSync(TAB_FILE); } catch { /* ignore */ }
s.close();
process.exit(0);
