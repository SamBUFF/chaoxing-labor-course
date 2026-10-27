# 超星学习通 DOM / URL 参考（2026-10 实测）

## URL 结构

| 用途 | 地址 |
|---|---|
| 课程首页 | `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=&clazzid=&cpi=&enc=&v=2&hideHead=0` |
| 章节目录 | `.../mooc2-ans/mycourse/studentcourse?courseid=&clazzid=&cpi=&ut=s&stuenc={enc}` |
| 小节学习 | `https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId={kid}&courseId=&clazzid=&cpi=&enc={oldenc}&mooc2=1&hidetype=0&fanyaVersion=0` |
| 知识点卡片 | `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=&courseid=&knowledgeid={kid}&num=0&ut=s&cpi=&mooc2=1` |
| 视频模块 | `https://mooc1.chaoxing.com/ananas/modules/video/index.html` |
| 文档模块（PPT/PDF） | `https://mooc1.chaoxing.com/ananas/modules/pdf/index.html` |
| 作业卡模块 | `https://mooc1.chaoxing.com/ananas/modules/work/index.html` |
| 作业列表 | `https://mooc1.chaoxing.com/mooc2/work/list?courseId=&classId=&cpi=&ut=s&stuenc=&enc={workEnc}` |
| 作答（作业列表） | `https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?...&workId=&answerId=0&enc=`（交卷后 302 到 `/work/prompt`） |
| 作答（章节卡 / doHomeWorkNew） | `.../mooc-ans/work/doHomeWorkNew?courseId=&workAnswerId=&workId=&api=1&knowledgeid=&...` |
| 详情（含正确答案） | `.../mooc-ans/mooc2/work/view?courseId=&classId=&cpi=&workId=&answerId=&enc=` |

`enc` 有三个，别混：

- 地址栏 `enc`：课程页 / 作业列表用
- `#oldenc`：**章节跳转（studentstudy）用**
- `#workEnc` / `#examEnc`：作业 / 考试用

## 小节结构：多卡片 × 多任务点

一个小节的学生学习页里：

```
studentstudy（父页）
├─ #prev_tab li*            ← 附件卡片 tab，onclick=changeDisplayContent(i,n,kid,courseid,clazzid,'')
└─ #iframe                  ← 当前卡片（knowledge/cards）
     └─ .ans-attach-ct*     ← 一个卡片里的任务点，可能 1 个也可能 3 个（实测 3 个视频同卡）
          ├─ iframe[src*=ananas/modules/{video|pdf|doc|audio|work}]
          ├─ iframe[objectid][jobid]   ← 是任务点才带 jobid
          └─ .ans-job-icon             ← 只是“完成条件”提示气泡
```

- 只有 `#prev_tab li[title]` 里的卡片才会加载；切卡用 `changeDisplayContent(i, n, 'kid','courseid','clazzid','')`。
- `#prev_tab li` 的 `title` 常是 `PPT` / `视频` / `章节测试`，也可能是附件名。

## 关键选择器

| 对象 | 选择器 |
|---|---|
| 卡片 tab | `#prev_tab li`（`title` 为卡片名） |
| 卡片内容 iframe | `#iframe`（src 含 `knowledge/cards`） |
| 任务点容器 | `.ans-attach-ct`，**完成时为 `ans-attach-ct ... ans-job-finished`** |
| 完成条件提示 | `.ans-job-icon`（含 `ans-job-video` 等类型类 + 文案） |
| 视频 iframe / 播放器 | `iframe[src*=ananas/modules/video]` / `.video-js`（`el.player`） |
| 文档 iframe | `iframe[src*=ananas/modules/pdf]`，全局函数 `unMaskAndFinishJob()` / `checkJobFinish()` |
| 章节条目 | `.chapter_item[id=cur{kid}]` |
| 章节条目-任务区 | `.catalog_task`：绿勾为 `.catalog_state.icon_yiwanc`，未完成是 `.catalog_jindu > .catalog_points_yi`（剩余任务点数，`0` 也可能只是「本小节无任务点」） |
| 总进度 | 页面文本 `已完成任务点: N/M` |
| 题目容器（doHomeWorkNew） | `.TiMu`（顺序=题号），`li[qid][qtype]` |
| 选项 | 单选 `span.num_option[data]`；多选 `span.num_option_dx[data]`；判断 `data=true/false` |
| 答案真值 | 隐藏域 `#answer{qid}`（单选 `D`、多选 `AC`、判断 `true/false`） |
| 交卷按钮 | `a.btnSubmit.workBtnIndex`（文本「提交」） |
| 交卷确认弹窗 | **顶层页面**的 `a.jb_btn`（文本「提交」），不在答题 iframe 内 |
| 作业列表项 | `li[data="...workId=..."]`，标题 `.overHidden2.fl`，状态 `.status.fl` |
| 作业详情题 | `.questionLi`，选项 `ul.mark_letter > li`，正确答案正则 `正确答案[：:]?\s*([A-Za-z]+)` |
| 重做 | 页面头部 `a.redo`；弹窗确认键 `a.jb_btn` |

## 坑

1. **父页面读不到某些 iframe 的 contentDocument**（返回 `null` 且不抛错）。`#iframe` 与内层模块帧通常是同源可读的；读不到就导航进 iframe 的 src，或从同源 tab 用 `fetch()` 拉 HTML 再 `DOMParser` 解析。
2. **视频必须 muted 才能起播**，否则 `play()` 静默 reject、`readyState` 停 0、`duration` 为 `NaN`。
3. **`preload="none"`**：未播放时没有元数据；时长可从 iframe 的 `data` 属性 JSON 或 `attDuration` 拿。
4. **播放器会自己暂停**（周期性 + 切后台时），必须 500ms 心跳。
5. **`Page.bringToFront` 不是唯一解**：`Emulation.setFocusEmulationEnabled(true)` 就能让后台 tab 的 `document.visibilityState === 'visible'`，播放不再因窗口被遮挡而停（2026-10 实测，优于抢焦点；随 CDP 连接断开失效，需重设）。
6. **4x 会被重置**为 1x 并立即暂停（反作弊）。2x 是官方支持的上限。
7. 首次进入视频 iframe 可能有「写笔记 / 知道了」引导浮层，先点掉再点播放。
8. 作业详情页与作答页**不是同一套 DOM**：前者无 `#answer{qid}`，选项在 `ul.mark_letter`。
9. 交卷后 URL 变成 `/work/prompt`；「重做」有两个按钮，页面头部 `a.redo` 只开弹窗，`a.jb_btn` 才是确认。
10. 资料模块（`/coursedata/stu-datalist`）常为空，别指望从中拿 PPT 当答题依据。
11. **完成标记写在 `.ans-attach-ct` 上**（`ans-job-finished`），不是 `.ans-job-icon`；且播放器不一定即时回写，**最终以目录 N/M 为准**。
12. **「无任务点」的小节**（只有资料、没配任务点）在目录里显示橙色 `0`，不会自动变绿；逐个打开一次后才会出现 `icon_yiwanc`。
13. **题干/选项有 `font-cxsecret` 字符混淆**：服务端下发的 HTML 就是混淆文本（`fetch` 重取原文也拿不到明文），只能截图用视觉读题；多选题的 `aria-label` 是明文，可交叉校验。
14. **章节卡测验 ≠ 作业列表作业**：只有从章节卡入口交卷才点亮任务点，作业列表交满分也不会点亮。
15. `web-access` proxy 会长期 attach 它创建的 tab，此后从其他连接再 `Target.attachToTarget` 会报 `No target with given id found`；驱动脚本应 `Target.createTarget` 自建 tab 并独占。

## 2026-10-27 补充（思想道德与法治课实测）

| 部位 | 选择器 / 说明 |
|---|---|
| 交卷确认弹窗（本课） | 顶层 `a.jb_btn#popok`（取消是 `#popno`）；出现有 3~5s 延迟，必须轮询 |
| 交卷触发 | 内层 `window.btnBlueSubmit()`，比 `a.click()` 可靠；内部有 `reqLimit` 计数，耗尽会提示「请刷新页面后重试」 |
| 简答/论述题 | `.TiMu` 内 `iframe#ueditor_0`（UEditor），正文写 `contentDocument.body.innerHTML`；真值是同级 `textarea#answer{qid}`，需触发 `UE.instants[*].sync()` |
| 结果页「修改答案」 | 内层文本为「修改答案」的 `<a>`；部分测验有（可重做），部分没有（一次定分）。**重做会清空 UEditor 简答文本** |
| 结果页判定 | 「待完成」= 未交；「已完成 / 第N次作答 / 本次成绩X分」= 已交；「待批阅」= 有主观题等教师批阅 |
| 课程首页导航 | `span.nav_content`（文本「作业 / 考试 / 章节…」），点击后页面自己生成带 `enc/stuenc/t` 的 iframe src；手拼 `work/list` URL 容易 404 或「无效的参数」 |

16. **截图读题要加宽视口**：默认工作 tab 视口可能只有约 758×486 且横向滚动，吸顶头和左缘悬浮工具条会挡住题干。先 `Emulation.setDeviceMetricsOverride({width:1500,height:1200,deviceScaleFactor:1,mobile:false})`，再 `scrollIntoView` 后回退约 190px，即可完整读题。
17. **每次新建 CDP WebSocket 都会触发 Chrome「允许调试」授权**：用 `scripts/relay.mjs` 常驻一条上游连接，脚本统一走 `ws://127.0.0.1:9333`，`lib-cdp.mjs` 已自动优先中继、失败回落直连。
18. **部分「专题测验」不单独计任务点**：随章节任务点一起判完成，`verify` 不列出就不用单独做。
