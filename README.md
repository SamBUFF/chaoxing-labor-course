# chaoxing-labor-course

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white)](#安装)
[![Agent Skill](https://img.shields.io/badge/Agent-Skill-8b5cf6)](https://www.workbuddy.cn)
[![platform](https://img.shields.io/badge/platform-%E8%B6%85%E6%98%9F%E5%AD%A6%E4%B9%A0%E9%80%9A%20%2F%20%E6%B3%9B%E9%9B%85-ff6a00)](https://mooc1.chaoxing.com)

<p align="center">
  <a href="#安装"><strong>安装</strong></a> &nbsp;·&nbsp;
  <a href="#复制这段话给-agent"><strong>怎么用</strong></a> &nbsp;·&nbsp;
  <a href="#硬边界"><strong>硬边界</strong></a> &nbsp;·&nbsp;
  <a href="#快速开始"><strong>命令</strong></a> &nbsp;·&nbsp;
  <a href="#踩过的坑"><strong>踩坑</strong></a> &nbsp;·&nbsp;
  <a href="#已知限制"><strong>限制</strong></a>
</p>

> 超星学习通 / 泛雅（`mooc1.chaoxing.com`、`mooc2-ans.chaoxing.com`）课程自动化 Skill：视频按平台允许的倍速**真播到达标**、PPT/PDF 文档任务点走完阅读流程、章节测验作答、空白小节补访问，最终让整门课的目录**全部显示绿勾**。

这是一个 **Agent Skill**（`SKILL.md` + Node 驱动脚本），供支持 skill 机制的 AI Agent（如 [WorkBuddy](https://www.workbuddy.cn)）加载后按流程操作浏览器，**不是开箱即用的独立程序**。

---

## ⚠️ 使用前必读

- 只用**你自己的**账号，在**你自己的**课程里操作。
- 部分院校把「脚本刷课」认定为**违规**，会清空学习记录甚至处分。**风险自负。**
- 脚本**不跳进度、不伪造上报**。倍速上限就是平台给的 2x，想更快只能熬时间。
- **同一账号同一时间只开一个章节页。** 并行会被判「多终端登录」，正在播的视频直接中断（见[硬边界](#硬边界)第 5 条）。
- 主观题（课后体验作业）需要**你改成自己的经历**再用。平台有大雅相似度分析。

---

## 安装

### 第 1 步：前置 skill —— 先装 web-access

本 Skill **不能单独工作**。它不接管账号密码，而是复用你**已经登录**的 Chrome / Edge 的调试端口 —— 提供这个能力的是 **`web-access`** Skill。

| 前置 | 是否必需 | 作用 |
|---|---|---|
| **[web-access](https://www.workbuddy.cn)** Skill | **必需** | 让浏览器带调试端口运行，并代理 CDP 调用；本 Skill 全部脚本都建立在它之上 |
| Chrome 或 Edge | **必需** | 脚本自建后台工作 tab，不碰你已有的 tab |
| 该浏览器里**已登录**学习通 | **必需** | 登录态就是凭据，脚本不碰密码 |
| Node.js 22+ | **必需** | 原生 WebSocket 直连 CDP，不依赖 puppeteer |

装好 `web-access` 后，先跑一次确认环境可用：

```bash
node "$HOME/.workbuddy/skills/web-access/scripts/check-deps.mjs"
# 期望：node: ok / browser: ok (Chrome, port 9222) / proxy: ready
```

看到 `browser: ok` 才继续。报错就按它自己的提示处理（多半是浏览器没带调试端口启动）。

### 第 2 步：装本 Skill

```bash
git clone https://github.com/SamBUFF/chaoxing-labor-course.git \
  "$HOME/.workbuddy/skills/chaoxing-labor-course"
```

也可以在 WorkBuddy 里直接用仓库 URL 安装。

### 第 3 步：起中继（强烈建议）

```bash
node "$HOME/.workbuddy/skills/chaoxing-labor-course/scripts/relay.mjs"
```

用**后台常驻**方式跑，日志写到 `./.chaoxing/relay.log`。不起也能用，但每条命令都会弹一次「允许调试」，几十条命令要手点几十次。

`lib-cdp.mjs` 的连接顺序是 `CX_CDP_WS` 环境变量 → 本地中继 `ws://127.0.0.1:9333` → 直连 Chrome。中继没起时自动回落直连，起了之后所有脚本自动走中继，无需改任何调用。浏览器 / 工具重启后中继会退出，重新起一次即可。

> Windows 上 CDP proxy 会随发起它的 shell 一起被回收。若遇到 `upstream connect failed ... 10061`，用后台常驻方式起：
> `node ".../check-deps.mjs"; echo KEEPER; node -e "setInterval(function(){},60000)"`

---

## 复制这段话给 Agent

装好上面三步后，**把下面任意一段连同你的课程链接一起发给 Agent 就行**。链接就是浏览器地址栏里那个 `mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?...` 的完整地址。

### ① 整门课做完（视频 + 文档 + 测验 + 作业）

```text
用 chaoxing-labor-course 这个 skill 完成这门课：
<粘贴课程页链接>

章节视频、PPT/PDF 文档任务点、章节测验、课后体验作业都一起做掉，
做完把「任务点 N/M 前后对比」「每个测验的分数」「每题答案 + 一句考点」报给我。
```

> 出现「**完成**」这个词，Agent 才会提交测验（默认只填不交）。想自己按交卷键的话，把它换成「学完」。

### ② 只刷视频和文档，测验我自己做

```text
用 chaoxing-labor-course 把这门课的视频和文档任务点学完，章节测验先不要动：
<粘贴课程页链接>
```

### ③ 只做章节测验

```text
用 chaoxing-labor-course 把这几节的章节测验做一下，题面是混淆的，先截图读题再作答：
<粘贴课程页链接>
节号：2.6、3.6、4.6
```

### ④ 收尾核查（怕漏交作业 / 考试）

```text
用 chaoxing-labor-course 核查这门课还有没有漏掉的作业和考试，章节绿勾是否齐了：
<粘贴课程页链接>
```

### ⑤ 先看看还剩多少，不动手

```text
用 chaoxing-labor-course 只读模式看一下这门课的进度，列出待完成清单，先别开跑：
<粘贴课程页链接>
```

---

## 它解决什么问题

学习通目录里的一个「绿勾」要同时满足三件事，缺一不可：

1. 小节里的**视频任务点**播到平台口径的完成线（观看时长 ≥ 总时长 90%，个别课要求 100%）
2. 小节里的 **PPT / PDF 文档任务点**走完阅读流程
3. **没有任务点的小节**也要被打开过一次 —— 否则永远显示橙色 `0`

本 Skill 把这三件事拆成可重放的命令，并用一次 `verify` 读出「已完成任务点 N/M + 绿勾数」作为**唯一可信的进度真值**。

| 能力 | 命令 | 说明 |
|---|---|---|
| 免反复授权 | `relay.mjs` | CDP 常驻中继：只跟 Chrome 建一条连接，脚本统一连本地 `:9333` |
| 摸清结构 | `drive.mjs init <课程URL>` | 解析 `courseid/clazzid/cpi/enc/t` 并存原始首页，补齐章节跳转所需的 `oldenc` |
| 读进度 | `drive.mjs verify` | N/M + 绿勾 + 待完成清单，输出 `todo.json` |
| 学章节 | `drive.mjs run` | 逐小节处理多卡片、多任务点，支持 `--only` / `--max` / `--pass` |
| 补绿勾 | `drive.mjs visit` | 打开无任务点的小节 |
| 章节测验 | `quizcard.mjs` | 三层 iframe 定位；题面混淆只能截图视觉读题；支持 UEditor 简答题与重做 |
| 收尾核查 | `course-todo.mjs` | 作业列表 + 考试列表（独立入口，章节全绿也可能漏交） |
| 作业列表 | `chaoxing.mjs` | `works/quiz/fill/submit/review/redo`，交卷后用 `review` 抓官方标准答案核对 |

### 适合 / 不适合

| 适合 | 不适合 |
|---|---|
| 「视频 + 文档 + 章节测验」结构的通识课、思政课、素养课 | 需要真人出镜打卡、签到、直播的课 |
| 目录有明确任务点计数的课 | 纯讨论区 / 互评类作业 |
| 章节测验是客观题 + 1~2 道简答题 | 整卷型考试（用 [yiban-exam](https://github.com/SamBUFF/yiban-exam)） |

### 已验证的课程

| 课程 | 规模 | 结果 |
|---|---|---|
| 劳动教育 | 139 个任务点（约 40 个视频） | 139/139，两轮约 100 分钟 |
| 思想道德与法治（2026 秋·第 11 期） | 章节专题测验 | 客观题全对，7.7 / 8.8 专题测验随章节判完成 |
| 大学生心理健康教育 | 47 个任务点 / 60 个目录小节 | 47/47 + 绿勾 60/60，7 个测验全 100 分，3 篇课后体验作业 |

---

## 硬边界

这些不是「建议」，是脚本本身不会越过的线：

1. **视频只真播。** 不跳进度、不伪造上报。倍速上限就是平台给的 2x，设 4x 会被播放器立刻重置为 1x 并暂停；直接打进度上报接口会进「学习异常」记录，代价远大于省下的时间。
2. **默认不提交。** `submit` 必须显式带 `--yes`。只有你明确说「完成 / 做完 / 交掉 / 提交 / 做一下」时才交卷。
3. **不编造答案。** 先按课程内容作答；交完用 `review` 拉官方标准答案核对，允许重做时才重做，且重做前必须已拿到答案键。
4. **不覆盖已有成绩。** 重做会覆盖上次成绩，接近满分或你没要求提分时不做。
5. **章节学习必须单 tab 串行。** 同一账号下并行打开两个章节页会被判「多终端登录」，主 tab 被强制重定向到 `detect.chaoxing.com` 警告页，视频随之中断；**该警告页的 JS 执行会永久挂起**（`Runtime.evaluate` 无响应，表现为「日志停但进程还活着」）。恢复只需把 tab 导航回课程首页。想靠「第二个工作目录 + 独立 `worker-tab.txt`」骗过脚本也没用 —— 骗得过脚本，骗不过平台。
6. **「学完」= 任务点全清 + 空白小节都访问过。** 章节全绿也**不等于**整门课完成，作业列表和考试是独立入口，收尾必须核查。

---

## 快速开始

```bash
SK="$HOME/.workbuddy/skills/chaoxing-labor-course"

# 1. 解析课程 + 看进度（只读，不动任何东西）
node "$SK/scripts/drive.mjs" init "https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?..."
node "$SK/scripts/drive.mjs" verify

# 2. 学章节（先把待完成清单给人确认，再开跑）
node "$SK/scripts/drive.mjs" run --max 3    # 先试探 3 个小节
node "$SK/scripts/drive.mjs" run            # 全量，默认跑 2 轮捞漏
node "$SK/scripts/drive.mjs" visit          # 补无任务点小节的绿勾

# 3. 章节测验（题面被 font-cxsecret 混淆，必须截图读题）
node "$SK/scripts/quizcard.mjs" open 984632362
node "$SK/scripts/quizcard.mjs" shot all                    # 逐题截图 → .chaoxing/q1.png ...
node "$SK/scripts/quizcard.mjs" fill answers.json           # {"1":"D","6":"AC","9":"对"}
node "$SK/scripts/quizcard.mjs" filltext 14 a14.txt         # 第 14 题是简答题时写文本
node "$SK/scripts/quizcard.mjs" submit --yes
node "$SK/scripts/quizcard.mjs" result                      # 每题「我的答案 + 得分」
node "$SK/scripts/quizcard.mjs" modify --yes                # 有「修改答案」入口时重做

# 4. 收尾核对（章节全绿 ≠ 整门课完成）
node "$SK/scripts/drive.mjs" verify
node "$SK/scripts/drive.mjs" visit
node "$SK/scripts/course-todo.mjs"          # 作业列表 + 考试列表
```

状态与产物统一写在**当前工作目录**的 `./.chaoxing/`。

---

## 目录结构

```text
SKILL.md                      # Agent 读的流程主文件（含命令速查、排错速查、陷阱）
references/
  chaoxing-dom.md             # 页面结构、选择器、解析失败排查
  labor-course-bank.md        # 劳动教育课已核验的答案与知识点
  ideology-law-bank.md        # 思想道德与法治课已核验的答案（含反直觉题校准）
  mental-health-bank.md       # 大学生心理健康教育：7 个测验满分答案 + 3 篇作业成稿要点
scripts/
  relay.mjs                   # CDP 常驻中继（免去反复的「允许调试」授权）
  drive.mjs                   # 章节任务点主驱动（原生 CDP，自建工作 tab）
  quizcard.mjs                # 章节卡片内测验（含简答题 / 重做 / 结果回读）
  course-todo.mjs             # 收尾核查：作业列表 + 考试列表
  chaoxing.mjs                # 作业列表流程（走 web-access proxy）
  lib-cdp.mjs                 # CDP 连接、中继回落、焦点模拟等通用原语
```

---

## 踩过的坑

| 现象 | 原因与处理 |
|---|---|
| 日志停住但进程还活着，`/eval` 也超时 | **多终端登录风控**。先 `curl /targets` 看主 tab 是否被跳到 `detect.chaoxing.com`，是就把 tab 导航回课程首页，并关掉并行的第二个 tab |
| `dump` 显示 `mode:view` 但页面写「待完成」 | 纯简答题没有 `li[qid]` 可解析，**不是**已提交。`shot 1` 确认有 UEditor 输入框，再用 `filltext` |
| 结果页「待批阅」 | 有简答题，等教师批阅，不是没交上 |
| 重做完简答题空了 | 「修改答案」会清空 UEditor 内容，必须重新 `filltext` 再交 |
| `studentstudy` 报「页面未就绪」 | `#iframe` 偶发加载慢，**重跑一次同一条命令**即可 |
| 每条命令都弹「允许调试」 | 没起中继，见[第 3 步](#第-3-步起中继强烈建议) |
| 截图题干被吸顶头挡住 | `shot` 已内置加宽视口 + 回退滚动，别用裸 `Page.captureScreenshot` |
| `submit` 点了没反应 | 脚本已改调 `btnBlueSubmit()` 并轮询 `#popok`；仍不行就刷新页面（`reqLimit` 耗尽会提示） |
| 视频不动 | 看 `run` 进程是否已退出，保活只存在于 `run` 存活期间 |

---

## 已知限制

- **题干与选项被混淆**：章节测验由服务端下发 `font-cxsecret` 乱码文本，`fetch` 重取原文也拿不到明文，只能截图视觉读题；多选题的 `aria-label` 是明文，可用于交叉校验。
- **保活只在 `run` 存活期间存在**：`Emulation.setFocusEmulationEnabled` 挂在 CDP 会话上，`open/shot/fill/submit` 这类短连接命令办完就断开、焦点模拟随之释放，属正常现象。真正防暂停的是 `run` 内部的 500ms 心跳。
- 播放器回写完成标记有延迟，单条播完可能显示「待目录核对」，以 `verify` 的 N/M 为准。
- **「X.X 心理实践」这类小节不是客观题**，是 1 题课后体验作业（简答题），`run` 会跳过并提示交给 `quizcard.mjs` —— 这是预期行为，不是漏跑。
- 平台改版会导致选择器失效，先读 `references/chaoxing-dom.md` 再动代码。

---

## 更新记录

| 日期 | 内容 |
|---|---|
| 2026-10-29 | 新增「单 tab 串行」硬边界（多终端登录风控）；补简答题识别陷阱与课后体验作业流程；新增心理健康课题库 |
| 2026-10-27 | 中继免反复授权；简答题 / 重做 / 收尾核查 |
| 2026-10-19 | 首个可用版本：视频、文档、章节测验、补绿勾 |

---

## 免责声明

本项目仅供**个人学习效率**用途。使用前请确认符合所在学校的规章制度与平台服务条款；自动化操作可能被平台判定为异常行为，由此产生的账号、成绩与纪律后果由使用者自行承担。

## License

[MIT](LICENSE) © 2026 SamBUFF
