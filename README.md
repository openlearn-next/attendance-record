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

- **自动记录**（学生端 `student.view`）：学生进入课程页面即自动记录为「已到」，同一（课件 + 学生 + 日期）幂等去重。若该生先前被批量标记为「缺勤」，实际到场后会自动反转为「已到」；教师标记的「请假/迟到」不被自动覆盖。
- **考勤明细**（教师端 `teacher.tab` → 考勤明细）：按班级/日期区间/状态筛选、表格展示全部字段（含状态徽章）、手动补录、编辑、删除、导出 CSV。
- **批量标记**（教师端 `teacher.tab` → 批量标记）：选择课题+日期+状态（缺勤/迟到/请假），勾选学生批量写入；或「一键标记缺勤」把当日所有未记录学生标记为缺勤（已到/迟到/请假不覆盖）。
- **学期汇总**（教师端 `teacher.tab` → 学期汇总）：班级总记录、出勤天数、应出勤天数（来自课表 `schedules`）、班级出勤率，以及每名学生的记录数/出勤天数/请假天数/缺勤天数/出勤率/最近一次。
- **实时概览**（教师端 `classroom.tool` 白板工具栏 📋 按钮）：本课实时已到/迟到/请假/缺勤名单，监听考勤事件自动刷新。
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
