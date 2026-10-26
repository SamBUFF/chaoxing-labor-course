---
name: chaoxing-labor-course
description: 用于超星学习通 / 泛雅（mooc1.chaoxing.com、mooc2-ans.chaoxing.com）课程的全流程代办：按平台允许的倍速把章节视频任务点真实学完、把 PPT/PDF 类文档任务点走完阅读流程、把章节卡片里的测验作答提交，最后让整门课程目录全部显示绿勾。触发场景：用户丢来一个 chaoxing 课程页链接并说「把这门课程的章节都学习掉（学掉的会显示绿勾）」「把这一章的资料都学完」「8.2 的章节测试做一下」「学习通作业帮我做完」「劳动教育课刷完任务点」。默认不交卷，用户明确说「完成 / 提交 / 交掉 / 做一下」才提交。
description_zh: 超星学习通课程自动化：多卡片小节逐个处理（视频真播放至完成 + PPT/PDF 任务点走阅读流程 + 章节测验作答），并补齐无任务点小节的访问，使整门课程目录全绿。适用于「视频/文档任务点 + 章节测验」结构的通识课、思政课、素养课。
description_en: Automate Chaoxing (Xuexitong) course completion - handle multi-card sections (play videos to 100% at the platform's max allowed speed, complete PPT/PDF document taskpoints), answer chapter quizzes, and open empty sections so the whole course catalog turns green. Built on a self-owned CDP tab with focus emulation.
agent_created: true
---

# 学习通（超星）课程代学 + 作业作答

一句话流程：**解析课程参数 → 摸清任务点 → 视频逐条真播到 100% / 文档走阅读流程 → 章节测验作答 → 访问空白小节补绿勾 → 核对「已完成任务点 N/M」。**

脚本分工：

| 脚本 | 适用 | 底层 |
|---|---|---|
| `scripts/drive.mjs` | 章节任务点（视频 / PPT·PDF / 全绿） | 原生 CDP，自建工作 tab |
| `scripts/quizcard.mjs` | 章节卡片内的测验 / 随堂测 | 同上 |
| `scripts/chaoxing.mjs` | 作业列表（`work/list`）的拉题 / 交卷 / 抓标准答案 / 重做 | web-access proxy |

## 五条硬边界

1. **视频只真播，不跳进度、不伪造上报。** 平台完成条件是「观看时长 ≥ 总时长 90%」，倍速上限只有 **2x**（官方菜单 0.75/1/1.25/1.5/2）。设 4x 会被播放器立刻重置为 1x 并暂停。不要直接请求进度上报接口——会进「学习异常」记录，代价远大于省下的时间。
2. **默认不交卷。** `submit` 必须带 `--yes`。只有当用户明确说「完成 / 做完 / 交掉 / 提交 / 做一下」时才提交。注意：章节测验不提交就不算完成任务点，用户说「把章节学完」时它必须做。
3. **不编造答案。** 先按课程内容作答；作业提交后**一定**用 `review` 把官方标准答案抓下来核对。平台允许重做时（提示「前一次作答记录会被覆盖，以本次成绩为最终成绩」）才重做，且重做前必须已经拿到标准答案。
4. **不覆盖用户成绩。** 重做会覆盖上一次成绩；若已接近满分或用户没要求提分，不要重做。
5. **「学完」= 任务点全清 + 空白小节都访问过。** 目录绿勾有两个来源：有任务点的小节要等 `icon_yiwanc`（任务点全完成）；**没有任务点的小节永远显示橙色 0，必须打开一次才变绿**。用户要「全部绿勾」时两件事都要做。

## 0. 前置

依赖 **web-access** skill 的调试端口（复用用户已登录的浏览器）。先跑一次让 Chrome 带调试端口起来：

```bash
node "$HOME/.workbuddy/skills/web-access/scripts/check-deps.mjs"
```

> 新版驱动**不需要** proxy 常驻，也不再靠 `Page.bringToFront` 抢焦点。判定可用性只看 `check-deps` 是否报 `browser: ok`。

**先定位实际路径**——本 skill 可能装在多套运行时里，下文统一用 `$SK`（本 skill 目录）与 `$WA`（web-access 目录）：

| 环境 | `$SK` | `$WA` |
|---|---|---|
| WorkBuddy | `$HOME/.workbuddy/skills/chaoxing-labor-course` | `$HOME/.workbuddy/skills/web-access` |
| DSH / DeepSeek Harness | `$HOME/.dsh/skills/chaoxing-labor-course` | `$HOME/.dsh/skills/web-access` |

不确定时 `ls` 一下哪条路径存在，不要凭猜。先读 `$WA/references/site-patterns/chaoxing.com.md`（URL 约定与反作弊细节）。

`$CX = "$SK/scripts/chaoxing.mjs"`。所有命令都在**工作目录**执行（状态与产物写到 `./.chaoxing/`）。

## 1. 初始化与摸清结构

```bash
node "$SK/scripts/drive.mjs" init "<用户给的课程页URL>"
```

从 URL 取 `courseid/clazzid/cpi/enc`，再在页面隐藏域补 `oldenc`（章节跳转用，**不是**地址栏那个 enc）、`workEnc`、`examEnc`，写入 `.chaoxing/state.json`；同时把自建的工作 tab id 存进 `.chaoxing/worker-tab.txt`（后续命令复用它）。

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
- **后台保活用 `Emulation.setFocusEmulationEnabled(true)`**：让后台 tab 的 `document.visibilityState` 变成 `visible`，视频不会因窗口被遮挡而暂停，也不抢用户焦点。这比 `Page.bringToFront` 稳（后者要抢焦点，且 Chrome 窗口被完全遮挡时照样判 hidden）。焦点模拟随连接断开失效，脚本每次连接都会重设。
- 视频：先 `muted = true` 再 `play()`（否则被自动播放策略静默拦下，readyState 卡 0）；**500ms 心跳**检测 `paused` 就再 play、`playbackRate` 不是 2 就设回 2；倍速上限 2x。
- 文档（PPT/PDF）：不读内容，直接触发页面自己遮罩的 onclick `unMaskAndFinishJob()`（等价人工点「阅读」），再用模块内 `checkJobFinish()` 校验，返回 `already` 或 `after:true` 即完成。
- 10 个 10~14 分钟的视频，2x 下约 1 小时。用 `run_in_background` 跑，靠 `.chaoxing/study.log` 观察，不要在前台干等。
- 遇到「章节测验 / 作业」卡会被跳过并提示交给 `quizcard.mjs`。

## 3. 章节测验（卡片内）

```bash
node "$SK/scripts/quizcard.mjs" open 984632362        # 打开该小节的测验卡（自动认出「章节测试」tab）
node "$SK/scripts/quizcard.mjs" dump                  # 题号 / qid / qtype / 选项字母 / 当前答案
node "$SK/scripts/quizcard.mjs" shot 3                # 第 3 题截图 → .chaoxing/q3.png（读题用）
node "$SK/scripts/quizcard.mjs" fill answers.json     # {"1":"D","6":"AC","9":"true"}
node "$SK/scripts/quizcard.mjs" submit --yes          # 提交并回读得分
```

- **题干与选项被 `font-cxsecret` 混淆**：服务端下发的就是乱码文本，`fetch` 重取原文同样拿不到明文，**只能截图用视觉读题**。多选题的 `aria-label` 是明文，可用来交叉校验。
- iframe 三层：`#iframe` → `.ans-attach-ct iframe`（`ananas/modules/work`）→ `/mooc-ans/api/work?...`（`doHomeWorkNew`）；答案真值是隐藏域 `#answer{qid}`，选项是 `li[qid][qtype]`。
- `qtype`：`0` 单选、`1` 多选、`3` 判断（判断选项 `span.num_option[data]` 为 `true`/`false`）。多选题的字母在 `span.num_option_dx[data]`。
- **提交确认弹窗在顶层页面**（`a.jb_btn`，文本「提交」），不在答题 iframe 里。
- 填完必须回读 `#answer{qid}` 全串再提交；提交后把「本次成绩 N 分」和每题答案一起汇报。
- 提交后的结果页是**明文**（不再混淆），`dump` 会自动切到 view 模式回「我的答案 + 得分」。但不少课程的结果页**不显示「正确答案」**，别指望靠它拿到答案键——所以要一次做对：拿不准的题先查证（如 ICIO 的 I 是 Instruction 而非 Input）。

## 4. 作业列表（`work/list` 那条路）

章节卡里的测验**不等于**作业列表里的作业：列表交满分不会点亮章节任务点，反之亦然。处理作业列表时仍用 `chaoxing.mjs`（走 proxy）：

```bash
node "$CX" works                              # 列作业：workId / 标题 / 状态
node "$CX" quiz --work "3-4多选题"            # 拉题 → .chaoxing/quiz-<workId>.json
node "$CX" fill --file answers.json           # 只勾选，不提交；会回读隐藏域校验
node "$CX" submit --yes                       # 提交（自动点掉确认弹窗），回读分数
node "$CX" review                             # 抓官方标准答案 → answers-correct.json
node "$CX" redo --yes                         # 重做（覆盖上次成绩）
node "$CX" close                              # 关掉脚本创建的 tab
```

答题优先用课程自己的内容（`references/labor-course-bank.md` 有劳动教育课已核验的答案与知识点），不要凭常识硬猜。

## 5. 收尾

```bash
node "$SK/scripts/drive.mjs" verify    # N/M 与绿勾数
node "$SK/scripts/drive.mjs" visit     # 若还有橙色 0 的小节
```

汇报三样东西：**任务点 N/M 前后对比**、**测验/作业最终分数**、**每题答案（附一句考点）**。用户看的是结果，不是过程日志。

## 命令速查

| 命令 | 作用 | 是否写操作 |
|---|---|---|
| `drive.mjs init <url>` | 解析课程参数、建工作 tab | 开 tab |
| `drive.mjs verify` | N/M + 绿勾 + 待完成清单 | 只读 |
| `drive.mjs run [--only] [--max] [--pass]` | 逐小节完成任务点 | 产生学习记录 |
| `drive.mjs visit` | 打开无任务点小节补绿勾 | 产生访问记录 |
| `quizcard.mjs open <kid>` | 打开章节测验卡 | 只读 |
| `quizcard.mjs dump` / `shot <n>` | 看题 / 截图读题 | 只读 |
| `quizcard.mjs fill <json>` | 填涂并回读校验 | 改草稿 |
| `quizcard.mjs submit --yes` | 提交测验 | **不可逆** |
| `chaoxing.mjs works/quiz/fill/submit/review/redo` | 作业列表流程 | 见上 |
| `chaoxing.mjs close` | 关掉 proxy 创建的 tab | — |

## 参考文件

| 文件 | 何时读 |
|---|---|
| `references/chaoxing-dom.md` | 页面结构变了 / 要改选择器 / 排查解析失败 |
| `references/labor-course-bank.md` | 答劳动教育课的测验题（已核验答案 + 知识点） |
| `web-access/references/site-patterns/chaoxing.com.md` | 每次开工前（平台反作弊与 URL 约定） |
