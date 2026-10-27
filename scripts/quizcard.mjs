#!/usr/bin/env node
/**
 * quizcard.mjs — 章节卡片内的「章节测验 / 随堂测验」作答器
 *
 * 与作业列表（work/list）那条路不同：章节卡片里的测验走
 *   #prev_tab → ananas/modules/work → /mooc-ans/api/work?... → doHomeWorkNew
 * 三层 iframe，只有从章节卡入口提交才会点亮任务点。
 *
 * 子命令：
 *   open <kid> [--tab N]        打开该小节的测验卡（不给 --tab 时按 tab 标题自动找“测验/测试/作业”）
 *   dump                        打印题目结构（题号/qid/qtype/选项字母/当前答案）；已提交的页面会切到 view 模式，
 *                               回原文（我的答案/得分），有「正确答案」时自动导出 answers-correct.json
 *   shot <n> | shot all         截图读题 → .chaoxing/q<n>.png（题干有字体混淆，靠截图读题）
 *                               自动加宽视口并避开吸顶头，all 一次截完整套题
 *   fill <plan.json>            按 {"1":"D","6":"AC","9":"true"} 填涂，并回读 #answer{qid} 校验
 *                               判断题也接受 "对"/"错"（自动转 true/false）
 *   filltext <n> <file>         第 n 题是简答/论述题时，把文本写进 UEditor（并同步隐藏域）
 *   submit --yes                提交（确认弹窗在顶层页面，不在答题 iframe 里）
 *   result                      打印结果页全文（每题「我的答案 + 得分」）
 *   modify --yes                点「修改答案」进入重做（没有该入口会明确提示；重做会清空简答题文本）
 *
 * 注意：题干/选项被 font-cxsecret 混淆，服务端下发的原文就是乱码，
 *       fetch 重取也拿不到明文 —— 必须截图用视觉读题；多选题的 aria-label 是明文可交叉校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect, navigate, sleep } from './lib-cdp.mjs';

const WORK = path.resolve('.chaoxing');
const STATE = JSON.parse(fs.readFileSync(path.join(WORK, 'state.json'), 'utf8'));
const TAB_FILE = path.join(WORK, 'worker-tab.txt');

// 三层 iframe 取到 doHomeWorkNew 的 document
const QD = `(()=>{
  try{
    const d=document.getElementById('iframe')&&document.getElementById('iframe').contentDocument;
    if(!d) return null;
    const f2=d.querySelector('.ans-attach-ct iframe');
    const d3=f2&&f2.contentDocument?f2.contentDocument.querySelector('iframe'):null;
    return d3?d3.contentDocument:null;
  }catch(e){return null}
})()`;

const secUrl = (kid) => `https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=${kid}&courseId=${STATE.courseid}&clazzid=${STATE.clazzid}&cpi=${STATE.cpi}&enc=${STATE.oldenc}&mooc2=1&hidetype=0&fanyaVersion=0`;

const args = process.argv.slice(2);
const mode = args[0] || 'dump';
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };

const s = await connect(TAB_FILE);

async function quizReady(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    // .TiMu = 未提交的作答页；.questionLi = 已提交的结果页
    const ok = await s.ev(`(()=>{const q=${QD}; return !!(q && (q.querySelectorAll('.TiMu').length || q.querySelectorAll('.questionLi').length))})()`).catch(() => false);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

if (mode === 'open') {
  const kid = args[1];
  if (!kid) { console.error('用法: quizcard.mjs open <knowledgeId> [--tab N]'); process.exit(1); }
  if (!await navigate(s, secUrl(kid), { readyJs: `!!document.getElementById('iframe')` })) {
    console.error('小节页未就绪'); process.exit(1);
  }
  await sleep(2000);
  const tabs = JSON.parse(await s.ev(`(()=>{
    const lis=[...document.querySelectorAll('#prev_tab li')];
    return JSON.stringify(lis.map((li,i)=>({i:i+1,title:(li.getAttribute('title')||li.innerText||'').replace(/\\s+/g,' ').trim()})));
  })()`));
  let idx = Number(opt('tab') || 0);
  if (!idx) {
    const hit = tabs.find((t) => /测验|测试|作业|考试/.test(t.title));
    idx = hit ? hit.i : tabs.length;
  }
  console.log('卡片：' + tabs.map((t) => `${t.i}.${t.title}`).join(' / '));
  // 内层 doHomeWorkNew 经常要 20s 以上才就绪；没起来就再切一次卡，别直接放弃
  let ready = false;
  for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
    await s.ev(`changeDisplayContent(${idx},${tabs.length},'${kid}','${STATE.courseid}','${STATE.clazzid}','')`).catch(() => {});
    await sleep(4000);
    ready = await quizReady(attempt === 1 ? 15000 : 25000);
    if (!ready) console.log(`第 ${attempt} 次等待仍未就绪${attempt < 3 ? '，重试切卡' : ''}`);
  }
  if (!ready) { console.error('测验页没加载出来（可再跑一次 open，或检查该小节是否真是测验卡）'); process.exit(1); }
  console.log(await s.ev(`(()=>{const q=${QD};return (q.body.innerText||'').replace(/\\s+/g,' ').slice(0,120)})()`));
  s.close();
  process.exit(0);
}

if (!await quizReady(8000)) { console.error('当前不在测验卡，先跑: quizcard.mjs open <kid>'); s.close(); process.exit(1); }

if (mode === 'dump') {
  const raw = await s.ev(`(()=>{
    const q=${QD};
    const ti=[...q.querySelectorAll('.TiMu')];
    if(ti.length && q.querySelector('li[qid]')){
      return JSON.stringify({mode:'edit',questions:ti.map((e,i)=>{
        const lis=[...e.querySelectorAll('li[qid]')];
        const qid=lis.length?lis[0].getAttribute('qid'):'';
        const inp=q.getElementById('answer'+qid);
        return {
          n:i+1, qid, qtype:lis.length?lis[0].getAttribute('qtype'):'',
          stem:(e.querySelector('.fontLabel')||e).getAttribute('aria-label')||(e.querySelector('.fontLabel')||e).innerText.replace(/\\s+/g,' ').trim().slice(0,80),
          opts:lis.map((li)=>({
            letter:(li.querySelector('span.num_option,span.num_option_dx')||{getAttribute:()=>''}).getAttribute('data')||'',
            aria:li.getAttribute('aria-label')||''
          })),
          cur:inp?inp.value:''
        };
      })});
    }
    // 已提交的结果页：直接回原文，含「我的答案」「正确答案」
    const ql=[...q.querySelectorAll('.questionLi')];
    const boxes=ql.length?ql:[...q.querySelectorAll('.TiMu')];
    return JSON.stringify({mode:'view',questions:boxes.map((e,i)=>({n:i+1,text:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,600)}))});
  })()`);
  const obj = JSON.parse(raw);
  console.log(JSON.stringify(obj, null, 1));
  fs.writeFileSync(path.join(WORK, 'quiz-dump.json'), JSON.stringify(obj, null, 2));
  if (obj.mode === 'view') {
    const ans = {};
    obj.questions.forEach((it) => {
      const m = it.text.match(/正确答案[：:]\s*([A-Za-z对错正确错误]+)/);
      if (m) ans[it.n] = m[1];
    });
    if (Object.keys(ans).length) {
      fs.writeFileSync(path.join(WORK, 'answers-correct.json'), JSON.stringify(ans, null, 2));
      console.log('标准答案 → .chaoxing/answers-correct.json：' + JSON.stringify(ans));
    }
  }
}

if (mode === 'shot') {
  // 实测默认视口只有约 758x486 且横向滚动，截图会被吸顶头和左缘悬浮条挡住。
  // 加宽视口 + 滚到题目后再往上回退，题干和选项才能完整可读。
  await s.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1200, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const total = Number(await s.ev(`(()=>{const q=${QD};return q.querySelectorAll('.TiMu').length})()`).catch(() => 0));
  const arg = String(args[1] || '1');
  const list = arg === 'all' ? Array.from({ length: total }, (_, i) => i + 1) : [Number(arg)];
  for (const n of list) {
    await s.ev(`(()=>{const q=${QD};const l=[...q.querySelectorAll('.TiMu')];if(l[${n - 1}])l[${n - 1}].scrollIntoView({block:'start'});return 1})()`);
    await sleep(900);
    await s.ev(`window.scrollBy(0,-190);1`).catch(() => {});
    await s.ev(`(()=>{const q=${QD};q.defaultView.scrollBy(0,-60);return 1})()`).catch(() => {});
    await sleep(700);
    const r = await s.call('Page.captureScreenshot', { format: 'png' });
    const f = path.join(WORK, `q${n}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('saved ' + f);
  }
  await s.call('Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
}

if (mode === 'fill') {
  const planFile = args[1];
  if (!planFile) { console.error('用法: quizcard.mjs fill answers.json'); process.exit(1); }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  // 判断题允许写 "对"/"错"/"正确"/"错误"，统一成 true/false
  for (const k of Object.keys(plan)) {
    const v = plan[k];
    if (typeof v === 'string' && /^(对|正确|√|T|true)$/i.test(v.trim())) plan[k] = 'true';
    else if (typeof v === 'string' && /^(错|错误|×|X|F|false)$/i.test(v.trim())) plan[k] = 'false';
  }
  const out = await s.ev(`(()=>{
    const q=${QD}; const list=[...q.querySelectorAll('.TiMu')]; const plan=${JSON.stringify(plan)}; const log=[];
    list.forEach((e,i)=>{
      const n=i+1, want=String(plan[String(n)]==null?plan[n]||'':plan[String(n)]||''); if(!want){log.push(n+':skip');return;}
      const lis=[...e.querySelectorAll('li[qid]')];
      const qid=lis.length?lis[0].getAttribute('qid'):'';
      const qtype=lis.length?lis[0].getAttribute('qtype'):'';
      const inp=q.getElementById('answer'+qid);
      const cur=inp?String(inp.value):'';
      const opt={}; lis.forEach(li=>{const sp=li.querySelector('span.num_option,span.num_option_dx');const L=sp?sp.getAttribute('data'):'';if(L)opt[L]=li;});
      const acts=[];
      if(/^(true|false)$/i.test(want)){
        const tg=want.toLowerCase();
        if(cur.toLowerCase()!==tg && opt[tg]){ opt[tg].click(); acts.push('set='+tg); }
      } else if(qtype==='1' || want.length>1){
        const w=new Set(want.toUpperCase().split('')), c=new Set(cur.toUpperCase().split(''));
        Object.keys(opt).forEach(L=>{
          const U=L.toUpperCase();
          if(w.has(U)&&!c.has(U)){ opt[L].click(); acts.push('+'+U); }
          else if(!w.has(U)&&c.has(U)){ opt[L].click(); acts.push('-'+U); }
        });
      } else {
        const tg=want.toUpperCase();
        if(cur.toUpperCase()!==tg && opt[tg]){ opt[tg].click(); acts.push('set='+tg); }
      }
      log.push(n+': qtype='+qtype+' want='+want+' was='+cur+' act='+(acts.join(',')||'none'));
    });
    return log.join('\\n');
  })()`);
  console.log(out);
  await sleep(600);
  console.log('--- 回读 #answer ---');
  console.log(await s.ev(`(()=>{const q=${QD};return [...q.querySelectorAll('.TiMu')].map((e,i)=>{
    const li=e.querySelector('li[qid]');const qid=li?li.getAttribute('qid'):'';const inp=q.getElementById('answer'+qid);
    return (i+1)+'='+(inp?inp.value:'?')}).join(' | ')})()`));
}

if (mode === 'filltext') {
  // 简答 / 论述题：UEditor 富文本，正文在 iframe#ueditor_0 的 body，
  // 提交真值是同级 textarea#answer{qid}，必须两边都写并触发 sync
  const n = Number(args[1] || 0);
  const file = args[2];
  if (!n || !file) { console.error('用法: quizcard.mjs filltext <题号> <文本文件>'); process.exit(1); }
  const text = fs.readFileSync(file, 'utf8').trim();
  const out = await s.ev(`(()=>{
    const q=${QD};
    const box=[...q.querySelectorAll('.TiMu')][${n - 1}];
    if(!box) return 'no-question';
    const frame=box.querySelector('iframe[id^=ueditor]');
    const ta=box.querySelector('textarea[id^=answer]');
    if(!frame) return 'no-editor（该题不是 UEditor 简答题）';
    frame.contentDocument.body.innerHTML='<p>'+${JSON.stringify(text)}+'</p>';
    frame.contentDocument.body.dispatchEvent(new Event('input',{bubbles:true}));
    try{
      const W=frame.contentWindow;
      if(W.UE && W.UE.instants) Object.keys(W.UE.instants).forEach(k=>{try{W.UE.instants[k].sync()}catch(e){}});
    }catch(e){}
    if(ta && !ta.value.trim()) ta.value=${JSON.stringify(text)};
    return 'ok';
  })()`);
  console.log(out);
  await sleep(1200);
  console.log(await s.ev(`(()=>{
    const q=${QD};const box=[...q.querySelectorAll('.TiMu')][${n - 1}];
    const ta=box.querySelector('textarea[id^=answer]');
    const fr=box.querySelector('iframe[id^=ueditor]');
    return '回读：textarea='+(ta?ta.value.length:0)+' 字符 / 编辑器='+(fr.contentDocument.body.innerText||'').length+' 字符';
  })()`));
}

if (mode === 'result') {
  console.log(await s.ev(`(()=>{const q=${QD};return (q.body.innerText||'').replace(/\\s+/g,' ')})()`));
}

if (mode === 'modify') {
  if (!args.includes('--yes')) { console.log('重做会覆盖上一次成绩，且会清空简答题文本。确认后加 --yes'); s.close(); process.exit(0); }
  const c1 = await s.ev(`(()=>{const q=${QD};const a=[...q.querySelectorAll('a')].find(e=>/修改答案/.test((e.innerText||'').trim()));if(!a)return 'none';a.click();return 'clicked'})()`);
  console.log('修改答案:', c1);
  if (c1 === 'none') { console.log('该测验没有「修改答案」入口，不能重做，当前成绩即最终成绩。'); s.close(); process.exit(0); }
  await sleep(3000);
  for (let i = 0; i < 15; i++) {
    const c2 = await s.ev(`(()=>{const b=document.querySelector('#popok');if(!b||b.offsetParent===null)return 'no-dialog';b.click();return 'confirmed'})()`);
    if (c2 === 'confirmed') { console.log('确认弹窗: confirmed'); break; }
    await sleep(700);
  }
  await sleep(4000);
  console.log('已进入作答页，记得重填简答题再提交。');
}

if (mode === 'submit') {
  if (!args.includes('--yes')) { console.log('提交不可逆。确认无误后加 --yes'); s.close(); process.exit(0); }
  // 实测 a.click() 有的课程不触发 handler，直接调 btnBlueSubmit() 最稳
  const c1 = await s.ev(`(()=>{
    const q=${QD};
    try{ if(typeof q.defaultView.btnBlueSubmit==='function'){ q.defaultView.btnBlueSubmit(); return 'btnBlueSubmit()'; } }catch(e){ return 'ERR:'+e.message; }
    const b=q.querySelector('a.btnSubmit.workBtnIndex')||[...q.querySelectorAll('a')].find(e=>(e.innerText||'').trim()==='提交');
    if(!b)return 'none';b.click();return 'clicked';
  })()`);
  console.log('触发提交:', c1);
  // 确认弹窗在顶层页面，本课是 a.jb_btn#popok，出现常有 3~5s 延迟，必须轮询
  let c2 = 'no-dialog';
  for (let i = 0; i < 25; i++) {
    await sleep(700);
    c2 = await s.ev(`(()=>{
      const b=document.querySelector('#popok');
      if(b && b.offsetParent!==null){ b.click(); return 'confirmed'; }
      const alt=[...document.querySelectorAll('a.jb_btn')].filter(e=>e.offsetParent!==null&&/提交|确定/.test((e.innerText||'').trim()));
      if(alt.length){ alt[0].click(); return 'confirmed'; }
      return 'no-dialog';
    })()`);
    if (c2 === 'confirmed') break;
  }
  console.log('确认弹窗:', c2);
  await sleep(9000);
  const txt = await s.ev(`(()=>{try{const q=${QD};return (q.body.innerText||'').replace(/\\s+/g,' ')}catch(e){return '取结果页失败'}})()`);
  const score = txt.match(/本次成绩\s*([\d.]+)\s*分/);
  console.log('结果:', score ? ('本次成绩 ' + score[1] + ' 分') : txt.slice(0, 120));
  console.log(txt.slice(0, 400));
  if (/待完成/.test(txt.slice(0, 40))) console.log('提示：页面仍显示「待完成」，可能没提交成功；用 result 复核，必要时刷新后重试。');
}

s.close();
process.exit(0);
