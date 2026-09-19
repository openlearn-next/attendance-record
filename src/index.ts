import type { PluginContext } from '@openlearn/plugin-sdk';
import {
  ICommandBusServiceToken,
  IActionRegistryServiceToken,
  IEventBusServiceToken,
  IDatabaseToken,
} from '@openlearn/plugin-sdk';

// ── 常量 ────────────────────────────────────────────────
const PLUGIN_ID = '@ext/attendance-record';

// 默认作息表（第 N 节 → 起止时间）。可在插件配置中覆盖。
const DEFAULT_PERIODS: { period: number; start: string; end: string }[] = [
  { period: 1, start: '08:00', end: '08:45' },
  { period: 2, start: '08:55', end: '09:40' },
  { period: 3, start: '10:00', end: '10:45' },
  { period: 4, start: '10:55', end: '11:40' },
  { period: 5, start: '14:00', end: '14:45' },
  { period: 6, start: '14:55', end: '15:40' },
  { period: 7, start: '16:00', end: '16:45' },
  { period: 8, start: '16:55', end: '17:40' },
];

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

interface AttendanceRecord {
  id: string;
  class_id: string;
  lesson_id: string;
  schedule_id: string;
  student_id: string;
  student_name: string;
  date: string;
  weekday: string;
  period_no: string;
  time_slot: string;
  topic: string;
  teacher: string;
  machine_no: string;
  ip_address: string;
  recorded_at: number;
  source: string;
  note: string;
}

export default {
  manifest: {
    id: PLUGIN_ID,
    name: '课堂考勤记录',
    version: '0.1.2',
    description: '学生进入课程时自动记录考勤（年月日/星期/节次/课题/教师/机号/IP），教师端查看班级学期明细与汇总',
    author: 'OpenLearn',
    // 推荐 inline 模式：本插件的定时任务（自动缺勤判定）依赖 processManager.registerInterval，
    // 其回调需与插件同一进程运行，worker 模式下函数无法跨线程序列化。默认即 inline，此处显式声明。
    executionMode: 'inline',
    engines: { openlearn: '>=0.2.0' },
    requires: [
      '@openlearn/core:ICommandBusService@^1.0.0',
      '@openlearn/core:IActionRegistryService@^1.0.0',
      '@openlearn/core:IEventBusService@^1.0.0',
      '@openlearn/core:IDatabase@^1.0.0',
    ],
    capabilitiesProposed: [
      'attendance:record',
      'attendance:read',
      'attendance:write',
      'lesson:read',
      'class:read',
      'student:read',
    ],
    configuration: {
      properties: {
        teacher_name: {
          type: 'string',
          default: '',
          description: '当前授课教师姓名（为空时回退到课件创建者姓名）',
        },
        semester_name: {
          type: 'string',
          default: '',
          description: '当前学期名称，用于汇总页标题，如「2025-2026学年第一学期」',
        },
        period_timetable: {
          type: 'string',
          default: JSON.stringify(DEFAULT_PERIODS),
          description: '作息表 JSON 数组：[{"period":1,"start":"08:00","end":"08:45"},...]，用于把课表时间区间映射为第 N 节',
        },
        auto_mark_absent: {
          type: 'boolean',
          default: true,
          description: '是否在每节课结束后自动把未记录学生标记为缺勤（建议开启，可随时在明细页手动修正）',
        },
        auto_mark_interval_min: {
          type: 'integer',
          default: 5,
          description: '自动缺勤判定扫描间隔（分钟）',
        },
      },
    },
  },

  async activate(ctx: PluginContext) {
    const commandBus = ctx.services.commandBus;
    const actionRegistry = ctx.services.actionRegistry;
    const eventBus = ctx.services.eventBus;
    const pluginId = ctx.pluginId;

    // 原始 better-sqlite3 句柄，用于读取宿主表（lessons/schedules/classes/students/class_students/student_seats/computer_labs/users）
    const rawDb: any = await ctx.resolve(IDatabaseToken);

    // Worker runtime 不提供 ctx.config，fallback 到 manifest 默认值
    const getConfigValue = (key: string): any => {
      const cfg = (ctx as any).config;
      if (cfg && typeof cfg[key] !== 'undefined') return cfg[key];
      return (ctx.manifest as any)?.configuration?.properties?.[key]?.default;
    };

    // ── 1. 建表 ─────────────────────────────────────────
    await ctx.db.ensureTable(
      'attendance_logs',
      `id TEXT PRIMARY KEY,
       class_id TEXT NOT NULL,
       lesson_id TEXT NOT NULL,
       schedule_id TEXT DEFAULT '',
       student_id TEXT NOT NULL,
       student_name TEXT DEFAULT '',
       date TEXT NOT NULL,
       weekday TEXT DEFAULT '',
       period_no TEXT DEFAULT '',
       time_slot TEXT DEFAULT '',
       topic TEXT DEFAULT '',
       teacher TEXT DEFAULT '',
       machine_no TEXT DEFAULT '',
       ip_address TEXT DEFAULT '',
       status TEXT DEFAULT 'present',
       recorded_at INTEGER NOT NULL,
       source TEXT DEFAULT 'auto',
       note TEXT DEFAULT '',
       UNIQUE(lesson_id, student_id, date)`
    );

    const T_ATT = ctx.db.table('attendance_logs');

    // 升级兼容：旧表缺 status 列时补充（幂等）
    try { rawDb.prepare(`ALTER TABLE ${T_ATT} ADD COLUMN status TEXT DEFAULT 'present'`).run(); } catch { /* 已存在 */ }

    // 高频检索索引
    try {
      rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_${T_ATT}_class ON ${T_ATT} (class_id, date)`).run();
      rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_${T_ATT}_student ON ${T_ATT} (student_id, date)`).run();
      rawDb.prepare(`CREATE INDEX IF NOT EXISTS idx_${T_ATT}_lesson ON ${T_ATT} (lesson_id, date)`).run();
    } catch (e) {
      ctx.log.warn(`[attendance-record] 创建索引失败（不影响核心功能）: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── 2. 工具函数 ─────────────────────────────────────
    function uid(): string {
      return globalThis.crypto.randomUUID();
    }

    function pad2(n: number): string {
      return n < 10 ? `0${n}` : String(n);
    }

    function formatDate(ts: number): string {
      const d = new Date(ts);
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }

    function weekdayOf(dateStr: string): string {
      if (!dateStr) return '';
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
      if (!m) return '';
      const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return WEEKDAYS[dt.getDay()] || '';
    }

    function parsePeriodTimetable(): { period: number | string; start: string; end: string }[] {
      const raw = getConfigValue('period_timetable');
      if (typeof raw === 'string' && raw.trim()) {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr) && arr.length > 0) return arr;
        } catch { /* ignore, use default */ }
      }
      return DEFAULT_PERIODS;
    }

    // 把 "HH:MM-HH:MM" 映射为 "第N节"
    function resolvePeriodNo(timeSlot: string): string {
      if (!timeSlot) return '';
      const start = String(timeSlot).split('-')[0]?.trim();
      if (!start) return '';
      const periods = parsePeriodTimetable();
      for (const p of periods) {
        if (String(p.start).trim() === start) return `第${p.period}节`;
      }
      // 落入某个区间内
      for (const p of periods) {
        const s = String(p.start).trim();
        const e = String(p.end).trim();
        if (s && e && start >= s && start < e) return `第${p.period}节`;
      }
      return '';
    }

    // 查找课表：优先「班级+课件+今天」，逐级回退
    function findSchedule(lessonId: string, classId: string | null, dateStr: string): any {
      let sch: any = null;
      if (classId) {
        sch = rawDb.prepare(
          `SELECT * FROM schedules WHERE class_id = ? AND lesson_id = ? AND scheduled_date = ? ORDER BY time_slot ASC LIMIT 1`
        ).get(classId, lessonId, dateStr);
      }
      if (!sch) {
        sch = rawDb.prepare(
          `SELECT * FROM schedules WHERE lesson_id = ? AND scheduled_date = ? ORDER BY time_slot ASC LIMIT 1`
        ).get(lessonId, dateStr);
      }
      if (!sch && classId) {
        sch = rawDb.prepare(
          `SELECT * FROM schedules WHERE class_id = ? AND lesson_id = ? ORDER BY scheduled_date DESC, time_slot ASC LIMIT 1`
        ).get(classId, lessonId);
      }
      if (!sch) {
        sch = rawDb.prepare(
          `SELECT * FROM schedules WHERE lesson_id = ? ORDER BY scheduled_date DESC, time_slot ASC LIMIT 1`
        ).get(lessonId);
      }
      return sch || null;
    }

    // 班级归属：按 class_students 反查（学生可能属于多个班级，取第一条）
    function resolveClassIdOfStudent(studentId: string): string {
      try {
        const row: any = rawDb.prepare(
          `SELECT class_id FROM class_students WHERE student_id = ? LIMIT 1`
        ).get(studentId);
        return row?.class_id || '';
      } catch {
        return '';
      }
    }

    // 机号 / IP：学生固定座位 → 机房布局单元格
    function resolveSeat(classId: string, studentId: string): { machineNo: string; ip: string } {
      try {
        const seat: any = rawDb.prepare(
          `SELECT * FROM student_seats WHERE class_id = ? AND student_id = ?`
        ).get(classId, studentId);
        if (!seat) return { machineNo: '', ip: '' };

        const lab: any = rawDb.prepare(`SELECT * FROM computer_labs WHERE id = ?`).get(seat.lab_id);
        let label = '';
        let ip = '';
        if (lab) {
          if (lab.layout_json && lab.layout_json !== '{}' && lab.layout_json !== '') {
            try {
              const layout = JSON.parse(lab.layout_json);
              const cell = layout.cells?.find(
                (c: any) => c.row === seat.row_idx && c.col === seat.col_idx
              );
              if (cell) {
                label = cell.label || '';
                ip = cell.ip || '';
              }
            } catch { /* ignore */ }
          }
          if (!label) {
            label = `${String.fromCharCode(65 + seat.row_idx)}${seat.col_idx + 1}`;
          }
        }
        return { machineNo: label, ip };
      } catch {
        return { machineNo: '', ip: '' };
      }
    }

    // 教师：手动指定 > 配置 > 课件创建者 > 空
    function resolveTeacher(lessonId: string, payloadTeacher?: string): string {
      if (payloadTeacher && String(payloadTeacher).trim()) return String(payloadTeacher).trim();
      const cfg = getConfigValue('teacher_name');
      if (cfg && String(cfg).trim()) return String(cfg).trim();
      try {
        const row: any = rawDb.prepare(
          `SELECT u.name FROM lessons l LEFT JOIN users u ON u.id = l.creator_id WHERE l.id = ?`
        ).get(lessonId);
        return row?.name || '';
      } catch {
        return '';
      }
    }

    function topicOf(lessonId: string): string {
      try {
        const row: any = rawDb.prepare(`SELECT title FROM lessons WHERE id = ?`).get(lessonId);
        return row?.title || '';
      } catch {
        return '';
      }
    }

    function studentNameOf(studentId: string): string {
      try {
        const row: any = rawDb.prepare(`SELECT name FROM students WHERE id = ?`).get(studentId);
        return row?.name || '';
      } catch {
        return '';
      }
    }

    function classNameOf(classId: string): string {
      try {
        const row: any = rawDb.prepare(`SELECT name FROM classes WHERE id = ?`).get(classId);
        return row?.name || '';
      } catch {
        return '';
      }
    }

    // 状态归一化：present/late/leave/absent
    function normStatus(s: any): string {
      return ['present', 'late', 'leave', 'absent'].includes(s) ? s : 'present';
    }

    // 写入/更新一条考勤记录（强制指定状态，按 (lesson, student, date) 幂等）。
    // 主键 id 始终取新值，避免与既有行主键冲突；更新由 ON CONFLICT 命中 (lesson, student, date) 完成。
    function upsertRecord(r: {
      classId: string; lessonId: string; scheduleId: string; studentId: string;
      studentName: string; date: string; timeSlot: string; periodNo: string; topic: string;
      teacher: string; machineNo: string; ip: string; status: string; source: string; note: string; recordedAt: number;
    }) {
      rawDb.prepare(`
        INSERT INTO ${T_ATT}
          (id, class_id, lesson_id, schedule_id, student_id, student_name, date, weekday, period_no, time_slot, topic, teacher, machine_no, ip_address, status, recorded_at, source, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lesson_id, student_id, date) DO UPDATE SET
          class_id = excluded.class_id,
          student_name = excluded.student_name,
          weekday = excluded.weekday,
          period_no = excluded.period_no,
          time_slot = excluded.time_slot,
          topic = excluded.topic,
          teacher = excluded.teacher,
          machine_no = excluded.machine_no,
          ip_address = excluded.ip_address,
          status = excluded.status,
          recorded_at = excluded.recorded_at,
          source = excluded.source,
          note = excluded.note
      `).run(
        uid(), r.classId, r.lessonId, r.scheduleId, r.studentId, r.studentName, r.date,
        weekdayOf(r.date), r.periodNo, r.timeSlot, r.topic, r.teacher, r.machineNo, r.ip,
        r.status, r.recordedAt, r.source, r.note
      );
    }

    // ── 3. 自动记录（学生进入课程）────────────────────────
    await actionRegistry.register({
      id: 'attendance-record-entry',
      commandType: 'attendance.record_entry',
      description: '学生进入课程学习时自动记录一条考勤（年月日/星期/节次/课题/教师/机号/IP）',
      capabilityRequired: 'attendance:record',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          lessonId: { type: 'STRING', description: '课件/课程 ID' },
          classId: { type: 'STRING', description: '班级 ID（可选）' },
          studentId: { type: 'STRING', description: '学生 ID' },
          studentName: { type: 'STRING', description: '学生姓名（可选）' },
          teacher: { type: 'STRING', description: '教师姓名（可选，缺省取配置）' },
        },
        required: ['lessonId', 'studentId'],
      },
    });

    await commandBus.registerHandler('attendance.record_entry', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        const lessonId = p.lessonId;
        const studentId = p.studentId;
        // 未显式传班级时按 class_students 反查，避免记录 class_id 为空
        const classId = p.classId || resolveClassIdOfStudent(studentId) || null;
        if (!lessonId || !studentId) throw new Error('缺少 lessonId 或 studentId');

        const now = Date.now();
        const date = formatDate(now);
        const schedule = findSchedule(lessonId, classId, date);
        const timeSlot = schedule?.time_slot || '';
        const periodNo = resolvePeriodNo(timeSlot);
        const machine = resolveSeat(classId || '', studentId);
        const teacher = resolveTeacher(lessonId, p.teacher);
        const name = p.studentName || studentNameOf(studentId);

        const existing: any = rawDb.prepare(
          `SELECT * FROM ${T_ATT} WHERE lesson_id = ? AND student_id = ? AND date = ?`
        ).get(lessonId, studentId, date);

        // 教师标记（请假/迟到/已到）不被自动记录覆盖；缺勤则反转为已到（学生实际到场）
        if (existing) {
          if (existing.status === 'leave' || existing.status === 'late' || existing.status === 'present') {
            return { recorded: false, already: true, record: existing };
          }
        }

        upsertRecord({
          classId: classId || existing?.class_id || '',
          lessonId,
          scheduleId: schedule?.id || existing?.schedule_id || '',
          studentId,
          studentName: name,
          date,
          timeSlot,
          periodNo,
          topic: topicOf(lessonId),
          teacher,
          machineNo: machine.machineNo || existing?.machine_no || '',
          ip: machine.ip || existing?.ip_address || '',
          status: 'present',
          source: 'auto',
          note: existing?.note || '',
          recordedAt: now,
        });

        const record = rawDb.prepare(
          `SELECT * FROM ${T_ATT} WHERE lesson_id = ? AND student_id = ? AND date = ?`
        ).get(lessonId, studentId, date);

        await eventBus.publish({
          id: uid(),
          type: 'attendance.record_created',
          source: `plugin.${pluginId}`,
          payload: { lessonId, classId: classId || '', studentId, date, status: 'present' },
          timestamp: now,
          correlationId: command.id,
        });

        return { recorded: true, already: false, record };
      },
    });

    // ── 3b. 课堂在场学生自动签到（教师端代记）──────────────
    // 由插件前端订阅宿主 presence-update 后调用：把「当前课件在场学生」按
    // class_students 归属班级写入 present。内部命令，不注册到 actionRegistry。
    await commandBus.registerHandler('attendance.sync_present', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        const lessonId = p.lessonId;
        const studentIds: string[] = Array.isArray(p.studentIds) ? p.studentIds : [];
        if (!lessonId) throw new Error('缺少 lessonId');
        if (studentIds.length === 0) return { synced: 0, skipped: 0, studentIds: [] };

        const now = Date.now();
        const date = p.date || formatDate(now);
        const requestedClassId = p.classId || '';
        const schedule = findSchedule(lessonId, requestedClassId || null, date);
        const timeSlot = schedule?.time_slot || '';
        const periodNo = resolvePeriodNo(timeSlot);
        const teacher = resolveTeacher(lessonId);
        const topic = topicOf(lessonId);

        const syncedIds: string[] = [];
        let skipped = 0;

        for (const sid of studentIds) {
          // 按 class_students 识别：指定班级时必须属于该班级，否则反查其归属班级
          let classId = requestedClassId;
          if (classId) {
            const inClass: any = rawDb.prepare(
              `SELECT 1 AS ok FROM class_students WHERE class_id = ? AND student_id = ?`
            ).get(classId, sid);
            if (!inClass) { skipped++; continue; }
          } else {
            classId = resolveClassIdOfStudent(sid);
          }

          const existing: any = rawDb.prepare(
            `SELECT id, status, schedule_id, machine_no, ip_address, note FROM ${T_ATT} WHERE lesson_id = ? AND student_id = ? AND date = ?`
          ).get(lessonId, sid, date);
          // 已到 / 迟到 / 请假不被自动签到覆盖，仅缺勤反转为已到
          if (existing && existing.status !== 'absent') continue;

          const machine = resolveSeat(classId, sid);
          upsertRecord({
            classId,
            lessonId,
            scheduleId: schedule?.id || existing?.schedule_id || '',
            studentId: sid,
            studentName: studentNameOf(sid),
            date,
            timeSlot,
            periodNo,
            topic,
            teacher,
            machineNo: machine.machineNo || existing?.machine_no || '',
            ip: machine.ip || existing?.ip_address || '',
            status: 'present',
            source: 'auto',
            note: existing?.note || '',
            recordedAt: now,
          });
          syncedIds.push(sid);
        }

        if (syncedIds.length > 0) {
          await eventBus.publish({
            id: uid(),
            type: 'attendance.record_updated',
            source: `plugin.${pluginId}`,
            payload: { lessonId, classId: requestedClassId, date, status: 'present', count: syncedIds.length },
            timestamp: now,
            correlationId: command.id,
          });
        }
        return { synced: syncedIds.length, skipped, studentIds: syncedIds };
      },
    });

    // ── 4. 手动补录 / 新增（教师）────────────────────────
    await commandBus.registerHandler('attendance.add_record', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        if (!p.lessonId || !p.studentId) throw new Error('缺少 lessonId 或 studentId');
        const now = Date.now();
        const date = p.date || formatDate(now);
        const timeSlot = p.timeSlot || '';
        upsertRecord({
          classId: p.classId || '',
          lessonId: p.lessonId,
          scheduleId: p.scheduleId || '',
          studentId: p.studentId,
          studentName: p.studentName || studentNameOf(p.studentId),
          date,
          timeSlot,
          periodNo: p.periodNo || resolvePeriodNo(timeSlot),
          topic: p.topic || topicOf(p.lessonId),
          teacher: p.teacher || resolveTeacher(p.lessonId),
          machineNo: p.machineNo || '',
          ip: p.ipAddress || '',
          status: normStatus(p.status),
          source: 'manual',
          note: p.note || '',
          recordedAt: p.recordedAt || now,
        });

        const record = rawDb.prepare(
          `SELECT * FROM ${T_ATT} WHERE lesson_id = ? AND student_id = ? AND date = ?`
        ).get(p.lessonId, p.studentId, date);
        await eventBus.publish({
          id: uid(),
          type: 'attendance.record_updated',
          source: `plugin.${pluginId}`,
          payload: { studentId: p.studentId, date },
          timestamp: now,
          correlationId: command.id,
        });
        return { success: true, record };
      },
    });

    // ── 4b. 批量标记状态（教师：缺勤/请假/迟到）────────────
    await commandBus.registerHandler('attendance.batch_mark', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        if (!p.lessonId) throw new Error('缺少 lessonId');
        const studentIds: string[] = Array.isArray(p.studentIds) ? p.studentIds : [];
        if (studentIds.length === 0) throw new Error('缺少 studentIds');
        const status = normStatus(p.status);
        if (status === 'present') throw new Error('批量标记请选择缺勤/请假/迟到');
        const now = Date.now();
        const date = p.date || formatDate(now);
        const classId = p.classId || '';
        const schedule = findSchedule(p.lessonId, classId || null, date);
        const timeSlot = schedule?.time_slot || '';
        const periodNo = resolvePeriodNo(timeSlot);
        const teacher = resolveTeacher(p.lessonId);
        const topic = topicOf(p.lessonId);

        let count = 0;
        for (const sid of studentIds) {
          upsertRecord({
            classId,
            lessonId: p.lessonId,
            scheduleId: schedule?.id || '',
            studentId: sid,
            studentName: studentNameOf(sid),
            date,
            timeSlot,
            periodNo,
            topic,
            teacher,
            machineNo: '',
            ip: '',
            status,
            source: 'manual',
            note: p.note || '',
            recordedAt: now,
          });
          count++;
        }

        await eventBus.publish({
          id: uid(),
          type: 'attendance.record_updated',
          source: `plugin.${pluginId}`,
          payload: { lessonId: p.lessonId, classId, date, status, count },
          timestamp: now,
          correlationId: command.id,
        });
        return { success: true, count };
      },
    });

    // 将某节课当日未记录的学生标记为缺勤（返回标记人次，不发布事件）
    function markAbsentForLesson(lessonId: string, classId: string, date: string, note: string): number {
      const roster = classId
        ? (rawDb.prepare(
            `SELECT s.id FROM class_students cs JOIN students s ON s.id = cs.student_id WHERE cs.class_id = ?`
          ).all(classId) as any[])
        : [];
      const schedule = findSchedule(lessonId, classId || null, date);
      const timeSlot = schedule?.time_slot || '';
      const periodNo = resolvePeriodNo(timeSlot);
      const teacher = resolveTeacher(lessonId);
      const topic = topicOf(lessonId);
      const now = Date.now();

      let count = 0;
      for (const s of roster) {
        const existing: any = rawDb.prepare(
          `SELECT id, status FROM ${T_ATT} WHERE lesson_id = ? AND student_id = ? AND date = ?`
        ).get(lessonId, s.id, date);
        // 已有到场/迟到/请假记录的学生跳过
        if (existing && existing.status !== 'absent') continue;
        upsertRecord({
          classId,
          lessonId,
          scheduleId: schedule?.id || '',
          studentId: s.id,
          studentName: studentNameOf(s.id),
          date,
          timeSlot,
          periodNo,
          topic,
          teacher,
          machineNo: '',
          ip: '',
          status: 'absent',
          source: 'auto',
          note,
          recordedAt: now,
        });
        count++;
      }
      return count;
    }

    // 扫描今日所有「已结束」的课节并自动标记缺勤
    function autoMarkAbsentForToday(): { marked: number } {
      const date = formatDate(Date.now());
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const schedules = rawDb.prepare(
        `SELECT id, class_id, lesson_id, time_slot FROM schedules WHERE scheduled_date = ? AND (status = 'scheduled' OR status IS NULL)`
      ).all(date) as any[];
      let marked = 0;
      for (const sch of schedules) {
        const end = String(sch.time_slot || '').split('-')[1]?.trim();
        if (!end) continue;
        const parts = end.split(':');
        const h = Number(parts[0]);
        const m = Number(parts[1]);
        if (Number.isNaN(h) || Number.isNaN(m)) continue;
        if (nowMin >= h * 60 + m) {
          marked += markAbsentForLesson(sch.lesson_id, sch.class_id, date, '自动判定缺勤');
        }
      }
      return { marked };
    }

    // ── 4c. 一键标记缺勤（未记录的学生全标记为缺勤）────────
    await commandBus.registerHandler('attendance.batch_mark_all_absent', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        if (!p.lessonId) throw new Error('缺少 lessonId');
        const date = p.date || formatDate(Date.now());
        let classId = p.classId || '';
        if (!classId) {
          const sch = rawDb.prepare(
            `SELECT class_id FROM schedules WHERE lesson_id = ? AND scheduled_date = ? ORDER BY time_slot ASC LIMIT 1`
          ).get(p.lessonId, date) as any;
          classId = sch?.class_id || '';
        }
        const count = markAbsentForLesson(p.lessonId, classId, date, p.note || '');
        await eventBus.publish({
          id: uid(),
          type: 'attendance.record_updated',
          source: `plugin.${pluginId}`,
          payload: { lessonId: p.lessonId, classId, date, status: 'absent', count },
          timestamp: Date.now(),
          correlationId: command.id,
        });
        return { success: true, count };
      },
    });

    // ── 4d. 手动触发：扫描今日已结束课节并标记缺勤──────────
    await commandBus.registerHandler('attendance.auto_mark_absent', {
      async execute() {
        return autoMarkAbsentForToday();
      },
    });

    // ── 5. 更新记录（教师修正）───────────────────────────
    await commandBus.registerHandler('attendance.update_record', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        if (!p.id) throw new Error('缺少记录 id');
        const existing: any = rawDb.prepare(`SELECT * FROM ${T_ATT} WHERE id = ?`).get(p.id);
        if (!existing) throw new Error('记录不存在');

        const date = p.date ?? existing.date;
        const timeSlot = p.timeSlot ?? existing.time_slot;
        rawDb.prepare(
          `UPDATE ${T_ATT} SET
            class_id = ?, lesson_id = ?, student_id = ?, student_name = ?,
            date = ?, weekday = ?, period_no = ?, time_slot = ?, topic = ?,
            teacher = ?, machine_no = ?, ip_address = ?, status = ?, note = ?
           WHERE id = ?`
        ).run(
          p.classId ?? existing.class_id,
          p.lessonId ?? existing.lesson_id,
          p.studentId ?? existing.student_id,
          p.studentName ?? existing.student_name,
          date,
          p.weekday ?? weekdayOf(date),
          p.periodNo ?? resolvePeriodNo(timeSlot),
          timeSlot,
          p.topic ?? existing.topic,
          p.teacher ?? existing.teacher,
          p.machineNo ?? existing.machine_no,
          p.ipAddress ?? existing.ip_address,
          normStatus(p.status ?? existing.status),
          p.note ?? existing.note,
          p.id
        );
        const record = rawDb.prepare(`SELECT * FROM ${T_ATT} WHERE id = ?`).get(p.id);
        return { success: true, record };
      },
    });

    // ── 6. 删除记录 ──────────────────────────────────────
    await commandBus.registerHandler('attendance.delete_record', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        if (!p.id) throw new Error('缺少记录 id');
        rawDb.prepare(`DELETE FROM ${T_ATT} WHERE id = ?`).run(p.id);
        return { success: true };
      },
    });

    // ── 7. 明细查询 ──────────────────────────────────────
    await commandBus.registerHandler('attendance.list_records', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        const where: string[] = [];
        const params: any[] = [];
        if (p.classId) { where.push('a.class_id = ?'); params.push(p.classId); }
        if (p.lessonId) { where.push('a.lesson_id = ?'); params.push(p.lessonId); }
        if (p.studentId) { where.push('a.student_id = ?'); params.push(p.studentId); }
        if (p.status) { where.push('a.status = ?'); params.push(p.status); }
        if (p.startDate) { where.push('a.date >= ?'); params.push(p.startDate); }
        if (p.endDate) { where.push('a.date <= ?'); params.push(p.endDate); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const limit = Math.min(Math.max(Number(p.limit) || 500, 1), 2000);
        const offset = Math.max(Number(p.offset) || 0, 0);

        const rows = rawDb.prepare(
          `SELECT a.*, c.name AS class_name
           FROM ${T_ATT} a
           LEFT JOIN classes c ON c.id = a.class_id
           ${whereSql}
           ORDER BY a.date DESC, a.time_slot ASC, a.recorded_at ASC
           LIMIT ? OFFSET ?`
        ).all(...params, limit, offset);

        const total = rawDb.prepare(
          `SELECT COUNT(*) AS c FROM ${T_ATT} a ${whereSql}`
        ).get(...params) as any;

        return { records: rows, total: total?.c || 0 };
      },
    });

    // ── 8. 班级列表（供教师面板下拉）──────────────────────
    await commandBus.registerHandler('attendance.list_classes', {
      async execute() {
        try {
          return rawDb.prepare(
            `SELECT c.id, c.name, c.description, c.lab_id, c.created_at,
                    (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.id) AS student_count
             FROM classes c
             ORDER BY c.created_at DESC`
          ).all();
        } catch {
          return [];
        }
      },
    });

    // ── 8b. 班级花名册（供教师面板下拉）──────────────────
    await commandBus.registerHandler('attendance.list_students', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        if (!p.classId) return [];
        try {
          return rawDb.prepare(
            `SELECT s.id, s.name, s.student_number
             FROM class_students cs JOIN students s ON s.id = cs.student_id
             WHERE cs.class_id = ?
             ORDER BY s.student_number ASC`
          ).all(p.classId);
        } catch {
          return [];
        }
      },
    });

    // ── 8c. 课件列表（供教师面板选择课题）──────────────────
    await commandBus.registerHandler('attendance.list_lessons', {
      async execute() {
        try {
          return rawDb.prepare(
            `SELECT id, title FROM lessons ORDER BY updated_at DESC LIMIT 300`
          ).all();
        } catch {
          return [];
        }
      },
    });

    // ── 9. 班级学期汇总 ──────────────────────────────────
    await actionRegistry.register({
      id: 'attendance-class-summary',
      commandType: 'attendance.class_summary',
      description: '汇总某班级的学期考勤情况（总人次、出勤天数、每名学生出勤次数与出勤率）',
      capabilityRequired: 'attendance:read',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          classId: { type: 'STRING', description: '班级 ID' },
          startDate: { type: 'STRING', description: '起始日期（YYYY-MM-DD，可选）' },
          endDate: { type: 'STRING', description: '结束日期（YYYY-MM-DD，可选）' },
        },
        required: ['classId'],
      },
    });

    await commandBus.registerHandler('attendance.class_summary', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        if (!p.classId) throw new Error('缺少 classId');

        const className = (rawDb.prepare(`SELECT name FROM classes WHERE id = ?`).get(p.classId) as any)?.name || '未知班级';

        // 出勤记录过滤条件
        const where: string[] = ['a.class_id = ?'];
        const params: any[] = [p.classId];
        if (p.startDate) { where.push('a.date >= ?'); params.push(p.startDate); }
        if (p.endDate) { where.push('a.date <= ?'); params.push(p.endDate); }
        const whereSql = where.join(' AND ');

        const roster = rawDb.prepare(
          `SELECT s.id, s.name, s.student_number
           FROM class_students cs JOIN students s ON s.id = cs.student_id
           WHERE cs.class_id = ?
           ORDER BY s.student_number ASC`
        ).all(p.classId) as any[];

        // 应出勤天数（课表里已安排的日期数）
        let scheduledDates = 0;
        try {
          const sdWhere: string[] = ['class_id = ?'];
          const sdParams: any[] = [p.classId];
          if (p.startDate) { sdWhere.push('scheduled_date >= ?'); sdParams.push(p.startDate); }
          if (p.endDate) { sdWhere.push('scheduled_date <= ?'); sdParams.push(p.endDate); }
          const row = rawDb.prepare(
            `SELECT COUNT(DISTINCT scheduled_date) AS c FROM schedules WHERE ${sdWhere.join(' AND ')}`
          ).get(...sdParams) as any;
          scheduledDates = row?.c || 0;
        } catch { /* ignore */ }

        const perStudent = roster.map((s) => {
          const rec = rawDb.prepare(
            `SELECT COUNT(*) AS c,
                    COUNT(DISTINCT CASE WHEN status IN ('present','late') THEN date END) AS attended_days,
                    COUNT(DISTINCT CASE WHEN status = 'leave' THEN date END) AS leave_days,
                    MAX(recorded_at) AS last_at
             FROM ${T_ATT} a WHERE ${whereSql} AND a.student_id = ?`
          ).get(...params, s.id) as any;
          const attendedDays = rec?.attended_days || 0;
          const leaveDays = rec?.leave_days || 0;
          const denom = Math.max(scheduledDates - leaveDays, 0);
          const rate = scheduledDates > 0 && denom > 0 ? Math.round((attendedDays / denom) * 1000) / 10 : null;
          const absentDays = scheduledDates > 0 ? Math.max(scheduledDates - attendedDays - leaveDays, 0) : null;
          return {
            studentId: s.id,
            studentNo: s.student_number || '',
            name: s.name || '',
            recordCount: rec?.c || 0,
            attendedDays,
            leaveDays,
            absentDays,
            lastAttended: rec?.last_at || null,
            rate,
          };
        });

        const totalRecords = rawDb.prepare(
          `SELECT COUNT(*) AS c FROM ${T_ATT} a WHERE ${whereSql}`
        ).get(...params) as any;

        const distinctDates = rawDb.prepare(
          `SELECT COUNT(DISTINCT date) AS c FROM ${T_ATT} a WHERE ${whereSql}`
        ).get(...params) as any;

        const overview = {
          className,
          semesterName: String(getConfigValue('semester_name') || ''),
          totalStudents: roster.length,
          totalRecords: totalRecords?.c || 0,
          attendedDates: distinctDates?.c || 0,
          scheduledDates,
        };

        return { overview, perStudent };
      },
    });

    // ── 10. 单节课实时概览（含缺勤自动判定）──────────────────
    await actionRegistry.register({
      id: 'attendance-lesson-overview',
      commandType: 'attendance.lesson_overview',
      description: '查看某节课的实时考勤：已到/缺勤名单（缺勤=班级花名册中尚未记录考勤的学生）',
      capabilityRequired: 'attendance:read',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          lessonId: { type: 'STRING', description: '课件/课程 ID' },
          classId: { type: 'STRING', description: '班级 ID（可选，缺省按课表自动推断）' },
          date: { type: 'STRING', description: '日期 YYYY-MM-DD（可选，缺省今天）' },
        },
        required: ['lessonId'],
      },
    });

    await commandBus.registerHandler('attendance.lesson_overview', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        const lessonId = p.lessonId;
        if (!lessonId) throw new Error('缺少 lessonId');
        const date = p.date || formatDate(Date.now());

        // 推断班级：显式传入 > 今日课表 > 最近课表
        let cid = p.classId || null;
        if (!cid) {
          const sch = rawDb.prepare(
            `SELECT class_id FROM schedules WHERE lesson_id = ? AND scheduled_date = ? ORDER BY time_slot ASC LIMIT 1`
          ).get(lessonId, date) as any;
          cid = sch?.class_id || null;
        }
        if (!cid) {
          const sch = rawDb.prepare(
            `SELECT class_id FROM schedules WHERE lesson_id = ? ORDER BY scheduled_date DESC LIMIT 1`
          ).get(lessonId) as any;
          cid = sch?.class_id || null;
        }

        const roster = cid
          ? (rawDb.prepare(
              `SELECT s.id, s.name, s.student_number
               FROM class_students cs JOIN students s ON s.id = cs.student_id
               WHERE cs.class_id = ?
               ORDER BY s.student_number ASC`
            ).all(cid) as any[])
          : [];

        const rows = rawDb.prepare(
          `SELECT * FROM ${T_ATT} WHERE lesson_id = ? AND date = ?`
        ).all(lessonId, date) as any[];
        const rowByStudent = new Map(rows.map((r: any) => [r.student_id, r]));

        const bucket = (pred: (r: any | undefined) => boolean) =>
          roster
            .filter((s: any) => pred(rowByStudent.get(s.id)))
            .map((s: any) => {
              const rec = rowByStudent.get(s.id);
              return {
                studentId: s.id, name: s.name, studentNo: s.student_number || '',
                machineNo: rec?.machine_no || '', ip: rec?.ip_address || '',
                periodNo: rec?.period_no || '', recordedAt: rec?.recorded_at || null,
                note: rec?.note || '',
              };
            });

        const present = bucket((r) => r?.status === 'present');
        const late = bucket((r) => r?.status === 'late');
        const leave = bucket((r) => r?.status === 'leave');
        // 缺勤 = 显式标记 absent + 尚未记录的学生
        const absent = bucket((r) => !r || r?.status === 'absent');

        const schedule = findSchedule(lessonId, cid, date);
        const timeSlot = schedule?.time_slot || '';

        return {
          lessonId,
          classId: cid || '',
          className: cid ? classNameOf(cid) : '',
          topic: topicOf(lessonId),
          date,
          weekday: weekdayOf(date),
          timeSlot,
          periodNo: resolvePeriodNo(timeSlot),
          teacher: resolveTeacher(lessonId),
          total: roster.length,
          presentCount: present.length,
          lateCount: late.length,
          leaveCount: leave.length,
          absentCount: absent.length,
          present,
          late,
          leave,
          absent,
        };
      },
    });

    // ── 11. 日维度统计（供图表）───────────────────────────
    await commandBus.registerHandler('attendance.daily_stats', {
      async execute(command: any) {
        const p = (command.payload || {}) as any;
        if (!p.classId) throw new Error('缺少 classId');
        const rosterCount = (rawDb.prepare(
          `SELECT COUNT(*) AS c FROM class_students WHERE class_id = ?`
        ).get(p.classId) as any)?.c || 0;

        const sdWhere: string[] = ['class_id = ?'];
        const sdParams: any[] = [p.classId];
        if (p.startDate) { sdWhere.push('scheduled_date >= ?'); sdParams.push(p.startDate); }
        if (p.endDate) { sdWhere.push('scheduled_date <= ?'); sdParams.push(p.endDate); }
        const schedDates = rawDb.prepare(
          `SELECT DISTINCT scheduled_date AS d FROM schedules WHERE ${sdWhere.join(' AND ')}`
        ).all(...sdParams) as any[];

        const rdWhere: string[] = ['class_id = ?'];
        const rdParams: any[] = [p.classId];
        if (p.startDate) { rdWhere.push('date >= ?'); rdParams.push(p.startDate); }
        if (p.endDate) { rdWhere.push('date <= ?'); rdParams.push(p.endDate); }
        const recDates = rawDb.prepare(
          `SELECT DISTINCT date AS d FROM ${T_ATT} WHERE ${rdWhere.join(' AND ')}`
        ).all(...rdParams) as any[];

        const dateSet = new Set<string>();
        for (const r of schedDates) dateSet.add(r.d);
        for (const r of recDates) dateSet.add(r.d);
        const dates = Array.from(dateSet).sort();

        const list = dates.map((date) => {
          const rows = rawDb.prepare(
            `SELECT status, COUNT(*) AS c FROM ${T_ATT} WHERE class_id = ? AND date = ? GROUP BY status`
          ).all(p.classId, date) as any[];
          const m: Record<string, number> = { present: 0, late: 0, leave: 0, absent: 0 };
          for (const r of rows) if (m[r.status] !== undefined) m[r.status] = r.c;
          m.absent = Math.max(rosterCount - m.present - m.late - m.leave, 0);
          const rate = rosterCount > 0 ? Math.round(((m.present + m.late) / rosterCount) * 1000) / 10 : 0;
          return { date, weekday: weekdayOf(date), present: m.present, late: m.late, leave: m.leave, absent: m.absent, total: rosterCount, rate };
        });
        return list;
      },
    });

    // ── 12. 定时自动缺勤判定（best-effort；失败则手动「一键标记缺勤」兜底）──
    try {
      if (getConfigValue('auto_mark_absent') !== false) {
        const intervalMin = Number(getConfigValue('auto_mark_interval_min')) || 5;
        await ctx.services.processManager.registerInterval(
          'attendance-auto-absent',
          intervalMin * 60 * 1000,
          (log: (msg: string) => void) => {
            try {
              const { marked } = autoMarkAbsentForToday();
              if (marked > 0) log(`[attendance] 自动标记缺勤 ${marked} 人次`);
            } catch (e) {
              log(`[attendance] 自动缺勤判定失败: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        );
      }
    } catch (e) {
      ctx.log.warn(`[attendance-record] 定时任务注册失败（可在明细页手动「一键标记缺勤」）: ${e instanceof Error ? e.message : String(e)}`);
    }

    ctx.log.info('Plugin activated');
  },

  async deactivate() {
    // ctx.db.dropAllTables() 由 PluginHost 自动调用
  },
};
