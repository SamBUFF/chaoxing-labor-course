# chaoxing-labor-course

> 超星学习通 / 泛雅（mooc1.chaoxing.com、mooc2-ans.chaoxing.com）课程自动化 Skill：视频按平台允许倍速**真播到达标**、PPT/PDF 文档任务点走完阅读流程、章节测验作答、空白小节补访问，最终让整门课的目录**全部显示绿勾**。

这是一个 **Agent Skill**（`SKILL.md` + Node 驱动脚本），供支持 skill 机制的 AI Agent（如 [WorkBuddy](https://www.workbuddy.cn)）加载后按流程操作浏览器，不是开箱即用的独立程序。

---

## 它解决什么问题

学习通的课程目录里，一个"绿勾"要同时满足三件事，缺一不可：

1. 小节里的**视频任务点**播到平台口径的完成线（观看时长 ≥ 总时长 90%）
2. 小节里的 **PPT / PDF 文档任务点**走完阅读流程
3. **没有任务点的小节**也要被打开过一次 —— 否则永远显示橙色 `0`

本 Skill 把这三件事拆成可重放的命令，并用一次 `verify` 读出「已完成任务点 N/M + 绿勾数」作为唯一可信的进度真值。

| 能力 | 命令 | 说明 |
|---|---|---|
| 摸清结构 | `drive.mjs init <课程URL>` | 解析 `courseid/clazzid/cpi/enc`，补齐 §章节跳转所需的 `oldenc` |
| 读进度 | `drive.mjs verify` | N/M + 绿勾 + 待完成清单，输出 `todo.json` |
| 学章节 | `drive.mjs run` | 逐小节处理多卡片、多任务点，支持 `--only` / `--max` / `--pass` |
| 补绿勾 | `drive.mjs visit` | 打开无任务点的小节 |
| 章节测验 | `quizcard.mjs open/dump/shot/fill/submit` | 三层 iframe 结构定位，题面混淆只能截图视觉读题 |
| 作业列表 | `chaoxing.mjs works/quiz/fill/submit/review/redo` | 交卷后用 `review` 抓官方标准答案核对 |

---

## 设计上的几条硬边界

这些不是"建议"，是脚本本身不会越过的线：

- **视频只真播。** 不跳进度、不伪造上报。倍速上限就是平台给的 2x，设 4x 会被播放器立刻重置为 1x 并暂停；直接打进度上报接口会进「学习异常」记录，代价远大于省下的时间。
- **默认不提交。** `submit` 必须显式带 `--yes`。
- **不编造答案。** 作业交完一定用 `review` 拉官方标准答案核对，允许重做时才重做，且重做前必须已拿到答案键。
- **不覆盖已有成绩。** 重做会覆盖上次成绩，接近满分或用户没要求提分时不做。

---

## 安装

```bash
git clone https://github.com/SamBUFF/chaoxing-labor-course.git \
  "$HOME/.workbuddy/skills/chaoxing-labor-course"
```

也可以在 WorkBuddy 里直接用仓库 URL 安装本 Skill。

### 依赖

| 依赖 | 说明 |
|---|---|
| **Node.js 22+** | 脚本用了原生 WebSocket 直连 CDP，不依赖 puppeteer |
| **web-access** Skill | 复用用户已登录的 Chrome/Edge 调试端口，先跑它的 `check-deps.mjs` 让浏览器带端口启动 |
| 已登录学习通的浏览器 | 脚本自建后台工作 tab，不碰用户已有 tab |

```bash
# 先确认 CDP 可用（路径按自己的 web-access 安装位置调整）
node "$HOME/.workbuddy/skills/web-access/scripts/check-deps.mjs"
```

> Windows 上 CDP proxy 会随发起它的 shell 一起被回收。若遇到 `upstream connect failed ... 10061`，用后台常驻方式起：
> `node ".../check-deps.mjs"; echo KEEPER; node -e "setInterval(function(){},60000)"`

---

## 快速开始

```bash
SK="$HOME/.workbuddy/skills/chaoxing-labor-course"

# 1. 解析课程 + 看进度（只读）
node "$SK/scripts/drive.mjs" init "https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?..."
node "$SK/scripts/drive.mjs" verify

# 2. 学完整门课（把待完成清单先给用户确认，再开跑）
node "$SK/scripts/drive.mjs" run --max 3    # 先试探 3 个小节
node "$SK/scripts/drive.mjs" run            # 全量，默认跑 2 轮捞漏
node "$SK/scripts/drive.mjs" visit          # 补无任务点小节的绿勾

# 3. 章节测验（题面被 font-cxsecret 混淆，需截图读题）
node "$SK/scripts/quizcard.mjs" open 984632362
node "$SK/scripts/quizcard.mjs" shot 3      # → .chaoxing/q3.png
node "$SK/scripts/quizcard.mjs" fill answers.json
node "$SK/scripts/quizcard.mjs" submit --yes

# 4. 收尾核对
node "$SK/scripts/drive.mjs" verify
```

状态与产物统一写在**当前工作目录**的 `./.chaoxing/`。

---

## 目录结构

```
SKILL.md                      # Agent 读的流程主文件（含命令速查、陷阱）
references/
  chaoxing-dom.md             # 页面结构、选择器、解析失败排查
  labor-course-bank.md        # 劳动教育课已核验的答案与知识点
scripts/
  drive.mjs                   # 章节任务点主驱动（原生 CDP，自建工作 tab）
  quizcard.mjs                # 章节卡片内测验
  chaoxing.mjs                # 作业列表流程（走 web-access proxy）
  lib-cdp.mjs                 # CDP 连接与焦点模拟等通用原语
```

---

## 已知限制

- **题干与选项被混淆**：章节测验由服务端下发 `font-cxsecret` 乱码文本，`fetch` 重取原文也拿不到明文，只能截图视觉读题；多选题的 `aria-label` 是明文，可用于交叉校验。
- 播放器回写完成标记有延迟，单条播完可能显示"待目录核对"，以 `verify` 的 N/M 为准。
- 平台改版会导致选择器失效，先读 `references/chaoxing-dom.md` 再动代码。

---

## 免责声明

本项目仅供**个人学习效率**用途。使用前请确认符合所在学校的规章制度与平台服务条款；自动化操作可能被平台判定为异常行为，由此产生的账号、成绩与纪律后果由使用者自行承担。

## License

[MIT](LICENSE) © 2026 SamBUFF
