---
name: chaoxing-labor-course
description: 用于超星学习通 / 泛雅（mooc1.chaoxing.com、mooc2-ans.chaoxing.com）课程的全流程代办：按平台允许的倍速把章节视频任务点真实学完、把 PPT/PDF 类文档任务点走完阅读流程、把章节卡片里的测验作答提交，最后让整门课程目录全部显示绿勾。触发场景：用户丢来一个 chaoxing 课程页链接并说「把这门课程的章节都学习掉（学掉的会显示绿勾）」「把这一章的资料都学完」「8.2 的章节测试做一下」「学习通作业帮我做完」「劳动教育课刷完任务点」「完成这门课程」。默认不交卷，用户明确说「完成 / 提交 / 交掉 / 做一下」才提交。
description_zh: 超星学习通课程自动化：多卡片小节逐个处理（视频真播放至完成 + PPT/PDF 任务点走阅读流程 + 章节测验作答），并补齐无任务点小节的访问，使整门课程目录全绿。适用于「视频/文档任务点 + 章节测验」结构的通识课、思政课、素养课。**必须单 tab 串行**——并行开第二个章节 tab 会触发「多终端登录」风控并把主 tab 跳到 detect 警告页（JS 永久挂起）。内置 CDP 常驻中继避免反复授权、简答题（UEditor）填写与作业/考试收尾核查。
description_en: Automate Chaoxing (Xuexitong) course completion - handle multi-card sections (play videos to 100% at the platform's max allowed speed, complete PPT/PDF document taskpoints), answer chapter quizzes (including text answers), and open empty sections so the whole course catalog turns green. Built on a self-owned CDP tab with focus emulation and a persistent local CDP relay that avoids repeated debugging permission prompts.
agent_created: true
---

# 学习通（超星）课程代学 + 作业作答

一句话流程：**起 CDP 中继 → 解析课程参数 → 摸清任务点 → 视频逐条真播到 100% / 文档走阅读流程 → 章节测验作答 → 访问空白小节补绿勾 → 核对「已完成任务点 N/M」→ 核查作业列表与考试。**

脚本分工：

| 脚本 | 适用 | 底层 |
|---|---|---|
| `scripts/relay.mjs` | CDP 常驻中继，只跟 Chrome 建一次连接 | 本地 WS 转发 |
| `scripts/drive.mjs` | 章节任务点（视频 / PPT·PDF / 全绿） | 原生 CDP，自建工作 tab |
| `scripts/quizcard.mjs` | 章节卡片内的测验 / 随堂测（含简答题） | 同上 |
| `scripts/course-todo.mjs` | 收尾核查作业列表 + 考试列表 | 同上 |
| `scripts/chaoxing.mjs` | 作业列表（`work/list`）的拉题 / 交卷 / 抓标准答案 / 重做 | web-access proxy |

## 六条硬边界

1. **视频只真播，不跳进度、不伪造上报。** 平台完成条件是「观看时长 ≥ 总时长 90%」（个别课要求 100%），倍速上限只有 **2x**（官方菜单 0.75/1/1.25/1.5/2）。设 4x 会被播放器立刻重置为 1x 并暂停。不要直接请求进度上报接口——会进「学习异常」记录，代价远大于省下的时间。
2. **默认不交卷。** `submit` 必须带 `--yes`。只有当用户明确说「完成 / 做完 / 交掉 / 提交 / 做一下」时才提交。注意：章节测验不提交就不算完成任务点，用户说「把章节学完」时它必须做。
3. **不编造答案。** 先按课程内容作答；提交后用 `result` 回读每题得分核对，有「正确答案」时 `dump` 会自动导出 `answers-correct.json`。平台允许重做时（结果页有「修改答案」入口）才重做，且重做前必须已经知道错哪题、正确答案是什么。
4. **不覆盖用户成绩。** 重做会覆盖上一次成绩；若已接近满分或用户没要求提分，不要重做。没有「修改答案」入口的测验一次定分，别硬试。
5. **「学完」= 任务点全清 + 空白小节都访问过。** 目录绿勾有两个来源：有任务点的小节要等 `icon_yiwanc`（任务点全完成）；**没有任务点的小节永远显示橙色 0，必须打开一次才变绿**。另外**章节全绿 ≠ 整门课完成**，作业列表和考试是独立入口，收尾必须核查。
6. **章节学习必须单 tab 串行，别为提速并行。**（2026-10-29 实测）同账号下并行打开两个章节页（`studentstudy?chapterId=`）会被判「多终端登录」，主 tab 被强制重定向到 `https://detect.chaoxing.com/api/monitor_temp?mes=您的账号于HH:MM在一台谷歌内核浏览器设备登入章节页面...`，正在播放的视频随之中断。**该警告页的 JS 执行会永久挂起**：`Runtime.evaluate` 无响应、proxy `/eval` 超时、curl 28，驱动表现为「日志停但进程还活着」。恢复只需 `Page.navigate` 回课程首页，不必重新登录。用「第二个 cwd + 独立 `worker-tab.txt`」能骗过脚本，**骗不过平台，等于白搭**。

## 0. 前置

依赖 **web-access** skill 的调试端口（复用用户已登录的浏览器）。先跑一次让 Chrome 带调试端口起来：

```bash
node "C:/Users/BUFF/.workbuddy/skills/web-access/scripts/check-deps.mjs"
```

> 新版驱动**不需要** proxy 常驻，也不再靠 `Page.bringToFront` 抢焦点。判定可用性只看 `check-deps` 是否报 `browser: ok`。

**再启动 CDP 常驻中继（强烈建议，尤其是要跑几十条命令时）**：

```bash
node "$SK/scripts/relay.mjs"        # 用 run_in_background 常驻，日志 .chaoxing/relay.log
```

Chrome 对**每一次**新建到调试端口的 WebSocket 都弹「允许调试」，没有中继时用户要连点几十次。中继只跟 Chrome 建一条长连接，之后所有脚本连本地 `127.0.0.1:9333`，不再触发授权。`lib-cdp.mjs` 会自动优先走中继，没起就回落直连，不用改任何调用。浏览器/工具重启后中继退出，需要重新起一次（那一次仍要点一下允许）。

**先定位实际路径**——本 skill 可能装在多套运行时里，下文统一用 `$SK`（本 skill 目录）与 `$WA`（web-access 目录）：

| 环境 | `$SK` | `$WA` |
|---|---|---|
| WorkBuddy | `C:/Users/BUFF/.workbuddy/skills/chaoxing-labor-course` | `C:/Users/BUFF/.workbuddy/skills/web-access` |
| DSH / DeepSeek Harness | `C:/Users/BUFF/.dsh/skills/chaoxing-labor-course` | `C:/Users/BUFF/.dsh/skills/web-access` |

不确定时 `ls` 一下哪条路径存在，不要凭猜。先读 `$WA/references/site-patterns/chaoxing.com.md`（URL 约定与反作弊细节）。

`$CX = "$SK/scripts/chaoxing.mjs"`。所有命令都在**工作目录**执行（状态与产物写到 `./.chaoxing/`）。

## 1. 初始化与摸清结构

```bash
node "$SK/scripts/drive.mjs" init "<用户给的课程页URL>"
```

从 URL 取 `courseid/clazzid/cpi/enc/t` 并保存原始首页地址 `home`，再在页面隐藏域补 `oldenc`（章节跳转用，**不是**地址栏那个 enc）、`workEnc`、`examEnc`，写入 `.chaoxing/state.json`；同时把自建的工作 tab id 存进 `.chaoxing/worker-tab.txt`（后续命令复用它）。

```bash
node "$SK/scripts/drive.mjs" verify   # 「已完成任务点 N/M」+ 绿勾 g/总 + 待完成小节清单 → todo.json
```

`verify` 是唯一可信的进度真值。**开工前把待完成清单列给用户确认**，别默默跑两小时。

## 2. 学章节（视频 / 文档）

```bash
node "$SK/scripts/drive.mjs" run                     # 全部待完成小节，默认跑 2 轮（第二轮捞漏）
node "$SK/scripts/drive.mjs" run --only 1234,5678     # 只跑指定 knowledgeId
node "$SK/scripts/drive.mjs" run --max 3              # 只跑前 3 个小节（试探用）
node "$SK/scripts/drive.mjs" visit                    # 把无任务点的小节逐个打开 → 补绿勾
```

要点（都已在真实课程上验证过）：

- **一个小节 = `#prev_tab` 里多个 tab**（PPT / 视频 …），**一个 tab 卡片里又可能含多个任务点**（实测一个卡里 3 个视频）。脚本用 `changeDisplayContent(i,n,kid,courseid,clazzid,'')` 逐个切换，再按 `.ans-attach-ct` 逐条处理。
- **完成标记在 `.ans-attach-ct` 的 `ans-job-finished` 上，不在 `.ans-job-icon`。** 播放器也不一定即时回写该 class，单条播完可能显示「完成标记待目录核对」——最终以 `verify` 的 N/M 为准。
- **后台保活用 `Emulation.setFocusEmulationEnabled(true)`**：让后台 tab 的 `document.visibilityState` 变成 `visible`，视频不会因窗口被遮挡而暂停，也不抢用户焦点。焦点模拟随连接断开失效，脚本每次连接都会重设。**所以只有 `run` 在跑的时候才有保活；`open/shot/fill/submit` 这类短连接命令办完事就断开，属正常现象，不是保活失效。**
- 视频：先 `muted = true` 再 `play()`（否则被自动播放策略静默拦下，readyState 卡 0）；**500ms 心跳**检测 `paused` 就再 play、`playbackRate` 不是 2 就设回 2；倍速上限 2x。
- 文档（PPT/PDF）：不读内容，直接触发页面自己遮罩的 onclick `unMaskAndFinishJob()`（等价人工点「阅读」），再用模块内 `checkJobFinish()` 校验，返回 `already` 或 `after:true` 即完成。
- 参考量级：139 个任务点（含约 40 个视频）两轮跑完约 100 分钟。用 `run_in_background` 跑，靠 `.chaoxing/study.log` 观察，不要在前台干等。
- 遇到「章节测验 / 作业」卡会被跳过并提示交给 `quizcard.mjs`。

## 3. 章节测验（卡片内）

```bash
node "$SK/scripts/quizcard.mjs" open 984632362        # 打开该小节的测验卡（自动认出「章节测试」tab）
node "$SK/scripts/quizcard.mjs" dump                  # 题号 / qid / qtype / 选项字母 / 当前答案
node "$SK/scripts/quizcard.mjs" shot all              # 整套题逐题截图 → .chaoxing/q<n>.png（也可 shot 3 只截第 3 题）
node "$SK/scripts/quizcard.mjs" fill answers.json     # {"1":"D","6":"AC","9":"true"}，判断题也可写 "对"/"错"
node "$SK/scripts/quizcard.mjs" filltext 14 a14.txt   # 第 14 题是简答题时写入文本
node "$SK/scripts/quizcard.mjs" submit --yes          # 提交并回读得分
node "$SK/scripts/quizcard.mjs" result                # 结果页全文：每题「我的答案 + 得分」
node "$SK/scripts/quizcard.mjs" modify --yes          # 有「修改答案」入口时进入重做
```

- **题干与选项被 `font-cxsecret` 混淆**：服务端下发的就是乱码文本，`fetch` 重取原文同样拿不到明文，**只能截图用视觉读题**。多选题的 `aria-label` 是明文，可用来交叉校验。
- `shot` 已自动加宽视口并避开吸顶头/左缘悬浮条；若截图仍被挡，先确认视口没被别的命令改回去。
- iframe 三层：`#iframe` → `.ans-attach-ct iframe`（`ananas/modules/work`）→ `/mooc-ans/api/work?...`（`doHomeWorkNew`）；答案真值是隐藏域 `#answer{qid}`，选项是 `li[qid][qtype]`。
- `qtype`：`0` 单选、`1` 多选、`3` 判断（判断选项 `span.num_option[data]` 为 `true`/`false`）。多选题的字母在 `span.num_option_dx[data]`。
- **简答/论述题是 UEditor 富文本**：正文在 `iframe#ueditor_0` 的 body，提交真值是同级 `textarea#answer{qid}`，`filltext` 会两边都写并触发 `sync`。`fill` 对这类题只会 skip。
- **提交确认弹窗在顶层页面**（`a.jb_btn#popok`），不在答题 iframe 里，且出现常有 3~5 秒延迟，脚本已轮询等待。
- 填完必须回读 `#answer{qid}` 全串再提交；提交后用 `result` 把「本次成绩 N 分」和每题答案一起汇报。
- 提交后的结果页是**明文**（不再混淆）。但不少课程的结果页**不显示「正确答案」**，只有「我的答案 + 得分」——错了哪题能看出来，正确答案要靠自己判断或重做一次校准。所以尽量一次做对，拿不准的先查证。
- 部分测验结果页有「修改答案」入口可重做提分；**重做会清空简答题文本，必须重新 `filltext`**。没有该入口的一次定分。
- 个别小节的「专题测验」不单独计为待办任务点，会随章节任务点一起被平台判完成（实测 7.7 / 8.8），`verify` 里没列出来就不用管。
- **简答题识别陷阱（2026-10-29 实测）**：`dump` 对**纯简答/论述题**（题干下没有 `li[qid]` 选项）会落到 `mode:view`，输出看起来像「已提交结果页」。**不是**已提交——只是这类题没有客观选项给 dump 解析。要 `shot 1` 截图确认看到 UEditor 工具栏和大空白输入框，再 `filltext` 写入。提交后状态是「**待批阅**」（需教师批阅），任务点已计入完成，**不要**因为没拿到分数就去 `modify` 重做。
- **心理实践 / 课后体验作业卡**：心理健康等课程的「X.X 心理实践」小节不是客观测验，是 1 题简答题（如「写下你的墓志铭」「怎么爱自己」）。`run` 会跳过并提示交给 quizcard——确实要这么走，按用户第一人称写 600~900 字（不要写成 AI 八股文），`filltext` 后 `submit --yes`。没有「修改答案」入口就是一次定分。


## 4. 作业列表（`work/list` 那条路）

章节卡里的测验**不等于**作业列表里的作业：列表交满分不会点亮章节任务点，反之亦然。处理作业列表时仍用 `chaoxing.mjs`（走 proxy）：

```bash
node "$CX" works                              # 列作业：workId / 标题 / 状态
node "$CX" quiz --work "3-4多选题"            # 拉题 → .chaoxing/quiz-<workId>.json
node "$CX" fill --file answers.json           # 只勾选，不提交；会回读隐藏域校验
node "$CX" submit --yes                       # 提交（自动点掉确认弹窗），回读分数
node "$CX" review                             # 抓官方标准答案 → answers-correct.json
node "$CX" redo --yes                         # 重做（覆盖上次成绩）
node "$CX" close                              # 关掉 proxy 创建的 tab
```

答题优先用课程自己的内容（`references/labor-course-bank.md` 有劳动教育课已核验的答案与知识点，`references/ideology-law-bank.md` 有思想道德与法治课已核验的答案，`references/mental-health-bank.md` 有大学生心理健康教育课已核验的答案），不要凭常识硬猜。

## 5. 收尾

```bash
node "$SK/scripts/drive.mjs" verify         # N/M 与绿勾数，必须全部清零
node "$SK/scripts/drive.mjs" visit          # 若还有橙色 0 的小节
node "$SK/scripts/course-todo.mjs"          # 作业列表 + 考试列表（独立入口，章节全绿也可能有漏）
```

`course-todo` 会点课程首页的「作业 / 考试」导航让页面自己算出带 enc 的地址（手拼容易 404 或「无效的参数」），并打印列表与完成状态；`state.json` 里的 `home/enc` 过期时重新 `init` 一次。

`visit` 会把所有「目录里还没绿勾」的小节逐个打开——**包括**那些看起来像测验但**没有任务点**的小节（实测：11.2「模块八章节测验」）。这类小节在 `verify` 的待办清单里本来就不出现，**不要**手贱再 `quizcard.mjs open` 一次当客观题做，`visit` 打开一下目录就绿了。

汇报三样东西：**任务点 N/M 前后对比**、**测验/作业最终分数**、**每题答案（附一句考点）**。用户看的是结果，不是过程日志。

## 排错速查（都是实测踩过的）

| 现象 | 原因与处理 |
|---|---|
| 每条命令都弹「允许调试」 | 没起中继。`node "$SK/scripts/relay.mjs"` 后台常驻一次即可 |
| `open` 报「测验页没加载出来」 | 内层 doHomeWorkNew 加载慢。脚本已自动重试切卡 3 次；仍失败就再跑一次 `open`，或直接 `dump` 探 |
| 截图题干被吸顶头/左缘图标挡住 | 视口太窄且横向滚动。`shot` 已内置加宽视口 + 回退滚动，别再用裸 `Page.captureScreenshot` |
| `submit` 点了没反应 / `no-dialog` | `a.click()` 在部分课程不触发 handler。脚本已改为直接调 `btnBlueSubmit()`，并轮询 `#popok`；仍不行就刷新页面重试（`reqLimit` 耗尽会提示「请刷新页面后重试」） |
| 结果页「待批阅」 | 有简答/论述题，等教师批阅，不是没交上 |
| 重做完简答题空了 | 「修改答案」会清空 UEditor 内容，重新 `filltext` 再交 |
| 视频不动、日志停在某条 | 看是不是 `run` 进程已退出；保活只存在于 `run` 存活期间 |
| **日志停但进程还活着，`/eval` 也超时** | **多终端登录风控**（见硬边界第 6 条）。先 `curl /targets` 看主 tab 是否被跳到 `detect.chaoxing.com`，是就 `Page.navigate` 回课程首页；同时关掉并行的第二个 tab |
| `dump` 显示 `mode:view` 但页面写「待完成」 | 简答题没有 `li[qid]` 给 dump 解析，不是已提交。`shot 1` 确认有 UEditor 输入框，再 `filltext` |
| `studentstudy` 报「页面未就绪」 | `#iframe` 偶发加载慢（2026-10-29 实测 9.2）。**重跑一次同一条命令**即可，不必改参数 |
| proxy `/eval` 返回 `os error 10061` | Windows 上 proxy 子进程随 shell 回收。改用 relay 直连，或读 `.chaoxing/` 下的脚本产物判断状态 |

## 命令速查

| 命令 | 作用 | 是否写操作 |
|---|---|---|
| `relay.mjs` | CDP 常驻中继，免去反复授权 | 常驻进程 |
| `drive.mjs init <url>` | 解析课程参数、建工作 tab | 开 tab |
| `drive.mjs verify` | N/M + 绿勾 + 待完成清单 | 只读 |
| `drive.mjs run [--only] [--max] [--pass]` | 逐小节完成任务点 | 产生学习记录 |
| `drive.mjs visit` | 打开无任务点小节补绿勾 | 产生访问记录 |
| `course-todo.mjs [works\|exams]` | 核查作业 / 考试列表 | 只读 |
| `quizcard.mjs open <kid>` | 打开章节测验卡 | 只读 |
| `quizcard.mjs dump` / `shot <n>\|all` | 看题 / 截图读题 | 只读 |
| `quizcard.mjs fill <json>` | 填涂并回读校验 | 改草稿 |
| `quizcard.mjs filltext <n> <file>` | 简答题写文本 | 改草稿 |
| `quizcard.mjs result` | 结果页全文与每题得分 | 只读 |
| `quizcard.mjs modify --yes` | 进入重做 | **覆盖上次成绩** |
| `quizcard.mjs submit --yes` | 提交测验 | **不可逆** |
| `chaoxing.mjs works/quiz/fill/submit/review/redo` | 作业列表流程 | 见上 |
| `chaoxing.mjs close` | 关掉 proxy 创建的 tab | — |

## 参考文件

| 文件 | 何时读 |
|---|---|
| `references/chaoxing-dom.md` | 页面结构变了 / 要改选择器 / 排查解析失败 |
| `references/labor-course-bank.md` | 答劳动教育课的测验题（已核验答案 + 知识点） |
| `references/ideology-law-bank.md` | 答思想道德与法治课的专题测验（已核验答案 + 反直觉题校准） |
| `references/mental-health-bank.md` | 答大学生心理健康教育课的章节测验（已核验 7 个测验满分答案 + 3 个简答题原文与成稿） |
| `web-access/references/site-patterns/chaoxing.com.md` | 每次开工前（平台反作弊与 URL 约定） |
