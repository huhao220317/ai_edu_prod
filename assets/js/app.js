/* ==========================================================================
   app.js — 语文课堂提问系统
   功能：课文管理 / 题目上传（CSV·TXT·JSON）/ 随堂答题 / 自动判分 / 结果统计
   数据：全部保存在浏览器 localStorage，无需后端
   ========================================================================== */

'use strict';

/* ============================== 常量 ============================== */
const STORAGE_KEY  = 'yw_quiz_bank_v1';
const SESSION_KEY  = 'yw_quiz_session_v1';
const SCORE_KEY    = 'yw_quiz_scores_v1';
const DEMO_SEED_KEY = 'yw_quiz_demo_seed';

/* 课堂提问相关 */
const ROSTER_KEY    = 'yw_quiz_roster_v1';     // 学生名单：班级 + 学生
const ASK_KEY       = 'yw_quiz_ask_v1';        // 正在进行 / 最近一次的提问
const ASK_DRAFT_KEY = 'yw_quiz_ask_draft_v1';  // 提问设置页的选择（课文、题型、人数…）

/* 便携数据文件（U 盘模式）：网站文件夹里放一个 portable-data.js，双击打开就会自动加载 */
const PORTABLE_FILE   = 'portable-data.js';
const PORTABLE_FORMAT = 'yw-quiz-portable';
const PORTABLE_SAVED_KEY  = 'yw_quiz_local_saved_at';   // 本机数据最后一次变动的时间
const PORTABLE_IGNORE_KEY = 'yw_quiz_portable_ignore';  // 老师选择「保持本机」时记下文件时间，不再打扰

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ALL_TYPES = ['choice', 'judge', 'fill', 'short'];

/* ============================== 全局状态 ============================== */
let bank = null;         // 题库
let session = null;      // 当前答题会话
let manageTab = 'file';  // 题库管理页当前标签
let manageEditing = null; // 正在编辑题目的课文 id（null = 题库管理首页）
let draft = null;        // 题目编辑草稿：{ lessonId, qid, type, stem, options, answer, analysis }
let roster = null;       // 学生名单：{ version, activeClassId, classes: [{ id, name, students: [...] }] }
let assignment = null;   // 课堂提问会话：{ students: [{ studentId, name, questions, marks }], idx, qIdx, ... }
let askDraft = null;     // 提问设置页的选择
let askRevealed = false; // 提问进行页是否已展开答案（内存态，切题即收起）
let rosterFilter = '';   // 学生名单页的搜索词

const $  = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

/* ============================== 工具函数 ============================== */
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
let uidSeq = 0;   // 同毫秒内批量生成 id 时的递增序号，避免随机部分撞号
function uid(prefix) {
  uidSeq = (uidSeq + 1) % 1e9;
  return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + uidSeq.toString(36) + Math.random().toString(36).slice(2, 7);
}
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

/** 取整并限制在 [min, max] 区间内，非法输入返回默认值 */
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** 时间戳 →「10月2日」，用于名单里展示「上次被提问」 */
function shortDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/** 归一化文本：去掉空白与中英文标点，用于答案比对 */
function normText(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？…—·「」『』“”‘’（）()【】〔〕《》〈〉,.!?;:"'`~()\[\]{}<>\-_/\\|]/g, '')
    .toLowerCase();
}
/** 判断题答案归一化 */
function normJudge(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (/不(正确|对|是)|错误|错|×|✗|false|^f$|^n(o)?$/i.test(t)) return '错误';
  if (/正确|对|是|√|✓|true|^t$|^y(es)?$/i.test(t)) return '正确';
  return '';
}
/** 选择题答案归一化：支持 A / A.xxx / 1 / 选项原文 */
function normChoice(raw, options) {
  const t = String(raw == null ? '' : raw).trim();
  const opts = options || [];
  if (/^[A-Ha-h]$/.test(t)) return t.toUpperCase();
  let m = t.match(/^([A-Ha-h])\s*[.、．)）:：]/);
  if (m) return m[1].toUpperCase();
  if (/^[1-9]$/.test(t)) {
    const i = parseInt(t, 10);
    if (i >= 1 && i <= opts.length) return LETTERS[i - 1];
  }
  const idx = opts.findIndex(o => normText(o) === normText(t));
  if (idx >= 0) return LETTERS[idx];
  return t.toUpperCase();
}
/** 题型归一化：先认标准英文键，再认中文写法，最后按内容推断 */
function normType(raw, options, answer) {
  const t = String(raw == null ? '' : raw).trim().toLowerCase();

  // 标准英文键（JSON 备份、程序生成的数据都用这个）
  if (t === 'choice' || t === 'single' || t === 'multi') return 'choice';
  if (t === 'judge' || t === 'bool' || t === 'boolean' || t === 'tf') return 'judge';
  if (t === 'fill' || t === 'blank' || t === 'gap') return 'fill';
  if (t === 'short' || t === 'essay' || t === 'text' || t === 'qa') return 'short';

  // 中文写法
  if (/多选|单选|选择/.test(t)) return 'choice';
  if (/判断|对错|是非/.test(t)) return 'judge';
  if (/填空|补全/.test(t)) return 'fill';
  if (/简答|问答|论述|分析|阅读|表达|习作/.test(t)) return 'short';

  // 未标注或无法识别：按内容推断
  if (options && options.length >= 2) return 'choice';
  if (/^(正确|错误|对|错|是|否|√|×|T|F)$/i.test(String(answer || '').trim())) return 'judge';
  return 'short';
}

function toast(msg, kind) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast is-show' + (kind ? ' is-' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function icon(name) {
  return '<svg aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
}

/* ============================== 存储层 ============================== */
/** 归一化整个题库，确保结构完整、字段规范 */
function normalizeBank(raw) {
  const out = { version: 1, lessons: [] };
  const lessons = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.lessons) ? raw.lessons : []);
  lessons.forEach(ls => {
    if (!ls || typeof ls !== 'object') return;
    const lesson = {
      id: ls.id || uid('ls'),
      title: String(ls.title || ls.name || '未命名课文').trim(),
      grade: String(ls.grade || '').trim(),
      author: String(ls.author || '').trim(),
      desc: String(ls.desc || ls.description || '').trim(),
      updatedAt: ls.updatedAt || Date.now(),
      questions: []
    };
    const qs = Array.isArray(ls.questions) ? ls.questions : [];
    qs.forEach(q => {
      const nq = normalizeQuestion(q);
      if (nq) lesson.questions.push(nq);
    });
    // 允许「先建课文、后录题目」的空课文存在；否则老师在网页上新建的课文一刷新就没了
    out.lessons.push(lesson);
  });
  return out;
}

/** 归一化单道题目，非法返回 null */
function normalizeQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const stem = String(q.stem || q.title || q.question || '').trim();
  if (!stem) return null;

  let options = Array.isArray(q.options) ? q.options.map(o => String(o).trim()).filter(Boolean)
              : (typeof q.options === 'string' && q.options.trim() ? q.options.split(/[|｜]/).map(s => s.trim()).filter(Boolean) : []);

  const type = normType(q.type, options, q.answer);
  const item = {
    id: q.id || uid('q'),
    type: type,
    stem: stem,
    options: type === 'choice' ? options : [],
    answer: '',
    analysis: String(q.analysis || q.explain || '').trim()
  };

  if (type === 'choice') {
    if (item.options.length < 2) return null;   // 只有一个选项的选择题没有意义，视为无效数据
    item.answer = normChoice(q.answer, item.options);
  } else if (type === 'judge') {
    item.answer = normJudge(q.answer) || '正确';
  } else {
    item.answer = String(q.answer == null ? '' : q.answer).trim();
  }
  return item;
}

/** 判断题库是否仍是「未被老师改动过的内置示例」——所有题目 id 都带示例前缀（gc- / zm-） */
function isUntouchedDemo(b) {
  if (!b || !b.lessons.length) return false;
  return b.lessons.every(l => l.questions.length > 0 && l.questions.every(q => /^(gc|zm)-/.test(q.id)));
}

/** 把内置示例里、题库中还不存在的课文补进去（只新增，绝不覆盖已有课文） */
function addMissingDemoLessons(target, demoLessons) {
  let added = 0;
  demoLessons.forEach(dl => {
    if (!target.lessons.some(l => l.title === dl.title)) {
      target.lessons.push(deepClone(dl));
      added++;
    }
  });
  return added;
}

function loadBank() {
  const demoLessons = normalizeBank(deepClone(DEMO_BANK)).lessons;
  let seededVersion = -1;
  try { seededVersion = parseInt(localStorage.getItem(DEMO_SEED_KEY) || '-1', 10); } catch (e) { /* 忽略 */ }

  // 1) 优先读本地已保存的题库
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const b = normalizeBank(JSON.parse(raw));
      if (b.lessons.length) {
        // 内置示例升级：仅当题库完全未被改动时才补齐新课，避免动到老师自己录入的内容
        if (seededVersion !== DEMO_SEED_VERSION && isUntouchedDemo(b)) {
          const added = addMissingDemoLessons(b, demoLessons);
          if (added) saveRawBank(b);
        }
        markDemoSeeded();
        return b;
      }
    }
  } catch (e) { console.warn('[题库] 读取失败', e); }

  // 2) 首次打开：写入完整的内置示例题库
  const demo = normalizeBank(deepClone(DEMO_BANK));
  saveRawBank(demo);
  markDemoSeeded();
  return demo;
}

function saveRawBank(b) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(b)); } catch (e) { /* 忽略 */ }
}
function markDemoSeeded() {
  try { localStorage.setItem(DEMO_SEED_KEY, String(DEMO_SEED_VERSION)); } catch (e) { /* 忽略 */ }
}

function saveBank() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(bank)); markLocalChange(); return true; }
  catch (e) { toast('保存失败：浏览器存储空间不可用', 'bad'); return false; }
}

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function saveSession() {
  if (!session) return;
  try {
    const all = loadSessions();
    all[session.lessonId] = session;
    localStorage.setItem(SESSION_KEY, JSON.stringify(all));
  } catch (e) { /* 忽略 */ }
}
function loadScores() {
  try { return JSON.parse(localStorage.getItem(SCORE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}

/* ---- 题库改动 → 答题会话同步 ---- */
/** 题目内容指纹：题干 / 选项 / 答案任一改动，即视为「换了道题」，旧作答作废 */
function questionSig(q) {
  return JSON.stringify([q.type, q.stem, q.options || [], q.answer]);
}

/** 把会话的题序与当前题库对齐：默认按题库顺序重建，新增题目排在末尾，清掉失效作答 */
function rebaseSessionToLesson(s, lesson) {
  const validIds = lesson.questions.map(q => q.id);
  let next;
  if (s.shuffle || s.subset) {
    // 打乱顺序 / 只练错题：保留原有题序，去掉已不存在的题，不强行插入新题
    next = (s.order || []).filter(id => validIds.indexOf(id) >= 0);
    if (!next.length && validIds.length) next = validIds.slice();   // 错题被删光了，退回全部题目
  } else {
    next = validIds.slice();
  }
  s.order = next;
  Object.keys(s.answers || {}).forEach(qid => {
    if (validIds.indexOf(qid) < 0) delete s.answers[qid];
  });
  if (s.idx >= s.order.length) s.idx = Math.max(0, s.order.length - 1);
  return s;
}

/**
 * 题库被改动后同步所有答题会话，避免答题页出现空题或错判：
 *  · 课文被删除        → 连会话一起清掉
 *  · 题目被删除/重排   → 从题序中移除，新增题目追加到末尾
 *  · 题目内容被改动    → 该题旧作答作废（否则会按新答案显示上次的判分）
 * @param {string} [changedLessonId] 只同步这一篇课文；不传则全量同步
 */
function syncSessionsAfterBankChange(changedLessonId) {
  let all;
  try { all = loadSessions(); } catch (e) { return; }
  let dirty = false;

  Object.keys(all).forEach(lid => {
    const s = all[lid];
    if (!s) { delete all[lid]; dirty = true; return; }
    const lesson = bank.lessons.find(l => l.id === lid);
    if (!lesson) { delete all[lid]; dirty = true; return; }
    if (changedLessonId && lid !== changedLessonId) return;

    const before = (s.order || []).join(',') + '|' + JSON.stringify(s.answers || {});
    rebaseSessionToLesson(s, lesson);
    if (before !== (s.order || []).join(',') + '|' + JSON.stringify(s.answers || {})) dirty = true;

    // 题目内容变了的：作废该题旧作答
    if (!s.sigs) {
      // 老版本会话没有指纹，补上但不动作答，避免误清老师/学生的作答
      s.sigs = {};
      lesson.questions.forEach(q => { s.sigs[q.id] = questionSig(q); });
      dirty = true;
    } else {
      lesson.questions.forEach(q => {
        const sig = questionSig(q);
        if (s.sigs[q.id] && s.sigs[q.id] !== sig) {
          if (s.answers) delete s.answers[q.id];
          dirty = true;
        }
        if (s.sigs[q.id] !== sig) { s.sigs[q.id] = sig; dirty = true; }
      });
      Object.keys(s.sigs).forEach(qid => {
        if (lesson.questions.every(q => q.id !== qid)) { delete s.sigs[qid]; dirty = true; }
      });
    }

    if (!s.order.length) { delete all[lid]; dirty = true; }
  });

  if (dirty) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(all)); } catch (e) { /* 忽略 */ } }
}
function saveScore(lessonId, data) {
  try {
    const all = loadScores();
    all[lessonId] = data;
    localStorage.setItem(SCORE_KEY, JSON.stringify(all));
  } catch (e) { /* 忽略 */ }
}

/* ============================== 题库导入：解析器 ============================== */

/* ---- 1) 分隔符表格（CSV / TSV） ---- */
const HEADER_ALIASES = {
  lesson:   ['课文', '课文名', '课题', '篇目', '课程', '单元课文'],
  grade:    ['年级', '册次', '年级册次'],
  author:   ['作者', '出处'],
  type:     ['题型', '类型', '题目类型'],
  stem:     ['题干', '题目', '问题', '题目内容', '试题'],
  answer:   ['答案', '正确答案', '参考答案', '标准答案'],
  analysis: ['解析', '答案解析', '说明', '分析', '讲评']
};

function detectDelimiter(text) {
  const line = (text.split(/\r?\n/).find(l => l.trim()) || '');
  const tab = (line.match(/\t/g) || []).length;
  const comma = (line.match(/,/g) || []).length;
  const semi = (line.match(/;/g) || []).length;
  if (tab >= comma && tab >= semi && tab > 0) return '\t';
  if (semi > comma) return ';';
  return ',';
}

function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  row.push(field);
  if (row.some(c => String(c).trim() !== '')) rows.push(row);
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function normalizeHeaderCell(h) {
  return String(h || '').replace(/^\uFEFF/, '').replace(/\s/g, '').toLowerCase();
}

/**
 * 把「二维数组表格」解析成课文数组
 * CSV / TSV 与 Excel（.xlsx）共用这一套列识别逻辑，保证两种来源解析结果一致
 * @param {Array<Array>} rows 二维数组，第一行可为表头
 * @param {{defaultTitle?:string}} opts defaultTitle：行内没有「课文」列时使用的课文名（Excel 用工作表名）
 */
function rowsToLessons(rows, opts) {
  const options = opts || {};
  const fallbackTitle = String(options.defaultTitle == null ? '' : options.defaultTitle).trim() || '未命名课文';
  if (!rows || !rows.length) return [];

  // 识别表头：只有「语义列名」命中 ≥2 个才算表头，避免把首行数据误判为表头
  const head = rows[0].map(normalizeHeaderCell);
  const map = {};
  let optionStart = -1;
  let optionEnd = -1;
  let aliasHits = 0;
  head.forEach((h, i) => {
    for (const key in HEADER_ALIASES) {
      if (HEADER_ALIASES[key].some(a => normalizeHeaderCell(a) === h)) {
        if (map[key] == null) { map[key] = i; aliasHits++; }
        return;
      }
    }
    if (/^选项[a-h]$/.test(h) || /^[a-h]$/.test(h)) {
      if (optionStart < 0) optionStart = i;
      optionEnd = i;                       // 选项列是连续的，记录右边界
      if (map['opt_' + h.replace('选项', '')] == null) map['opt_' + h.replace('选项', '')] = i;
    }
  });

  const hasHeader = aliasHits >= 2;
  // 无表头时按固定列序解析：课文,年级,题型,题干,A,B,C,D,答案,解析
  if (!hasHeader) {
    optionStart = -1;                 // 关键：清掉表头探测时残留的选项列起点，否则会走错分支
    for (const k in map) delete map[k];
    map.lesson = 0; map.grade = 1; map.type = 2; map.stem = 3;
    map.opt_A = 4; map.opt_B = 5; map.opt_C = 6; map.opt_D = 7;
    map.opt_E = 8; map.opt_F = 9;
    map.answer = 10; map.analysis = 11;
  }

  const body = hasHeader ? rows.slice(1) : rows;
  const byLesson = new Map();

  body.forEach(cells => {
    const get = k => (map[k] != null ? String(cells[map[k]] == null ? '' : cells[map[k]]).trim() : '');

    let stem = '', typeRaw = '', answerRaw = '', analysisRaw = '';
    let lessonName = '未命名课文', gradeRaw = '', authorRaw = '';
    let options = [];

    if (hasHeader) {
      stem = get('stem');
      typeRaw = get('type');
      answerRaw = get('answer');
      analysisRaw = get('analysis');
      lessonName = get('lesson') || fallbackTitle;
      gradeRaw = get('grade');
      authorRaw = get('author');

      if (optionStart >= 0) {
        // 有明确的「选项A~」列：仅在表头界定的选项列区间内取值，避免把「答案」列当成选项
        const last = optionEnd >= 0 ? optionEnd : cells.length - 1;
        for (let i = optionStart; i <= last && i < cells.length; i++) {
          const v = String(cells[i] == null ? '' : cells[i]).trim();
          if (!v) break;
          options.push(v);
        }
      } else {
        ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach(L => {
          const v = get('opt_' + L);
          if (v) options.push(v);
        });
      }
    } else {
      // 无表头：按「课文,年级,题型,题干,选项…,答案,解析」自适应切分
      // 末两列固定为答案/解析，中间列全部视为选项，因此 4 选项与 6 选项都能正确落位
      const n = cells.length;
      lessonName = String(cells[0] == null ? '' : cells[0]).trim() || fallbackTitle;
      gradeRaw = String(cells[1] == null ? '' : cells[1]).trim();
      typeRaw = String(cells[2] == null ? '' : cells[2]).trim();
      stem = String(cells[3] == null ? '' : cells[3]).trim();
      if (n >= 6) {
        analysisRaw = String(cells[n - 1] == null ? '' : cells[n - 1]).trim();
        answerRaw = String(cells[n - 2] == null ? '' : cells[n - 2]).trim();
        for (let i = 4; i <= n - 3; i++) {
          const v = String(cells[i] == null ? '' : cells[i]).trim();
          if (v) options.push(v);
        }
      } else {
        answerRaw = String(cells[4] == null ? '' : cells[4]).trim();
      }
    }

    if (!stem) return;

    if (!options.length) {
      // 题干里用 | 分隔了选项
      const parts = stem.split(/[|｜]/).map(s => s.trim()).filter(Boolean);
      if (parts.length >= 3) { options = parts.slice(1); }
    }

    const q = {
      type: typeRaw,
      stem: options.length >= 2 && stem.indexOf('|') > -1 ? stem.split(/[|｜]/)[0].trim() : stem,
      options: options,
      answer: answerRaw,
      analysis: analysisRaw
    };
    const nq = normalizeQuestion(q);
    if (!nq) return;

    if (!byLesson.has(lessonName)) {
      byLesson.set(lessonName, { title: lessonName, grade: gradeRaw, author: authorRaw, questions: [] });
    }
    byLesson.get(lessonName).questions.push(nq);
  });

  return Array.from(byLesson.values());
}

/** 分隔符表格（CSV / TSV）解析：检出分隔符后走统一的表格解析 */
function parseTable(text) {
  const delim = detectDelimiter(text);
  return rowsToLessons(parseDelimited(text, delim), {});
}

/* ---- 2) 纯文本格式 ---- */
// 题型标记：兼容 [选择] / [选择题] / 【判断题】 等写法
const TYPE_RE = /^[\[【(（]\s*(单选|多选|选择|判断|是非|填空|简答|问答|论述|阅读|分析)\s*题?\s*[\]】)）]\s*(.*)$/;
const OPT_RE  = /^([A-Ha-h])\s*[.、．)）:：]\s*(.+)$/;
const ANS_RE  = /^(答案|正确答案|参考答案|标准答案)\s*[:：]\s*(.*)$/;
const ANA_RE  = /^(解析|答案解析|说明|分析|讲评)\s*[:：]\s*(.*)$/;
const ATTR_RE = /^@\s*(年级|册次|作者|出处|简介|说明)\s*[:：]?\s*(.*)$/;

function parsePlainText(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const lessons = [];
  let cur = null, q = null;

  const flushQ = () => {
    if (!q) return;
    const nq = normalizeQuestion(q);
    if (nq && cur) cur.questions.push(nq);
    q = null;
  };
  const flushLesson = () => {
    flushQ();
    if (cur && cur.questions.length) lessons.push(cur);
    cur = null;
  };

  lines.forEach(raw => {
    const line = raw.trim();
    if (!line) return;

    // 课文标题
    if (/^#{1,6}\s*/.test(line)) {
      flushLesson();
      cur = { title: line.replace(/^#{1,6}\s*/, '').trim() || '未命名课文', grade: '', author: '', desc: '', questions: [] };
      return;
    }
    if (!cur) cur = { title: '未命名课文', grade: '', author: '', desc: '', questions: [] };

    // @属性
    const attr = line.match(ATTR_RE);
    if (attr) {
      const k = attr[1], v = attr[2].trim();
      if (k === '年级' || k === '册次') cur.grade = v;
      else if (k === '作者') cur.author = v;
      else if (k === '出处') cur.author = v;
      else if (k === '简介' || k === '说明') cur.desc = v;
      return;
    }

    // 新题目
    const tm = line.match(TYPE_RE);
    if (tm) {
      flushQ();
      q = { type: tm[1], stem: (tm[2] || '').trim(), options: [], answer: '', analysis: '' };
      return;
    }

    // 选项：仅当本题是选择题，或已经收集到选项时才按选项处理
    const om = line.match(OPT_RE);
    if (om && q && !q.answer && (/选择/.test(q.type) || q.options.length > 0)) {
      q.options.push(om[2].trim());
      return;
    }

    // 答案
    const am = line.match(ANS_RE);
    if (am && q) { q.answer = am[2].trim(); return; }

    // 解析
    const nm = line.match(ANA_RE);
    if (nm && q) { q.analysis = nm[2].trim(); return; }

    // 续行
    if (q) {
      if (!q.answer) q.stem += (q.stem ? ' ' : '') + line;
      else q.analysis += (q.analysis ? '\n' : '') + line;
    } else if (!cur.desc) {
      cur.desc = line;
    }
  });

  flushLesson();
  return lessons;
}

/* ---- 3) JSON 格式 ---- */
function parseJsonBank(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error('JSON 格式有误：' + e.message); }

  if (Array.isArray(data)) {
    // 题目数组 或 课文数组
    if (data.length && (data[0].questions || data[0].stem || data[0].title)) {
      if (data[0].questions) return normalizeBank({ lessons: data }).lessons;
      return normalizeBank({ lessons: [{ title: '未命名课文', questions: data }] }).lessons;
    }
    return [];
  }
  if (data && data.lessons) return normalizeBank(data).lessons;
  if (data && (data.stem || data.question)) {
    return normalizeBank({ lessons: [{ title: data.title || '未命名课文', questions: [data] }] }).lessons;
  }
  return [];
}

/* ---- 4) Excel（.xlsx / .xls）---- */
const XLSX_EXT_RE = /\.(xlsx|xlsm|xlsb|xls)$/i;
// 这些名字的工作表是「说明」性质，不当作题库解析
const SHEET_SKIP_RE = /^(说明|填写说明|使用说明|模板说明|格式说明|帮助|help|readme)$/i;

/** Excel 组件是否可用（vendor 目录未一起上传时会退化为不可用） */
function hasXlsx() {
  return typeof XLSX !== 'undefined' && XLSX && typeof XLSX.read === 'function';
}

/**
 * 解析 Excel 工作簿，支持两种排布（可混用）：
 *   ① 每张工作表一篇课文——表名即课文名，表内可以不写「课文」列
 *   ② 全部课文写在同一张表里——用「课文」列区分
 * 名为「填写说明」的工作表会被自动跳过（导出文件里就带着这样一张表）
 */
function parseWorkbook(buffer) {
  if (!hasXlsx()) {
    throw new Error('Excel 解析组件未加载，请确认 assets/js/vendor/xlsx.full.min.js 已随网站一起上传；也可以先用 CSV 上传');
  }
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'array' });
  } catch (e) {
    throw new Error('无法读取该 Excel 文件（' + e.message + '）');
  }

  const out = [];
  (wb.SheetNames || []).forEach(name => {
    if (SHEET_SKIP_RE.test(String(name).trim())) return;
    const ws = wb.Sheets[name];
    if (!ws) return;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false })
      .map(r => (r || []).map(c => (c == null ? '' : String(c))))
      .filter(r => r.some(c => c.trim() !== ''));
    if (rows.length) out.push.apply(out, rowsToLessons(rows, { defaultTitle: name }));
  });
  return out;
}

/* ---- 导出 Excel：把当前题库写成可再次上传的 .xlsx ---- */
// 导出/导入使用同一套中文表头，导出文件编辑后可直接上传，形成闭环
const XLSX_HEADER = ['课文', '年级', '作者', '题型', '题干', '选项A', '选项B', '选项C', '选项D', '选项E', '选项F', '答案', '解析'];
const XLSX_COL_W = [12, 11, 10, 9, 52, 20, 20, 20, 20, 20, 20, 16, 40];

/** 题库 → 二维数组（表头 + 每道题一行） */
function bankToRows(b) {
  const source = b || bank;
  const rows = [XLSX_HEADER.slice()];
  (source.lessons || []).forEach(l => {
    (l.questions || []).forEach(q => {
      const opts = (q.options || []).slice(0, 6);
      const row = [l.title, l.grade || '', l.author || '', QUESTION_TYPES[q.type] || q.type, q.stem];
      for (let i = 0; i < 6; i++) row.push(opts[i] || '');
      row.push(q.answer || '', q.analysis || '');
      rows.push(row);
    });
  });
  return rows;
}

/** 导出 Excel 需要的「填写说明」工作表内容 */
function xlsxHelpRows() {
  return [
    ['语文课堂提问系统 · 题库文件填写说明'],
    [''],
    ['这个文件就是你的题库。在 Excel 里改完保存，回到网站「题库管理」页重新上传，改动即生效。'],
    [''],
    ['列名', '怎么填'],
    ['课文', '必填。同一篇课文的题目填相同的课文名，系统会自动归到一组'],
    ['年级', '选填，如「四年级上册」'],
    ['作者', '选填'],
    ['题型', '填：选择题 / 判断题 / 填空题 / 简答题（留空会按内容自动判断）'],
    ['题干', '必填。题目内容'],
    ['选项A~选项F', '只有选择题需要填，按 A、B、C、D 顺序往后写即可'],
    ['答案', '选择题填 A / B / C / D；判断题填「正确」或「错误」；填空题可填多个可接受答案，用 | 分隔（例：一会儿|一瞬间|转眼间）；简答题填参考答案'],
    ['解析', '选填。课堂上判分后会显示给老师参考'],
    [''],
    ['小提示'],
    ['· 一张工作表可以放多篇课文，也可以用「课文」列区分；'],
    ['· 也可以把每篇课文单独放一张工作表，表名就是课文名（此时可以不写「课文」列）；'],
    ['· 本工作表只是说明，导入时会被自动跳过，可以随意修改。']
  ];
}

/** 用二维数组生成一个工作簿对象 */
function buildWorkbook(sheets) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(item => {
    const ws = XLSX.utils.aoa_to_sheet(item.rows);
    if (item.cols) ws['!cols'] = item.cols.map(w => ({ wch: w }));
    if (item.autofilter && item.rows.length > 1) {
      ws['!autofilter'] = { ref: 'A1:' + XLSX.utils.encode_col(item.rows[0].length - 1) + item.rows.length };
    }
    XLSX.utils.book_append_sheet(wb, ws, item.name);
  });
  return wb;
}

/** 触发浏览器下载（二进制） */
function downloadBinary(filename, arrayBuffer, mime) {
  const blob = new Blob([arrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function todayStamp() {
  const d = new Date();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

/** 导出当前题库为 .xlsx */
function exportBankXlsx() {
  if (!hasXlsx()) { toast('Excel 组件未加载，请刷新页面后重试', 'bad'); return; }
  if (!bank.lessons.length) { toast('题库为空，没有可导出的内容', 'bad'); return; }
  const wb = buildWorkbook([
    { name: '题库', rows: bankToRows(), cols: XLSX_COL_W, autofilter: true },
    { name: '填写说明', rows: xlsxHelpRows(), cols: [22, 88] }
  ]);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBinary('语文题库-' + todayStamp() + '.xlsx', buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  toast('已导出 Excel 题库，可直接在 Excel 里修改后再上传', 'ok');
}

/** 下载空白 Excel 模板 */
function exportBlankXlsx() {
  if (!hasXlsx()) { toast('Excel 组件未加载，请刷新页面后重试', 'bad'); return; }
  const sample = [
    XLSX_HEADER.slice(),
    ['观潮', '四年级上册', '周密', '选择题', '钱塘江大潮自古以来被称为（　　）。', '天下奇观', '世界奇景', '天下第一潮', '人间胜景', '', '', 'A', '开篇总起句，奠定赞叹基调。'],
    ['观潮', '四年级上册', '周密', '判断题', '潮来前江面上很平静。', '', '', '', '', '', '', '正确', '与潮来时的壮观形成对比。'],
    ['观潮', '四年级上册', '周密', '填空题', '潮来时形成一堵两丈多高的（　　）。', '', '', '', '', '', '', '水墙', '以「水墙」喻浪，写出潮头之高。'],
    ['观潮', '四年级上册', '周密', '简答题', '作者用了哪些比喻来写潮来时？', '', '', '', '', '', '', '把潮水比作白线、水墙，把潮声比作闷雷、山崩地裂，使景象可感、气势更足。', '先找比喻句，再说表达效果。']
  ];
  const wb = buildWorkbook([
    { name: '题库', rows: sample, cols: XLSX_COL_W },
    { name: '填写说明', rows: xlsxHelpRows(), cols: [22, 88] }
  ]);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBinary('题目模板.xlsx', buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  toast('已下载 Excel 模板，填好后拖回来自动识别', 'ok');
}

/* ---- 统一入口：自动识别格式（CSV / TSV / 文本 / JSON） ---- */
function parseQuestions(text, filename) {
  const name = String(filename || '').toLowerCase();
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];

  if (name.endsWith('.json')) {
    const r = parseJsonBank(trimmed);
    if (r.length) return r;
  }
  // 内容嗅探：JSON
  if (/^[\[{]/.test(trimmed)) {
    try { const r = parseJsonBank(trimmed); if (r.length) return r; } catch (e) { /* 继续尝试其他格式 */ }
  }
  // 纯文本格式：出现 [选择] 类标记 或 # 标题
  if (/^[\[【(（]\s*(单选|多选|选择|判断|是非|填空|简答|问答|论述)/m.test(trimmed) || /^#{1,6}\s+/m.test(trimmed)) {
    const r = parsePlainText(trimmed);
    if (r.length) return r;
  }
  // 兜底：按表格解析
  return parseTable(trimmed);
}

/** 合并导入的课文到题库 */
function mergeLessons(incoming, strategy) {
  let added = 0, merged = 0;
  incoming.forEach(ls => {
    const exist = bank.lessons.find(x => x.title === ls.title);
    if (exist) {
      if (strategy === 'replace') {
        exist.questions = ls.questions;
        exist.grade = ls.grade || exist.grade;
        exist.author = ls.author || exist.author;
        exist.desc = ls.desc || exist.desc;
      } else {
        exist.questions = exist.questions.concat(ls.questions);
      }
      exist.updatedAt = Date.now();
      merged++;
    } else {
      const nl = normalizeBank({ lessons: [ls] }).lessons[0];
      if (nl) { bank.lessons.push(nl); added++; }
    }
  });
  return { added, merged };
}

/* ============================== 判分 ============================== */
/** 返回 'right' | 'wrong' | 'pending' */
function judge(q, rec) {
  if (!rec || rec.value == null || rec.value === '') return 'pending';
  if (q.type === 'short') return rec.selfCorrect === true ? 'right' : (rec.selfCorrect === false ? 'wrong' : 'pending');
  if (q.type === 'choice') return rec.value === q.answer ? 'right' : 'wrong';
  if (q.type === 'judge') return normJudge(rec.value) === q.answer ? 'right' : 'wrong';
  // 填空：允许多个可接受答案，用 | 或 ｜ 分隔
  const accepts = String(q.answer).split(/[|｜]/).map(s => normText(s)).filter(Boolean);
  const got = normText(rec.value);
  if (!accepts.length) return 'pending';
  return accepts.indexOf(got) >= 0 ? 'right' : 'wrong';
}

function isAnswered(q, rec) {
  if (!rec) return false;
  if (q.type === 'short') return rec.selfCorrect != null || (rec.value || '').trim() !== '';
  return rec.value != null && String(rec.value).trim() !== '';
}

/* ============================== 会话（答题）管理 ============================== */
function createSession(lesson, opts) {
  const options = opts || {};
  let order = lesson.questions.map(q => q.id);
  if (options.shuffle) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
  }
  const sigs = {};
  lesson.questions.forEach(q => { sigs[q.id] = questionSig(q); });
  return {
    lessonId: lesson.id,
    title: lesson.title,
    order: order,
    idx: 0,
    practice: options.practice !== false,
    shuffle: !!options.shuffle,
    answers: {},
    sigs: sigs,
    startedAt: Date.now(),
    finished: false
  };
}

function currentLesson() {
  if (!session) return null;
  return bank.lessons.find(l => l.id === session.lessonId) || null;
}
function questionById(id) {
  const ls = currentLesson();
  return ls ? (ls.questions.find(q => q.id === id) || null) : null;
}

/* ============================== 学生名单：存储与工具 ============================== */
/** 归一化名单数据，保证结构完整 */
function normalizeRoster(raw) {
  const out = { version: 1, activeClassId: '', classes: [] };
  const classes = raw && Array.isArray(raw.classes) ? raw.classes : [];
  classes.forEach(c => {
    if (!c || typeof c !== 'object') return;
    const students = [];
    (Array.isArray(c.students) ? c.students : []).forEach(s => {
      const name = String(typeof s === 'string' ? s : (s && s.name) || '').trim();
      if (!name) return;
      students.push({
        id: (s && s.id) || uid('stu'),
        name: name,
        askedCount: Math.max(0, parseInt((s && s.askedCount) || 0, 10) || 0),
        lastAskedAt: (s && s.lastAskedAt) || 0
      });
    });
    out.classes.push({
      id: c.id || uid('cls'),
      name: String(c.name || '').trim() || '未命名班级',
      students: students
    });
  });
  if (!out.classes.length) out.classes.push({ id: uid('cls'), name: '我的班级', students: [] });
  out.activeClassId = (raw && out.classes.some(c => c.id === raw.activeClassId)) ? raw.activeClassId : out.classes[0].id;
  return out;
}

function loadRoster() {
  try {
    const raw = localStorage.getItem(ROSTER_KEY);
    if (raw) return normalizeRoster(JSON.parse(raw));
  } catch (e) { console.warn('[名单] 读取失败', e); }
  return normalizeRoster(null);
}

function saveRoster() {
  try { localStorage.setItem(ROSTER_KEY, JSON.stringify(roster)); markLocalChange(); return true; }
  catch (e) { toast('保存失败：浏览器存储空间不可用', 'bad'); return false; }
}

/** 当前班级 */
function activeClass() {
  if (!roster || !roster.classes.length) return null;
  return roster.classes.find(c => c.id === roster.activeClassId) || roster.classes[0];
}

/** 全校学生总数（首页统计用） */
function totalStudents() {
  if (!roster) return 0;
  return roster.classes.reduce((s, c) => s + c.students.length, 0);
}

/** 把一段文本切成姓名：支持换行、逗号、顿号、分号、空格、Excel 整列粘贴 */
function splitNames(text) {
  return String(text == null ? '' : text)
    .split(/[\s,，、;；|｜/]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** 往班级里加学生，返回新增 / 重名数量 */
function addStudentsToClass(cls, names) {
  let added = 0, dup = 0;
  names.forEach(name => {
    if (cls.students.some(s => s.name === name)) { dup++; return; }
    cls.students.push({ id: uid('stu'), name: name, askedCount: 0, lastAskedAt: 0 });
    added++;
  });
  return { added: added, dup: dup };
}

/* ============================== 课堂提问：存储与分配逻辑 ============================== */
function loadAssignment() {
  try {
    const raw = localStorage.getItem(ASK_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw);
    if (!a || !Array.isArray(a.students) || !a.students.length) return null;
    a.students.forEach(r => { if (!Array.isArray(r.marks)) r.marks = []; });
    return a;
  } catch (e) { return null; }
}

function saveAssignment() {
  if (!assignment) return;
  try { localStorage.setItem(ASK_KEY, JSON.stringify(assignment)); } catch (e) { /* 忽略 */ }
}

function defaultAskDraft() {
  return {
    classId: (roster && roster.activeClassId) || '',
    studentIds: [],
    lessonIds: [],
    types: ALL_TYPES.slice(),
    per: 1,
    noRepeat: true,
    pickMode: 'random',
    randomCount: 4,
    preferNew: true
  };
}

function loadAskDraft() {
  const d = defaultAskDraft();
  try {
    const raw = localStorage.getItem(ASK_DRAFT_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        Object.keys(d).forEach(k => { if (saved[k] != null) d[k] = saved[k]; });
      }
    }
  } catch (e) { /* 忽略 */ }
  return d;
}

function saveAskDraft() {
  try { localStorage.setItem(ASK_DRAFT_KEY, JSON.stringify(askDraft)); } catch (e) { /* 忽略 */ }
}

/** 启动时对齐设置：清掉已删除的课文 / 学生，保证新课文默认选中 */
function initAskDraft() {
  if (!askDraft) askDraft = loadAskDraft();
  if (!roster.classes.some(c => c.id === askDraft.classId)) {
    askDraft.classId = roster.activeClassId;
    askDraft.studentIds = [];
  }
  const types = Array.isArray(askDraft.types) ? askDraft.types.filter(t => QUESTION_TYPES[t]) : [];
  askDraft.types = types.length ? types : ALL_TYPES.slice();
  const lessonIds = bank.lessons.map(l => l.id);
  askDraft.lessonIds = (Array.isArray(askDraft.lessonIds) ? askDraft.lessonIds : []).filter(id => lessonIds.indexOf(id) >= 0);
  if (!askDraft.lessonIds.length) askDraft.lessonIds = lessonIds.slice();   // 默认「全部课文」
  const cls = roster.classes.find(c => c.id === askDraft.classId) || roster.classes[0];
  const stuIds = cls ? cls.students.map(s => s.id) : [];
  askDraft.studentIds = (Array.isArray(askDraft.studentIds) ? askDraft.studentIds : []).filter(id => stuIds.indexOf(id) >= 0);
  askDraft.per = clampInt(askDraft.per, 1, 20, 1);
  askDraft.pickMode = askDraft.pickMode === 'manual' ? 'manual' : 'random';
  askDraft.noRepeat = askDraft.noRepeat !== false;
}

/** Fisher-Yates 洗牌，返回新数组 */
function shuffleArray(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/**
 * 随机抽学生
 * @param {Array} students 班级学生
 * @param {number} n 抽几位
 * @param {boolean} preferNew 优先抽被提问次数少的同学（抽到的机会更公平）
 */
function randomPickStudents(students, n, preferNew) {
  const pool = students.slice();
  const picked = [];
  const want = Math.min(clampInt(n, 1, pool.length || 1, 1), pool.length);
  while (picked.length < want && pool.length) {
    let candidates = pool;
    if (preferNew) {
      const min = pool.reduce((m, s) => Math.min(m, s.askedCount || 0), Infinity);
      const lean = pool.filter(s => (s.askedCount || 0) <= min);
      if (lean.length) candidates = lean;
    }
    const s = candidates[Math.floor(Math.random() * candidates.length)];
    picked.push(s);
    pool.splice(pool.indexOf(s), 1);
  }
  return picked;
}

/** 把题目存成快照：提问过程中题库再改，也不影响本次提问 */
function snapshotQuestion(lesson, q) {
  return {
    qid: q.id,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    type: q.type,
    stem: q.stem,
    options: (q.options || []).slice(),
    answer: q.answer || '',
    analysis: q.analysis || ''
  };
}

/** 按课文 + 题型筛出候选题库 */
function buildAskPool(lessonIds, types) {
  const ids = lessonIds || [];
  const ts = types || [];
  const pool = [];
  bank.lessons.forEach(l => {
    if (ids.indexOf(l.id) < 0) return;
    l.questions.forEach(q => { if (ts.indexOf(q.type) >= 0) pool.push(snapshotQuestion(l, q)); });
  });
  return pool;
}

/**
 * 随机分配题目：每人 per 道
 * 先把整个题库洗牌后按顺序发放，因此题库够用时「同学之间不会重题」；
 * 不够时自动开启第二轮，但同一位学生手里不会出现重复的题。
 */
function assignQuestions(pool, students, per) {
  const enough = pool.length >= students.length * per;
  const plan = students.map(s => ({ studentId: s.id, name: s.name, questions: [], marks: [] }));
  if (!pool.length || per <= 0) return { plan: plan, enough: false };

  let bag = [];
  let cursor = 0;
  const draw = () => {
    if (cursor >= bag.length) { bag = shuffleArray(pool); cursor = 0; }
    return bag[cursor++];
  };

  plan.forEach(row => {
    const seen = {};
    let guard = 0;
    while (row.questions.length < per && guard++ < per * 8 + 40) {
      const q = draw();
      if (!q) break;
      if (seen[q.qid]) {
        if (pool.length <= row.questions.length) break;   // 题库比题目数量还小，只能重复
        continue;
      }
      seen[q.qid] = true;
      row.questions.push(deepClone(q));
    }
    row.marks = row.questions.map(() => '');
  });
  return { plan: plan, enough: enough };
}

/** 题库不够时先问一句，避免老师看到意外的重复题目 */
function confirmPoolShortage(poolSize, studentCount, per) {
  if (poolSize >= studentCount * per) return true;
  return confirm('所选范围里一共 ' + poolSize + ' 道题，要给 ' + studentCount + ' 位学生各抽 ' + per + ' 道。\n\n' +
    '点「确定」= 允许部分题目在同学之间重复使用，继续提问\n' +
    '点「取消」= 返回调整课文范围或题目数量');
}

/** 用当前设置生成一次提问会话 */
function createAssignment(opts) {
  const res = assignQuestions(opts.pool, opts.students, opts.per);
  const plan = res.plan.filter(r => r.questions.length);
  if (!plan.length) { toast('没有可以分配的题目', 'bad'); return; }
  const skipped = res.plan.length - plan.length;
  const types = (opts.types && opts.types.length ? opts.types : askDraft.types).slice();

  assignment = {
    id: uid('ask'),
    at: Date.now(),
    classId: opts.cls ? opts.cls.id : '',
    className: opts.cls ? opts.cls.name : '',
    lessonIds: opts.lessonIds.slice(),
    lessonTitles: bank.lessons.filter(l => opts.lessonIds.indexOf(l.id) >= 0).map(l => l.title),
    types: types,
    per: opts.per,
    noRepeat: !!askDraft.noRepeat,
    reused: !res.enough,
    pool: opts.pool,
    students: plan,
    idx: 0,
    qIdx: 0,
    finished: false,
    finishedAt: 0
  };

  // 记录被提问次数，方便下次「优先抽提问次数少的同学」
  const now = Date.now();
  opts.students.forEach(s => { s.askedCount = (s.askedCount || 0) + 1; s.lastAskedAt = now; });
  saveRoster();
  saveAssignment();
  askRevealed = false;

  if (parseRoute().name === 'askRun') rerenderAskRun();
  else location.hash = '#/ask/run';

  if (skipped) toast('题库题目不够，有 ' + skipped + ' 位学生没有分到题目', 'bad');
  else toast('已为 ' + plan.length + ' 位学生随机分配题目' + (assignment.reused ? '（部分题目重复）' : ''), 'ok');
}

/** 开始提问：校验设置 → 生成分配 */
function startAsk() {
  const cls = activeClass();
  if (!cls) { toast('请先创建班级', 'bad'); return; }
  const picked = cls.students.filter(s => askDraft.studentIds.indexOf(s.id) >= 0);
  if (!picked.length) { toast('请至少选一名学生', 'bad'); return; }
  if (!askDraft.lessonIds.length) { toast('请至少选一篇课文', 'bad'); return; }
  if (!askDraft.types.length) { toast('请至少选一种题型', 'bad'); return; }

  const per = clampInt(askDraft.per, 1, 20, 1);
  const pool = buildAskPool(askDraft.lessonIds, askDraft.types);
  if (!pool.length) { toast('所选范围里没有题目，换一篇课文或题型试试', 'bad'); return; }
  if (!confirmPoolShortage(pool.length, picked.length, per)) return;

  createAssignment({ cls: cls, students: picked, lessonIds: askDraft.lessonIds, per: per, pool: pool, types: askDraft.types });
}

/** 小结页「再抽一轮」：同一批学生、同样的范围，重新随机分题 */
function askAgain() {
  if (!assignment) return;
  const cls = roster.classes.find(c => c.id === assignment.classId) || activeClass();
  const students = [];
  (assignment.students || []).forEach(r => {
    const s = cls ? cls.students.find(x => x.id === r.studentId) : null;
    if (s) students.push(s);
  });
  if (!students.length) { toast('名单里找不到这些学生了，请重新设置', 'bad'); location.hash = '#/ask'; return; }

  const lessonIds = (assignment.lessonIds || []).filter(id => bank.lessons.some(l => l.id === id));
  if (!lessonIds.length) { toast('提问范围里的课文已经不存在了，请重新设置', 'bad'); location.hash = '#/ask'; return; }
  const types = (assignment.types && assignment.types.length) ? assignment.types : ALL_TYPES.slice();
  const pool = buildAskPool(lessonIds, types);
  if (!pool.length) { toast('所选范围里没有题目了，请重新设置', 'bad'); location.hash = '#/ask'; return; }
  if (!confirmPoolShortage(pool.length, students.length, assignment.per)) return;

  createAssignment({ cls: cls, students: students, lessonIds: lessonIds, per: assignment.per, pool: pool, types: types });
}

/** 结束提问 → 小结 */
function finishAsk() {
  if (!assignment) return;
  const left = countUnmarked();
  if (left && !confirm('还有 ' + left + ' 道题没有记录，确定结束本次提问吗？')) return;
  assignment.finished = true;
  assignment.finishedAt = Date.now();
  saveAssignment();
  rerenderAskRun();
}

function countUnmarked() {
  let n = 0;
  (assignment ? assignment.students : []).forEach(r => {
    r.questions.forEach((q, i) => { if (!r.marks[i]) n++; });
  });
  return n;
}

/** 换一题：把当前题换成题库里还没用过的另一道 */
function swapCurrentQuestion() {
  if (!assignment || assignment.finished) return;
  const row = assignment.students[assignment.idx];
  if (!row || !row.questions.length) return;
  const cur = row.questions[assignment.qIdx];
  const used = row.questions.map(x => x.qid);
  let candidates = (assignment.pool || []).filter(q => used.indexOf(q.qid) < 0);
  let warnReuse = false;
  if (!candidates.length) {
    candidates = (assignment.pool || []).filter(q => q.qid !== cur.qid);
    warnReuse = true;
  }
  if (!candidates.length) { toast('题库里没有可以替换的题目了', 'bad'); return; }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  row.questions[assignment.qIdx] = deepClone(pick);
  row.marks[assignment.qIdx] = '';
  askRevealed = false;
  saveAssignment();
  toast(warnReuse ? '已换题（题库不够，可能和别的同学重复）' : '已换一题', 'ok');
  rerenderAskRun();
}

/**
 * 给后来加入的学生抽题：优先用「别的同学还没被问到的题」，题库不够时再允许重复。
 * 同一位学生自己的题目不会重复。
 */
function assignQuestionsForOne(pool, per, usedQids) {
  const used = usedQids || [];
  const list = shuffleArray(pool.filter(q => used.indexOf(q.qid) < 0)).slice(0, per);
  if (list.length < per) {
    const rest = shuffleArray(pool).filter(q => list.every(x => x.qid !== q.qid));
    list.push.apply(list, rest.slice(0, per - list.length));
  }
  return list.map(q => deepClone(q));
}

/**
 * 临时加一位学生（课堂上来了旁听生、转学生，或者老师临时想提问某位同学）。
 * · 名字在班级名单里 → 沿用这位同学，提问次数照常累加
 * · 名字不在名单里 → 只加入本次提问，不写入名单（下次提问不会再出现）
 */
function addTempStudent(name) {
  if (!assignment || assignment.finished) return;
  const nm = String(name == null ? '' : name).trim();
  if (!nm) { toast('请输入学生姓名', 'bad'); return; }
  if (nm.length > 12) { toast('姓名太长了，请确认一下', 'bad'); return; }

  const cls = roster.classes.find(c => c.id === assignment.classId) || null;
  const inRoster = cls ? cls.students.find(s => s.name === nm) : null;
  const already = assignment.students.some(r => (inRoster ? r.studentId === inRoster.id : r.name === nm));
  if (already) { toast('「' + nm + '」已经在这次提问里了', 'bad'); return; }

  const usedQids = [];
  assignment.students.forEach(r => r.questions.forEach(q => {
    if (usedQids.indexOf(q.qid) < 0) usedQids.push(q.qid);
  }));
  const questions = assignQuestionsForOne(assignment.pool || [], assignment.per, usedQids);
  if (!questions.length) { toast('题库里没有可以分配的题目了', 'bad'); return; }

  if (inRoster) {
    inRoster.askedCount = (inRoster.askedCount || 0) + 1;
    inRoster.lastAskedAt = Date.now();
    saveRoster();
  }

  assignment.students.push({
    studentId: inRoster ? inRoster.id : uid('temp'),
    name: nm,
    temp: !inRoster,
    questions: questions,
    marks: questions.map(() => '')
  });
  assignment.idx = assignment.students.length - 1;   // 直接跳到新加的这位同学
  assignment.qIdx = 0;
  askRevealed = false;
  saveAssignment();
  toast(inRoster ? '已把「' + nm + '」加进来（名单里的同学）' : '已临时加入「' + nm + '」（不会写入名单）', 'ok');
  rerenderAskRun();
}

/* ============================== 便携数据文件（U 盘模式） ==============================
   网页在 file:// 下不能读写磁盘上的任意文件（浏览器安全限制），但可以加载同目录的脚本。
   所以「便携模式」= 把题库 + 名单 + 成绩导出成一个 portable-data.js 放进网站文件夹，
   换电脑 / 换 U 盘后双击打开，网页会自动把它读进来。 */

/** 记一笔「本机数据最后变动时间」，用于判断便携文件是否比本机新 */
function markLocalChange() {
  try { localStorage.setItem(PORTABLE_SAVED_KEY, String(Date.now())); } catch (e) { /* 忽略 */ }
}
function localSavedAt() {
  try { return parseInt(localStorage.getItem(PORTABLE_SAVED_KEY) || '0', 10) || 0; } catch (e) { return 0; }
}
function portableIgnoredAt() {
  try { return parseInt(localStorage.getItem(PORTABLE_IGNORE_KEY) || '0', 10) || 0; } catch (e) { return 0; }
}

/** 校验并整理便携文件内容；不是本系统的文件就返回 null */
function normalizePortable(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== PORTABLE_FORMAT) return null;
  return {
    savedAt: parseInt(raw.savedAt, 10) || 0,
    bank: normalizeBank(raw.bank || null),
    roster: raw.roster ? normalizeRoster(raw.roster) : null,
    scores: (raw.scores && typeof raw.scores === 'object') ? raw.scores : null
  };
}

/** 读网页文件夹里的 portable-data.js（由 index.html 用 <script> 加载） */
function readPortableFile() {
  return normalizePortable(window.YW_PORTABLE_DATA);
}

/** 生成便携文件的内容 */
function portableFileContent() {
  const payload = {
    format: PORTABLE_FORMAT,
    version: 1,
    savedAt: Date.now(),
    note: '语文课堂提问系统 · 便携数据文件。放在网站文件夹里（和 index.html 同一层），打开网站会自动加载。换电脑时直接覆盖同名文件即可。',
    bank: bank,
    roster: roster ? { version: 1, activeClassId: roster.activeClassId, classes: roster.classes } : null,
    scores: loadScores()
  };
  return '/* 由「语文课堂提问系统」导出，请勿手改 */\nwindow.YW_PORTABLE_DATA = ' +
    JSON.stringify(payload, null, 2) + ';\n';
}

/** 导出便携数据文件（U 盘模式用） */
function exportPortableData() {
  if (!bank || !bank.lessons.length) {
    toast('题库还是空的，先录几道题再导出便携数据', 'bad');
    return;
  }
  downloadTextFile(PORTABLE_FILE, portableFileContent(), 'application/javascript');
  markLocalChange();
  toast('已导出 ' + PORTABLE_FILE + '：把它放进网站文件夹（覆盖旧文件），整个文件夹拷到 U 盘即可', 'ok');
}

/** 把便携数据装进本机：题库、名单、成绩一起替换 */
function importPortableData(data, opts) {
  const portable = data || readPortableFile();
  const options = opts || {};
  if (!portable) { toast('没有找到可用的便携数据文件', 'bad'); return false; }

  bank = portable.bank;
  saveRawBank(bank);
  if (portable.roster) { roster = portable.roster; try { localStorage.setItem(ROSTER_KEY, JSON.stringify(roster)); } catch (e) { /* 忽略 */ } }
  if (portable.scores) { try { localStorage.setItem(SCORE_KEY, JSON.stringify(portable.scores)); } catch (e) { /* 忽略 */ } }
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* 忽略 */ }   // 会话跟着旧题库，直接清掉

  manageEditing = null;
  draft = null;
  session = null;
  askDraft = loadAskDraft();
  initAskDraft();
  markLocalChange();   // 载入后本机就是最新的，之后不再提示

  const lessons = bank.lessons.length;
  const students = roster ? roster.classes.reduce((n, c) => n + c.students.length, 0) : 0;
  if (!options.silent) toast('已载入便携数据：' + lessons + ' 篇课文、' + students + ' 名学生', 'ok');
  if (!options.noRender) dispatchView();
  return true;
}

/** 供界面按钮调用：立即载入 U 盘里的便携数据 */
function importPortableNow() {
  const portable = readPortableFile();
  if (!portable) { toast('网站文件夹里没有 portable-data.js', 'bad'); return false; }
  return importPortableData(portable, {});
}

function hidePortableTip() {
  const el = $('#portableTip');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

/** 本机数据与便携文件都非空、且文件更新时，顶部给一条提示让老师选择 */
function showPortableTip(portable) {
  if ($('#portableTip')) return;
  const el = document.createElement('div');
  el.id = 'portableTip';
  el.className = 'portable-tip';
  el.setAttribute('role', 'status');
  el.innerHTML = '<strong>U 盘里的数据比本机新</strong>' +
    '<span>便携数据文件是 ' + esc(shortDate(portable.savedAt)) + ' 导出的，本机数据是 ' +
      esc(shortDate(localSavedAt())) + '。要载入吗？</span>' +
    '<button class="btn btn-primary btn-sm" id="portableTipLoad" type="button">载入 U 盘数据</button>' +
    '<button class="btn btn-ghost btn-sm" id="portableTipKeep" type="button">保持本机</button>';
  const header = document.querySelector('.site-header');
  if (header && header.parentNode) header.parentNode.insertBefore(el, header.nextSibling);
  else document.body.insertBefore(el, document.body.firstChild);

  const load = $('#portableTipLoad');
  if (load) load.addEventListener('click', () => { hidePortableTip(); importPortableNow(); });
  const keep = $('#portableTipKeep');
  if (keep) keep.addEventListener('click', () => {
    try { localStorage.setItem(PORTABLE_IGNORE_KEY, String(portable.savedAt)); } catch (e) { /* 忽略 */ }
    hidePortableTip();
    toast('好的，继续用本机数据（再导出一次便携文件就能覆盖它）');
  });
}

/**
 * 启动时的自动判断：
 * · 这台电脑第一次打开（localStorage 里还没有题库，刚播完内置示例）→ 直接载入便携数据
 * · 本机有数据、便携文件更新 → 只提示，不擅自覆盖
 * @param {boolean} firstVisit 由 boot() 在 loadBank() 之前判断出来
 */
function applyPortableOnBoot(firstVisit) {
  const portable = readPortableFile();
  if (!portable) return null;
  if (firstVisit) {
    importPortableData(portable, { noRender: true });
    return portable;
  }
  if (portable.savedAt > localSavedAt() && portable.savedAt > portableIgnoredAt()) showPortableTip(portable);
  return portable;
}

/** 这台电脑以前有没有存过题库（要在 loadBank() 播种内置示例之前判断） */
function hasSavedBank() {
  try { return !!localStorage.getItem(STORAGE_KEY); } catch (e) { return false; }
}

/** 题库管理页上显示的便携数据状态 */
function portableStatusText() {
  const portable = readPortableFile();
  if (!portable) return '未找到 portable-data.js（导出的文件放进网站文件夹即可生效）';
  return '已找到（' + shortDate(portable.savedAt) + ' 导出的数据，共 ' + portable.bank.lessons.length + ' 篇课文）';
}

/* ============================== 路由 ============================== */
function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'manage') return { name: 'manage' };
  if (parts[0] === 'roster') return { name: 'roster' };
  if (parts[0] === 'ask')    return { name: parts[1] === 'run' ? 'askRun' : 'ask' };
  if (parts[0] === 'quiz')   return { name: 'quiz',   id: decodeURIComponent(parts[1] || '') };
  if (parts[0] === 'result') return { name: 'result', id: decodeURIComponent(parts[1] || '') };
  return { name: 'home' };
}

function render(keepScroll) {
  const route = parseRoute();
  const main = $('#main');
  $$('.nav a[data-nav]').forEach(a => {
    const key = a.getAttribute('data-nav');
    a.classList.toggle('is-active',
      (key === 'home' && (route.name === 'home' || route.name === 'quiz' || route.name === 'result')) ||
      (key === 'manage' && route.name === 'manage') ||
      (key === 'roster' && route.name === 'roster') ||
      (key === 'ask' && (route.name === 'ask' || route.name === 'askRun')));
  });

  if (route.name === 'home')         main.innerHTML = viewHome();
  else if (route.name === 'manage')  main.innerHTML = viewManage();
  else if (route.name === 'quiz')    main.innerHTML = viewQuiz(route.id);
  else if (route.name === 'result')  main.innerHTML = viewResult(route.id);
  else if (route.name === 'roster')  main.innerHTML = viewRoster();
  else if (route.name === 'ask')     main.innerHTML = viewAsk();
  else if (route.name === 'askRun')  main.innerHTML = viewAskRun();

  if (!keepScroll) window.scrollTo({ top: 0, behavior: 'auto' });
}

/** 题库管理页就地重绘（保留滚动位置，用于编辑题目后立即生效） */
function rerenderManage() {
  if (parseRoute().name !== 'manage') { render(); return; }
  render(true);
  bindManage();
}

/** 学生名单页就地重绘 */
function rerenderRoster() {
  if (parseRoute().name !== 'roster') { render(); return; }
  render(true);
  bindRoster();
}

/** 提问设置页就地重绘 */
function rerenderAskPage() {
  if (parseRoute().name !== 'ask') { render(); return; }
  render(true);
  bindAsk();
}

/** 提问进行页就地重绘 */
function rerenderAskRun() {
  if (parseRoute().name !== 'askRun') { render(); return; }
  render(true);
  bindAskRun();
}

/* ============================== 视图：首页 ============================== */
function viewHome() {
  const lessons = bank.lessons;
  const totalQ = lessons.reduce((s, l) => s + l.questions.length, 0);
  const scores = loadScores();

  let cards = '';
  if (!lessons.length) {
    cards = '<div class="empty">' + icon('book') +
      '<h3>题库还是空的</h3><p>把你的 Excel 题库文件拖到「题库管理」页就能导入，<br>也可以在那里逐题手动录入。支持 .xlsx / .csv / 纯文本 / JSON。</p>' +
      '<a class="btn btn-primary" href="#/manage">' + icon('upload') + '去导入题目</a></div>';
  } else {
    cards = '<div class="lesson-grid" id="lessonGrid">' + lessons.map(l => {
      const n = l.questions.length;
      const sc = scores[l.id];
      const types = ['choice', 'judge', 'fill', 'short']
        .map(t => ({ t: t, n: l.questions.filter(q => q.type === t).length }))
        .filter(x => x.n > 0)
        .map(x => '<span class="pill">' + QUESTION_TYPES[x.t] + ' ' + x.n + '</span>').join('');
      return '<article class="lesson-card" data-title="' + esc((l.title + ' ' + l.grade + ' ' + l.author).toLowerCase()) + '">' +
        '<div class="lesson-card-top">' +
          '<span class="lesson-icon">' + icon('book') + '</span>' +
          '<div><h3>' + esc(l.title) + '</h3>' +
          '<p class="meta">' + esc([l.grade, l.author].filter(Boolean).join(' · ') || '未标注年级') + '</p></div>' +
        '</div>' +
        '<p class="lesson-desc">' + esc(l.desc || '暂无简介') + '</p>' +
        '<div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">' + types + '</div>' +
        '<div class="lesson-foot">' +
          '<span class="pill pill-primary">共 ' + n + ' 题</span>' +
          (sc && n ? '<span class="pill ' + (sc.rate >= 80 ? 'pill-success' : 'pill-accent') + '">上次 ' + sc.rate + '%</span>' : '') +
          (n
            ? '<div class="lesson-foot-actions">' +
                '<button class="btn btn-ghost btn-sm" data-ask-lesson="' + esc(l.id) + '">' + icon('mic') + '提问</button>' +
                '<a class="btn btn-primary btn-sm" href="#/quiz/' + encodeURIComponent(l.id) + '">开始答题</a>' +
              '</div>'
            : '<button class="btn btn-ghost btn-sm" data-edit-lesson="' + esc(l.id) + '">去加题目</button>') +
        '</div>' +
      '</article>';
    }).join('') + '</div>';
  }

  return '<div class="view">' +
    '<section class="hero">' +
      '<h1>课文随堂提问 · 一问一答见真章</h1>' +
      '<p>按课文组织题库，题目由老师自己上传。课堂上可以随机点名、自动给每位学生分不同的题，也可以让学生自己逐题练习、即时判分。</p>' +
      '<div class="hero-stats">' +
        '<div class="hero-stat"><b>' + lessons.length + '</b><span>篇课文</span></div>' +
        '<div class="hero-stat"><b>' + totalQ + '</b><span>道题目</span></div>' +
        '<div class="hero-stat"><b>' + totalStudents() + '</b><span>名学生</span></div>' +
        '<div class="hero-stat"><b>4</b><span>种题型</span></div>' +
      '</div>' +
      '<div class="hero-actions">' +
        '<a class="btn btn-light btn-lg" href="#/ask">' + icon('mic') + '课堂提问</a>' +
        (lessons.length ? '<a class="btn btn-ghost btn-lg" href="#/quiz/' + encodeURIComponent(lessons[0].id) + '">' + icon('book') + '开始答题</a>' : '') +
        '<a class="btn btn-ghost btn-lg" href="#/manage">' + icon('upload') + '上传题目</a>' +
      '</div>' +
    '</section>' +

    '<div class="toolbar">' +
      '<div class="search-field">' + icon('search') +
        '<input type="search" id="lessonSearch" placeholder="搜索课文名或作者…" aria-label="搜索课文">' +
      '</div>' +
      '<span class="muted" style="font-size:14px" id="searchCount"></span>' +
    '</div>' +

    '<div class="section-head"><div><h2>我的课文</h2><p>点击课文即可开始随堂提问</p></div>' +
      '<a class="btn btn-ghost btn-sm" href="#/manage">' + icon('upload') + '管理题库</a></div>' +
    cards +
  '</div>';
}

/* ============================== 视图：答题 ============================== */
function viewQuiz(lessonId) {
  const lesson = bank.lessons.find(l => l.id === lessonId);
  if (!lesson) {
    return '<div class="view"><div class="empty">' + icon('book') + '<h3>没有找到这篇课文</h3>' +
      '<p>可能已被删除，请返回首页重新选择。</p><a class="btn btn-primary" href="#/">返回首页</a></div></div>';
  }
  if (!lesson.questions.length) {
    return '<div class="view"><div class="empty">' + icon('book') + '<h3>这篇课文还没有题目</h3>' +
      '<p>去「题库管理」为《' + esc(lesson.title) + '》上传题目吧。</p><a class="btn btn-primary" href="#/manage">去上传</a></div></div>';
  }

  // 复用已有会话（未完成的）；题序会先与当前题库对齐，题目被增删也不会丢掉已答内容
  const saved = loadSessions()[lessonId];
  if (saved && saved.order && saved.order.length && saved.startedAt && !saved.finished) {
    session = rebaseSessionToLesson(saved, lesson);
    saveSession();
  } else if (session && session.lessonId === lessonId && !session.finished) {
    session = rebaseSessionToLesson(session, lesson);
    saveSession();
  } else {
    session = createSession(lesson, { practice: true, shuffle: false });
    saveSession();
  }
  return renderQuizBody(lesson);
}

function renderQuizBody(lesson) {
  const total = session.order.length;
  const q = questionById(session.order[session.idx]);
  if (!q) return '<div class="view"><div class="empty"><h3>题目数据异常</h3></div></div>';

  const rec = session.answers[q.id] || {};
  const state = judge(q, rec);
  const answered = isAnswered(q, rec);
  const revealed = session.practice && (
    (q.type === 'choice' || q.type === 'judge') ? state !== 'pending' :
    q.type === 'fill' ? !!rec.checked :
    q.type === 'short' ? !!rec.revealed : false
  );

  const doneCount = session.order.filter(id => {
    const qq = lesson.questions.find(x => x.id === id);
    return qq && isAnswered(qq, session.answers[id]);
  }).length;

  const practiceClass = session.practice ? 'btn-primary' : 'btn-ghost';

  return '<div class="view">' +
    '<div class="quiz-topbar">' +
      '<div class="quiz-title">' +
        '<a class="btn btn-ghost btn-sm" href="#/" aria-label="返回课文列表">' + icon('arrow-l') + '返回</a>' +
        '<h2>' + esc(lesson.title) + '</h2>' +
      '</div>' +
      '<div class="quiz-actions">' +
        '<button class="btn btn-ghost btn-sm" id="fontToggle" title="切换投影字号">' + icon('book') + '<span id="fontLabel">正常</span></button>' +
        '<button class="btn ' + practiceClass + ' btn-sm" id="modeToggle">' + (session.practice ? '练习模式' : '测试模式') + '</button>' +
        '<button class="btn btn-ghost btn-sm" id="btnFinish">交卷看结果</button>' +
      '</div>' +
    '</div>' +

    '<div class="progress-wrap">' +
      '<div class="progress-meta"><span>第 ' + (session.idx + 1) + ' / ' + total + ' 题</span><span>已答 ' + doneCount + ' 题</span></div>' +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + Math.round((session.idx + 1) / total * 100) + '%"></div></div>' +
    '</div>' +

    '<section class="card q-card">' +
      '<div class="q-head">' +
        '<span class="q-index">第 ' + (session.idx + 1) + ' 题</span>' +
        '<span class="q-type">' + QUESTION_TYPES[q.type] + '</span>' +
      '</div>' +
      '<h3 class="q-stem">' + esc(q.stem) + '</h3>' +
      renderAnswerArea(q, rec, revealed) +
    '</section>' +

    '<div class="quiz-nav">' +
      '<button class="btn btn-ghost" id="btnPrev"' + (session.idx === 0 ? ' disabled' : '') + '>' + icon('arrow-l') + '上一题</button>' +
      '<button class="btn btn-primary" id="btnNext">' + (session.idx === total - 1 ? '完成并查看结果' : '下一题') + icon('arrow-r') + '</button>' +
    '</div>' +

    '<div class="qmap" id="qmap" aria-label="题号导航">' +
      session.order.map((id, i) => {
        const qq = lesson.questions.find(x => x.id === id);
        const st = qq ? judge(qq, session.answers[id]) : 'pending';
        let cls = 'qmap-btn';
        if (i === session.idx) cls += ' is-current';
        else if (st === 'right') cls += ' is-right';
        else if (st === 'wrong') cls += ' is-wrong';
        return '<button class="' + cls + '" data-goto="' + i + '">' + (i + 1) + '</button>';
      }).join('') +
    '</div>' +
  '</div>';
}

function renderAnswerArea(q, rec, revealed) {
  let html = '';

  if (q.type === 'choice') {
    html += '<div class="options">' + q.options.map((opt, i) => {
      const L = LETTERS[i];
      const sel = rec.value === L;
      let cls = 'option';
      if (revealed) {
        if (L === q.answer) cls += ' is-correct';
        else if (sel) cls += ' is-wrong';
      } else if (sel) cls += ' is-selected';
      return '<button class="' + cls + '" data-opt="' + L + '"' + (revealed ? ' disabled' : '') + '>' +
        '<span class="option-key">' + L + '</span><span class="option-text">' + esc(opt) + '</span></button>';
    }).join('') + '</div>';
    if (revealed) html += feedbackBlock(q, rec, 'choice');
    else if (rec.value) html += '<p class="hint" style="margin-top:12px;color:#6b7280;font-size:13px">已选 <b>' + rec.value + '</b>　按「下一题」继续（练习模式下点击选项即判分）</p>';
  }

  else if (q.type === 'judge') {
    html += '<div class="options">' + ['正确', '错误'].map(v => {
      const sel = rec.value === v;
      let cls = 'option';
      if (revealed) {
        if (v === q.answer) cls += ' is-correct';
        else if (sel) cls += ' is-wrong';
      } else if (sel) cls += ' is-selected';
      return '<button class="' + cls + '" data-judge="' + v + '"' + (revealed ? ' disabled' : '') + '>' +
        '<span class="option-key">' + (v === '正确' ? '√' : '×') + '</span><span class="option-text">' + v + '</span></button>';
    }).join('') + '</div>';
    if (revealed) html += feedbackBlock(q, rec, 'judge');
  }

  else if (q.type === 'fill') {
    html += '<div class="answer-area">' +
      '<input type="text" id="fillInput" placeholder="在此输入答案，按回车提交" value="' + esc(rec.value || '') + '"' +
        (revealed ? ' disabled' : '') + ' autocomplete="off">' +
      (!revealed ? '<p class="hint">提示：答案不区分大小写与标点；按回车键提交。</p>' : '') +
      '</div>';
    if (revealed) html += feedbackBlock(q, rec, 'fill');
  }

  else {
    html += '<div class="answer-area">' +
      '<textarea id="shortInput" placeholder="在此写下你的答案…"' + (revealed ? ' disabled' : '') + '>' + esc(rec.value || '') + '</textarea>' +
      (!revealed ? '<p class="hint">先独立作答，再点击下方按钮对照参考答案自评。</p>' : '') +
      '</div>';
    if (!revealed) {
      html += '<div class="quiz-nav" style="margin-top:14px">' +
        '<button class="btn" id="btnReveal">查看参考答案</button></div>';
    } else {
      html += '<div class="feedback info">' +
        '<div class="feedback-title">' + icon('check') + '参考答案</div>' +
        '<div class="feedback-body">' + esc(q.answer || '（本题未提供参考答案）') + '</div>' +
        (q.analysis ? '<div class="feedback-body" style="margin-top:10px"><b>解析：</b>' + esc(q.analysis) + '</div>' : '') +
        '</div>';
      html += '<div class="self-assess">' +
        '<button class="btn ' + (rec.selfCorrect === true ? 'btn-primary' : 'btn-ghost') + '" data-self="1">' + icon('check') + '我答对了</button>' +
        '<button class="btn ' + (rec.selfCorrect === false ? 'btn-danger' : 'btn-ghost') + '" data-self="0">' + icon('x') + '需要复习</button>' +
      '</div>';
    }
  }
  return html;
}

function feedbackBlock(q, rec, type) {
  const st = judge(q, rec);
  const right = st === 'right';
  const correctText = q.type === 'choice'
    ? (q.answer ? q.answer + '. ' + (q.options[LETTERS.indexOf(q.answer)] || '') : '—')
    : q.answer;

  return '<div class="feedback ' + (right ? 'ok' : 'bad') + '">' +
    '<div class="feedback-title">' + icon(right ? 'check' : 'x') + (right ? '回答正确' : '回答错误') + '</div>' +
    '<div class="feedback-body"><b>正确答案：</b>' + esc(correctText) + '</div>' +
    (q.analysis ? '<div class="feedback-body" style="margin-top:8px"><b>解析：</b>' + esc(q.analysis) + '</div>' : '') +
  '</div>';
}

/* ============================== 视图：结果 ============================== */
function viewResult(lessonId) {
  const lesson = bank.lessons.find(l => l.id === lessonId);
  const sess = (session && session.lessonId === lessonId) ? session : loadSessions()[lessonId];
  if (!lesson || !sess) {
    return '<div class="view"><div class="empty">' + icon('book') + '<h3>没有可用的答题记录</h3>' +
      '<p>请先完成一次答题。</p><a class="btn btn-primary" href="#/">返回首页</a></div></div>';
  }

  const total = sess.order.length;
  let right = 0, wrong = 0;
  const wrongs = [];
  sess.order.forEach(id => {
    const q = lesson.questions.find(x => x.id === id);
    if (!q) return;
    const rec = sess.answers[id];
    const st = judge(q, rec);
    if (st === 'right') right++;
    else {
      wrong++;
      if (st === 'wrong') wrongs.push({ q: q, rec: rec || {} });
    }
  });

  const rate = total ? Math.round(right / total * 100) : 0;
  const used = sess.finished ? sess.finishedAt : Date.now();
  const elapsed = sess.startedAt ? Math.max(1, Math.round((used - sess.startedAt) / 60000)) : 0;

  // 记录成绩
  if (!sess.finished) {
    sess.finished = true;
    sess.finishedAt = Date.now();
    saveSession();
  }
  saveScore(lessonId, { rate: rate, right: right, total: total, at: Date.now() });

  const comment = rate >= 90 ? '掌握得非常扎实，可以进入下一篇课文了！'
                : rate >= 75 ? '整体不错，把错题再读一读就更稳了。'
                : rate >= 60 ? '基础基本过关，建议对照课文重读错题所在段落。'
                : '这篇还需要多读几遍，建议逐题回到原文找依据。';

  const wrongHtml = wrongs.length ? '<div class="wrong-list">' + wrongs.map(w => {
    const q = w.q;
    const correctText = q.type === 'choice'
      ? (q.answer + '. ' + (q.options[LETTERS.indexOf(q.answer)] || ''))
      : q.answer;
    let mine = w.rec.value != null ? String(w.rec.value) : '未作答';
    if (q.type === 'choice' && LETTERS.indexOf(mine) >= 0) mine = mine + '. ' + q.options[LETTERS.indexOf(mine)];
    if (q.type === 'short') mine = '自评：需要复习';
    return '<div class="wrong-item">' +
      '<div class="wrong-stem">' + esc(q.stem) + '</div>' +
      '<div class="wrong-line"><b>你的答案</b><span class="ans-wrong">' + esc(mine) + '</span></div>' +
      '<div class="wrong-line"><b>正确答案</b><span class="ans-right">' + esc(correctText) + '</span></div>' +
      (q.analysis ? '<div class="wrong-line"><b>解析</b>' + esc(q.analysis) + '</div>' : '') +
    '</div>';
  }).join('') + '</div>' : '';

  return '<div class="view">' +
    '<div class="quiz-topbar"><div class="quiz-title">' +
      '<a class="btn btn-ghost btn-sm" href="#/">' + icon('arrow-l') + '返回课文</a>' +
      '<h2>' + esc(lesson.title) + ' · 答题结果</h2>' +
    '</div></div>' +

    '<section class="result-hero">' +
      '<div class="score-ring" style="--pct:' + rate + '"><span>' + rate + '<small>%</small></span></div>' +
      '<h2>' + esc(comment) + '</h2>' +
      '<p>共 ' + total + ' 题，用时约 ' + elapsed + ' 分钟</p>' +
      '<div class="result-stats">' +
        '<div class="result-stat"><b style="color:#2f9e44">' + right + '</b><span>答对</span></div>' +
        '<div class="result-stat"><b style="color:#e03131">' + wrong + '</b><span>答错 / 未答</span></div>' +
        '<div class="result-stat"><b>' + rate + '%</b><span>正确率</span></div>' +
        '<div class="result-stat"><b>' + wrongs.length + '</b><span>待复习</span></div>' +
      '</div>' +
      '<div class="result-actions">' +
        '<button class="btn btn-primary" id="btnRetry">' + icon('arrow-r') + '再练一次</button>' +
        '<button class="btn btn-ghost" id="btnRetryWrong">只练错题</button>' +
        '<button class="btn btn-ghost" onclick="window.print()">打印结果</button>' +
        '<a class="btn btn-ghost" href="#/">返回课文列表</a>' +
      '</div>' +
    '</section>' +

    (wrongs.length ? '<div class="section-head" style="margin-top:30px"><div><h2>错题回顾</h2><p>把这 ' + wrongs.length + ' 道题重新读一遍原文</p></div></div>' + wrongHtml : '') +
  '</div>';
}

/* ============================== 视图：学生名单 ============================== */
function viewRoster() {
  const classes = roster.classes;
  const cls = activeClass();
  const students = cls ? cls.students : [];
  const askedTotal = students.reduce((s, x) => s + (x.askedCount || 0), 0);

  const rows = students.map(s =>
    '<li class="student-row">' +
      '<span class="student-name">' + esc(s.name) + '</span>' +
      '<span class="student-meta">' +
        (s.askedCount ? '已提问 ' + s.askedCount + ' 次' + (s.lastAskedAt ? ' · 上次 ' + shortDate(s.lastAskedAt) : '') : '还没被提问过') +
      '</span>' +
      '<button class="btn btn-ghost btn-sm" data-student-edit="' + esc(s.id) + '">改名</button>' +
      '<button class="icon-btn icon-btn-sm is-danger" data-student-del="' + esc(s.id) + '" title="从名单里删除" aria-label="删除">' + icon('trash') + '</button>' +
    '</li>').join('');

  return '<div class="view">' +
    '<div class="section-head">' +
      '<div><h2>学生名单</h2><p>把每个班的学生名单维护好，课堂提问就能直接随机点名。</p></div>' +
      '<div class="quiz-actions">' +
        '<a class="btn btn-primary btn-sm" href="#/ask">' + icon('mic') + '课堂提问</a>' +
        '<a class="btn btn-ghost btn-sm" href="#/">' + icon('arrow-l') + '返回课文列表</a>' +
      '</div>' +
    '</div>' +

    '<section class="panel card">' +
      '<h3>' + icon('users') + '班级</h3>' +
      '<p class="panel-desc">一位老师往往教好几个班，可以在这里分别维护名单。</p>' +
      '<div class="class-tabs">' +
        classes.map(c =>
          '<button type="button" class="class-tab' + (c.id === cls.id ? ' is-active' : '') + '" data-class="' + esc(c.id) + '">' +
            esc(c.name) + '<small>' + c.students.length + ' 人</small>' +
          '</button>').join('') +
        '<button type="button" class="class-tab is-add" id="btnNewClass">＋ 新建班级</button>' +
      '</div>' +
      '<div class="btn-row">' +
        '<button class="btn btn-ghost btn-sm" id="btnRenameClass">重命名班级</button>' +
        '<button class="btn btn-ghost btn-sm" id="btnDelClass">删除班级</button>' +
        '<button class="btn btn-ghost btn-sm" id="btnClearClass">清空本班名单</button>' +
      '</div>' +
    '</section>' +

    '<section class="panel card">' +
      '<h3>' + icon('users') + esc(cls.name) + ' · 共 ' + students.length + ' 人</h3>' +
      '<div class="roster-add">' +
        '<input type="text" id="newStudentName" placeholder="输入学生姓名，按回车添加；也可以一次粘贴多个名字" autocomplete="off">' +
        '<button class="btn btn-primary" id="btnAddStudent">' + icon('plus') + '添加</button>' +
      '</div>' +
      '<div class="roster-bar">' +
        '<button class="btn btn-ghost btn-sm" id="btnImportToggle">批量粘贴名单</button>' +
        (students.length ? '<button class="btn btn-ghost btn-sm" id="btnExportRoster">' + icon('download') + '导出名单</button>' : '') +
        (askedTotal ? '<span class="pill">累计提问 ' + askedTotal + ' 次</span>' : '') +
        '<span class="qedit-grow"></span>' +
        (students.length > 8 ? '<div class="search-field search-field-sm">' + icon('search') + '<input type="search" id="studentSearch" placeholder="搜索学生" value="' + esc(rosterFilter) + '" aria-label="搜索学生"></div>' : '') +
      '</div>' +
      '<div class="import-panel hidden" id="importPanel">' +
        '<textarea id="importNames" class="code-input code-input-sm" placeholder="一行一个名字，例如：&#10;张三&#10;李四&#10;王五&#10;&#10;支持从 Excel 整列复制粘贴，也支持用逗号、顿号、空格分隔。重名会自动跳过。" aria-label="批量导入学生名单"></textarea>' +
        '<div class="btn-row">' +
          '<button class="btn btn-primary btn-sm" id="btnImportNames">' + icon('check') + '导入名单</button>' +
          '<button class="btn btn-ghost btn-sm" id="btnImportCancel">取消</button>' +
        '</div>' +
      '</div>' +
      (students.length
        ? '<ul class="student-list" id="studentList">' + rows + '</ul>'
        : '<p class="muted" style="margin-top:16px">还没有学生。可以在上面逐个添加，或点「批量粘贴名单」把整份名单贴进来。</p>') +
      (students.length ? '<p class="tip-line">「已提问 N 次」是自动累计的：在课堂提问页勾选「优先抽提问次数少的同学」时，会优先照顾被提问少的学生。</p>' : '') +
    '</section>' +
  '</div>';
}

/* ============================== 视图：课堂提问（设置） ============================== */
function viewAsk() {
  const cls = roster.classes.find(c => c.id === askDraft.classId) || activeClass();
  if (askDraft.classId !== cls.id) { askDraft.classId = cls.id; askDraft.studentIds = []; saveAskDraft(); }

  const head = '<div class="section-head">' +
    '<div><h2>课堂提问</h2><p>选好学生和题目范围，系统会给每位学生随机分不同的题，课堂上一个个提问。</p></div>' +
    '<div class="quiz-actions">' +
      '<a class="btn btn-ghost btn-sm" href="#/roster">' + icon('users') + '管理学生名单</a>' +
      '<a class="btn btn-ghost btn-sm" href="#/">' + icon('arrow-l') + '返回课文列表</a>' +
    '</div>' +
  '</div>';

  if (!bank.lessons.length) {
    return '<div class="view">' + head + '<div class="empty">' + icon('book') +
      '<h3>题库还是空的</h3><p>先上传或录入题目，才能安排课堂提问。</p>' +
      '<a class="btn btn-primary" href="#/manage">' + icon('upload') + '去题库管理</a></div></div>';
  }
  if (!cls.students.length) {
    return '<div class="view">' + head + '<div class="empty">' + icon('users') +
      '<h3>「' + esc(cls.name) + '」还没有学生</h3><p>先把班级名单填好，回来就能随机点名了。</p>' +
      '<a class="btn btn-primary" href="#/roster">' + icon('users') + '去添加学生</a></div></div>';
  }

  // 上一次提问还没结束（比如中途点到别处去了）→ 顶部给个回来的入口
  let resumeBar = '';
  if (assignment && !assignment.finished) {
    const qCount = assignment.students.reduce((s, r) => s + r.questions.length, 0);
    resumeBar = '<div class="ask-resume">' + icon('mic') +
      '<span>上一次提问还没结束（' + assignment.students.length + ' 位学生 · ' + qCount + ' 道题）。</span>' +
      '<a class="btn btn-primary btn-sm" href="#/ask/run">继续提问</a>' +
      '<button class="btn btn-ghost btn-sm" id="btnAskWrapUp">结束并看小结</button>' +
    '</div>';
  }

  const picked = cls.students.filter(s => askDraft.studentIds.indexOf(s.id) >= 0);
  const per = clampInt(askDraft.per, 1, 20, 1);
  const byType = { choice: 0, judge: 0, fill: 0, short: 0 };
  bank.lessons.forEach(l => {
    if (askDraft.lessonIds.indexOf(l.id) < 0) return;
    l.questions.forEach(q => { if (byType[q.type] != null) byType[q.type]++; });
  });

  const chips = cls.students.map(s => {
    const on = askDraft.studentIds.indexOf(s.id) >= 0;
    return '<button type="button" class="student-chip' + (on ? ' is-on' : '') + '" data-pick-student="' + esc(s.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      esc(s.name) + (s.askedCount ? '<small>已问 ' + s.askedCount + ' 次</small>' : '') +
    '</button>';
  }).join('');

  const randomRow = askDraft.pickMode === 'random'
    ? '<div class="pick-row">' +
        '<span>抽取</span>' +
        '<input type="number" id="drawCount" min="1" max="' + cls.students.length + '" value="' + clampInt(askDraft.randomCount, 1, cls.students.length, 1) + '" aria-label="抽取人数">' +
        '<span>人</span>' +
        '<button class="btn btn-primary btn-sm" id="btnDraw">' + icon('dice') + '随机抽取</button>' +
        '<label class="inline-check"><input type="checkbox" id="drawPreferNew"' + (askDraft.preferNew ? ' checked' : '') + '>优先抽提问次数少的同学</label>' +
      '</div>'
    : '<p class="tip-line">点下面的名字选中或取消，可以多选。选好后直接开始提问。</p>';

  const lessonList = bank.lessons.map(l => {
    const on = askDraft.lessonIds.indexOf(l.id) >= 0;
    return '<label class="check-item' + (on ? ' is-on' : '') + '" data-lesson-check="' + esc(l.id) + '">' +
      '<input type="checkbox"' + (on ? ' checked' : '') + '>' +
      '<span><b>' + esc(l.title) + '</b>' + (l.grade ? ' <small>' + esc(l.grade) + '</small>' : '') + '</span>' +
      '<span class="qedit-grow"></span>' +
      '<small>' + l.questions.length + ' 题</small>' +
    '</label>';
  }).join('');

  const typeBtns = ALL_TYPES.map(t =>
    '<button type="button" class="type-toggle' + (askDraft.types.indexOf(t) >= 0 ? ' is-on' : '') + '" data-type-toggle="' + t + '">' +
      QUESTION_TYPES[t] + '<small>' + byType[t] + ' 题</small>' +
    '</button>').join('');

  return '<div class="view">' + head + resumeBar +
    '<div class="ask-grid">' +

      '<section class="panel card">' +
        '<h3><span class="step-no">1</span>选学生</h3>' +
        '<div class="ask-class-row">' +
          '<label for="askClass">班级</label>' +
          '<select id="askClass">' + roster.classes.map(c =>
            '<option value="' + esc(c.id) + '"' + (c.id === cls.id ? ' selected' : '') + '>' + esc(c.name) + '（' + c.students.length + ' 人）</option>').join('') +
          '</select>' +
        '</div>' +
        '<div class="mode-switch">' +
          '<button type="button" class="' + (askDraft.pickMode === 'random' ? 'is-on' : '') + '" data-pickmode="random">' + icon('dice') + '随机抽取</button>' +
          '<button type="button" class="' + (askDraft.pickMode === 'manual' ? 'is-on' : '') + '" data-pickmode="manual">' + icon('users') + '手动指定</button>' +
        '</div>' +
        randomRow +
        '<div class="student-picker" id="studentPicker">' + chips + '</div>' +
        '<div class="btn-row" style="margin-top:12px">' +
          '<button class="btn btn-ghost btn-sm" id="btnPickAll">全选</button>' +
          '<button class="btn btn-ghost btn-sm" id="btnPickNone">清空</button>' +
        '</div>' +
        '<p class="ask-selected">已选 <b id="askSelectedCount">' + picked.length + '</b> 人：' +
          '<span id="askSelectedNames">' + (picked.length ? esc(picked.map(s => s.name).join('、')) : '还没有选学生') + '</span></p>' +
      '</section>' +

      '<section class="panel card">' +
        '<h3><span class="step-no">2</span>选课文与题型</h3>' +
        '<div class="fld"><label>课文 <span class="fld-hint">可以多选</span></label>' +
          '<div class="check-list">' + lessonList + '</div>' +
          '<div class="btn-row" style="margin-top:8px">' +
            '<button class="btn btn-ghost btn-sm" id="btnLessonAll">全选</button>' +
            '<button class="btn btn-ghost btn-sm" id="btnLessonNone">全不选</button>' +
          '</div>' +
        '</div>' +
        '<div class="fld"><label>题型 <span class="fld-hint">可以混搭，比如只抽选择题和填空题</span></label>' +
          '<div class="type-toggles">' + typeBtns + '</div>' +
        '</div>' +
        '<div class="fld"><label>题目数量</label>' +
          '<div class="pick-row" style="margin-top:0">' +
            '<span>每位学生抽</span>' +
            '<input type="number" id="askPer" min="1" max="20" value="' + per + '" aria-label="每位学生的题目数量">' +
            '<span>道题</span>' +
          '</div>' +
          '<label class="inline-check" style="margin-top:10px"><input type="checkbox" id="askNoRepeat"' + (askDraft.noRepeat ? ' checked' : '') + '>不同学生之间不重复出题</label>' +
          '<p class="fld-hint">题库里的题目不够时，会自动循环使用并提前提示。</p>' +
        '</div>' +
      '</section>' +
    '</div>' +

    '<section class="panel card ask-go">' +
      '<div class="ask-go-inner">' +
        '<div class="ask-preview" id="askPreview">' + askPreviewHtml(picked, per) + '</div>' +
        '<button class="btn btn-primary btn-lg" id="btnStartAsk">' + icon('mic') + '开始提问</button>' +
      '</div>' +
      '<p class="tip-line">开始后会进入提问界面：一次显示一位学生的一道题，可以随时「显示答案」核对，学生答完点「答对 / 答错」记录。</p>' +
    '</section>' +
  '</div>';
}

/** 设置页底部的一行提示：范围里有多少题、够不够分 */
function askPreviewHtml(picked, per) {
  const pool = buildAskPool(askDraft.lessonIds, askDraft.types);
  if (!askDraft.lessonIds.length) return '<span class="ask-preview-warn">还没有选课文</span>';
  if (!askDraft.types.length) return '<span class="ask-preview-warn">还没有选题型</span>';
  if (!pool.length) return '<span class="ask-preview-warn">所选范围里没有题目</span>';
  if (!picked.length) return '选题范围共 <b>' + pool.length + '</b> 道题，选好学生就可以开始';
  const need = picked.length * per;
  return '选题范围共 <b>' + pool.length + '</b> 道题 · ' + picked.length + ' 人 × ' + per + ' 题 = <b>' + need + '</b> 题 · ' +
    (pool.length >= need
      ? '<span class="ask-preview-ok">题目充足，同学之间不会重题</span>'
      : '<span class="ask-preview-warn">题目不够，会有重复</span>');
}

/* ============================== 视图：课堂提问（进行中） ============================== */
const ALL_MARK_KEYS = ['right', 'wrong', 'skip'];
const MARK_TEXT = { right: '答对', wrong: '答错', skip: '跳过' };

function viewAskRun() {
  if (!assignment) {
    return '<div class="view"><div class="empty">' + icon('mic') +
      '<h3>还没有正在进行的提问</h3><p>先到「课堂提问」页选好学生和题目范围，再开始提问。</p>' +
      '<a class="btn btn-primary" href="#/ask">' + icon('mic') + '去安排提问</a></div></div>';
  }
  if (assignment.finished) return viewAskSummary();

  const total = assignment.students.length;
  const row = assignment.students[assignment.idx];
  if (!row) return viewAskSummary();
  const q = row.questions[assignment.qIdx];
  const mark = row.marks[assignment.qIdx] || '';
  const doneCount = row.marks.filter(Boolean).length;
  const rightCount = row.marks.filter(m => m === 'right').length;

  let questionCard;
  if (!q) {
    questionCard = '<section class="card q-card"><p class="muted">这位学生还没有分到题目。</p></section>';
  } else {
    questionCard = '<section class="card q-card">' +
      '<div class="q-head">' +
        '<span class="q-index">第 ' + (assignment.qIdx + 1) + ' 题</span>' +
        '<span class="q-type">' + QUESTION_TYPES[q.type] + '</span>' +
        '<span class="q-source">《' + esc(q.lessonTitle) + '》</span>' +
        '<span class="qedit-grow"></span>' +
        ((assignment.pool || []).length > 1 ? '<button class="btn btn-ghost btn-sm" id="btnAskSwap">' + icon('refresh') + '换一题</button>' : '') +
        '<button class="btn ' + (askRevealed ? 'btn-primary' : 'btn-ghost') + ' btn-sm" id="btnAskReveal">' + icon('eye') + (askRevealed ? '收起答案' : '显示答案') + '</button>' +
      '</div>' +
      '<h3 class="q-stem">' + esc(q.stem) + '</h3>' +
      renderAskAnswer(q, askRevealed) +
      '<div class="ask-mark">' +
        '<span class="ask-mark-label">记录：</span>' +
        ALL_MARK_KEYS.map(function (k) {
          return '<button class="btn btn-sm mark-btn' + (mark === k ? ' is-on-' + k : '') + '" data-mark="' + k + '">' +
            (k === 'right' ? icon('check') : k === 'wrong' ? icon('x') : '') + MARK_TEXT[k] +
          '</button>';
        }).join('') +
        '<span class="muted ask-mark-hint">' +
          (mark ? '已记录「' + MARK_TEXT[mark] + '」，再点一次可取消' : '学生答完在这里点一下，会自动跳到下一题') +
        '</span>' +
      '</div>' +
    '</section>';
  }

  const isLastQ = assignment.qIdx >= row.questions.length - 1;
  const nextName = assignment.idx < total - 1 ? assignment.students[assignment.idx + 1].name : '';
  let navRight;
  if (!isLastQ) {
    navRight = '<button class="btn btn-primary" id="btnAskNextQ">下一题' + icon('arrow-r') + '</button>';
  } else if (assignment.idx < total - 1) {
    navRight = '<button class="btn btn-primary" id="btnAskNextStudent2">下一位学生：' + esc(nextName) + icon('arrow-r') + '</button>';
  } else {
    navRight = '<button class="btn btn-primary" id="btnAskFinish2">' + icon('check') + '结束并查看小结</button>';
  }

  const studentMap = assignment.students.map((r, i) => {
    const done = r.marks.filter(Boolean).length;
    const right = r.marks.filter(m => m === 'right').length;
    let cls = 'ask-map-chip';
    if (i === assignment.idx) cls += ' is-current';
    else if (done && done >= r.questions.length) cls += ' is-done';
    return '<button class="' + cls + '" data-ask-goto="' + i + '">' + esc(r.name) +
      '<small>' + (r.questions.length ? right + '/' + r.questions.length + ' 对' : '无题') + '</small>' +
    '</button>';
  }).join('');

  return '<div class="view">' +
    '<div class="quiz-topbar">' +
      '<div class="quiz-title">' +
        '<a class="btn btn-ghost btn-sm" href="#/ask">' + icon('arrow-l') + '返回设置</a>' +
        '<h2>课堂提问 · ' + esc(assignment.className || '') + '</h2>' +
      '</div>' +
      '<div class="quiz-actions">' +
        '<button class="btn btn-ghost btn-sm" id="fontToggle" title="切换投影字号">' + icon('book') + '<span id="fontLabel">正常</span></button>' +
        '<button class="btn btn-ghost btn-sm" id="btnAskFinish">结束并看小结</button>' +
      '</div>' +
    '</div>' +

    '<section class="card ask-student-card">' +
      '<div class="ask-student-line">' +
        '<span class="ask-student-index">第 ' + (assignment.idx + 1) + ' / ' + total + ' 位学生</span>' +
        '<strong class="ask-student-name">' + esc(row.name) + '</strong>' +
        (row.temp ? '<span class="pill pill-accent">临时加入</span>' : '') +
        '<span class="pill">' + row.questions.length + ' 道题</span>' +
        '<span class="pill pill-success">答对 ' + rightCount + '</span>' +
        '<span class="pill">已记录 ' + doneCount + ' / ' + row.questions.length + '</span>' +
        '<span class="qedit-grow"></span>' +
        '<button class="btn btn-ghost btn-sm" id="btnAskAddStudent" title="名单外的同学，只加入这次提问">＋ 临时加人</button>' +
        '<button class="btn btn-ghost btn-sm" id="btnAskPrevStudent"' + (assignment.idx === 0 ? ' disabled' : '') + '>' + icon('arrow-l') + '上一位学生</button>' +
        '<button class="btn btn-ghost btn-sm" id="btnAskNextStudent"' + (assignment.idx >= total - 1 ? ' disabled' : '') + '>下一位学生' + icon('arrow-r') + '</button>' +
      '</div>' +
    '</section>' +

    questionCard +

    '<div class="quiz-nav">' +
      '<button class="btn btn-ghost" id="btnAskPrevQ"' + (assignment.qIdx === 0 ? ' disabled' : '') + '>' + icon('arrow-l') + '上一题</button>' +
      navRight +
    '</div>' +

    '<div class="ask-student-map" aria-label="学生导航">' + studentMap + '</div>' +
  '</div>';
}

/** 提问页的题目内容：选项只做展示，不点选 */
function renderAskAnswer(q, revealed) {
  if (q.type === 'choice' || q.type === 'judge') {
    const isChoice = q.type === 'choice';
    const opts = isChoice ? (q.options || []) : ['正确', '错误'];
    const keys = isChoice ? LETTERS : ['√', '×'];
    const answerIdx = isChoice
      ? LETTERS.indexOf(q.answer)
      : (normJudge(q.answer) === '正确' ? 0 : 1);
    let html = '<div class="options">' + opts.map((opt, i) => {
      let cls = 'option';
      if (revealed && i === answerIdx) cls += ' is-correct';
      return '<div class="' + cls + '"><span class="option-key">' + (keys[i] || '') + '</span>' +
        '<span class="option-text">' + esc(opt) + '</span></div>';
    }).join('') + '</div>';
    if (revealed) html += askAnswerBlock(q);
    return html;
  }

  let html = '<div class="answer-area">' +
    '<p class="hint">让学生口头回答，再点右上角「显示答案」核对。</p></div>';
  if (revealed) html += askAnswerBlock(q);
  return html;
}

/** 提问页的答案块（给老师看的正确答案 + 解析） */
function askAnswerBlock(q) {
  const correctText = q.type === 'choice'
    ? (q.answer ? q.answer + '. ' + (q.options[LETTERS.indexOf(q.answer)] || '') : '—')
    : (q.answer || '（这道题没有填答案）');
  return '<div class="feedback info">' +
    '<div class="feedback-title">' + icon('check') + '正确答案</div>' +
    '<div class="feedback-body">' + esc(correctText) + '</div>' +
    (q.analysis ? '<div class="feedback-body" style="margin-top:8px"><b>解析：</b>' + esc(q.analysis) + '</div>' : '') +
  '</div>';
}

/** 提问小结：正确率 + 逐人明细，可打印 */
function viewAskSummary() {
  const rows = assignment.students || [];
  let totalQ = 0, right = 0, wrong = 0, skip = 0, unmarked = 0;
  rows.forEach(r => {
    r.questions.forEach((q, i) => {
      totalQ++;
      const m = r.marks[i];
      if (m === 'right') right++;
      else if (m === 'wrong') wrong++;
      else if (m === 'skip') skip++;
      else unmarked++;
    });
  });
  const rate = totalQ ? Math.round(right / totalQ * 100) : 0;
  const markHtml = m => m === 'right' ? '<span class="mark-ok">✓ 答对</span>'
    : m === 'wrong' ? '<span class="mark-bad">✗ 答错</span>'
    : m === 'skip' ? '<span class="mark-skip">— 跳过</span>'
    : '<span class="mark-skip">未记录</span>';

  const tableRows = rows.map(r => {
    const rRight = r.marks.filter(m => m === 'right').length;
    const items = r.questions.map((q, i) =>
      '<li>' +
        '<span class="ask-sum-stem">' + esc(q.stem) + '</span>' +
        '<span class="ask-sum-meta">' + QUESTION_TYPES[q.type] + ' · 《' + esc(q.lessonTitle) + '》</span>' +
        markHtml(r.marks[i]) +
      '</li>').join('');
    return '<tr>' +
      '<td><strong>' + esc(r.name) + '</strong>' + (r.temp ? '<br><span class="pill pill-accent">临时</span>' : '') + '</td>' +
      '<td><ul class="ask-sum-list">' + items + '</ul></td>' +
      '<td class="ask-sum-score">' + rRight + ' / ' + r.questions.length + '</td>' +
    '</tr>';
  }).join('');

  const comment = unmarked ? '还有 ' + unmarked + ' 道题没有记录，可以点「继续记录」补上再结束。'
    : rate >= 80 ? '整体掌握得不错，重点讲评答错的题目即可。'
    : rate >= 60 ? '基础基本过关，建议带着学生回到课文里找依据。'
    : '多数题目还需要再讲一遍，可以从错题集中的段落入手。';

  const meta = [
    assignment.className,
    rows.length + ' 位学生',
    (assignment.lessonTitles || []).join('、'),
    shortDate(assignment.finishedAt || assignment.at)
  ].filter(Boolean).join(' · ');

  return '<div class="view">' +
    '<div class="quiz-topbar">' +
      '<div class="quiz-title">' +
        '<a class="btn btn-ghost btn-sm" href="#/ask">' + icon('arrow-l') + '返回设置</a>' +
        '<h2>提问小结</h2>' +
      '</div>' +
      '<div class="quiz-actions"><button class="btn btn-ghost btn-sm" onclick="window.print()">打印小结</button></div>' +
    '</div>' +

    '<section class="result-hero">' +
      '<div class="score-ring" style="--pct:' + rate + '"><span>' + rate + '<small>%</small></span></div>' +
      '<h2>' + comment + '</h2>' +
      '<p>' + esc(meta) + '</p>' +
      '<div class="result-stats">' +
        '<div class="result-stat"><b>' + rows.length + '</b><span>被提问学生</span></div>' +
        '<div class="result-stat"><b>' + totalQ + '</b><span>题目</span></div>' +
        '<div class="result-stat"><b style="color:#2f9e44">' + right + '</b><span>答对</span></div>' +
        '<div class="result-stat"><b style="color:#e03131">' + (wrong + skip) + '</b><span>答错 / 跳过</span></div>' +
      '</div>' +
      '<div class="result-actions">' +
        '<button class="btn btn-primary" id="btnAskAgain">' + icon('dice') + '再抽一轮（重新随机分题）</button>' +
        (unmarked ? '<button class="btn btn-ghost" id="btnAskResume">继续记录</button>' : '') +
        '<a class="btn btn-ghost" href="#/ask">重新设置</a>' +
        '<a class="btn btn-ghost" href="#/">返回课文列表</a>' +
      '</div>' +
    '</section>' +

    '<section class="panel card" style="margin-top:22px">' +
      '<h3>' + icon('file') + '逐人明细</h3>' +
      '<p class="panel-desc">' + (unmarked ? '还有 ' + unmarked + ' 道题没有记录，显示为「未记录」。' : '全班记录如下，可以打印出来留存。') + '</p>' +
      '<table class="ask-table">' +
        '<thead><tr><th>学生</th><th>题目与记录</th><th>答对</th></tr></thead>' +
        '<tbody>' + tableRows + '</tbody>' +
      '</table>' +
    '</section>' +
  '</div>';
}

/* ============================== 视图：题库管理 ============================== */
function viewManage() {
  // 正在编辑某篇课文的题目 → 切到题目编辑视图
  if (manageEditing) {
    const editing = bank.lessons.find(x => x.id === manageEditing);
    if (editing) return viewLessonEditor(editing);
    manageEditing = null;
    draft = null;
  }

  const lessons = bank.lessons;
  const totalQ = lessons.reduce((s, l) => s + l.questions.length, 0);
  const byType = { choice: 0, judge: 0, fill: 0, short: 0 };
  lessons.forEach(l => l.questions.forEach(q => { if (byType[q.type] != null) byType[q.type]++; }));

  const rows = lessons.length ? lessons.map(l =>
    '<div class="bank-row">' +
      '<div class="bank-name"><strong>' + esc(l.title) + '</strong>' +
        '<small>' + esc([l.grade, l.author].filter(Boolean).join(' · ') || '未标注') + ' · ' + l.questions.length + ' 题</small></div>' +
      '<button class="btn btn-ghost btn-sm" data-manage-lesson="' + esc(l.id) + '">' + icon('file') + '管理题目</button>' +
      '<a class="btn btn-ghost btn-sm' + (l.questions.length ? '' : ' is-disabled') + '" href="#/quiz/' + encodeURIComponent(l.id) + '">答题</a>' +
      '<button class="icon-btn" data-del-lesson="' + esc(l.id) + '" title="删除这篇课文" aria-label="删除' + esc(l.title) + '">' + icon('trash') + '</button>' +
    '</div>').join('') : '<p class="muted" style="margin-top:14px">暂无课文。可以上传 Excel 表格，也可以点下方「新建课文」手动逐题录入。</p>';

  return '<div class="view">' +
    '<div class="section-head"><div><h2>题库管理</h2><p>上传题目、查看题库、导出备份。所有数据仅保存在本机浏览器。</p></div>' +
      '<a class="btn btn-ghost btn-sm" href="#/">' + icon('arrow-l') + '返回课文列表</a></div>' +

    '<div class="manage-grid">' +
      '<div>' +
        '<section class="panel card">' +
          '<h3>' + icon('upload') + '上传题库文件</h3>' +
          '<p class="panel-desc">你维护好的 <b>Excel 表格（.xlsx）</b> 可以直接拖进来；也支持 <b>CSV</b>、<b>纯文本</b>、<b>JSON</b>，会自动识别格式。</p>' +

          '<div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="点击或拖拽文件上传">' +
            icon('upload') +
            '<strong>拖拽 .xlsx 文件到这里，或点击选择文件</strong>' +
            '<span>支持 .xlsx / .xls / .csv / .txt / .json，单个文件建议不超过 5 MB</span>' +
          '</div>' +
          '<input type="file" id="fileInput" class="hidden" accept=".xlsx,.xlsm,.xlsb,.xls,.csv,.txt,.json,.tsv,.md" multiple>' +
          '<p class="tip-line">在 Excel 里改完题目、存盘之后再拖进来，页面题库就会同步成最新内容。</p>' +

          '<div class="tabs" role="tablist">' +
            '<button class="tab' + (manageTab === 'file' ? ' is-active' : '') + '" data-tab="file" role="tab">粘贴文本</button>' +
            '<button class="tab' + (manageTab === 'help' ? ' is-active' : '') + '" data-tab="help" role="tab">格式说明</button>' +
          '</div>' +

          '<div class="tab-panel' + (manageTab === 'file' ? '' : ' hidden') + '" data-panel="file">' +
            '<textarea class="code-input" id="pasteArea" placeholder="把题目粘贴到这里…&#10;&#10;示例：&#10;# 观潮&#10;[选择] 钱塘江大潮自古以来被称为？&#10;A. 天下奇观&#10;B. 世界奇景&#10;答案：A&#10;解析：开篇总起句。" aria-label="粘贴题目文本"></textarea>' +
            '<div class="btn-row">' +
              '<button class="btn btn-primary" id="btnParse">' + icon('check') + '解析并导入</button>' +
              '<button class="btn btn-ghost" id="btnClearPaste">清空</button>' +
              '<button class="btn btn-ghost" id="btnTplXlsx">' + icon('download') + '下载 Excel 模板</button>' +
              '<button class="btn btn-ghost" id="btnTplCsv">' + icon('download') + '下载 CSV 模板</button>' +
              '<button class="btn btn-ghost" id="btnTplTxt">' + icon('download') + '下载文本模板</button>' +
            '</div>' +
          '</div>' +

          '<div class="tab-panel' + (manageTab === 'help' ? '' : ' hidden') + '" data-panel="help">' +
            '<div class="format-help">' +
              '<h4>格式一：Excel 表格 .xlsx（推荐）</h4>' +
              '<p>把 .xlsx 直接拖进上传区就行，<b>不用另存为别的格式</b>。首行为表头：课文、年级、作者、题型、题干、选项A~选项F、答案、解析，列的先后顺序不限。</p>' +
              '<p>两种排布都支持：<b>①</b> 所有课文写在同一张表里，用「课文」列区分；<b>②</b> 每篇课文单独一张工作表，表名就是课文名。点「下载 Excel 模板」可以直接拿到带示例的文件。</p>' +

              '<h4 style="margin-top:20px">格式二：CSV 表格</h4>' +
              '<p>列与 Excel 完全一致，在 Excel 里「另存为 CSV UTF-8」即可。</p>' +
              '<pre>课文,年级,题型,题干,选项A,选项B,选项C,选项D,答案,解析\n' +
              '观潮,四年级上册,选择题,钱塘江大潮自古被称为？,天下奇观,世界奇景,天下第一潮,人间胜景,A,开篇总起句\n' +
              '观潮,四年级上册,判断题,潮来前江面平静。,,,,,正确,与潮来时形成对比\n' +
              '观潮,四年级上册,填空题,形成一堵两丈多高的（　）。,,,,,水墙,以水墙喻浪\n' +
              '观潮,四年级上册,简答题,作者用了哪些比喻？,,,,,把潮水比作白线、水墙……,先找比喻再谈效果</pre>' +
              '<dl style="margin-top:14px">' +
                '<dt>题型</dt><dd>选择题 / 判断题 / 填空题 / 简答题（不填会按内容自动判断）</dd>' +
                '<dt>答案</dt><dd>选择题填 A/B/C/D；判断题填「正确 / 错误」；填空题可填多个可接受答案，用 <b>|</b> 分隔，如 <code>一会儿|一瞬间</code></dd>' +
              '</dl>' +

              '<h4 style="margin-top:20px">格式三：纯文本（手机上随手敲）</h4>' +
              '<p>用 <code># 课文名</code> 分课，用 <code>[题型]</code> 开始一道题。适合微信里复制粘贴。</p>' +
              '<pre># 观潮\n@年级 四年级上册\n@作者 周密\n\n[选择] 钱塘江大潮自古以来被称为？\nA. 天下奇观\nB. 世界奇景\n答案：A\n解析：开篇总起句。\n\n[判断] 潮来前江面上很平静。\n答案：正确</pre>' +

              '<h4 style="margin-top:20px">格式四：JSON（程序批量生成）</h4>' +
              '<p>直接导出本系统的备份文件即为该格式，可原样导入。</p>' +
              '<pre>{ "version": 1, "lessons": [ { "title": "观潮", "questions": [\n' +
              '  { "type": "choice", "stem": "题干", "options": ["A项","B项"],\n' +
              '    "answer": "A", "analysis": "解析" } ] } ] }</pre>' +
            '</div>' +
          '</div>' +
        '</section>' +
      '</div>' +

      '<div>' +
        '<section class="panel card">' +
          '<h3>' + icon('book') + '题库概览</h3>' +
          '<div class="stat-row">' +
            '<div class="stat-box"><b>' + lessons.length + '</b><span>篇课文</span></div>' +
            '<div class="stat-box"><b>' + totalQ + '</b><span>道题目</span></div>' +
          '</div>' +
          '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">' +
            Object.keys(byType).map(k => '<span class="pill">' + QUESTION_TYPES[k] + ' ' + byType[k] + '</span>').join('') +
          '</div>' +
          '<div class="bank-list">' + rows + '</div>' +
          '<div class="btn-row">' +
            '<button class="btn btn-primary btn-sm" id="btnExportXlsx">' + icon('download') + '导出 Excel 题库</button>' +
            '<button class="btn btn-ghost btn-sm" id="btnNewLesson">＋ 新建课文</button>' +
            '<button class="btn btn-ghost btn-sm" id="btnExport">' + icon('download') + '导出 JSON 备份</button>' +
            '<button class="btn btn-ghost btn-sm" id="btnExportPortable">' + icon('download') + '导出便携数据（U 盘用）</button>' +
            '<button class="btn btn-ghost btn-sm" id="btnRestoreDemo">恢复示例题库</button>' +
            '<button class="btn btn-danger btn-sm" id="btnWipe">' + icon('trash') + '清空全部</button>' +
          '</div>' +
          '<p class="muted" style="margin-top:14px;font-size:13px">「导出 Excel 题库」得到的 .xlsx 就是你的题库存档：在 Excel 里改完再上传回来，两边内容保持一致。JSON 备份适合换电脑时整库搬运。</p>' +
          '<p class="tip-line">便携数据文件：' + esc(portableStatusText()) + '<br>' +
            '「导出便携数据」会下载 <b>' + PORTABLE_FILE + '</b>：把它放进网站文件夹（覆盖旧文件），整个文件夹拷到 U 盘，换电脑打开就能直接用，题库 / 名单 / 成绩都会跟过去。</p>' +
        '</section>' +
      '</div>' +
    '</div>' +
  '</div>';
}

/* ============================== 视图：课文题目编辑器 ============================== */
/** 答案预览文本（列表用） */
function answerPreview(q) {
  const a = String(q.answer || '');
  if (!a) return '（未填写）';
  return a.length > 70 ? a.slice(0, 70) + '…' : a;
}

/** 单道题的摘要行 */
function renderQuestionSummary(q, index, total) {
  const opts = (q.options || []).map((o, i) => LETTERS[i] + '. ' + o).join('　');
  return '<article class="qedit-item">' +
    '<div class="qedit-head">' +
      '<span class="qedit-no">' + (index + 1) + '</span>' +
      '<span class="q-type">' + QUESTION_TYPES[q.type] + '</span>' +
      '<span class="qedit-grow"></span>' +
      '<div class="qedit-ops">' +
        '<button class="icon-btn icon-btn-sm" data-q-move="up" data-qid="' + esc(q.id) + '" title="上移"' + (index === 0 ? ' disabled' : '') + ' aria-label="上移">↑</button>' +
        '<button class="icon-btn icon-btn-sm" data-q-move="down" data-qid="' + esc(q.id) + '" title="下移"' + (index === total - 1 ? ' disabled' : '') + ' aria-label="下移">↓</button>' +
        '<button class="btn btn-ghost btn-sm" data-q-edit="' + esc(q.id) + '">编辑</button>' +
        '<button class="icon-btn icon-btn-sm is-danger" data-q-del="' + esc(q.id) + '" title="删除这道题" aria-label="删除">' + icon('trash') + '</button>' +
      '</div>' +
    '</div>' +
    '<p class="qedit-stem">' + esc(q.stem) + '</p>' +
    (opts ? '<div class="qedit-opts">' + esc(opts) + '</div>' : '') +
    '<div class="qedit-meta">' +
      '<span class="qedit-ans">答案：' + esc(answerPreview(q)) + '</span>' +
      (q.analysis ? '<span class="qedit-ana">解析：' + esc(q.analysis.length > 46 ? q.analysis.slice(0, 46) + '…' : q.analysis) + '</span>' : '') +
    '</div>' +
  '</article>';
}

/** 题目编辑表单（同一时刻只编辑一道题） */
function renderQuestionForm(d, index) {
  const isNew = d.qid === null;
  const typeSel = ['choice', 'judge', 'fill', 'short'].map(t =>
    '<option value="' + t + '"' + (d.type === t ? ' selected' : '') + '>' + QUESTION_TYPES[t] + '</option>').join('');

  let optionsHtml = '';
  if (d.type === 'choice') {
    optionsHtml = '<div class="fld"><label>选项 <span class="fld-hint">至少 2 个，答案按 A、B、C… 顺序对应</span></label>' +
      '<div class="opt-rows">' +
        d.options.map((o, i) =>
          '<div class="opt-row">' +
            '<span class="opt-key">' + LETTERS[i] + '</span>' +
            '<input type="text" class="opt-input" data-opt-idx="' + i + '" value="' + esc(o) + '" placeholder="选项 ' + LETTERS[i] + ' 的内容">' +
            (d.options.length > 2
              ? '<button type="button" class="icon-btn icon-btn-sm is-danger" data-opt-del="' + i + '" title="删除选项 ' + LETTERS[i] + '" aria-label="删除选项">' + icon('x') + '</button>'
              : '') +
          '</div>').join('') +
      '</div>' +
      (d.options.length < 8 ? '<button type="button" class="btn btn-ghost btn-sm" data-opt-add="1">＋ 添加选项</button>' : '') +
      '</div>';
  }

  let answerHtml = '';
  if (d.type === 'choice') {
    answerHtml = '<div class="fld"><label>正确答案</label><div class="ans-pills">' +
      d.options.map((o, i) =>
        '<button type="button" class="ans-pill' + (d.answer === LETTERS[i] ? ' is-on' : '') + '" data-ans="' + LETTERS[i] + '" title="' + esc(o) + '">' + LETTERS[i] + '</button>').join('') +
      '</div></div>';
  } else if (d.type === 'judge') {
    answerHtml = '<div class="fld"><label>正确答案</label><div class="ans-pills">' +
      ['正确', '错误'].map(v =>
        '<button type="button" class="ans-pill ans-pill-text' + (d.answer === v ? ' is-on' : '') + '" data-ans="' + v + '">' + v + '</button>').join('') +
      '</div></div>';
  } else if (d.type === 'fill') {
    answerHtml = '<div class="fld"><label for="draftAnswer">正确答案</label>' +
      '<input type="text" id="draftAnswer" value="' + esc(d.answer) + '" placeholder="多个可接受答案用 | 分隔，例如：一会儿|一瞬间|转眼间">' +
      '<p class="fld-hint">学生填其中任意一个都算对；比对时会自动忽略空格与标点。</p></div>';
  } else {
    answerHtml = '<div class="fld"><label for="draftAnswer">参考答案</label>' +
      '<textarea id="draftAnswer" rows="4" placeholder="课堂上让学生先答，再点「查看参考答案」自行对照">' + esc(d.answer) + '</textarea>' +
      '<p class="fld-hint">简答题由学生对照参考答案自评「答对 / 需复习」。</p></div>';
  }

  return '<article class="qedit-item is-editing">' +
    '<div class="qedit-head">' +
      '<span class="qedit-no is-editing">' + (isNew ? '新' : index + 1) + '</span>' +
      '<strong>' + (isNew ? '新增题目' : '编辑第 ' + (index + 1) + ' 题') + '</strong>' +
    '</div>' +
    '<form id="qEditForm" class="qedit-form">' +
      '<div class="fld"><label for="draftType">题型</label>' +
        '<select id="draftType">' + typeSel + '</select></div>' +
      '<div class="fld"><label for="draftStem">题干 <span class="fld-hint">必填</span></label>' +
        '<textarea id="draftStem" rows="3" placeholder="题目内容">' + esc(d.stem) + '</textarea></div>' +
      optionsHtml +
      answerHtml +
      '<div class="fld"><label for="draftAnalysis">解析 <span class="fld-hint">选填，判分后给老师参考</span></label>' +
        '<textarea id="draftAnalysis" rows="2" placeholder="选填">' + esc(d.analysis) + '</textarea></div>' +
      '<div class="btn-row">' +
        '<button type="submit" class="btn btn-primary btn-sm">' + icon('check') + '保存并生效</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-form-cancel="1">取消</button>' +
      '</div>' +
    '</form>' +
  '</article>';
}

/** 课文题目编辑视图 */
function viewLessonEditor(lesson) {
  const qs = lesson.questions;
  const creating = !!draft && draft.lessonId === lesson.id && draft.qid === null;
  const byType = { choice: 0, judge: 0, fill: 0, short: 0 };
  qs.forEach(q => { if (byType[q.type] != null) byType[q.type]++; });

  let list;
  if (!qs.length && !creating) {
    list = '<p class="muted" style="margin-top:16px">这篇课文还没有题目。点下方「新增题目」逐题录入，或拖入 Excel 表格批量导入。</p>';
  } else {
    list = qs.map((q, i) => {
      const isEditing = !!draft && draft.lessonId === lesson.id && draft.qid === q.id;
      return isEditing ? renderQuestionForm(draft, i) : renderQuestionSummary(q, i, qs.length);
    }).join('');
    if (creating) list += renderQuestionForm(draft, qs.length);
  }

  return '<div class="view">' +
    '<div class="section-head">' +
      '<div>' +
        '<h2>' + esc(lesson.title) + ' · 题目管理</h2>' +
        '<p>共 <b>' + qs.length + '</b> 道题　改动即时生效，首页与答题页会同步更新。</p>' +
      '</div>' +
      '<button class="btn btn-ghost btn-sm" id="btnExitEditor">' + icon('arrow-l') + '返回题库管理</button>' +
    '</div>' +

    '<section class="panel card">' +
      '<h3>' + icon('book') + '课文信息</h3>' +
      '<form class="lesson-form" id="lessonInfoForm">' +
        '<div class="fld-grid">' +
          '<div class="fld"><label for="lTitle">课文名</label><input type="text" id="lTitle" value="' + esc(lesson.title) + '"></div>' +
          '<div class="fld"><label for="lGrade">年级</label><input type="text" id="lGrade" value="' + esc(lesson.grade) + '" placeholder="如：四年级上册"></div>' +
          '<div class="fld"><label for="lAuthor">作者</label><input type="text" id="lAuthor" value="' + esc(lesson.author) + '" placeholder="选填"></div>' +
        '</div>' +
        '<div class="fld"><label for="lDesc">课文简介 <span class="fld-hint">选填，显示在首页卡片上</span></label>' +
          '<textarea id="lDesc" rows="2">' + esc(lesson.desc) + '</textarea></div>' +
        '<div class="btn-row">' +
          '<button type="submit" class="btn btn-primary btn-sm">' + icon('check') + '保存课文信息</button>' +
          '<button type="button" class="btn btn-danger btn-sm" id="btnDelLessonInEditor">' + icon('trash') + '删除这篇课文</button>' +
        '</div>' +
      '</form>' +
    '</section>' +

    '<section class="panel card" style="margin-top:20px">' +
      '<h3>' + icon('file') + '题目列表</h3>' +
      (qs.length ? '<div class="type-pills">' +
        Object.keys(byType).map(k => '<span class="pill">' + QUESTION_TYPES[k] + ' ' + byType[k] + '</span>').join('') +
        '</div>' : '') +
      '<div class="qedit-list">' + list + '</div>' +
      (creating ? '' : '<div class="btn-row"><button class="btn btn-primary" id="btnAddQuestion">＋ 新增题目</button></div>') +
    '</section>' +

    '<section class="panel card" style="margin-top:20px">' +
      '<h3>' + icon('upload') + '批量导入（可选）</h3>' +
      '<p class="panel-desc">同样把 <b>.xlsx</b> 拖进来即可。表格里若出现同名课文，会问你是「整体替换」还是「追加」。</p>' +
      '<div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="点击或拖拽文件上传">' +
        icon('upload') +
        '<strong>拖拽 .xlsx / .csv 文件到这里</strong>' +
        '<span>导入后立即并入当前题库</span>' +
      '</div>' +
      '<input type="file" id="fileInput" class="hidden" accept=".xlsx,.xlsm,.xlsb,.xls,.csv,.txt,.json,.tsv,.md" multiple>' +
      '<p class="tip-line">用 Excel 批量整理题目时，直接在下面「导出 Excel 题库」拿到当前题库，改完再拖回这里即可。</p>' +
    '</section>' +
  '</div>';
}

/** 保存题目草稿（新增或修改），成功后立即生效 */
function saveDraft(lesson) {
  if (!draft) return;
  const stem = String(draft.stem || '').trim();
  if (!stem) { toast('题干不能为空', 'bad'); return; }

  const payload = {
    type: draft.type,
    stem: stem,
    options: [],
    answer: '',
    analysis: String(draft.analysis || '').trim()
  };

  if (draft.type === 'choice') {
    const opts = (draft.options || []).map(s => String(s).trim());
    if (opts.length < 2) { toast('选择题至少要有 2 个选项', 'bad'); return; }
    if (opts.some(o => !o)) { toast('选项内容不能留空，请补全或删掉空选项', 'bad'); return; }
    const idx = LETTERS.indexOf(draft.answer);
    if (idx < 0 || idx >= opts.length) { toast('请点选一个正确答案', 'bad'); return; }
    payload.options = opts;
    payload.answer = draft.answer;
  } else if (draft.type === 'judge') {
    payload.answer = normJudge(draft.answer) || '正确';
  } else {
    payload.answer = String(draft.answer || '').trim();
    if (!payload.answer) { toast(draft.type === 'fill' ? '请填写正确答案' : '请填写参考答案', 'bad'); return; }
  }

  const nq = normalizeQuestion(payload);
  if (!nq) { toast('题目内容不完整，无法保存', 'bad'); return; }

  if (draft.qid === null) {
    lesson.questions.push(nq);
    toast('已新增第 ' + lesson.questions.length + ' 题', 'ok');
  } else {
    const i = lesson.questions.findIndex(x => x.id === draft.qid);
    if (i < 0) { toast('这道题已不存在，请刷新页面重试', 'bad'); return; }
    nq.id = draft.qid;              // 保留原 id，学生的作答记录不受影响
    lesson.questions[i] = nq;
    toast('已保存修改，页面已即时生效', 'ok');
  }

  lesson.updatedAt = Date.now();
  saveBank();
  syncSessionsAfterBankChange(lesson.id);
  draft = null;
  rerenderManage();
}

/** 删除整篇课文 */
function deleteLesson(id) {
  const l = bank.lessons.find(x => x.id === id);
  if (!l) return;
  if (!confirm('确定删除《' + l.title + '》及其 ' + l.questions.length + ' 道题目吗？此操作不可撤销。')) return;
  bank.lessons = bank.lessons.filter(x => x.id !== id);
  saveBank();
  try { const s = loadSessions(); delete s[id]; localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
  try { const sc = loadScores(); delete sc[id]; localStorage.setItem(SCORE_KEY, JSON.stringify(sc)); } catch (e) { /* 忽略 */ }
  if (session && session.lessonId === id) session = null;
  if (manageEditing === id) { manageEditing = null; draft = null; }
  toast('已删除《' + l.title + '》', 'ok');
  rerenderManage();
}

/** 新建一篇空白课文 */
function createLesson() {
  const title = prompt('请输入课文名（例如：爬山虎的脚）', '');
  if (title === null) return;
  const name = String(title).trim();
  if (!name) { toast('课文名不能为空', 'bad'); return; }
  if (bank.lessons.some(x => x.title === name)) { toast('已经有同名的课文「' + name + '」了', 'bad'); return; }
  const lesson = normalizeBank({ lessons: [{ title: name, questions: [] }] }).lessons[0];
  if (!lesson) { toast('创建失败，请重试', 'bad'); return; }
  bank.lessons.push(lesson);
  saveBank();
  syncSessionsAfterBankChange();
  manageEditing = lesson.id;
  draft = null;
  toast('已新建《' + name + '》，现在可以加题目了', 'ok');
  rerenderManage();
}

/** 文件上传区（题库管理页与课文编辑页共用） */
function bindDropzone() {
  const dz = $('#dropzone'), fi = $('#fileInput');
  if (!dz || !fi) return;
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  fi.addEventListener('change', () => { handleFiles(fi.files); fi.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('is-drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('is-drag'); }));
  dz.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
}

function bindLessonEditor() {
  const lesson = bank.lessons.find(x => x.id === manageEditing);
  if (!lesson) { manageEditing = null; rerenderManage(); return; }

  const exit = $('#btnExitEditor');
  if (exit) exit.addEventListener('click', () => { manageEditing = null; draft = null; rerenderManage(); });

  // 课文信息
  const infoForm = $('#lessonInfoForm');
  if (infoForm) infoForm.addEventListener('submit', e => {
    e.preventDefault();
    const title = $('#lTitle').value.trim();
    if (!title) { toast('课文名不能为空', 'bad'); return; }
    if (bank.lessons.some(x => x.id !== lesson.id && x.title === title)) {
      toast('已经有同名的课文「' + title + '」了，换个名字吧', 'bad');
      return;
    }
    lesson.title = title;
    lesson.grade = $('#lGrade').value.trim();
    lesson.author = $('#lAuthor').value.trim();
    lesson.desc = $('#lDesc').value.trim();
    lesson.updatedAt = Date.now();
    saveBank();
    if (session && session.lessonId === lesson.id) session.title = lesson.title;
    toast('课文信息已保存', 'ok');
    rerenderManage();
  });

  const delBtn = $('#btnDelLessonInEditor');
  if (delBtn) delBtn.addEventListener('click', () => deleteLesson(lesson.id));

  const addBtn = $('#btnAddQuestion');
  if (addBtn) addBtn.addEventListener('click', () => {
    if (draft && !confirm('还有一道题没有保存，继续新增会放弃这些修改。确定继续吗？')) return;
    draft = { lessonId: lesson.id, qid: null, type: 'choice', stem: '', options: ['', '', '', ''], answer: 'A', analysis: '' };
    rerenderManage();
    const el = document.querySelector('#draftStem');
    if (el) { try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); } }
  });

  // 编辑某题
  $$('[data-q-edit]').forEach(btn => btn.addEventListener('click', () => {
    const q = lesson.questions.find(x => x.id === btn.getAttribute('data-q-edit'));
    if (!q) return;
    if (draft && !confirm('还有一道题没有保存，继续编辑会放弃这些修改。确定继续吗？')) return;
    draft = {
      lessonId: lesson.id,
      qid: q.id,
      type: q.type,
      stem: q.stem,
      options: (q.options || []).slice(),
      answer: q.answer || '',
      analysis: q.analysis || ''
    };
    if (draft.type === 'choice' && draft.options.length < 2) draft.options = ['', ''];
    if (draft.type === 'judge' && !normJudge(draft.answer)) draft.answer = '正确';
    rerenderManage();
  }));

  // 删除某题
  $$('[data-q-del]').forEach(btn => btn.addEventListener('click', () => {
    const qid = btn.getAttribute('data-q-del');
    const q = lesson.questions.find(x => x.id === qid);
    if (!q) return;
    const brief = q.stem.length > 36 ? q.stem.slice(0, 36) + '…' : q.stem;
    if (!confirm('确定删除这道题吗？\n\n' + brief)) return;
    lesson.questions = lesson.questions.filter(x => x.id !== qid);
    lesson.updatedAt = Date.now();
    if (draft && draft.qid === qid) draft = null;
    saveBank();
    syncSessionsAfterBankChange(lesson.id);
    toast('已删除该题', 'ok');
    rerenderManage();
  }));

  // 上移 / 下移
  $$('[data-q-move]').forEach(btn => btn.addEventListener('click', () => {
    const qid = btn.getAttribute('data-qid');
    const dir = btn.getAttribute('data-q-move');
    const i = lesson.questions.findIndex(x => x.id === qid);
    if (i < 0) return;
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= lesson.questions.length) return;
    const tmp = lesson.questions[i];
    lesson.questions[i] = lesson.questions[j];
    lesson.questions[j] = tmp;
    lesson.updatedAt = Date.now();
    saveBank();
    syncSessionsAfterBankChange(lesson.id);
    rerenderManage();
  }));

  // 编辑表单
  const form = $('#qEditForm');
  if (form && draft) {
    const bindLive = (sel, key) => {
      const el = $(sel, form);
      if (el) el.addEventListener('input', () => { draft[key] = el.value; });
    };
    bindLive('#draftStem', 'stem');
    bindLive('#draftAnalysis', 'analysis');
    bindLive('#draftAnswer', 'answer');

    $$('[data-opt-idx]', form).forEach(inp => inp.addEventListener('input', () => {
      draft.options[parseInt(inp.getAttribute('data-opt-idx'), 10)] = inp.value;
    }));

    const typeEl = $('#draftType', form);
    if (typeEl) typeEl.addEventListener('change', () => {
      draft.type = typeEl.value;
      if (draft.type === 'choice') {
        if (!Array.isArray(draft.options) || draft.options.length < 2) draft.options = ['', '', '', ''];
        if (!/^[A-H]$/.test(draft.answer)) draft.answer = 'A';
      } else if (draft.type === 'judge') {
        draft.answer = normJudge(draft.answer) || '正确';
      }
      rerenderManage();
    });

    $$('[data-opt-add]', form).forEach(btn => btn.addEventListener('click', () => {
      if (draft.options.length >= 8) return;
      draft.options.push('');
      rerenderManage();
    }));

    $$('[data-opt-del]', form).forEach(btn => btn.addEventListener('click', () => {
      const i = parseInt(btn.getAttribute('data-opt-del'), 10);
      const cur = LETTERS.indexOf(draft.answer);
      draft.options.splice(i, 1);
      // 正确答案跟着选项一起挪位，避免指到别的选项上
      if (cur < 0) draft.answer = LETTERS[0];
      else if (cur === i) draft.answer = LETTERS[0];
      else if (cur > i) draft.answer = LETTERS[cur - 1];
      rerenderManage();
    }));

    $$('[data-ans]', form).forEach(btn => btn.addEventListener('click', () => {
      draft.answer = btn.getAttribute('data-ans');
      $$('[data-ans]', form).forEach(b => b.classList.toggle('is-on', b === btn));
    }));

    $$('[data-form-cancel]', form).forEach(btn => btn.addEventListener('click', () => { draft = null; rerenderManage(); }));

    form.addEventListener('submit', e => { e.preventDefault(); saveDraft(lesson); });
  }

  bindDropzone();
}

/* ============================== 交互：首页搜索 ============================== */
function bindHome() {
  const input = $('#lessonSearch');
  if (!input) return;
  input.addEventListener('input', () => {
    const kw = input.value.trim().toLowerCase();
    let shown = 0;
    $$('#lessonGrid .lesson-card').forEach(card => {
      const hit = !kw || (card.getAttribute('data-title') || '').indexOf(kw) >= 0;
      card.classList.toggle('hidden', !hit);
      if (hit) shown++;
    });
    const cnt = $('#searchCount');
    if (cnt) cnt.textContent = kw ? '匹配 ' + shown + ' 篇' : '';
  });

  // 空课文卡片上的「去加题目」：直接进这篇课文的题目管理
  $$('[data-edit-lesson]').forEach(btn => btn.addEventListener('click', () => {
    manageEditing = btn.getAttribute('data-edit-lesson');
    draft = null;
    if (parseRoute().name === 'manage') { render(true); bindManage(); }
    else location.hash = '#/manage';
  }));

  // 课文卡片上的「提问」：带着这篇课文去课堂提问页
  $$('[data-ask-lesson]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-ask-lesson');
    askDraft.lessonIds = [id];
    saveAskDraft();
    location.hash = '#/ask';
  }));
}

/** 投影字号切换（答题页与课堂提问页共用） */
function bindFontToggle() {
  const fontBtn = $('#fontToggle');
  if (!fontBtn) return;
  fontBtn.addEventListener('click', () => {
    const order = ['', 'zoom-lg', 'zoom-xl'];
    const labels = ['正常', '大字', '投影'];
    let cur = order.findIndex(c => c && document.body.classList.contains(c));
    if (cur < 0) cur = 0;
    order.forEach(c => { if (c) document.body.classList.remove(c); });
    const nx = (cur + 1) % order.length;
    if (order[nx]) document.body.classList.add(order[nx]);
    const lab = $('#fontLabel');
    if (lab) lab.textContent = labels[nx];
    try { localStorage.setItem('yw_quiz_zoom', String(nx)); } catch (e) { /* 忽略 */ }
  });
}

/* ============================== 交互：答题页 ============================== */
function bindQuiz() {
  if (!session) return;
  const lesson = currentLesson();
  if (!lesson) return;

  let disposed = false;
  const rerender = () => { disposed = true; $('#main').innerHTML = renderQuizBody(lesson); bindQuiz(); };

  const setAnswer = (qid, patch) => {
    session.answers[qid] = Object.assign({}, session.answers[qid] || {}, patch);
    saveSession();
  };
  const q = questionById(session.order[session.idx]);
  if (!q) return;
  const rec = session.answers[q.id] || {};

  const go = delta => {
    const next = session.idx + delta;
    if (next < 0) return;
    if (next >= session.order.length) { location.hash = '#/result/' + encodeURIComponent(lesson.id); return; }
    session.idx = next;
    saveSession();
    rerender();
  };

  // 选项
  $$('[data-opt]').forEach(btn => btn.addEventListener('click', () => {
    const val = btn.getAttribute('data-opt');
    if (session.practice) {
      setAnswer(q.id, { value: val });
    } else {
      setAnswer(q.id, { value: val });
    }
    rerender();
  }));

  // 判断题
  $$('[data-judge]').forEach(btn => btn.addEventListener('click', () => {
    setAnswer(q.id, { value: btn.getAttribute('data-judge') });
    rerender();
  }));

  // 填空题
  const fillInput = $('#fillInput');
  if (fillInput) {
    fillInput.addEventListener('input', () => { setAnswer(q.id, { value: fillInput.value, checked: false }); });
    fillInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setAnswer(q.id, { value: fillInput.value, checked: true });
        rerender();
      }
    });
    // 练习模式下失焦即判分（节点已被重渲染时跳过，避免重复渲染）
    fillInput.addEventListener('blur', () => {
      if (disposed || !document.contains(fillInput)) return;
      if (session.practice && String(fillInput.value || '').trim()) {
        setAnswer(q.id, { value: fillInput.value, checked: true });
        rerender();
      }
    });
  }

  // 简答题
  const shortInput = $('#shortInput');
  if (shortInput) {
    shortInput.addEventListener('input', () => setAnswer(q.id, { value: shortInput.value }));
  }
  const reveal = $('#btnReveal');
  if (reveal) reveal.addEventListener('click', () => {
    setAnswer(q.id, { value: shortInput ? shortInput.value : '', revealed: true });
    rerender();
  });
  $$('[data-self]').forEach(btn => btn.addEventListener('click', () => {
    setAnswer(q.id, { selfCorrect: btn.getAttribute('data-self') === '1' });
    rerender();
  }));

  // 上一题 / 下一题
  const prev = $('#btnPrev'); if (prev) prev.addEventListener('click', () => go(-1));
  const next = $('#btnNext'); if (next) next.addEventListener('click', () => go(1));

  // 题号导航
  $$('[data-goto]').forEach(btn => btn.addEventListener('click', () => {
    session.idx = parseInt(btn.getAttribute('data-goto'), 10) || 0;
    saveSession();
    rerender();
  }));

  // 交卷
  const finish = $('#btnFinish');
  if (finish) finish.addEventListener('click', () => {
    const unanswered = session.order.filter(id => {
      const qq = lesson.questions.find(x => x.id === id);
      return qq && !isAnswered(qq, session.answers[id]);
    }).length;
    if (unanswered && !confirm('还有 ' + unanswered + ' 道题没作答，确定现在交卷吗？')) return;
    location.hash = '#/result/' + encodeURIComponent(lesson.id);
  });

  // 模式切换
  const modeBtn = $('#modeToggle');
  if (modeBtn) modeBtn.addEventListener('click', () => {
    session.practice = !session.practice;
    saveSession();
    toast(session.practice ? '已切换到练习模式：即时判分并显示解析' : '已切换到测试模式：交卷后统一看结果');
    rerender();
  });

  // 投影字号
  bindFontToggle();

  // 键盘快捷键
  document.onkeydown = e => {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA/.test(tag)) return;
    if (e.key === 'ArrowLeft') { go(-1); }
    else if (e.key === 'ArrowRight') { go(1); }
    else if (/^[1-8]$/.test(e.key) && q.type === 'choice') {
      const L = LETTERS[parseInt(e.key, 10) - 1];
      if (L && q.options[LETTERS.indexOf(L)]) { setAnswer(q.id, { value: L }); rerender(); }
    }
    else if (/^[1-8]$/.test(e.key) && q.type === 'judge') {
      setAnswer(q.id, { value: e.key === '1' ? '正确' : '错误' }); rerender();
    }
  };
}

/* ============================== 交互：结果页 ============================== */
function bindResult() {
  const lessonId = parseRoute().id;
  const lesson = bank.lessons.find(l => l.id === lessonId);
  const retry = $('#btnRetry');
  if (retry) retry.addEventListener('click', () => {
    session = createSession(lesson, { practice: session ? session.practice : true, shuffle: false });
    saveSession();
    location.hash = '#/quiz/' + encodeURIComponent(lessonId);
  });
  const retryWrong = $('#btnRetryWrong');
  if (retryWrong) retryWrong.addEventListener('click', () => {
    const sess = (session && session.lessonId === lessonId) ? session : loadSessions()[lessonId];
    if (!sess) return;
    const wrongIds = sess.order.filter(id => {
      const q = lesson.questions.find(x => x.id === id);
      return q && judge(q, sess.answers[id]) !== 'right';
    });
    if (!wrongIds.length) { toast('太棒了，没有错题！', 'ok'); return; }
    const base = createSession(lesson, { practice: true, shuffle: false });
    session = Object.assign(base, { order: wrongIds, idx: 0, answers: {}, subset: true });
    saveSession();
    toast('已筛出 ' + wrongIds.length + ' 道错题，开始重练', 'ok');
    location.hash = '#/quiz/' + encodeURIComponent(lessonId);
  });
}

/* ============================== 交互：学生名单页 ============================== */
function bindRoster() {
  $$('[data-class]').forEach(btn => btn.addEventListener('click', () => {
    roster.activeClassId = btn.getAttribute('data-class');
    rosterFilter = '';
    saveRoster();
    rerenderRoster();
  }));

  const newClass = $('#btnNewClass');
  if (newClass) newClass.addEventListener('click', () => {
    const name = prompt('新班级名称（例如：四年级一班）', '');
    if (name === null) return;
    const nm = name.trim();
    if (!nm) { toast('班级名称不能为空', 'bad'); return; }
    if (roster.classes.some(c => c.name === nm)) { toast('已经有同名的班级了', 'bad'); return; }
    const cls = { id: uid('cls'), name: nm, students: [] };
    roster.classes.push(cls);
    roster.activeClassId = cls.id;
    rosterFilter = '';
    saveRoster();
    toast('已新建班级「' + nm + '」', 'ok');
    rerenderRoster();
  });

  const rename = $('#btnRenameClass');
  if (rename) rename.addEventListener('click', () => {
    const cls = activeClass();
    if (!cls) return;
    const name = prompt('修改班级名称', cls.name);
    if (name === null) return;
    const nm = name.trim();
    if (!nm) { toast('班级名称不能为空', 'bad'); return; }
    if (roster.classes.some(c => c.id !== cls.id && c.name === nm)) { toast('已经有同名的班级了', 'bad'); return; }
    cls.name = nm;
    saveRoster();
    toast('班级名称已修改', 'ok');
    rerenderRoster();
  });

  const delClass = $('#btnDelClass');
  if (delClass) delClass.addEventListener('click', () => {
    const cls = activeClass();
    if (!cls) return;
    if (roster.classes.length <= 1) { toast('至少要保留一个班级', 'bad'); return; }
    if (!confirm('确定删除班级「' + cls.name + '」以及里面的 ' + cls.students.length + ' 名学生吗？此操作不可撤销。')) return;
    roster.classes = roster.classes.filter(c => c.id !== cls.id);
    roster.activeClassId = roster.classes[0].id;
    askDraft.studentIds = [];
    rosterFilter = '';
    saveRoster();
    saveAskDraft();
    toast('已删除班级', 'ok');
    rerenderRoster();
  });

  const clearClass = $('#btnClearClass');
  if (clearClass) clearClass.addEventListener('click', () => {
    const cls = activeClass();
    if (!cls || !cls.students.length) { toast('本班还没有学生', 'bad'); return; }
    if (!confirm('确定清空「' + cls.name + '」的 ' + cls.students.length + ' 名学生吗？此操作不可撤销。')) return;
    cls.students = [];
    askDraft.studentIds = [];
    saveRoster();
    saveAskDraft();
    toast('已清空本班名单', 'ok');
    rerenderRoster();
  });

  const input = $('#newStudentName');
  const addByName = () => {
    const cls = activeClass();
    if (!cls) return;
    const names = splitNames(input ? input.value : '');
    if (!names.length) { toast('请输入学生姓名', 'bad'); return; }
    const res = addStudentsToClass(cls, names);
    saveRoster();
    if (!res.added) { toast('这些名字都已经在名单里了', 'bad'); return; }
    toast('已添加 ' + res.added + ' 人' + (res.dup ? '，跳过 ' + res.dup + ' 个重名' : ''), 'ok');
    rerenderRoster();
  };
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addByName(); } });
  const addBtn = $('#btnAddStudent');
  if (addBtn) addBtn.addEventListener('click', addByName);

  // 搜索：只过滤已渲染的行，避免重绘导致输入框失焦
  const search = $('#studentSearch');
  if (search) search.addEventListener('input', () => {
    rosterFilter = search.value;
    const kw = rosterFilter.trim().toLowerCase();
    $$('.student-row').forEach(row => {
      const el = $('.student-name', row);
      const hit = !kw || (el ? el.textContent.toLowerCase().indexOf(kw) >= 0 : false);
      row.classList.toggle('hidden', !hit);
    });
  });

  const impToggle = $('#btnImportToggle');
  if (impToggle) impToggle.addEventListener('click', () => {
    const panel = $('#importPanel');
    if (!panel) return;
    panel.classList.toggle('hidden');
    const ta = $('#importNames');
    if (ta && !panel.classList.contains('hidden')) ta.focus();
  });
  const expRoster = $('#btnExportRoster');
  if (expRoster) expRoster.addEventListener('click', () => {
    const cls = activeClass();
    if (!cls || !cls.students.length) { toast('本班还没有学生', 'bad'); return; }
    const content = cls.students.map(s => s.name).join('\n') + '\n';
    downloadTextFile(cls.name + '-学生名单.csv', content, 'text/csv');
    toast('已导出本班名单，下次换电脑直接粘贴导入即可', 'ok');
  });
  const impCancel = $('#btnImportCancel');
  if (impCancel) impCancel.addEventListener('click', () => {
    const panel = $('#importPanel');
    if (panel) panel.classList.add('hidden');
  });
  const impBtn = $('#btnImportNames');
  if (impBtn) impBtn.addEventListener('click', () => {
    const cls = activeClass();
    if (!cls) return;
    const ta = $('#importNames');
    const names = splitNames(ta ? ta.value : '');
    if (!names.length) { toast('请先粘贴名单', 'bad'); return; }
    const res = addStudentsToClass(cls, names);
    saveRoster();
    if (!res.added) { toast('名单里的人都已经在班级里了，没有新增', 'bad'); return; }
    toast('已导入 ' + res.added + ' 人' + (res.dup ? '，跳过 ' + res.dup + ' 个重名' : ''), 'ok');
    rerenderRoster();
  });

  $$('[data-student-edit]').forEach(btn => btn.addEventListener('click', () => {
    const cls = activeClass();
    const s = cls && cls.students.find(x => x.id === btn.getAttribute('data-student-edit'));
    if (!s) return;
    const name = prompt('修改姓名', s.name);
    if (name === null) return;
    const nm = name.trim();
    if (!nm) { toast('姓名不能为空', 'bad'); return; }
    if (cls.students.some(x => x.id !== s.id && x.name === nm)) { toast('班里已经有叫「' + nm + '」的学生了', 'bad'); return; }
    s.name = nm;
    saveRoster();
    rerenderRoster();
  }));

  $$('[data-student-del]').forEach(btn => btn.addEventListener('click', () => {
    const cls = activeClass();
    const id = btn.getAttribute('data-student-del');
    const s = cls && cls.students.find(x => x.id === id);
    if (!s) return;
    if (!confirm('把「' + s.name + '」从名单里删除吗？')) return;
    cls.students = cls.students.filter(x => x.id !== id);
    askDraft.studentIds = askDraft.studentIds.filter(x => x !== id);
    saveRoster();
    saveAskDraft();
    toast('已删除', 'ok');
    rerenderRoster();
  }));
}

/* ============================== 交互：课堂提问（设置页） ============================== */
/** 把已选项同步到界面：学生 chips、题型、课文、底部提示 */
function syncAskPickers() {
  $$('[data-pick-student]').forEach(chip => {
    const on = askDraft.studentIds.indexOf(chip.getAttribute('data-pick-student')) >= 0;
    chip.classList.toggle('is-on', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  $$('[data-type-toggle]').forEach(btn => {
    btn.classList.toggle('is-on', askDraft.types.indexOf(btn.getAttribute('data-type-toggle')) >= 0);
  });
  $$('[data-lesson-check]').forEach(lb => {
    const on = askDraft.lessonIds.indexOf(lb.getAttribute('data-lesson-check')) >= 0;
    const cb = $('input', lb);
    if (cb) cb.checked = on;
    lb.classList.toggle('is-on', on);
  });
  updateAskSummary();
}

/** 更新「已选学生」与底部题目数量提示 */
function updateAskSummary() {
  const cls = activeClass();
  const picked = cls ? cls.students.filter(s => askDraft.studentIds.indexOf(s.id) >= 0) : [];
  const per = clampInt(askDraft.per, 1, 20, 1);

  const cnt = $('#askSelectedCount');
  if (cnt) cnt.textContent = String(picked.length);
  const names = $('#askSelectedNames');
  if (names) names.textContent = picked.length ? picked.map(s => s.name).join('、') : '还没有选学生';
  const pv = $('#askPreview');
  if (pv) pv.innerHTML = askPreviewHtml(picked, per);
}

/** 课文全选 / 全不选 */
function setAllLessons(on) {
  askDraft.lessonIds = on ? bank.lessons.map(l => l.id) : [];
  saveAskDraft();
  $$('[data-lesson-check]').forEach(lb => {
    const hit = askDraft.lessonIds.indexOf(lb.getAttribute('data-lesson-check')) >= 0;
    const cb = $('input', lb);
    if (cb) cb.checked = hit;
    lb.classList.toggle('is-on', hit);
  });
  updateAskSummary();
}

function bindAsk() {
  const clsSel = $('#askClass');
  if (clsSel) clsSel.addEventListener('change', () => {
    askDraft.classId = clsSel.value;
    askDraft.studentIds = [];
    saveAskDraft();
    rerenderAskPage();
  });

  $$('[data-pickmode]').forEach(btn => btn.addEventListener('click', () => {
    askDraft.pickMode = btn.getAttribute('data-pickmode');
    saveAskDraft();
    rerenderAskPage();
  }));

  const draw = $('#btnDraw');
  if (draw) draw.addEventListener('click', () => {
    const cls = activeClass();
    if (!cls) return;
    const countEl = $('#drawCount');
    const preferEl = $('#drawPreferNew');
    const n = clampInt(countEl ? countEl.value : 1, 1, cls.students.length, 1);
    askDraft.pickMode = 'random';
    askDraft.randomCount = n;
    askDraft.preferNew = preferEl ? preferEl.checked : true;
    const picked = randomPickStudents(cls.students, n, askDraft.preferNew);
    askDraft.studentIds = picked.map(s => s.id);
    saveAskDraft();
    syncAskPickers();
    toast('已随机抽到：' + picked.map(s => s.name).join('、'), 'ok');
  });

  $$('[data-pick-student]').forEach(chip => chip.addEventListener('click', () => {
    const id = chip.getAttribute('data-pick-student');
    const i = askDraft.studentIds.indexOf(id);
    if (i >= 0) askDraft.studentIds.splice(i, 1);
    else askDraft.studentIds.push(id);
    saveAskDraft();
    syncAskPickers();
  }));

  const pickAll = $('#btnPickAll');
  if (pickAll) pickAll.addEventListener('click', () => {
    const cls = activeClass();
    askDraft.studentIds = cls ? cls.students.map(s => s.id) : [];
    saveAskDraft();
    syncAskPickers();
  });
  const pickNone = $('#btnPickNone');
  if (pickNone) pickNone.addEventListener('click', () => {
    askDraft.studentIds = [];
    saveAskDraft();
    syncAskPickers();
  });

  $$('[data-lesson-check]').forEach(lb => {
    const cb = $('input', lb);
    if (!cb) return;
    cb.addEventListener('change', () => {
      const id = lb.getAttribute('data-lesson-check');
      if (cb.checked) { if (askDraft.lessonIds.indexOf(id) < 0) askDraft.lessonIds.push(id); }
      else askDraft.lessonIds = askDraft.lessonIds.filter(x => x !== id);
      lb.classList.toggle('is-on', cb.checked);
      saveAskDraft();
      updateAskSummary();
    });
  });
  const lessonAll = $('#btnLessonAll');
  if (lessonAll) lessonAll.addEventListener('click', () => setAllLessons(true));
  const lessonNone = $('#btnLessonNone');
  if (lessonNone) lessonNone.addEventListener('click', () => setAllLessons(false));

  $$('[data-type-toggle]').forEach(btn => btn.addEventListener('click', () => {
    const t = btn.getAttribute('data-type-toggle');
    const i = askDraft.types.indexOf(t);
    if (i >= 0) askDraft.types.splice(i, 1);
    else askDraft.types.push(t);
    btn.classList.toggle('is-on', askDraft.types.indexOf(t) >= 0);
    saveAskDraft();
    updateAskSummary();
  }));

  const perEl = $('#askPer');
  if (perEl) perEl.addEventListener('change', () => {
    askDraft.per = clampInt(perEl.value, 1, 20, 1);
    perEl.value = askDraft.per;
    saveAskDraft();
    updateAskSummary();
  });
  const nrEl = $('#askNoRepeat');
  if (nrEl) nrEl.addEventListener('change', () => {
    askDraft.noRepeat = nrEl.checked;
    saveAskDraft();
    updateAskSummary();
  });
  const preferEl = $('#drawPreferNew');
  if (preferEl) preferEl.addEventListener('change', () => {
    askDraft.preferNew = preferEl.checked;
    saveAskDraft();
  });

  const start = $('#btnStartAsk');
  if (start) start.addEventListener('click', startAsk);

  const wrapUp = $('#btnAskWrapUp');
  if (wrapUp) wrapUp.addEventListener('click', () => {
    if (!assignment) return;
    if (!confirm('结束上一次提问吗？没记录的题会显示为「未记录」。')) return;
    assignment.finished = true;
    assignment.finishedAt = Date.now();
    saveAssignment();
    location.hash = '#/ask/run';
  });

  syncAskPickers();
}

/* ============================== 交互：课堂提问（进行页 / 小结） ============================== */
function bindAskRun() {
  bindFontToggle();
  if (!assignment) return;

  if (assignment.finished) {
    const again = $('#btnAskAgain');
    if (again) again.addEventListener('click', askAgain);
    const resume = $('#btnAskResume');
    if (resume) resume.addEventListener('click', () => {
      assignment.finished = false;
      assignment.finishedAt = 0;
      saveAssignment();
      rerenderAskRun();
    });
    return;
  }

  const row = assignment.students[assignment.idx];
  if (!row) return;

  const gotoStudent = i => {
    if (i < 0 || i >= assignment.students.length) return;
    if (!assignment.students[i].questions.length) return;
    assignment.idx = i;
    assignment.qIdx = 0;
    askRevealed = false;
    saveAssignment();
    rerenderAskRun();
  };
  const gotoQuestion = i => {
    if (i < 0 || i >= row.questions.length) return;
    assignment.qIdx = i;
    askRevealed = false;
    saveAssignment();
    rerenderAskRun();
  };

  const reveal = $('#btnAskReveal');
  if (reveal) reveal.addEventListener('click', () => {
    askRevealed = !askRevealed;
    rerenderAskRun();
  });
  const swap = $('#btnAskSwap');
  if (swap) swap.addEventListener('click', swapCurrentQuestion);

  const addStudent = $('#btnAskAddStudent');
  if (addStudent) addStudent.addEventListener('click', () => {
    const name = prompt('临时加一位学生：\n\n· 名字在名单里 → 沿用这位同学\n· 名单以外 → 只加入这次提问，不会写进名单', '');
    if (name === null) return;
    addTempStudent(name);
  });

  $$('[data-mark]').forEach(btn => btn.addEventListener('click', () => {
    const m = btn.getAttribute('data-mark');
    if (row.marks[assignment.qIdx] === m) row.marks[assignment.qIdx] = '';   // 再点一次取消
    else row.marks[assignment.qIdx] = m;
    saveAssignment();
    if (row.marks[assignment.qIdx] && assignment.qIdx < row.questions.length - 1) {
      assignment.qIdx++;
      askRevealed = false;
    }
    rerenderAskRun();
  }));

  const prevQ = $('#btnAskPrevQ');
  if (prevQ) prevQ.addEventListener('click', () => gotoQuestion(assignment.qIdx - 1));
  const nextQ = $('#btnAskNextQ');
  if (nextQ) nextQ.addEventListener('click', () => gotoQuestion(assignment.qIdx + 1));
  const prevS = $('#btnAskPrevStudent');
  if (prevS) prevS.addEventListener('click', () => gotoStudent(assignment.idx - 1));
  const nextS = $('#btnAskNextStudent');
  if (nextS) nextS.addEventListener('click', () => gotoStudent(assignment.idx + 1));
  const nextS2 = $('#btnAskNextStudent2');
  if (nextS2) nextS2.addEventListener('click', () => gotoStudent(assignment.idx + 1));
  const fin2 = $('#btnAskFinish2');
  if (fin2) fin2.addEventListener('click', finishAsk);
  const fin = $('#btnAskFinish');
  if (fin) fin.addEventListener('click', finishAsk);

  $$('[data-ask-goto]').forEach(btn => btn.addEventListener('click', () => {
    gotoStudent(parseInt(btn.getAttribute('data-ask-goto'), 10) || 0);
  }));
}

/* ============================== 交互：题库管理页 ============================== */
/* ---- 导入流程 ---- */
function importLessons(lessons, sourceName) {
  if (!lessons.length) { toast('没有解析到任何题目，请检查格式', 'bad'); return; }
  const titles = lessons.map(l => l.title);
  const clashes = titles.filter(t => bank.lessons.some(x => x.title === t));
  let strategy = 'append';
  if (clashes.length) {
    const useReplace = confirm(
      '题库里已经有这些课文：' + clashes.join('、') + '\n\n' +
      '点「确定」= 用这次上传的内容整体替换它们（推荐：在 Excel 里改完再传，选这个）\n' +
      '点「取消」= 把新题目追加到原有题目后面'
    );
    strategy = useReplace ? 'replace' : 'append';
  }
  const res = mergeLessons(lessons, strategy);
  saveBank();
  syncSessionsAfterBankChange();
  const qCount = lessons.reduce((s, l) => s + l.questions.length, 0);
  toast('导入成功：' + res.added + ' 篇新课文、' + res.merged + ' 篇更新，共 ' + qCount + ' 道题', 'ok');
  manageTab = 'file';
  // 必须走 rerenderManage：只重绘而不重新绑定，页面上的按钮会全部失效
  rerenderManage();
}

function handleFiles(files) {
  const list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  let pending = list.length;
  const collected = [];
  const done = () => { if (--pending === 0 && collected.length) importLessons(collected, 'file'); };

  list.forEach(file => {
    const isExcel = XLSX_EXT_RE.test(file.name || '');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = isExcel
          ? parseWorkbook(reader.result)                              // Excel：按二进制读
          : parseQuestions(String(reader.result || ''), file.name);   // 文本类：按 UTF-8 读
        if (!parsed.length) toast('「' + file.name + '」没有解析到题目，请检查表头与内容', 'bad');
        else collected.push.apply(collected, parsed);
      } catch (err) {
        toast('「' + file.name + '」解析失败：' + err.message, 'bad');
      }
      done();
    };
    reader.onerror = done;
    if (isExcel) reader.readAsArrayBuffer(file);
    else reader.readAsText(file, 'UTF-8');
  });
}

function bindManage() {
  // 课文题目编辑视图
  if (manageEditing) { bindLessonEditor(); return; }

  // 标签页
  $$('[data-tab]').forEach(btn => btn.addEventListener('click', () => {
    manageTab = btn.getAttribute('data-tab');
    $$('[data-tab]').forEach(b => b.classList.toggle('is-active', b === btn));
    $$('[data-panel]').forEach(p => p.classList.toggle('hidden', p.getAttribute('data-panel') !== manageTab));
  }));

  // 文件选择 / 拖拽
  bindDropzone();

  // 粘贴解析
  const parse = $('#btnParse');
  if (parse) parse.addEventListener('click', () => {
    const area = $('#pasteArea');
    const text = area ? area.value : '';
    if (!text.trim()) { toast('请先粘贴题目内容', 'bad'); return; }
    try {
      const lessons = parseQuestions(text, '');
      importLessons(lessons, 'paste');
      if (area) area.value = '';
    } catch (err) { toast('解析失败：' + err.message, 'bad'); }
  });
  const clr = $('#btnClearPaste');
  if (clr) clr.addEventListener('click', () => { const a = $('#pasteArea'); if (a) a.value = ''; });

  const tc = $('#btnTplCsv');
  if (tc) tc.addEventListener('click', () => downloadTextFile('题目模板.csv', TEMPLATE_CSV, 'text/csv'));
  const tt = $('#btnTplTxt');
  if (tt) tt.addEventListener('click', () => downloadTextFile('题目模板.txt', TEMPLATE_TXT, 'text/plain'));
  const tx = $('#btnTplXlsx');
  if (tx) tx.addEventListener('click', exportBlankXlsx);

  // 删除课文
  $$('[data-del-lesson]').forEach(btn => btn.addEventListener('click', () => deleteLesson(btn.getAttribute('data-del-lesson'))));

  // 进入某篇课文的题目管理
  $$('[data-manage-lesson]').forEach(btn => btn.addEventListener('click', () => {
    manageEditing = btn.getAttribute('data-manage-lesson');
    draft = null;
    rerenderManage();
  }));

  // 新建课文
  const nl = $('#btnNewLesson');
  if (nl) nl.addEventListener('click', createLesson);

  // 导出 Excel
  const expX = $('#btnExportXlsx');
  if (expX) expX.addEventListener('click', exportBankXlsx);

  // 导出 JSON 备份
  const exp = $('#btnExport');
  if (exp) exp.addEventListener('click', () => {
    const data = JSON.stringify({ version: 1, lessons: bank.lessons }, null, 2);
    downloadTextFile('语文题库备份-' + todayStamp() + '.json', data, 'application/json');
    toast('已导出 JSON 备份', 'ok');
  });

  // 导出便携数据（U 盘模式）
  const expPortable = $('#btnExportPortable');
  if (expPortable) expPortable.addEventListener('click', exportPortableData);

  // 恢复示例
  const rs = $('#btnRestoreDemo');
  if (rs) rs.addEventListener('click', () => {
    if (!confirm('将把内置示例题库（《观潮》《走月亮》）合并进来，已有的同名课文会被覆盖。继续吗？')) return;
    const res = mergeLessons(normalizeBank(deepClone(DEMO_BANK)).lessons, 'replace');
    saveBank();
    syncSessionsAfterBankChange();
    toast('已恢复示例题库', 'ok');
    rerenderManage();
  });

  // 清空
  const wipe = $('#btnWipe');
  if (wipe) wipe.addEventListener('click', () => {
    if (!confirm('确定清空全部题库吗？所有课文的题目都会被删除，此操作不可撤销。')) return;
    if (!confirm('最后确认一次：真的要清空吗？建议先导出备份。')) return;
    bank = { version: 1, lessons: [] };
    saveBank();
    try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(SCORE_KEY); } catch (e) { /* 忽略 */ }
    manageEditing = null;
    draft = null;
    if (session) session = null;
    toast('题库已清空', 'ok');
    rerenderManage();
  });
}

/* ============================== PWA：装到手机桌面 / 离线可用 ============================== */
const INSTALL_TIP_KEY = 'yw_quiz_install_tip_v1';
let installPrompt = null;   // 安卓 Chrome 的安装事件：先存下来，等老师点按钮时再触发

/** 当前是不是「已经装到桌面」的独立窗口模式 */
function isStandalone() {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch (e) { /* 忽略 */ }
  return window.navigator.standalone === true;
}

function isIOSDevice() {
  const ua = navigator.userAgent || '';
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  // iPadOS 13 以后 Safari 会把自己伪装成 Mac，用触点数区分
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

function isMobileDevice() {
  return isIOSDevice() || /android|mobile|harmony/i.test(navigator.userAgent || '');
}

/**
 * 注册 Service Worker（离线可用的关键）。
 * 浏览器只允许在 https 或 localhost 下注册，所以：双击打开（file://）、
 * 用公网 IP 走 http 访问时都会自动跳过——网站照常能用，只是没有离线缓存。
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !isLocal) return;

  navigator.serviceWorker.register('./service-worker.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('网站已更新，刷新页面即可用上新版本');
        }
      });
    });
  }).catch(() => { /* 注册失败不影响正常使用 */ });
}

/** 点「装到桌面」时：能直接弹安装框就弹，否则给出对应机型的步骤 */
function requestInstall() {
  if (isStandalone()) { toast('已经装到桌面了，从桌面图标打开就行'); return; }

  if (installPrompt) {
    installPrompt.prompt();
    installPrompt.userChoice.then(choice => {
      if (choice && choice.outcome === 'accepted') installPrompt = null;
    }).catch(() => {});
    return;
  }

  if (isIOSDevice()) {
    alert('iPhone / iPad 加到桌面：\n\n' +
      '1）用 Safari 打开本页\n' +
      '2）点底部中间的「分享」按钮（方框带向上箭头）\n' +
      '3）在菜单里选「添加到主屏幕」→ 点「添加」\n\n' +
      '装好后桌面会出现「语文提问」图标，点开就是全屏，不用再输网址。');
    return;
  }

  alert('装到桌面的方法：\n\n' +
    '· 安卓手机（Chrome / Edge）：点右上角「⋮」→「安装应用」或「添加到主屏幕」\n' +
    '· iPhone / iPad：必须用 Safari 打开 → 分享 → 添加到主屏幕\n' +
    '· 如果是在微信里打开的：点右上角「···」→「在浏览器中打开」，再按上面的方法装');
}

function hideInstallTip() {
  const el = $('#installTip');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

/** 手机上第一次打开时，顶部提示一句「可以装到桌面」（关掉后不再出现） */
function showInstallTip() {
  if (isStandalone() || !isMobileDevice() || $('#installTip')) return;
  try { if (localStorage.getItem(INSTALL_TIP_KEY) === '1') return; } catch (e) { /* 忽略 */ }

  const el = document.createElement('div');
  el.id = 'installTip';
  el.className = 'install-tip';
  el.setAttribute('role', 'status');
  el.innerHTML = '<strong>加到手机桌面，像 App 一样用</strong>' +
    '<span>上课不用每次输网址，断网也能打开。</span>' +
    '<button class="btn btn-primary btn-sm" id="installTipGo" type="button">怎么装</button>' +
    '<button class="install-tip-close" id="installTipClose" type="button" aria-label="不再提示" title="不再提示">✕</button>';

  const header = document.querySelector('.site-header');
  if (header && header.parentNode) header.parentNode.insertBefore(el, header.nextSibling);
  else document.body.insertBefore(el, document.body.firstChild);

  const go = $('#installTipGo');
  if (go) go.addEventListener('click', requestInstall);
  const close = $('#installTipClose');
  if (close) close.addEventListener('click', () => {
    try { localStorage.setItem(INSTALL_TIP_KEY, '1'); } catch (e) { /* 忽略 */ }
    hideInstallTip();
  });
}

function initInstall() {
  const btn = $('#btnInstall');
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    hideInstallTip();
    toast('已添加到桌面，以后从桌面图标直接打开就行', 'ok');
  });
  if (!btn) return;
  if (isStandalone()) { btn.classList.add('hidden'); return; }
  btn.addEventListener('click', requestInstall);
}

/* ============================== 启动 ============================== */

/**
 * 本地存储可用性探测。
 * 部分浏览器（如 Safari 用 file:// 双击打开时）会禁止 localStorage 写入，
 * 此时网站仍能运行，但刷新后题目改动与答题进度会丢失——必须明确告知老师，
 * 否则会出现「明明改了题，重新打开又变回去了」的困惑。
 */
function storageAvailable() {
  try {
    const k = '__yw_probe__';
    localStorage.setItem(k, '1');
    const ok = localStorage.getItem(k) === '1';
    localStorage.removeItem(k);
    return ok;
  } catch (e) { return false; }
}

function showStorageWarning() {
  if ($('#storageWarning')) return;
  const el = document.createElement('div');
  el.id = 'storageWarning';
  el.className = 'storage-warning';
  el.setAttribute('role', 'alert');
  el.innerHTML =
    '<strong>提示：当前浏览器禁止本地保存</strong>' +
    '<span>你新上传的题目、编辑的题目和答题进度<b>在刷新后不会保留</b>。' +
    '建议改用 <b>Chrome / Edge</b> 打开本页面；' +
    '或按《使用教程》里的「方式二」用本地小服务打开，即可正常保存。</span>';
  const host = document.querySelector('.site-header') || document.body;
  if (host.parentNode) host.parentNode.insertBefore(el, host);
  else document.body.insertBefore(el, document.body.firstChild);
}

/** 渲染 + 绑定当前路由（首屏、hashchange、载入便携数据后共用） */
function dispatchView() {
  if (parseRoute().name !== 'quiz') document.onkeydown = null;
  render();
  const r = parseRoute();
  if (r.name === 'home') bindHome();
  else if (r.name === 'quiz') bindQuiz();
  else if (r.name === 'manage') bindManage();
  else if (r.name === 'result') bindResult();
  else if (r.name === 'roster') bindRoster();
  else if (r.name === 'ask') bindAsk();
  else if (r.name === 'askRun') bindAskRun();
}

function boot() {
  const firstVisit = !hasSavedBank();   // 必须在 loadBank() 之前判断
  bank = loadBank();
  roster = loadRoster();
  askDraft = loadAskDraft();
  assignment = loadAssignment();

  // 网站文件夹里有便携数据？本机是空的就直接用，比本机新就提示
  applyPortableOnBoot(firstVisit);
  initAskDraft();

  // 存储不可用 → 顶部醒目提示
  if (!storageAvailable()) showStorageWarning();

  // PWA：注册离线缓存 + 「装到桌面」引导
  registerServiceWorker();
  initInstall();
  showInstallTip();

  // 恢复上次的投影字号
  try {
    const z = parseInt(localStorage.getItem('yw_quiz_zoom') || '0', 10);
    if (z === 1) document.body.classList.add('zoom-lg');
    else if (z === 2) document.body.classList.add('zoom-xl');
  } catch (e) { /* 忽略 */ }

  if (!location.hash) location.hash = '#/';

  // 点顶部导航「题库管理」→ 回到题库管理首页（从题目编辑视图退出）
  $$('.nav a[href="#/manage"]').forEach(a => a.addEventListener('click', () => {
    if (!manageEditing && !draft) return;
    manageEditing = null;
    draft = null;
    if (parseRoute().name === 'manage') { render(true); bindManage(); }
  }));

  window.addEventListener('hashchange', dispatchView);
  dispatchView();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
