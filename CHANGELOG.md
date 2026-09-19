# 更新日志 (CHANGELOG)

本文档记录 **OpenLearn 课堂考勤记录插件（`@ext/attendance-record`）** 的版本更新历程与变更详情。

---

## [0.1.1] - 2026-09-19

### 🐛 修复 (Bug Fixes)

- **修复考勤记录从未写入数据库的问题（`19 values for 18 columns`）**：
  - **根因分析**：`upsertRecord` 的 `INSERT` 语句声明了 18 个列，但 `VALUES` 里写了 19 个占位符，SQLite 直接拒绝执行。该问题自首个版本即存在，导致**所有写入路径**（学生端自动记录、手动补录、批量标记、自动缺勤判定）从未成功落库，`attendance_logs` 恒为空表；而 `attendance.lesson_overview` 把「无记录」的学生全部归入缺勤，因此课堂上无论学生是否到场，一律显示未签到。
  - **修复实施**：将 `VALUES` 占位符对齐为 18 个，写入链路恢复正常。
- **修复上课状态下学生不自动签到的问题**：
  - **根因分析**：宿主上课时渲染 `StudentLessonView`，其中不渲染 `student.view` 扩展点，插件学生端记录器 `StudentAttendanceRecorder` 根本不会挂载，因此无人调用 `attendance.record_entry`。宿主的在线/在课状态是服务端内存态，只通过 socket 广播 `presence-update`，插件后端订阅不到，也没有任何「在线学生」REST API。
  - **修复实施**：改由常驻白板工具栏的**教师端代记**——插件前端订阅 `presence-update`，把「当前课件在场学生 ∩ `class_students` 名册」批量写入「已到」。
- **修复学生端身份字段取值错误**：宿主 session 中只有旧登录才会带 `studentId`，新版登录仅提供 `userId`（`server/middleware/auth.ts` 仅在缺 `userId` 时才把 `studentId` 提升为 `userId`）。现改为 `session.userId || session.studentId`。
- **修复考勤面板实时刷新失效**：宿主 `realtime-bridge` 只转发白板/批改/聚光灯等事件，插件的 `attendance.*` 事件不会到达 socket，原 `socketService.on('attendance.record_created')` 监听永远不触发。改为面板可见时每 8 秒轮询，并在自动签到写库后立即刷新。
- **自动签到失败不再被静默吞掉**：原 `catch {}` 掩盖了后端报错（本次的写入失败即因此长时间未被发现）。现在面板显示「自动签到失败：<原因>」并输出 `console.warn`，下一次 presence 变更会自动重试。

### ⚡ 增强 (Enhancements)

- **新增命令 `attendance.sync_present`**：给定 `lessonId` + `studentIds` 批量写入「已到」，内部命令（未注册 action，不受 `CapabilityGuard` 拦截）。已到/迟到/请假不被覆盖，缺勤自动反转为已到，按（课件 + 学生 + 日期）幂等。
- **按 `class_students` 识别班级归属**：指定班级时逐个校验该生是否在名册内（不在则跳过）；未指定班级时按 `class_students` 反查其归属班级。`attendance.record_entry` 未传 `classId` 时同样回填，避免记录 `class_id` 为空。
- **考勤面板新增状态行与「立即同步」按钮**：显示当前在场人数，可一键用最新在线状态快照补记。

### 📌 已知局限 (Known Limitations)

- 教师打开白板**之前**就已在课的学生，要等该生触发下一次在线状态变更（进出课件/上下线）才会被自动记上；可在考勤面板点「立即同步」手动补记。彻底解决需要在宿主 `server/presence.ts` 的 `io.on('connection')` 中补一次 `broadcastPresence()`，本次按「不改宿主」的原则未做。

---

## [0.1.0] - 2026-09-19

- 首个版本：学生进入课程自动记录考勤（年月日/星期/节次/课题/教师/机号/IP），教师端考勤明细、学期汇总、统计图表、批量标记与自动缺勤判定。
