/* ==========================================================================
   tests/logic.test.js — 逻辑层测试
   直接在 Node 的 vm 沙箱里加载 assets/js 下的生产代码（data.js + app.js），
   不做替身替换，跑的就是老师浏览器里的那份逻辑。
   运行：bash tests/run.sh       （或 node tests/logic.test.js）
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ------------------------------ 迷你测试框架 ------------------------------ */
let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' → ' + e.message);
    console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + '：' : '') + '期望 ' + b + '，实际 ' + a);
}

/* ------------------------------ 加载生产代码 ------------------------------ */
// 极简 DOM 替身：只为让 app.js 顺利加载，不触发 boot()
const sandbox = {
  console: console,
  document: {
    readyState: 'loading',
    addEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; }
  },
  window: { addEventListener: function () {} },
  location: { hash: '' },
  localStorage: (function () {
    const store = {};
    return {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    };
  })(),
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
const ctx = vm.createContext(sandbox);

vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/data.js'), 'utf8'), ctx, { filename: 'data.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8'), ctx, { filename: 'app.js' });

const api = function (name) {
  const fn = vm.runInContext('typeof ' + name + ' === "function" ? ' + name + ' : null', ctx);
  if (!fn) throw new Error('找不到函数 ' + name);
  return fn;
};

/* ------------------------------ 基础工具 ------------------------------ */
console.log('\n工具函数');
const normText = api('normText');
const normJudge = api('normJudge');
const normChoice = api('normChoice');
const normType = api('normType');
const clampInt = api('clampInt');
const splitNames = api('splitNames');

test('normText 忽略空格与中英文标点', function () {
  eq(normText('一 会 儿。'), '一会儿');
  eq(normText('“白线”'), '白线');
});

test('normJudge 认识多种写法', function () {
  ['正确', '对', '√', 'T', 'true', '是'].forEach(function (v) { eq(normJudge(v), '正确', v); });
  ['错误', '错', '×', 'F', 'false', '不正确'].forEach(function (v) { eq(normJudge(v), '错误', v); });
  eq(normJudge('不知道'), '');
});

test('normChoice 支持字母 / 序号 / 选项原文', function () {
  const opts = ['天下奇观', '世界奇景', '天下第一潮', '人间胜景'];
  eq(normChoice('A', opts), 'A');
  eq(normChoice('a', opts), 'A');
  eq(normChoice('B. 世界奇景', opts), 'B');
  eq(normChoice('2', opts), 'B');
  eq(normChoice('天下第一潮', opts), 'C');
});

test('normType 未标注题型时按内容推断', function () {
  eq(normType('', ['甲', '乙'], 'A'), 'choice');
  eq(normType('', [], '正确'), 'judge');
  eq(normType('', [], '水墙'), 'short');
  eq(normType('填空', [], '水墙'), 'fill');
  eq(normType('判断题', [], '错误'), 'judge');
});

test('clampInt 处理越界与非法输入', function () {
  eq(clampInt('5', 1, 10, 1), 5);
  eq(clampInt('99', 1, 10, 1), 10);
  eq(clampInt('0', 1, 10, 1), 1);
  eq(clampInt('abc', 1, 10, 3), 3);
});

test('splitNames 支持换行 / 逗号 / 顿号 / Excel 粘贴', function () {
  eq(splitNames('张三\n李四\n王五'), ['张三', '李四', '王五']);
  eq(splitNames('张三, 李四、王五；赵六'), ['张三', '李四', '王五', '赵六']);
  eq(splitNames('张三\t李四'), ['张三', '李四']);
  eq(splitNames('  '), []);
});

/* ------------------------------ 判分 ------------------------------ */
console.log('\n判分');
const judge = api('judge');

test('四种题型的判分', function () {
  eq(judge({ type: 'choice', answer: 'B', options: ['甲', '乙'] }, { value: 'B' }), 'right');
  eq(judge({ type: 'choice', answer: 'B', options: ['甲', '乙'] }, { value: 'A' }), 'wrong');
  eq(judge({ type: 'judge', answer: '正确' }, { value: '对' }), 'right');
  eq(judge({ type: 'fill', answer: '一会儿|一瞬间' }, { value: ' 一瞬间。' }), 'right');
  eq(judge({ type: 'fill', answer: '水墙' }, { value: '白浪' }), 'wrong');
  eq(judge({ type: 'short', answer: '参考' }, { value: '我的答案' }), 'pending');
  eq(judge({ type: 'short', answer: '参考' }, { value: '我的答案', selfCorrect: true }), 'right');
  eq(judge({ type: 'choice', answer: 'B', options: ['甲', '乙'] }, {}), 'pending');
});

/* ------------------------------ 学生名单 ------------------------------ */
console.log('\n学生名单');
const normalizeRoster = api('normalizeRoster');
const randomPickStudents = api('randomPickStudents');

test('normalizeRoster 兼容字符串名单与脏数据', function () {
  const r = normalizeRoster({ classes: [
    { id: 'c1', name: '四(1)班', students: ['张三', { name: '李四', askedCount: '3' }, null, { name: '  ' }] },
    'bad',
    { name: '', students: [] }
  ] });
  eq(r.classes.length, 2, '非法班级被丢掉');
  eq(r.classes[0].students.length, 2, '空名字被过滤');
  eq(r.classes[0].students[1].askedCount, 3);
  ok(r.activeClassId === 'c1', '活动班级回落到第一个');
});

test('normalizeRoster 空数据时给一个默认班级', function () {
  const r = normalizeRoster(null);
  eq(r.classes.length, 1);
  eq(r.classes[0].name, '我的班级');
  eq(r.classes[0].students.length, 0);
});

test('开启公平优先时，先照顾「还没被问过」的同学', function () {
  const students = [
    { id: 'a', name: '张三', askedCount: 0 },
    { id: 'b', name: '李四', askedCount: 5 },
    { id: 'c', name: '王五', askedCount: 5 }
  ];
  for (let i = 0; i < 40; i++) {
    const one = randomPickStudents(students, 1, true);
    eq(one.length, 1);
    eq(one[0].id, 'a', '只应抽到没被问过的张三');
  }
  const two = randomPickStudents(students, 2, true).map(function (s) { return s.id; });
  ok(two.indexOf('a') >= 0, '抽两位时一定包含张三');
  eq(new Set(two).size, 2, '不会抽到重复的人');
});

test('不开启公平优先时也能抽够人数且不重复', function () {
  const students = ['a', 'b', 'c', 'd', 'e'].map(function (id, i) { return { id: id, name: 'S' + i, askedCount: i }; });
  const picked = randomPickStudents(students, 4, false);
  eq(picked.length, 4);
  eq(new Set(picked.map(function (s) { return s.id; })).size, 4);
  eq(randomPickStudents(students, 9, false).length, 5, '要的人数超过总数时只返回全部');
});

/* ------------------------------ 随机分题 ------------------------------ */
console.log('\n随机分题');
const assignQuestions = api('assignQuestions');
const assignQuestionsForOne = api('assignQuestionsForOne');
const buildAskPool = api('buildAskPool');

function makePool(n) {
  const pool = [];
  for (let i = 0; i < n; i++) {
    pool.push({ qid: 'q' + i, lessonId: 'l1', lessonTitle: '观潮', type: 'choice', stem: '题目 ' + i, options: ['甲', '乙'], answer: 'A', analysis: '' });
  }
  return pool;
}
function stu(ids) {
  return ids.map(function (id, i) { return { id: id, name: '学生' + i }; });
}
const qidsOf = function (res) {
  return res.plan.reduce(function (arr, row) { return arr.concat(row.questions.map(function (q) { return q.qid; })); }, []);
};

test('题库充足：同学之间不重题，每人拿满', function () {
  const res = assignQuestions(makePool(20), stu(['a', 'b', 'c']), 3);
  ok(res.enough, '应判定为题目充足');
  res.plan.forEach(function (row) { eq(row.questions.length, 3, row.name + ' 应拿到 3 道题'); });
  const all = qidsOf(res);
  eq(all.length, 9);
  eq(new Set(all).size, 9, '9 道题必须互不重复');
  res.plan.forEach(function (row) { eq(row.marks.length, row.questions.length, '记录数组要和题目一一对应'); });
});

test('题库刚好够分：仍然不重题', function () {
  const res = assignQuestions(makePool(4), stu(['a', 'b']), 2);
  ok(res.enough);
  eq(new Set(qidsOf(res)).size, 4);
});

test('题库不够：自动循环使用，但同一位学生手里不重复', function () {
  const res = assignQuestions(makePool(3), stu(['a', 'b']), 2);
  ok(!res.enough, '应提示题目不够');
  res.plan.forEach(function (row) {
    eq(row.questions.length, 2);
    const ids = row.questions.map(function (q) { return q.qid; });
    eq(new Set(ids).size, 2, row.name + ' 的两道题不能重复');
  });
});

test('题库比题目数量还小：有几分几，不报错', function () {
  const res = assignQuestions(makePool(1), stu(['a', 'b']), 3);
  ok(!res.enough);
  res.plan.forEach(function (row) { eq(row.questions.length, 1); });
});

test('空题库 / 0 道题直接返回空计划', function () {
  eq(assignQuestions([], stu(['a']), 2).plan[0].questions.length, 0);
  eq(assignQuestions(makePool(5), stu(['a']), 0).plan[0].questions.length, 0);
});

test('多次分配会洗出不同的组合', function () {
  const seen = {};
  for (let i = 0; i < 60; i++) {
    const row = assignQuestions(makePool(12), stu(['a', 'b']), 3).plan[0];
    seen[row.questions.map(function (q) { return q.qid; }).join(',')] = true;
  }
  ok(Object.keys(seen).length > 5, '60 次里应出现多种组合，实际 ' + Object.keys(seen).length + ' 种');
});

test('buildAskPool 按课文 + 题型筛选，并带上课文名', function () {
  vm.runInContext('bank = ' + JSON.stringify({
    version: 1,
    lessons: [
      { id: 'l1', title: '观潮', questions: [
        { id: 'a1', type: 'choice', stem: '题一', options: ['甲', '乙'], answer: 'A' },
        { id: 'a2', type: 'judge', stem: '题二', answer: '正确' }
      ] },
      { id: 'l2', title: '走月亮', questions: [
        { id: 'b1', type: 'fill', stem: '题三', answer: '洱海' }
      ] }
    ]
  }), ctx);
  eq(buildAskPool(['l1'], ['choice', 'judge']).length, 2);
  eq(buildAskPool(['l1'], ['fill']).length, 0);
  eq(buildAskPool(['l1', 'l2'], ['fill']).length, 1);
  eq(buildAskPool(['l2'], ['fill'])[0].lessonTitle, '走月亮');
  eq(buildAskPool(['none'], ['choice']).length, 0);
});

test('临时加人抽题：优先用别人还没被问过的题', function () {
  const pool = makePool(10);
  const used = ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];
  const list = assignQuestionsForOne(pool, 2, used);
  eq(list.length, 2);
  list.forEach(function (q) { ok(used.indexOf(q.qid) < 0, '不应分到已问过的 ' + q.qid); });
  eq(new Set(list.map(function (q) { return q.qid; })).size, 2, '同一位学生内部不重复');
});

test('临时加人：题库不够时允许与别人重复，但本人不重复', function () {
  const pool = makePool(3);
  const list = assignQuestionsForOne(pool, 2, ['q0', 'q1', 'q2']);
  eq(list.length, 2);
  eq(new Set(list.map(function (q) { return q.qid; })).size, 2);
});

test('临时加人：题库比题量还少时，有几分几', function () {
  eq(assignQuestionsForOne(makePool(1), 3, []).length, 1);
  eq(assignQuestionsForOne([], 2, []).length, 0);
});

/* ------------------------------ 解析（回归） ------------------------------ */
console.log('\n题库解析（回归）');
const parseQuestions = api('parseQuestions');

test('纯文本格式解析', function () {
  const text = '# 观潮\n@年级 四年级上册\n\n[选择] 钱塘江大潮被称为？\nA. 天下奇观\nB. 世界奇景\n答案：A\n解析：开篇总起句。\n\n[判断] 潮来前江面平静。\n答案：正确';
  const lessons = parseQuestions(text, '');
  eq(lessons.length, 1);
  eq(lessons[0].title, '观潮');
  eq(lessons[0].grade, '四年级上册');
  eq(lessons[0].questions.length, 2);
  eq(lessons[0].questions[0].type, 'choice');
  eq(lessons[0].questions[0].answer, 'A');
  eq(lessons[0].questions[1].type, 'judge');
});

test('CSV 表格解析（含表头识别）', function () {
  const csv = '课文,年级,题型,题干,选项A,选项B,答案,解析\n观潮,四年级上册,选择题,被称为？,天下奇观,世界奇景,A,总起句\n走月亮,四年级上册,填空题,月亮从（　）升起,,,洱海,开篇句';
  const lessons = parseQuestions(csv, 'x.csv');
  eq(lessons.length, 2);
  eq(lessons[0].questions[0].answer, 'A');
  eq(lessons[1].questions[0].type, 'fill');
  eq(lessons[1].questions[0].answer, '洱海');
});

test('JSON 备份解析', function () {
  const json = JSON.stringify({ version: 1, lessons: [{ title: '观潮', questions: [
    { type: 'choice', stem: '题干', options: ['甲', '乙'], answer: 'B', analysis: '因为' }
  ] }] });
  const lessons = parseQuestions(json, 'bank.json');
  eq(lessons.length, 1);
  eq(lessons[0].questions[0].answer, 'B');
});

/* ------------------------------ 收尾 ------------------------------ */
console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + '通过 ' + pass + ' 项，失败 ' + fail + ' 项\x1b[0m');
if (fail) {
  console.log('\n失败明细：');
  failures.forEach(function (f) { console.log(' - ' + f); });
  process.exit(1);
}
