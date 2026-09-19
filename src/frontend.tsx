import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer } from 'recharts';

// 模块级 FrontendPluginContext
let ctx: any = null;
let ReactDOM: any = null;

async function invoke<T = any>(type: string, payload?: any): Promise<T> {
  if (!ctx) throw new Error('Plugin not activated');
  return ctx.invokeCommand(type, payload);
}

async function getSession(): Promise<any> {
  try {
    const r: any = await ctx.services.frontendApi.get('/api/auth/session');
    return r?.session || null;
  } catch {
    return null;
  }
}

// ── 教师端：课堂在场学生自动签到 ────────────────────────
// 宿主的在线状态（presence）只在 socket 上广播、后端订阅不到，且上课态
// student.view 扩展点不挂载，因此改由教师端代记：订阅 presence-update，把
// 「当前课件在场学生 ∩ class_students 名册」写入已到。
interface PresenceSnapshot {
  onlineStudentIds: string[];
  activeStudentLessons: Record<string, string>;
}
let latestPresence: PresenceSnapshot | null = null;
let autoSyncTarget: { lessonId: string; classId: string } | null = null;
const syncedKeys = new Set<string>();
const syncListeners = new Set<() => void>();
let lastSyncAt = 0;
let syncStats = { inLesson: 0, synced: 0, error: '' as string };

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function resolveAutoSyncTarget(): { lessonId: string; classId: string } | null {
  if (autoSyncTarget?.lessonId) return autoSyncTarget;
  const hostCtx = ctx?.context?.get?.();
  return hostCtx?.lessonId ? { lessonId: hostCtx.lessonId, classId: hostCtx.classId || '' } : null;
}

function studentsInLesson(lessonId: string): string[] {
  if (!latestPresence) return [];
  const online = new Set(latestPresence.onlineStudentIds || []);
  const map = latestPresence.activeStudentLessons || {};
  return Object.keys(map).filter((sid) => map[sid] === lessonId && online.has(sid));
}

async function syncPresentFromPresence(force = false): Promise<void> {
  const target = resolveAutoSyncTarget();
  if (!ctx || !target || !latestPresence) return;
  // presence 抖动频繁，非强制同步做最小 3s 节流
  if (!force && Date.now() - lastSyncAt < 3000) return;

  const date = todayStr();
  const inLesson = studentsInLesson(target.lessonId);
  const todo = force
    ? inLesson
    : inLesson.filter((sid) => !syncedKeys.has(`${target.lessonId}|${sid}|${date}`));
  if (todo.length === 0) {
    syncStats = { inLesson: inLesson.length, synced: inLesson.length, error: '' };
    return;
  }

  lastSyncAt = Date.now();
  try {
    await invoke('attendance.sync_present', {
      lessonId: target.lessonId,
      classId: target.classId || undefined,
      studentIds: todo,
      date,
    });
    for (const sid of todo) syncedKeys.add(`${target.lessonId}|${sid}|${date}`);
    syncStats = { inLesson: inLesson.length, synced: inLesson.length, error: '' };
    syncListeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  } catch (e: any) {
    // 不静默吞错：面板与控制台都能看到，下次 presence 变更会自动重试
    const msg = e?.message || String(e);
    syncStats = { inLesson: inLesson.length, synced: syncStats.synced, error: msg };
    console.warn('[attendance] 自动签到失败:', msg);
    syncListeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  }
}

function startPresenceAutoSync(): void {
  const socketService = ctx?.services?.socketService;
  if (!socketService?.on) return;
  socketService.on('presence-update', (data: any) => {
    if (!data) return;
    latestPresence = {
      onlineStudentIds: data.onlineStudentIds || [],
      activeStudentLessons: data.activeStudentLessons || {},
    };
    syncPresentFromPresence(false);
  });
}

const S = {
  muted: { color: '#9ca3af', fontSize: 12 },
  label: { fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 },
  input: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, width: '100%', boxSizing: 'border-box' as const },
  btn: { padding: '6px 14px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 },
  btnGhost: { padding: '6px 14px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 },
  th: { textAlign: 'left' as const, padding: '6px 8px', borderBottom: '1px solid #e5e7eb', color: '#6b7280', fontWeight: 500, whiteSpace: 'nowrap' as const },
  td: { padding: '6px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 13, whiteSpace: 'nowrap' as const },
};

const STATUS_LABELS: Record<string, string> = { present: '已到', late: '迟到', leave: '请假', absent: '缺勤' };
const STATUS_COLORS: Record<string, string> = { present: '#16a34a', late: '#d97706', leave: '#2563eb', absent: '#dc2626' };

function statusBadge(s: string) {
  const st = s || 'present';
  return React.createElement('span', {
    style: { padding: '2px 8px', borderRadius: 6, fontSize: 11, background: STATUS_COLORS[st] || '#9ca3af', color: '#fff', whiteSpace: 'nowrap' },
  }, STATUS_LABELS[st] || st);
}

// ── 学生端：自动记录组件（student.view）──────────────────
function StudentAttendanceRecorder(props: { lessonId?: string | null; classId?: string | null }) {
  const [session, setSession] = useState<any>(null);
  const [status, setStatus] = useState<'idle' | 'recording' | 'done' | 'error' | 'skip'>('idle');
  const [msg, setMsg] = useState('');
  const attemptedRef = useRef('');

  useEffect(() => {
    getSession().then((s) => setSession(s)).catch(() => setSession(null));
  }, []);

  useEffect(() => {
    const lessonId = props.lessonId || null;
    const classId = props.classId || null;
    // 宿主 session 里学生 ID 可能是 userId，也可能只有旧字段 studentId
    const studentId = session?.userId || session?.studentId;
    if (!lessonId || !studentId || session?.role !== 'student') {
      setStatus('skip');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const key = `${lessonId}|${studentId}|${today}`;
    if (attemptedRef.current === key) return;
    attemptedRef.current = key;
    setStatus('recording');
    setMsg('记录中…');
    invoke('attendance.record_entry', { lessonId, classId, studentId, studentName: session.name })
      .then((r: any) => {
        setStatus('done');
        setMsg(r?.already ? '今日已记录' : '✅ 已记录考勤');
      })
      .catch((e: any) => {
        setStatus('error');
        setMsg(e?.message || '记录失败');
      });
  }, [props.lessonId, props.classId, session]);

  if (status === 'skip') return null;
  return React.createElement('div', {
    style: { padding: '8px 12px', fontSize: 12, color: status === 'error' ? '#ef4444' : '#6b7280', display: 'flex', alignItems: 'center', gap: 6 },
  },
    React.createElement('span', null, status === 'recording' ? '⏳' : status === 'done' ? '📌' : '⚠️'),
    React.createElement('span', null, msg || '考勤'),
  );
}

// ── 通用：日期→星期 ─────────────────────────────────────
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
function weekdayOf(dateStr: string): string {
  if (!dateStr) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return '';
  return WEEKDAYS[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()] || '';
}

// ── 教师端：记录表单（新增/编辑复用）────────────────────
function RecordForm(props: { classes: any[]; students: any[]; lessons: any[]; editing: any; onCancel: () => void; onSaved: () => void }) {
  const { classes, students, lessons, editing, onCancel, onSaved } = props;
  const [form, setForm] = useState<any>(() => (editing
    ? {
        classId: editing.class_id || '', lessonId: editing.lesson_id || '',
        studentId: editing.student_id || '', studentName: editing.student_name || '',
        date: editing.date || '', timeSlot: editing.time_slot || '',
        topic: editing.topic || '', teacher: editing.teacher || '',
        machineNo: editing.machine_no || '', ipAddress: editing.ip_address || '',
        status: editing.status || 'present', note: editing.note || '',
      }
    : {
        classId: '', lessonId: '', studentId: '', studentName: '',
        date: new Date().toISOString().slice(0, 10), timeSlot: '',
        topic: '', teacher: '', machineNo: '', ipAddress: '', status: 'present', note: '',
      }));

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const onClassChange = (classId: string) => {
    set('classId', classId);
  };
  const onLessonChange = (lessonId: string) => {
    const l = lessons.find((x: any) => x.id === lessonId);
    set('lessonId', lessonId);
    if (l && !form.topic) set('topic', l.title);
  };
  const onStudentChange = (studentId: string) => {
    const s = students.find((x: any) => x.id === studentId);
    set('studentId', studentId);
    if (s) set('studentName', s.name);
  };

  const submit = async () => {
    if (!form.studentId || !form.lessonId) { alert('请选择学生和课题'); return; }
    if (editing) {
      await invoke('attendance.update_record', { id: editing.id, ...form });
    } else {
      await invoke('attendance.add_record', form);
    }
    onSaved();
  };

  const field = (label: string, key: string, placeholder?: string) =>
    React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 130 } },
      React.createElement('span', { style: S.label }, label),
      React.createElement('input', { value: form[key] || '', placeholder, onChange: (e: any) => set(key, e.target.value), style: S.input }),
    );

  const sel = (label: string, key: string, options: { value: string; text: string }[], onChange?: (v: string) => void) =>
    React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 130 } },
      React.createElement('span', { style: S.label }, label),
      React.createElement('select', {
        value: form[key] || '',
        onChange: (e: any) => (onChange ? onChange(e.target.value) : set(key, e.target.value)),
        style: S.input,
      },
        React.createElement('option', { value: '' }, '— 选择 —'),
        options.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.text)),
      ),
    );

  return React.createElement('div', { style: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, marginBottom: 14 } },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
      React.createElement('strong', { style: { fontSize: 14 } }, editing ? '编辑记录' : '手动补录'),
      React.createElement('button', { onClick: onCancel, style: S.btnGhost }, '取消'),
    ),
    React.createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 } },
      sel('班级', 'classId', classes.map((c: any) => ({ value: c.id, text: c.name || c.id })), onClassChange),
      sel('学生', 'studentId', students.map((s: any) => ({ value: s.id, text: `${s.name || ''}（${s.student_number || s.id}）` })), onStudentChange),
      sel('课题', 'lessonId', lessons.map((l: any) => ({ value: l.id, text: l.title || l.id })), onLessonChange),
    ),
    React.createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
      sel('状态', 'status', [
        { value: 'present', text: '已到' },
        { value: 'late', text: '迟到' },
        { value: 'leave', text: '请假' },
        { value: 'absent', text: '缺勤' },
      ]),
      field('日期', 'date', 'YYYY-MM-DD'),
      field('时间区间', 'timeSlot', 'HH:MM-HH:MM'),
      field('课题(可改)', 'topic'),
      field('教师', 'teacher'),
      field('机号', 'machineNo'),
      field('IP地址', 'ipAddress'),
      field('备注', 'note'),
    ),
    React.createElement('div', { style: { marginTop: 12, display: 'flex', gap: 10 } },
      React.createElement('button', { onClick: submit, style: S.btn }, editing ? '保存修改' : '新增记录'),
    ),
  );
}

// ── 教师端：批量标记表单 ───────────────────────────────
function BatchMarkForm(props: { classId: string; students: any[]; lessons: any[]; onCancel: () => void; onDone: () => void }) {
  const { classId, students, lessons, onCancel, onDone } = props;
  const [lessonId, setLessonId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState('absent');
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const toggle = (id: string) => setChecked((c) => ({ ...c, [id]: !c[id] }));

  const markSelected = async () => {
    const ids = Object.keys(checked).filter((k) => checked[k]);
    if (!lessonId) { alert('请选择课题'); return; }
    if (ids.length === 0) { alert('请勾选学生'); return; }
    await invoke('attendance.batch_mark', { lessonId, classId, date, status, studentIds: ids });
    onDone();
  };

  const markAllAbsent = async () => {
    if (!lessonId) { alert('请选择课题'); return; }
    if (!confirm('将把该课节当日所有「未记录」的学生标记为缺勤（已到/迟到/请假不覆盖），确定？')) return;
    await invoke('attendance.batch_mark_all_absent', { lessonId, classId, date });
    onDone();
  };

  return React.createElement('div', { style: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 14, marginBottom: 14 } },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
      React.createElement('strong', { style: { fontSize: 14, color: '#b91c1c' } }, '批量标记'),
      React.createElement('button', { onClick: onCancel, style: S.btnGhost }, '取消'),
    ),
    React.createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 } },
        React.createElement('span', { style: S.label }, '课题'),
        React.createElement('select', { value: lessonId, onChange: (e: any) => setLessonId(e.target.value), style: S.input },
          React.createElement('option', { value: '' }, '— 选择课题 —'),
          lessons.map((l: any) => React.createElement('option', { key: l.id, value: l.id }, l.title || l.id)),
        ),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '日期'),
        React.createElement('input', { type: 'date', value: date, onChange: (e: any) => setDate(e.target.value), style: S.input }),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '状态'),
        React.createElement('select', { value: status, onChange: (e: any) => setStatus(e.target.value), style: S.input },
          React.createElement('option', { value: 'absent' }, '缺勤'),
          React.createElement('option', { value: 'late' }, '迟到'),
          React.createElement('option', { value: 'leave' }, '请假'),
        ),
      ),
      React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-end', paddingBottom: 1 } },
        React.createElement('button', { onClick: markAllAbsent, style: { ...S.btn, background: '#dc2626' } }, '一键标记缺勤'),
        React.createElement('button', { onClick: markSelected, style: S.btn }, '标记选中学生'),
      ),
    ),
    React.createElement('div', { style: { fontSize: 12, color: '#6b7280', marginBottom: 6 } },
      classId ? `勾选要标记的学生（共 ${students.length} 人）` : '请先在筛选区选择班级，再勾选学生',
    ),
    students.length > 0 ? React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 180, overflow: 'auto' } },
      students.map((s: any) => React.createElement('label', {
        key: s.id, style: { display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', background: checked[s.id] ? '#fee2e2' : '#fff', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
      },
        React.createElement('input', { type: 'checkbox', checked: !!checked[s.id], onChange: () => toggle(s.id) }),
        React.createElement('span', null, s.name || s.student_number || s.id),
      )),
    ) : null,
  );
}

// ── 教师端：明细视图 ────────────────────────────────────
function DetailView() {
  const [classes, setClasses] = useState<any[]>([]);
  const [students, setStudents] = useState<any[]>([]);
  const [lessons, setLessons] = useState<any[]>([]);
  const [classId, setClassId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [records, setRecords] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [showBatchMark, setShowBatchMark] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const loadClasses = useCallback(() => { invoke<any[]>('attendance.list_classes').then((r) => setClasses(r || [])); }, []);
  useEffect(() => { loadClasses(); invoke<any[]>('attendance.list_lessons').then((r) => setLessons(r || [])); }, [loadClasses]);

  useEffect(() => {
    if (classId) invoke<any[]>('attendance.list_students', { classId }).then((r) => setStudents(r || []));
    else setStudents([]);
  }, [classId]);

  const query = useCallback(async () => {
    setLoading(true);
    try {
      const r = await invoke<any>('attendance.list_records', { classId: classId || undefined, startDate: startDate || undefined, endDate: endDate || undefined, status: statusFilter || undefined, limit: 1000 });
      setRecords(r?.records || []);
      setTotal(r?.total || 0);
    } finally { setLoading(false); }
  }, [classId, startDate, endDate, statusFilter]);

  useEffect(() => { query(); }, [query]);

  const exportCsv = () => {
    const header = ['日期', '星期', '节次', '时间区间', '课题', '教师', '学生', '机号', 'IP地址', '状态', '来源'];
    const rows = records.map((r: any) => [
      r.date, r.weekday, r.period_no, r.time_slot, r.topic, r.teacher, r.student_name, r.machine_no, r.ip_address,
      STATUS_LABELS[r.status] || r.status || '已到',
      r.source === 'auto' ? '自动' : '手动',
    ]);
    const csv = '\uFEFF' + [header, ...rows].map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    ctx.services.uiService.downloadFile(csv, `attendance_${classId || 'all'}.csv`, 'text/csv');
  };

  return React.createElement('div', { style: { padding: 16 } },
    React.createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 } },
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '班级'),
        React.createElement('select', { value: classId, onChange: (e: any) => setClassId(e.target.value), style: { ...S.input, width: 180 } },
          React.createElement('option', { value: '' }, '全部班级'),
          classes.map((c: any) => React.createElement('option', { key: c.id, value: c.id }, c.name || c.id)),
        ),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '开始日期'),
        React.createElement('input', { type: 'date', value: startDate, onChange: (e: any) => setStartDate(e.target.value), style: S.input }),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '结束日期'),
        React.createElement('input', { type: 'date', value: endDate, onChange: (e: any) => setEndDate(e.target.value), style: S.input }),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '状态'),
        React.createElement('select', { value: statusFilter, onChange: (e: any) => setStatusFilter(e.target.value), style: S.input },
          React.createElement('option', { value: '' }, '全部'),
          React.createElement('option', { value: 'present' }, '已到'),
          React.createElement('option', { value: 'late' }, '迟到'),
          React.createElement('option', { value: 'leave' }, '请假'),
          React.createElement('option', { value: 'absent' }, '缺勤'),
        ),
      ),
      React.createElement('button', { onClick: () => { setShowForm(true); setEditing(null); }, style: S.btn }, '+ 手动补录'),
      React.createElement('button', { onClick: () => setShowBatchMark(!showBatchMark), style: { ...S.btnGhost, color: '#dc2626', borderColor: '#fecaca' } }, '批量标记'),
      React.createElement('button', { onClick: exportCsv, style: S.btnGhost }, '导出 CSV'),
    ),

    showForm ? React.createElement(RecordForm, {
      classes, students, lessons, editing,
      onCancel: () => { setShowForm(false); setEditing(null); },
      onSaved: () => { setShowForm(false); setEditing(null); query(); },
    }) : null,

    showBatchMark ? React.createElement(BatchMarkForm, {
      classId, students, lessons,
      onCancel: () => setShowBatchMark(false),
      onDone: () => { setShowBatchMark(false); query(); },
    }) : null,

    React.createElement('div', { style: { fontSize: 12, color: '#6b7280', marginBottom: 8 } },
      `共 ${total} 条记录${loading ? '（查询中…）' : ''}`,
    ),

    React.createElement('div', { style: { overflowX: 'auto' } },
      React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse' } },
        React.createElement('thead', null,
          React.createElement('tr', null,
            ['日期', '星期', '节次', '时间区间', '课题', '教师', '学生', '机号', 'IP', '状态', '来源', '操作'].map((h) =>
              React.createElement('th', { key: h, style: S.th }, h),
            ),
          ),
        ),
        React.createElement('tbody', null,
          records.map((r: any) => React.createElement('tr', { key: r.id },
            React.createElement('td', { style: S.td }, r.date),
            React.createElement('td', { style: S.td }, r.weekday),
            React.createElement('td', { style: S.td }, r.period_no),
            React.createElement('td', { style: S.td }, r.time_slot),
            React.createElement('td', { style: S.td }, r.topic),
            React.createElement('td', { style: S.td }, r.teacher),
            React.createElement('td', { style: S.td }, r.student_name),
            React.createElement('td', { style: S.td }, r.machine_no),
            React.createElement('td', { style: S.td }, r.ip_address),
            React.createElement('td', { style: S.td }, statusBadge(r.status)),
            React.createElement('td', { style: S.td }, r.source === 'auto' ? '自动' : '手动'),
            React.createElement('td', { style: S.td },
              React.createElement('button', {
                onClick: () => { setEditing(r); setShowForm(true); },
                style: { ...S.btnGhost, marginRight: 6, padding: '3px 10px', fontSize: 12 },
              }, '编辑'),
              React.createElement('button', {
                onClick: async () => { if (confirm('确认删除这条考勤记录？')) { await invoke('attendance.delete_record', { id: r.id }); query(); } },
                style: { ...S.btnGhost, color: '#ef4444', padding: '3px 10px', fontSize: 12 },
              }, '删除'),
            ),
          )),
          records.length === 0 ? React.createElement('tr', null,
            React.createElement('td', { colSpan: 12, style: { ...S.td, textAlign: 'center', color: '#9ca3af', padding: 24 } }, '暂无记录'),
          ) : null,
        ),
      ),
    ),
  );
}

// ── 教师端：汇总视图 ────────────────────────────────────
function SummaryView() {
  const [classes, setClasses] = useState<any[]>([]);
  const [classId, setClassId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [summary, setSummary] = useState<any>(null);

  useEffect(() => { invoke<any[]>('attendance.list_classes').then((r) => setClasses(r || [])); }, []);

  const query = async () => {
    if (!classId) return;
    const r = await invoke<any>('attendance.class_summary', { classId, startDate: startDate || undefined, endDate: endDate || undefined });
    setSummary(r);
  };

  useEffect(() => { if (classId) query(); }, [classId]);

  const o = summary?.overview;
  const per = summary?.perStudent || [];

  const card = (label: string, value: any, color = '#2563eb') =>
    React.createElement('div', { style: { padding: '14px 18px', background: '#f9fafb', borderRadius: 10, border: '1px solid #e5e7eb', minWidth: 140 } },
      React.createElement('div', { style: { fontSize: 12, color: '#6b7280', marginBottom: 6 } }, label),
      React.createElement('div', { style: { fontSize: 22, fontWeight: 700, color } }, String(value ?? '—')),
    );

  return React.createElement('div', { style: { padding: 16 } },
    React.createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 } },
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '班级'),
        React.createElement('select', { value: classId, onChange: (e: any) => setClassId(e.target.value), style: { ...S.input, width: 200 } },
          React.createElement('option', { value: '' }, '— 选择班级 —'),
          classes.map((c: any) => React.createElement('option', { key: c.id, value: c.id }, c.name || c.id)),
        ),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '开始日期'),
        React.createElement('input', { type: 'date', value: startDate, onChange: (e: any) => setStartDate(e.target.value), style: S.input }),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '结束日期'),
        React.createElement('input', { type: 'date', value: endDate, onChange: (e: any) => setEndDate(e.target.value), style: S.input }),
      ),
      React.createElement('button', { onClick: query, disabled: !classId, style: { ...S.btn, opacity: classId ? 1 : 0.5 } }, '查询'),
    ),

    o ? React.createElement('div', { style: { marginBottom: 16 } },
      React.createElement('h3', { style: { margin: '0 0 4px', fontSize: 15 } }, o.className),
      o.semesterName ? React.createElement('div', { style: S.muted }, o.semesterName) : null,
      React.createElement('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 } },
        card('学生人数', o.totalStudents),
        card('考勤总记录', o.totalRecords),
        card('已出勤天数', o.attendedDates, '#16a34a'),
        card('应出勤天数', o.scheduledDates),
        card('班级出勤率', o.scheduledDates > 0 ? `${Math.round((o.attendedDates / o.scheduledDates) * 100)}%` : '—', '#eab308'),
      ),
    ) : null,

    per.length > 0 ? React.createElement('div', { style: { overflowX: 'auto' } },
      React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse' } },
        React.createElement('thead', null,
          React.createElement('tr', null,
            ['学号', '姓名', '记录数', '出勤天数', '请假天数', '缺勤天数', '出勤率', '最近一次'].map((h) =>
              React.createElement('th', { key: h, style: S.th }, h),
            ),
          ),
        ),
        React.createElement('tbody', null,
          per.map((s: any) => React.createElement('tr', { key: s.studentId },
            React.createElement('td', { style: S.td }, s.studentNo),
            React.createElement('td', { style: S.td }, s.name),
            React.createElement('td', { style: S.td }, s.recordCount),
            React.createElement('td', { style: S.td }, s.attendedDays),
            React.createElement('td', { style: S.td }, s.leaveDays == null ? '—' : s.leaveDays),
            React.createElement('td', { style: S.td }, s.absentDays == null ? '—' : s.absentDays),
            React.createElement('td', { style: S.td }, s.rate == null ? '—' : `${s.rate}%`),
            React.createElement('td', { style: S.td }, s.lastAttended ? new Date(s.lastAttended).toLocaleString() : '—'),
          )),
        ),
      ),
    ) : (classId ? React.createElement('p', { style: S.muted }, '该班级暂无考勤记录') : null),
  );
}

// ── 教师端：统计图表视图 ──────────────────────────────
function ChartView() {
  const [classes, setClasses] = useState<any[]>([]);
  const [classId, setClassId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [data, setData] = useState<any[]>([]);

  useEffect(() => { invoke<any[]>('attendance.list_classes').then((r) => setClasses(r || [])); }, []);

  const query = async () => {
    if (!classId) return;
    const r = await invoke<any[]>('attendance.daily_stats', { classId, startDate: startDate || undefined, endDate: endDate || undefined });
    setData(r || []);
  };

  useEffect(() => { if (classId) query(); }, [classId]);

  const chartData = data.map((d) => ({ ...d, name: (d.date || '').slice(5) }));

  return React.createElement('div', { style: { padding: 16 } },
    React.createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 } },
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '班级'),
        React.createElement('select', { value: classId, onChange: (e: any) => setClassId(e.target.value), style: { ...S.input, width: 200 } },
          React.createElement('option', { value: '' }, '— 选择班级 —'),
          classes.map((c: any) => React.createElement('option', { key: c.id, value: c.id }, c.name || c.id)),
        ),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '开始日期'),
        React.createElement('input', { type: 'date', value: startDate, onChange: (e: any) => setStartDate(e.target.value), style: S.input }),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: S.label }, '结束日期'),
        React.createElement('input', { type: 'date', value: endDate, onChange: (e: any) => setEndDate(e.target.value), style: S.input }),
      ),
      React.createElement('button', { onClick: query, disabled: !classId, style: { ...S.btn, opacity: classId ? 1 : 0.5 } }, '查询'),
    ),
    data.length > 0 ? React.createElement('div', null,
      React.createElement('div', { style: { marginBottom: 24 } },
        React.createElement('h4', { style: { margin: '0 0 10px', fontSize: 14 } }, '每日考勤分布'),
        React.createElement(ResponsiveContainer, { width: '100%', height: 300 },
          React.createElement(BarChart, { data: chartData },
            React.createElement(CartesianGrid, { strokeDasharray: '3 3' }),
            React.createElement(XAxis, { dataKey: 'name' }),
            React.createElement(YAxis, { allowDecimals: false }),
            React.createElement(Tooltip, {}),
            React.createElement(Legend, {}),
            React.createElement(Bar, { dataKey: 'present', name: '已到', stackId: 'a', fill: '#16a34a' }),
            React.createElement(Bar, { dataKey: 'late', name: '迟到', stackId: 'a', fill: '#eab308' }),
            React.createElement(Bar, { dataKey: 'leave', name: '请假', stackId: 'a', fill: '#2563eb' }),
            React.createElement(Bar, { dataKey: 'absent', name: '缺勤', stackId: 'a', fill: '#dc2626' }),
          ),
        ),
      ),
      React.createElement('div', null,
        React.createElement('h4', { style: { margin: '0 0 10px', fontSize: 14 } }, '出勤率趋势（%）'),
        React.createElement(ResponsiveContainer, { width: '100%', height: 260 },
          React.createElement(LineChart, { data: chartData },
            React.createElement(CartesianGrid, { strokeDasharray: '3 3' }),
            React.createElement(XAxis, { dataKey: 'name' }),
            React.createElement(YAxis, { domain: [0, 100] }),
            React.createElement(Tooltip, {}),
            React.createElement(Line, { type: 'monotone', dataKey: 'rate', name: '出勤率', stroke: '#2563eb', strokeWidth: 2, dot: true }),
          ),
        ),
      ),
    ) : React.createElement('p', { style: S.muted }, classId ? '暂无数据' : '请选择班级'),
  );
}

// ── 教师端：主面板（teacher.tab）────────────────────────
function TeacherAttendancePanel() {
  const [tab, setTab] = useState<'detail' | 'summary' | 'chart'>('detail');
  const tabs = [
    { id: 'detail', label: '考勤明细' },
    { id: 'summary', label: '学期汇总' },
    { id: 'chart', label: '统计图表' },
  ] as const;

  return React.createElement('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
    React.createElement('div', { style: { display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 16px' } },
      tabs.map((t) => React.createElement('button', {
        key: t.id,
        onClick: () => setTab(t.id),
        style: {
          padding: '10px 16px', border: 'none', background: 'none', cursor: 'pointer',
          borderBottom: tab === t.id ? '2px solid #2563eb' : '2px solid transparent',
          color: tab === t.id ? '#2563eb' : '#6b7280', fontWeight: tab === t.id ? 600 : 400, fontSize: 14,
        },
      }, t.label)),
    ),
    React.createElement('div', { style: { flex: 1, overflow: 'auto' } },
      tab === 'detail' ? React.createElement(DetailView)
        : tab === 'summary' ? React.createElement(SummaryView)
        : React.createElement(ChartView),
    ),
  );
}

// ── 教师端：课堂工具架实时考勤面板（classroom.tool）──────
function ClassroomAttendancePanel(props: { lessonId?: string | null; classId?: string | null }) {
  const [visible, setVisible] = useState(false);
  const [overview, setOverview] = useState<any>(null);
  const [, setTick] = useState(0);
  const lessonId = props.lessonId || null;
  const classId = props.classId || null;

  const load = useCallback(async () => {
    if (!lessonId) { setOverview(null); return; }
    try {
      const r = await invoke('attendance.lesson_overview', { lessonId, classId });
      setOverview(r);
    } catch { setOverview(null); }
  }, [lessonId, classId]);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  // 面板可见时轮询刷新：attendance.* 事件不会被宿主转发到 socket，只能主动拉取
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [visible, load]);

  // 自动签到器写库后立即刷新
  useEffect(() => {
    const handler = () => { setTick((t) => t + 1); if (visible) load(); };
    syncListeners.add(handler);
    return () => { syncListeners.delete(handler); };
  }, [visible, load]);

  // 把当前课堂（课件/班级）告知自动签到器，并在打开面板时用最新 presence 补记一次
  useEffect(() => {
    autoSyncTarget = lessonId ? { lessonId, classId: classId || '' } : null;
    return () => { autoSyncTarget = null; };
  }, [lessonId, classId]);

  useEffect(() => {
    if (!visible) return;
    syncPresentFromPresence(true).then(() => load());
  }, [visible, load]);

  const toggle = () => setVisible((v) => !v);

  const btnStyle = {
    width: 36, height: 36, border: '1px solid #e5e7eb', borderRadius: 8,
    background: visible ? '#eff6ff' : '#fff', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
  } as const;
  const btn = React.createElement('button', { onClick: toggle, title: '课堂考勤', style: btnStyle }, '📋');

  if (!ReactDOM) return btn;

  const panel = visible ? ReactDOM.createPortal(
    React.createElement('div', {
      style: { position: 'fixed', top: 80, right: 20, width: 340, maxHeight: '72vh', overflow: 'auto', background: '#fff', borderRadius: 12, boxShadow: '0 4px 24px rgba(0,0,0,0.15)', zIndex: 9999, padding: 16, fontSize: 13 },
    },
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
        React.createElement('strong', null, '📋 课堂考勤'),
        React.createElement('button', { onClick: toggle, style: { border: 'none', background: 'none', cursor: 'pointer', fontSize: 16 } }, '✕'),
      ),
      !overview ? React.createElement('p', { style: { color: '#9ca3af' } }, lessonId ? '加载中…' : '当前无课程') :
      React.createElement('div', null,
        React.createElement('div', { style: { marginBottom: 10 } },
          React.createElement('div', { style: { fontWeight: 600, fontSize: 14 } }, overview.topic || '(无课题)'),
          React.createElement('div', { style: S.muted },
            `${overview.date} ${overview.weekday}  ${overview.periodNo || ''} ${overview.timeSlot}  ·  教师：${overview.teacher || '—'}${overview.className ? '  ·  ' + overview.className : ''}`,
          ),
        ),
        React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' } },
          React.createElement('span', { style: { padding: '4px 10px', borderRadius: 6, background: '#dcfce7', color: '#16a34a', fontWeight: 600 } }, `✅ 已到 ${overview.presentCount}`),
          React.createElement('span', { style: { padding: '4px 10px', borderRadius: 6, background: '#fef3c7', color: '#b45309', fontWeight: 600 } }, `⏰ 迟到 ${overview.lateCount || 0}`),
          React.createElement('span', { style: { padding: '4px 10px', borderRadius: 6, background: '#dbeafe', color: '#1d4ed8', fontWeight: 600 } }, `🏠 请假 ${overview.leaveCount || 0}`),
          React.createElement('span', { style: { padding: '4px 10px', borderRadius: 6, background: '#fee2e2', color: '#dc2626', fontWeight: 600 } }, `❌ 缺勤 ${overview.absentCount}`),
          React.createElement('span', { style: { padding: '4px 10px', borderRadius: 6, background: '#f3f4f6', color: '#6b7280', fontWeight: 600 } }, `共 ${overview.total}`),
        ),
        overview.absent && overview.absent.length > 0 ? React.createElement('div', { style: { marginBottom: 12 } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 6, color: '#dc2626' } }, '缺勤名单'),
          React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            overview.absent.map((s: any) => React.createElement('span', { key: s.studentId, style: { padding: '2px 8px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12 } }, s.name || s.studentNo)),
          ),
        ) : React.createElement('div', { style: { marginBottom: 12, color: '#16a34a', fontWeight: 600 } }, '无缺勤 ✓'),
        overview.late && overview.late.length > 0 ? React.createElement('div', { style: { marginBottom: 12 } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 6, color: '#b45309' } }, '迟到名单'),
          React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            overview.late.map((s: any) => React.createElement('span', { key: s.studentId, style: { padding: '2px 8px', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, fontSize: 12 } }, s.name || s.studentNo)),
          ),
        ) : null,
        overview.leave && overview.leave.length > 0 ? React.createElement('div', { style: { marginBottom: 12 } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 6, color: '#1d4ed8' } }, '请假名单'),
          React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            overview.leave.map((s: any) => React.createElement('span', { key: s.studentId, style: { padding: '2px 8px', background: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 12 } }, s.name || s.studentNo)),
          ),
        ) : null,
        overview.present && overview.present.length > 0 ? React.createElement('div', null,
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, '已到名单'),
          React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            overview.present.map((s: any) => React.createElement('span', { key: s.studentId, title: `机号 ${s.machineNo || '—'}  IP ${s.ip || '—'}`, style: { padding: '2px 8px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, fontSize: 12 } }, s.name || s.studentNo)),
          ),
        ) : null,
      ),
      React.createElement('div', { style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('span', { style: { ...S.muted, color: syncStats.error ? '#dc2626' : '#9ca3af' } },
          syncStats.error ? `自动签到失败：${syncStats.error}` : `自动签到：在场 ${syncStats.inLesson} 人`),
        React.createElement('button', {
          onClick: async () => { await syncPresentFromPresence(true); load(); },
          style: { ...S.btnGhost, padding: '3px 10px', fontSize: 12 },
        }, '立即同步'),
      ),
    ), document.body) : null;

  return React.createElement('div', null, btn, panel);
}

// ── activate ────────────────────────────────────────────
async function activate(hostCtx: any) {
  ctx = hostCtx;
  if ((window as any).HostSharedDeps?.ReactDOM) {
    ReactDOM = (window as any).HostSharedDeps.ReactDOM;
  }

  // 学生端：进入课程自动记录
  hostCtx.ui.registerExtensionPoint('student.view', {
    id: 'attendance-student-recorder',
    label: '考勤记录',
    icon: 'ClipboardCheck',
    component: StudentAttendanceRecorder,
    position: 99,
    group: 'teaching',
  });

  // 教师端：明细 + 汇总
  hostCtx.ui.registerExtensionPoint('teacher.tab', {
    id: 'attendance-teacher-tab',
    label: '考勤记录',
    icon: 'ClipboardList',
    component: TeacherAttendancePanel,
    position: 60,
    group: 'management',
  });

  // 教师/管理员端：订阅宿主 presence，把课堂在场学生自动记为已到
  getSession()
    .then((s) => {
      const role = s?.role || s?.subRole;
      if (role === 'teacher' || role === 'administrator' || role === 'admin') {
        startPresenceAutoSync();
      }
    })
    .catch(() => { /* 未登录时跳过 */ });

  // 教师端：课堂工具架实时考勤按钮（含缺勤名单）
  hostCtx.ui.registerExtensionPoint('classroom.tool', {
    id: 'attendance-classroom-tool',
    label: '课堂考勤',
    icon: 'ClipboardCheck',
    component: ClassroomAttendancePanel,
    position: 60,
    group: 'teaching',
  });
}

function deactivate() {}

export default { activate, deactivate };
