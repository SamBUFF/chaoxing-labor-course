# chaoxing-labor-course

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white)](#安装)

> 超星学习通 / 泛雅课程自动化：视频真播到达标、PPT/PDF 任务点走阅读流程、章节测验作答、空白小节补访问，最终让整门课目录**全部显示绿勾**。

**Agent Skill**，供 [WorkBuddy](https://www.workbuddy.cn) 这类支持 skill 的 Agent 加载，不是开箱即用的程序。

---

## 安装

**1. 前置 skill（必需）：`web-access`** —— 本 skill 不碰密码，复用你已登录浏览器的调试端口。先跑：

```bash
node "$HOME/.workbuddy/skills/web-access/scripts/check-deps.mjs"
# 要看到 browser: ok
```

**2. 装本 skill：**

```bash
git clone https://github.com/SamBUFF/chaoxing-labor-course.git \
  "$HOME/.workbuddy/skills/chaoxing-labor-course"
```

**3. 起中继（建议）：** `node "$HOME/.workbuddy/skills/chaoxing-labor-course/scripts/relay.mjs"` 后台常驻。不起则每条命令都弹「允许调试」。

---

## 复制这段话给 Agent

```text
用 chaoxing-labor-course 完成这门课：
<粘贴课程页链接>

章节视频、PPT/PDF 文档任务点、章节测验、课后作业都做掉，
做完报「任务点 N/M 前后对比」「每个测验的分数」「每题答案 + 一句考点」。
```

链接取浏览器地址栏里 `mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?...` 的完整地址。改一个词就能换玩法：

| 改成 | 效果 |
|---|---|
| 「完成」→「学完」 | 只填答案，**不交卷** |
| 「完成这门课」→「把视频和文档学完，章节测验不要动」 | 只刷任务点 |
| 「完成这门课」→「只读看一下进度，先别开跑」 | 只列待办清单 |
| 「完成这门课」→「核查有没有漏掉的作业和考试」 | 收尾核查 |

---

## 命令

```bash
SK="$HOME/.workbuddy/skills/chaoxing-labor-course"
node "$SK/scripts/drive.mjs" init "<课程URL>"   # 解析参数
node "$SK/scripts/drive.mjs" verify             # 任务点 N/M + 待办清单（唯一进度真值）
node "$SK/scripts/drive.mjs" run                # 学章节（视频/文档，--only/--max/--pass）
node "$SK/scripts/drive.mjs" visit              # 补空白小节的绿勾
node "$SK/scripts/quizcard.mjs" open <kid>      # 打开章节测验
node "$SK/scripts/quizcard.mjs" shot all        # 逐题截图读题（题面被混淆）
node "$SK/scripts/quizcard.mjs" fill ans.json   # 填涂 {"1":"D","6":"AC","9":"对"}
node "$SK/scripts/quizcard.mjs" filltext 1 a.txt# 简答题写文本
node "$SK/scripts/quizcard.mjs" submit --yes    # 提交（不可逆）
node "$SK/scripts/course-todo.mjs"              # 作业列表 + 考试列表
```

产物统一写在当前目录的 `./.chaoxing/`。

---

## 硬边界

1. **视频只真播。** 倍速上限 2x，设 4x 会被重置并暂停；不跳进度、不伪造上报。
2. **默认不交卷。** 只有你说「完成 / 提交」才交。
3. **不覆盖已有成绩。** 重做会覆盖上次成绩，没要求提分就不做。
4. **同一账号只开一个章节页。** 并行会被判「多终端登录」，视频直接中断，且该警告页 JS 永久挂起。
5. **章节全绿 ≠ 整门课完成。** 作业和考试是独立入口，收尾必须核查。

---

## 踩坑

| 现象 | 处理 |
|---|---|
| 日志停但进程活着，`/eval` 超时 | 多终端登录风控。把 tab 导航回课程首页，关掉并行的 tab |
| `dump` 显示 `mode:view` 但写「待完成」 | 简答题无选项可解析，**不是**已提交。`shot 1` 看有没有 UEditor，用 `filltext` |
| 结果页「待批阅」 | 简答题等教师批阅，不是没交上 |
| 页面「未就绪」 | 重跑一次同一条命令 |
| 截图题干被吸顶头挡住 | 用 `shot`，别用裸 `Page.captureScreenshot` |

---

## 免责声明

仅供**个人学习效率**用途。脚本刷课在部分院校属违规，账号、成绩与纪律后果自负。

[MIT](LICENSE) © 2026 SamBUFF
