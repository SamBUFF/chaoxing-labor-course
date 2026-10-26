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
 *   shot <n>                    把第 n 题截到 .chaoxing/q<n>.png（题干有字体混淆，靠截图读题）
 *   fill <plan.json>            按 {"1":"D","6":"AC","9":"true"} 填涂，并回读 #answer{qid} 校验
 *   submit --yes                提交（确认弹窗在顶层页面，不在答题 iframe 里）
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
  await s.ev(`changeDisplayContent(${idx},${tabs.length},'${kid}','${STATE.courseid}','${STATE.clazzid}','')`);
  await sleep(6000);
  if (!await quizReady()) { console.error('测验页没加载出来'); process.exit(1); }
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
  const n = Number(args[1] || 1);
  await s.ev(`(()=>{const q=${QD};const l=[...q.querySelectorAll('.TiMu')];if(l[${n - 1}])l[${n - 1}].scrollIntoView({block:'start'});return 1})()`);
  await sleep(800);
  const r = await s.call('Page.captureScreenshot', { format: 'png' });
  const f = path.join(WORK, `q${n}.png`);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log('saved ' + f);
}

if (mode === 'fill') {
  const planFile = args[1];
  if (!planFile) { console.error('用法: quizcard.mjs fill answers.json'); process.exit(1); }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
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

if (mode === 'submit') {
  if (!args.includes('--yes')) { console.log('提交不可逆。确认无误后加 --yes'); s.close(); process.exit(0); }
  const c1 = await s.ev(`(()=>{const q=${QD};const b=q.querySelector('a.btnSubmit.workBtnIndex')||[...q.querySelectorAll('a')].find(e=>(e.innerText||'').trim()==='提交');if(!b)return 'none';b.click();return 'clicked'})()`);
  console.log('提交按钮:', c1);
  await sleep(2500);
  // 确认弹窗在顶层页面
  const c2 = await s.ev(`(()=>{const b=[...document.querySelectorAll('a.jb_btn')].filter(e=>e.offsetParent!==null&&/提交|确定/.test((e.innerText||'').trim()));if(!b.length)return 'no-dialog';b[0].click();return 'confirmed'})()`);
  console.log('确认弹窗:', c2);
  await sleep(6000);
  console.log(await s.ev(`(()=>{try{const q=${QD};return (q.body.innerText||'').replace(/\\s+/g,' ').slice(0,260)}catch(e){return '取结果页失败'}})()`));
}

s.close();
process.exit(0);
