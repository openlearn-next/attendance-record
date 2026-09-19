# 课堂考勤记录插件（attendance-record）

OpenLearnV2 平台插件：**学生进入课程时自动记录考勤**，教师端查看**班级学期明细与汇总**。

## 记录字段

学生进入课程学习时，自动写入一条考勤记录，包含：

| 字段 | 来源 |
|------|------|
| 年月日 | 记录当天日期（`YYYY-MM-DD`） |
| 星期几 | 由日期计算 |
| 节次 | 课表 `schedules.time_slot`（如 `09:00-10:30`）+ 按配置的作息表映射为「第 N 节」 |
| 课题 | `lessons.title` |
| 教师 | 插件配置 `teacher_name` → 回退课件创建者 `lessons.creator_id` 对应姓名 |
| 机号 | 学生固定座位 `student_seats` → 机房 `computer_labs.layout_json` 对应单元格 `label` |
| IP 地址 | 同上单元格 `ip`（机房布局由 lab-seat 插件维护） |
| 状态 | `present`已到 / `late`迟到 / `leave`请假 / `absent`缺勤（自动记录默认为已到） |

> 说明：`机号`/`IP` 复用平台机房座位数据。若学生未在 `student_seats` 中分配座位，机号/IP 留空，可由教师在「手动补录」中填写。

## 功能

- **自动记录（上课态，教师端代记）**：教师白板端订阅宿主在线状态广播（`presence-update`），把**「当前课件在场学生 ∩ `class_students` 名册」自动写入「已到」**，学生一进入课堂即签到。同一（课件 + 学生 + 日期）幂等去重；若该生先前被标记为「缺勤」会自动反转为「已到」，教师在场的「请假/迟到」标记不被覆盖。
  > 为什么不走学生端：宿主上课时渲染 `StudentLessonView`，其中不渲染 `student.view` 扩展点，学生端组件不会挂载；且在线状态是服务端内存态，只通过 socket 广播，插件后端订阅不到。因此改由常驻白板工具栏的教师端代记。
  > 已知局限：教师打开白板**之前**就已在课的学生，要等该生触发下一次在线状态变更（进出课件/上下线）才被记上；可在考勤面板点「立即同步」用最近一次在线状态快照手动补记。
- **自动记录（学生学习页，学生端自报）**：学生进入课程学习页（`student.view`）时自报一条「已到」，作为上课态之外的补充路径。
- **考勤明细**（教师端 `teacher.tab` → 考勤明细）：按班级/日期区间/状态筛选、表格展示全部字段（含状态徽章）、手动补录、编辑、删除、导出 CSV。
- **批量标记**（教师端 `teacher.tab` → 批量标记）：选择课题+日期+状态（缺勤/迟到/请假），勾选学生批量写入；或「一键标记缺勤」把当日所有未记录学生标记为缺勤（已到/迟到/请假不覆盖）。
- **学期汇总**（教师端 `teacher.tab` → 学期汇总）：班级总记录、出勤天数、应出勤天数（来自课表 `schedules`）、班级出勤率，以及每名学生的记录数/出勤天数/请假天数/缺勤天数/出勤率/最近一次。
- **实时概览**（教师端 `classroom.tool` 白板工具栏 📋 按钮）：本课实时已到/迟到/请假/缺勤名单；面板打开期间每 8 秒自动刷新（宿主不转发 `attendance.*` 事件到 socket，只能主动拉取），并在自动签到写入后立即刷新。面板底部显示「在场 N 人」与「立即同步」按钮。
- **统计图表**（教师端 `teacher.tab` → 统计图表）：每日考勤分布堆叠柱图 + 出勤率趋势折线图（基于宿主 Recharts）。
- **自动缺勤判定**（定时任务）：每 N 分钟扫描今日「已结束」的课节（按课表 `time_slot` 结束时间判断），把未记录学生自动标记为缺勤；亦可在明细页手动「一键标记缺勤」。

## 安装

```bash
cd attendance-record
npm install
npm run build
```

产物：`openlearn-plugin-attendance-record.zip`

平台后台：**系统设置 → 插件中心 → 上传插件** → 上传 zip → 激活。

## ⚠️ 升级注意：重新上传会生成新的数据表

在插件中心**重新上传 zip** 时，宿主会为插件分配一个**新的实例 UUID**，插件私有表也随之变成新名字：

```
plugin_<旧UUID>_attendance_logs   ← 旧实例的数据，插件不再读取
plugin_<新UUID>_attendance_logs   ← 新实例的空表
```

也就是说，**升级后历史考勤记录不会自动迁移**，教师端明细/汇总会「看起来清空了」。旧表本身不会被删除，数据仍在数据库中。

升级前请先备份，必要时手动迁移：

```bash
# 1. 升级前记录旧实例 ID（插件中心详情页或数据库）
sqlite3 <宿主库> "SELECT id, name FROM plugins WHERE name = '课堂考勤记录'"
sqlite3 <宿主库> ".dump plugin_<旧UUID>_attendance_logs" > attendance_backup.sql

# 2. 升级后把旧数据插入新表（唯一键 (lesson_id, student_id, date) 保证幂等）
sqlite3 <宿主库> "INSERT OR IGNORE INTO plugin_<新UUID>_attendance_logs
                  SELECT * FROM plugin_<旧UUID>_attendance_logs"
```

> 若升级前旧表本来就没有任何记录（例如受 0.1.1 之前写入缺陷影响），可跳过迁移。

## ⚠️ 推荐使用 inline 执行模式

本插件**强烈建议以 inline 模式运行**（宿主默认即 inline），原因：

- 「自动缺勤判定」定时任务依赖 `processManager.registerInterval`，其回调需要与插件在同一进程内运行；
- 在 worker 模式下，回调函数无法跨 worker 线程序列化，定时任务可能注册失败，此时自动缺勤判定会静默降级为「仅手动」；
- 本插件在 `manifest` 中已显式声明 `"executionMode": "inline"`，上传后即为 inline 模式。

如何确认/切换执行模式：

1. 插件中心查看本插件详情，确认「执行模式」为 `inline`；
2. 若显示为 `worker`（例如管理员在上传时强制指定），请在插件中心切换回 `inline` 后重新激活；
3. 切换后需停用再激活插件，使 `registerInterval` 重新注册。

> 即使定时任务未生效，考勤记录、明细、汇总、图表、批量标记等其余功能不受影响；自动缺勤仍可通过明细页「一键标记缺勤」手动触发。

## 配置项（插件中心 → 配置）

| 键 | 默认 | 说明 |
|----|------|------|
| `teacher_name` | 空 | 当前授课教师姓名（为空时回退课件创建者） |
| `semester_name` | 空 | 学期名称，显示在汇总页标题，如「2025-2026学年第一学期」 |
| `period_timetable` | 8 节作息表 | JSON 数组，把课表时间区间映射为第 N 节，格式 `[{"period":1,"start":"08:00","end":"08:45"},…]` |
| `auto_mark_absent` | `true` | 是否在每节课结束后自动把未记录学生标记为缺勤 |
| `auto_mark_interval_min` | `5` | 自动缺勤判定扫描间隔（分钟） |

## 数据表

插件私有表 `attendance_logs`（自动前缀），唯一键 `(lesson_id, student_id, date)` 保证幂等；`status` 字段记录四态（present/late/leave/absent）。

## 权限

- `attendance:record` — 学生自动记录
- `attendance:read` / `attendance:write` — 教师查询 / 补录
