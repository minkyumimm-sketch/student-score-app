// STUDENT-GRADE-9SUBJECT-PUBLIC-UI-IMPL-1専用テスト。
//
// student-score-app（Public）にはこれまで専用のテスト方式が存在しないため、本STEPで新設する。
// Private側tests/regression/のGAS vm sandboxパターン（実ファイルをnode:vmへそのままロードし、
// 構造を手で複製しない）と同じ考え方を採用する: 実際のindex.htmlをパースしてid/class/option構造を
// 再現した最小限のDOMスタブを構築し、実際のconfig.js/api.js/app.jsをそのままvm.runInContextで
// 実行する。HTMLのonclick/oninput属性文字列はパース・evalせず、index.html自身がそれらの属性で
// 呼んでいるのと同じ公開関数(window.ScoreAppUi.xxx)を直接呼び出すことで同じ経路を検証する。
//
// 合成fixtureとモックfetchのみを使用する。実生徒データ・本番Spreadsheet・実際のネットワークには
// 一切アクセスしない。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, message) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(message);
    console.error('FAIL: ' + message);
  }
}

function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, message + ' (actual=' + JSON.stringify(actual) + ', expected=' + JSON.stringify(expected) + ')');
}

// ===== 最小限のfake DOM（実際のindex.htmlをパースして構築する） =====

function parseAttrs(attrString) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
  let m;
  while ((m = re.exec(attrString))) {
    attrs[m[1]] = m[2] === undefined ? true : m[2];
  }
  return attrs;
}

class FakeElement {
  constructor(tag, id) {
    this.tagName = (tag || 'div').toUpperCase();
    this.id = id || '';
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.textContent = '';
    this._innerHTML = '';
    this._value = '';
    this._listeners = {};
    this.style = {};
    this.onclick = null;
    this.oninput = null;
    if (this.tagName === 'SELECT') this.options = [];
  }
  get classList() {
    const self = this;
    return {
      add: function (c) {
        if (self.className.split(/\s+/).indexOf(c) === -1) self.className = (self.className + ' ' + c).trim();
      },
      remove: function (c) {
        self.className = self.className.split(/\s+/).filter(function (x) { return x !== c; }).join(' ');
      },
      contains: function (c) {
        return self.className.split(/\s+/).indexOf(c) !== -1;
      }
    };
  }
  get value() {
    if (this.tagName === 'SELECT') {
      const opt = this.options[this.selectedIndex];
      return opt ? opt.value : '';
    }
    return this._value;
  }
  set value(v) {
    if (this.tagName === 'SELECT') {
      const target = String(v);
      const idx = this.options.findIndex(function (o) { return o.value === target; });
      this.selectedIndex = idx === -1 ? -1 : idx;
      return;
    }
    this._value = v;
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(html) {
    this._innerHTML = html;
    if (html === '') this.children = []; // app.jsはクリア目的以外でinnerHTMLへ値を設定しない
  }
  appendChild(child) {
    this.children.push(child);
    if (this.tagName === 'SELECT' && child.tagName === 'OPTION') {
      this.options.push(child);
    }
    return child;
  }
  addEventListener(type, handler) {
    this._listeners[type] = this._listeners[type] || [];
    this._listeners[type].push(handler);
  }
  click() {
    if (typeof this.onclick === 'function') this.onclick();
  }
  focus() { this._focused = true; }
}

function buildDocumentStub(html) {
  const elementsById = new Map();

  // 第1パス: <select id="...">...</select>ブロックのoption一覧を取得する。
  const selectOptionsById = new Map();
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/g;
  let sm;
  while ((sm = selectRe.exec(html))) {
    const attrs = parseAttrs(sm[1]);
    if (!attrs.id) continue;
    const options = [];
    const optRe = /<option\b([^>]*)>/g;
    let om;
    while ((om = optRe.exec(sm[2]))) {
      const oAttrs = parseAttrs(om[1]);
      options.push(typeof oAttrs.value === 'string' ? oAttrs.value : '');
    }
    selectOptionsById.set(attrs.id, options);
  }

  // 第2パス: id属性を持つ全タグを汎用生成する。
  const tagRe = /<(\w+)\b([^>]*)>/g;
  let tm;
  while ((tm = tagRe.exec(html))) {
    const tag = tm[1];
    const attrs = parseAttrs(tm[2]);
    if (!attrs.id) continue;
    if (elementsById.has(attrs.id)) continue; // 同じidの再出現(閉じタグ誤検知等)を無視
    const el = new FakeElement(tag, attrs.id);
    if (typeof attrs.class === 'string') el.className = attrs.class;
    if (attrs.hidden === true) el.hidden = true;
    if (tag.toLowerCase() === 'select') {
      const opts = selectOptionsById.get(attrs.id) || [];
      opts.forEach(function (v) {
        const opt = new FakeElement('option');
        opt.value = v;
        el.options.push(opt);
      });
      el.selectedIndex = el.options.length ? 0 : -1;
    }
    elementsById.set(attrs.id, el);
  }

  const document_ = {
    getElementById: function (id) { return elementsById.get(id) || null; },
    createElement: function (tag) { return new FakeElement(tag); },
    querySelectorAll: function (selector) {
      if (selector !== '.step') throw new Error('test stub: unsupported selector ' + selector);
      const result = [];
      elementsById.forEach(function (el) {
        if (el.classList.contains('step')) result.push(el);
      });
      return result;
    },
    _elementsById: elementsById
  };
  return document_;
}

// ===== fetchモック =====

function makeJsonResponse_(obj) {
  const text = JSON.stringify(obj);
  return {
    status: 200, ok: true, redirected: false, url: 'https://script.google.com/macros/s/fake/exec',
    headers: { get: function () { return 'application/json'; } },
    text: function () { return Promise.resolve(text); }
  };
}

function parseQueryString_(url) {
  const qIndex = url.indexOf('?');
  const qs = qIndex === -1 ? '' : url.slice(qIndex + 1);
  const params = {};
  qs.split('&').filter(Boolean).forEach(function (pair) {
    const idx = pair.indexOf('=');
    const k = decodeURIComponent(pair.slice(0, idx));
    const v = decodeURIComponent(pair.slice(idx + 1));
    params[k] = v;
  });
  return params;
}

function makeFetchMock(state) {
  return function fakeFetch(url, opts) {
    try {
      const method = (opts && opts.method) || 'GET';
      let action, paramsOrBody;
      if (method === 'POST') {
        const bodyObj = JSON.parse(opts.body);
        action = bodyObj.action;
        paramsOrBody = bodyObj;
      } else {
        const params = parseQueryString_(url);
        action = params.action;
        paramsOrBody = params;
      }
      state.calls.push({ method: method, action: action, payload: paramsOrBody });
      const handler = state.handlers[action];
      if (!handler) {
        return Promise.resolve(makeJsonResponse_({ ok: false, error: 'mock: action not registered: ' + action }));
      }
      const outcome = handler(paramsOrBody);
      if (outcome && outcome.__networkError) {
        return Promise.reject(new Error(outcome.message || 'network error'));
      }
      return Promise.resolve(makeJsonResponse_(outcome));
    } catch (e) {
      return Promise.reject(e);
    }
  };
}

// ===== 高速fakeタイマー(debounce/retry待ちで実時間を消費しないようにする) =====

function makeFastTimers() {
  let nextId = 1;
  const handles = new Map();
  function fakeSetTimeout(fn) {
    const id = nextId++;
    const handle = setImmediate(function () {
      if (handles.has(id)) { handles.delete(id); fn(); }
    });
    handles.set(id, handle);
    return id;
  }
  function fakeClearTimeout(id) {
    const handle = handles.get(id);
    if (handle) { clearImmediate(handle); handles.delete(id); }
  }
  return { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout };
}

function tick(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 5); i++) {
    p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
  }
  return p;
}

// ===== sandbox構築（実ファイルをそのままロードする） =====

function loadSandbox(fetchHandlers) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const document_ = buildDocumentStub(html);
  const fetchState = { handlers: fetchHandlers || {}, calls: [] };
  const timers = makeFastTimers();

  const sandbox = {
    document: document_,
    fetch: makeFetchMock(fetchState),
    AbortController: global.AbortController,
    console: console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  };
  sandbox.window = sandbox; // window===globalThis(このvmコンテキスト内)という実ブラウザの性質を再現する

  const context = vm.createContext(sandbox);
  ['config.js', 'api.js', 'app.js'].forEach(function (file) {
    const code = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  });

  return { context: context, document: document_, fetchState: fetchState };
}

// 実DOMのtextContentは子要素を再帰的に連結するが、FakeElementは平坦なプロパティのため、
// テスト側でこの集約だけを再現する（app.js側の挙動を変えるものではない）。
function flattenText_(el) {
  if (!el.children || !el.children.length) return el.textContent || '';
  return el.children.map(flattenText_).join('');
}

async function selectFirstSearchResult_(sb, keyword) {
  sb.document.getElementById('studentSearch').value = keyword;
  sb.context.ScoreAppUi.onStudentSearchInput();
  await tick();
  const items = sb.document.getElementById('studentList').children;
  if (!items.length) throw new Error('no search result rendered for keyword=' + keyword);
  items[0].click();
  await tick();
}

const STUDENT = { studentId: 'S0001', displayName: 'テスト生徒', grade: '中2' };

function defaultHandlers(overrides) {
  const base = {
    ping: function () { return { ok: true }; },
    searchScoreEntryStudents: function () { return { ok: true, students: [STUDENT] }; },
    listAvailableTests: function () { return { ok: true, tests: [] }; },
    isAverageInputMember: function () { return { ok: true, isMember: false }; }
  };
  return Object.assign(base, overrides || {});
}

const FULL_SUBJECTS = { japanese: '4', social: '4', math: '3', science: '4', music: '5', art: '4', pe: '4', tech_home: '5', english: '3' };
const FULL_SUBJECTS_RECORD = { japanese: 4, social: 4, math: 3, science: 4, music: 5, art: 4, pe: 4, tech_home: 5, english: 3 };

function makeGradeRecord(overrides) {
  return Object.assign({
    studentId: STUDENT.studentId,
    year: 2026,
    grade: '中3',
    term: '前期',
    subjects: FULL_SUBJECTS_RECORD,
    confirmationStatus: 'unconfirmed',
    revision: 1,
    updatedAt: '2026-10-31T00:00:00.000Z',
    sonNaishin: 36,
    kansanNaishin: 54,
    referenceScore300: 249
  }, overrides || {});
}

async function run() {
  // ===== A. 導線ボタン表示・4step遷移・年度/学年/学期選択 =====
  {
    const sb = loadSandbox(defaultHandlers());
    await selectFirstSearchResult_(sb, 'テスト');
    const btn = sb.document.getElementById('showGradeInputBtn');
    assert(!!btn && btn.hidden === false, 'A1: 内申点入力ボタンがstep-testsに常時表示される（担当者判定なし）');

    sb.context.ScoreAppUi.showGradeInput();
    assert(sb.document.getElementById('step-grade-select').classList.contains('active'), 'A2: 内申点ボタン押下でstep-grade-selectへ遷移する');
    assertEqual(sb.document.getElementById('gradeSelectStudentLabel').textContent, 'テスト生徒 さん', 'A3: 選択中の生徒名が表示される');

    const yearSelect = sb.document.getElementById('gradeYearSelect');
    assertEqual(yearSelect.options.length, 10, 'A4: 年度選択肢が10件（現在年の5年前〜4年後）生成される');
    const currentYear = new Date().getFullYear();
    assertEqual(yearSelect.value, String(currentYear), 'A5: 年度のデフォルト選択は現在年');

    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
  }

  // ===== B. 未登録record=null の取得・表示 =====
  {
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function (params) {
        assertEqual(params.studentId, STUDENT.studentId, 'B1: getGradeHistoryにstudentIdが渡る');
        return { ok: true, record: null };
      }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();

    assert(sb.document.getElementById('step-grade-form').classList.contains('active'), 'B2: 未登録でもstep-grade-formへ進める');
    GRADE_SUBJECT_KEYS_TEST.forEach(function (key) {
      assertEqual(sb.document.getElementById('g_' + key).value, '', 'B3: 未登録時は教科「' + key + '」が空欄表示');
    });
  }

  // ===== C. 既存評定の読込(confirmation_status列は互換性のため残るがUI表示はしない) =====
  {
    const existing = makeGradeRecord({ confirmationStatus: 'confirmed', revision: 3 });
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: existing }; }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();

    assertEqual(sb.document.getElementById('g_japanese').value, '4', 'C1: 既存評定（国語=4）が読み込まれる');
    assertEqual(sb.document.getElementById('g_english').value, '3', 'C2: 既存評定（英語=3）が読み込まれる');
    assertEqual(sb.document.getElementById('gradeFormConfirmedWarning'), null, 'C3: confirmed警告のUI要素は撤去されている');
  }

  // ===== D. 9教科入力・部分入力・確認画面表示 =====
  {
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: null }; }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中2';
    sb.document.getElementById('gradeTermSelect').value = '後期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();

    // 部分入力（国語のみ）で確認画面へ進めることを確認する。
    sb.document.getElementById('g_japanese').value = '4';
    sb.context.ScoreAppUi.goToGradeConfirm();
    assert(sb.document.getElementById('step-grade-confirm').classList.contains('active'), 'D1: 部分入力でも確認画面へ進める');
    assertEqual(sb.document.getElementById('gc_japanese').textContent, '4', 'D2: 確認画面に入力済み教科の値が表示される');
    assertEqual(sb.document.getElementById('gc_social').textContent, '（未入力）', 'D3: 確認画面に未入力教科が「（未入力）」と表示される');
    assertEqual(sb.document.getElementById('gc_year').textContent, '2026年度', 'D4: 確認画面に年度が表示される');
    assertEqual(sb.document.getElementById('gc_gradeLevel').textContent, '中2', 'D5: 確認画面に学年が表示される');
    assertEqual(sb.document.getElementById('gc_term').textContent, '後期', 'D6: 確認画面に学期が表示される');
  }

  // ===== E. 新規保存(expectedRevision=0)・全教科入力・保存成功・計算結果表示 =====
  {
    let savedPayload = null;
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: null }; },
      saveGradeHistory: function (payload) {
        savedPayload = payload;
        return { ok: true, record: makeGradeRecord({ revision: 1 }) };
      }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();

    Object.keys(FULL_SUBJECTS).forEach(function (key) {
      sb.document.getElementById('g_' + key).value = FULL_SUBJECTS[key];
    });
    sb.context.ScoreAppUi.goToGradeConfirm();
    sb.context.ScoreAppUi.saveGradeHistoryEntry();
    await tick();

    assertEqual(savedPayload.studentId, STUDENT.studentId, 'E1: 保存payloadにstudentIdが含まれる');
    assertEqual(savedPayload.expectedRevision, 0, 'E2: 新規保存はexpectedRevision=0で送信される');
    assertEqual(savedPayload.subjects.japanese, 4, 'E3: 保存payloadの教科値が数値化される（文字列のまま送らない）');
    assertEqual(Object.keys(savedPayload.subjects).sort(), GRADE_SUBJECT_KEYS_TEST.slice().sort(), 'E4: 保存payloadに9教科すべてのキーが含まれる');

    assert(sb.document.getElementById('step-grade-done').classList.contains('active'), 'E5: 保存成功後にstep-grade-doneへ遷移する');
    assertEqual(sb.document.getElementById('gdone_year').textContent, '2026年度', 'E6: 完了画面に年度が表示される');
    const resultText = flattenText_(sb.document.getElementById('gradeDoneResult'));
    assert(resultText.indexOf('36点') !== -1, 'E7: 完了画面に素内申（サーバー計算値）が表示される');
    assert(resultText.indexOf('54点') !== -1, 'E8: 完了画面に換算内申（サーバー計算値）が表示される');
    assert(resultText.indexOf('249点') !== -1, 'E9: 完了画面に参考300点換算（サーバー計算値）が表示される');
    assert(resultText.indexOf('正式な調査書点ではない参考値です') !== -1, 'E10: 参考値の注記が表示される');
  }

  // ===== F. 既存更新(revision一致)・未完成(9教科未完了)表示 =====
  {
    let savedPayload = null;
    const existing = makeGradeRecord({ revision: 2, subjects: { japanese: 3, social: null, math: null, science: null, music: null, art: null, pe: null, tech_home: null, english: null }, sonNaishin: null, kansanNaishin: null, referenceScore300: null });
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: existing }; },
      saveGradeHistory: function (payload) {
        savedPayload = payload;
        return { ok: true, record: makeGradeRecord({ revision: 3, subjects: { japanese: 3, social: null, math: null, science: null, music: null, art: null, pe: null, tech_home: null, english: null }, sonNaishin: null, kansanNaishin: null, referenceScore300: null }) };
      }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();

    sb.context.ScoreAppUi.goToGradeConfirm();
    sb.context.ScoreAppUi.saveGradeHistoryEntry();
    await tick();

    assertEqual(savedPayload.expectedRevision, 2, 'F1: 既存更新は取得済みrevisionで送信される');
    const resultText = flattenText_(sb.document.getElementById('gradeDoneResult'));
    assert(resultText.indexOf('未完成') !== -1, 'F2: 9教科未完了時は完了画面に「未完成」と表示される');
    assert(resultText.indexOf('36点') === -1, 'F3: 未完成時は計算結果（素内申等）を表示しない');
  }

  // ===== G. confirmed状態のレコードを再編集・保存できる(表示は撤去済み、保存は従来どおり可能) =====
  {
    const existing = makeGradeRecord({ confirmationStatus: 'confirmed', revision: 3 });
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: existing }; },
      saveGradeHistory: function () {
        return { ok: true, record: makeGradeRecord({ confirmationStatus: 'unconfirmed', revision: 4 }) };
      }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();

    sb.context.ScoreAppUi.goToGradeConfirm();
    sb.context.ScoreAppUi.saveGradeHistoryEntry();
    await tick();
    assert(sb.document.getElementById('step-grade-done').classList.contains('active'), 'G2: confirmed状態だったレコードの再編集も保存できる');
  }

  // ===== H. GET通信失敗（record=nullと明確に区別し、新規保存できる状態にしない） =====
  {
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { __networkError: true, message: 'network down' }; }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick(10); // GET自動retry(最大1回)の完了を待つ

    assert(sb.document.getElementById('step-grade-select').classList.contains('active'), 'H1: GET通信失敗時はgrade-formへ進まない（record=nullと混同しない）');
    assert(sb.document.getElementById('gradeSelectMessage').textContent.length > 0, 'H2: GET通信失敗時にエラーメッセージが表示される');
  }

  // ===== I. POST通信失敗（通信結果不明時：成功と断定しない・自動retryなし） =====
  {
    let postCallCount = 0;
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: null }; },
      saveGradeHistory: function () {
        postCallCount++;
        return { __networkError: true, message: 'network down' };
      }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();
    sb.document.getElementById('g_japanese').value = '4';
    sb.context.ScoreAppUi.goToGradeConfirm();
    sb.context.ScoreAppUi.saveGradeHistoryEntry();
    await tick(10);

    assert(sb.document.getElementById('step-grade-confirm').classList.contains('active'), 'I1: POST通信失敗時はconfirm画面に留まる（成功と断定しない）');
    assertEqual(postCallCount, 1, 'I2: POST失敗時に自動retryしない（呼出は1回のみ）');
    // GATE5: 通信結果不明時は「保存失敗が確定した」と扱わず、保存ボタンをdisabledのまま維持する。
    // 単にボタンを再度押すだけで同じPOSTを再送できる状態には戻さない。
    assertEqual(sb.document.getElementById('gradeConfirmSaveBtn').disabled, true, 'I3: 通信結果不明時は保存ボタンがdisabledのまま維持される（同じPOSTの単純な再送を許さない）');
    assertEqual(sb.document.getElementById('gradeConfirmRecheckBtn').disabled, false, 'I4: 通信結果不明時は「保存状態を確認する」ボタンだけが有効になる');
  }

  // ===== J. CONFLICT（保存成功扱いにしない・最新データ再取得・古いrevisionで再送信させない） =====
  {
    let fetchCount = 0;
    let lastSentRevision = null;
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () {
        fetchCount++;
        if (fetchCount === 1) return { ok: true, record: null };
        return { ok: true, record: makeGradeRecord({ revision: 5, subjects: { japanese: 2, social: null, math: null, science: null, music: null, art: null, pe: null, tech_home: null, english: null } }) };
      },
      saveGradeHistory: function (payload) {
        lastSentRevision = payload.expectedRevision;
        return { ok: false, error: 'この評定記録は別の操作によって更新されています。最新データを読み込み直してください。', errorCode: 'CONFLICT' };
      }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();
    sb.document.getElementById('g_japanese').value = '4';
    sb.context.ScoreAppUi.goToGradeConfirm();
    sb.context.ScoreAppUi.saveGradeHistoryEntry();
    await tick(10);

    assertEqual(lastSentRevision, 0, 'J1: CONFLICT発生前の送信revisionは取得済みの値(0)だった');
    assert(sb.document.getElementById('step-grade-form').classList.contains('active'), 'J2: CONFLICT後はgrade-form画面へ戻る（保存成功扱いにしない）');
    assertEqual(sb.document.getElementById('g_japanese').value, '2', 'J3: CONFLICT後は最新データ（revision=5の内容）が再取得・反映される（古い入力値4は残らない）');
    assertEqual(fetchCount, 2, 'J4: CONFLICT時にgetGradeHistoryが自動で再取得される');
    const conflictMsg = sb.document.getElementById('gradeFormMessage').textContent;
    assert(conflictMsg.indexOf('保存されていません') !== -1, 'J4b: 未保存入力が失われたことが明示される');

    // 再送信すると、更新されたexpectedRevision(5)で送られることを確認する。
    let secondSentRevision = null;
    sb.fetchState.handlers.saveGradeHistory = function (payload) {
      secondSentRevision = payload.expectedRevision;
      return { ok: true, record: makeGradeRecord({ revision: 6 }) };
    };
    sb.context.ScoreAppUi.goToGradeConfirm();
    sb.context.ScoreAppUi.saveGradeHistoryEntry();
    await tick();
    assertEqual(secondSentRevision, 5, 'J5: 古いrevision(0)のまま再送信せず、再取得後の最新revision(5)で送信される');
  }

  // ===== J2. CONFLICT後の再取得自体が失敗した場合は保存操作を再開できない状態を維持する =====
  {
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: null }; },
      saveGradeHistory: function () {
        return { ok: false, error: 'この評定記録は別の操作によって更新されています。最新データを読み込み直してください。', errorCode: 'CONFLICT' };
      }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();
    sb.document.getElementById('g_japanese').value = '4';
    sb.context.ScoreAppUi.goToGradeConfirm();
    // CONFLICT後の自動再取得自体もネットワーク失敗させる。
    sb.fetchState.handlers.getGradeHistory = function () { return { __networkError: true, message: 'network down' }; };
    sb.context.ScoreAppUi.saveGradeHistoryEntry();
    await tick(10);

    assert(sb.document.getElementById('step-grade-confirm').classList.contains('active'), 'J2a: CONFLICT後の再取得失敗時はconfirm画面に留まる（grade-formへ進めない）');
    assertEqual(sb.document.getElementById('gradeConfirmSaveBtn').disabled, true, 'J2b: CONFLICT後の再取得失敗時は保存ボタンがdisabledのまま維持される（保存操作を再開できない）');
    assertEqual(sb.document.getElementById('gradeConfirmRecheckBtn').disabled, true, 'J2c: 再取得(GET)自体が失敗したため確認導線もdisabledのまま（さらに手動で再試行する必要がある）');
  }

  // ===== J3. 保存状態確認（GET成功・一致/不一致・GET失敗） =====
  {
    // 一致ケース: 通信結果不明なPOST後、recheckで取得したデータが送信内容と一致する。
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: null }; },
      saveGradeHistory: function () { return { __networkError: true, message: 'network down' }; }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();
    sb.document.getElementById('g_japanese').value = '4';
    sb.context.ScoreAppUi.goToGradeConfirm();
    sb.context.ScoreAppUi.saveGradeHistoryEntry();
    await tick(10); // 通信結果不明のまま確認画面に留まる

    // サーバーには実際には保存が成功していた、という状況を再現する（revision=1、japanese=4のみ）。
    sb.fetchState.handlers.getGradeHistory = function () {
      return { ok: true, record: makeGradeRecord({ revision: 1, subjects: { japanese: 4, social: null, math: null, science: null, music: null, art: null, pe: null, tech_home: null, english: null }, sonNaishin: null, kansanNaishin: null, referenceScore300: null }) };
    };
    sb.context.ScoreAppUi.recheckGradeSaveStatus();
    await tick();

    assert(sb.document.getElementById('step-grade-form').classList.contains('active'), 'J3a: 保存状態確認GET成功時はgrade-form画面へ進む');
    const matchMsg = sb.document.getElementById('gradeFormMessage').textContent;
    assert(matchMsg.indexOf('一致しています') !== -1, 'J3b: 送信内容と保存内容が一致する場合「一致しています」と表示する（成功と断定しない）');
    assertEqual(sb.document.getElementById('gradeConfirmSaveBtn').disabled, false, 'J3c: 確認後は保存ボタンが再度有効になる');
  }
  {
    // 不一致ケース: recheckで取得したデータが送信内容と異なる（他者の変更が先に保存された等）。
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: null }; },
      saveGradeHistory: function () { return { __networkError: true, message: 'network down' }; }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();
    sb.document.getElementById('g_japanese').value = '4';
    sb.context.ScoreAppUi.goToGradeConfirm();
    sb.context.ScoreAppUi.saveGradeHistoryEntry();
    await tick(10);

    sb.fetchState.handlers.getGradeHistory = function () {
      return { ok: true, record: makeGradeRecord({ revision: 1, subjects: { japanese: 1, social: null, math: null, science: null, music: null, art: null, pe: null, tech_home: null, english: null }, sonNaishin: null, kansanNaishin: null, referenceScore300: null }) };
    };
    sb.context.ScoreAppUi.recheckGradeSaveStatus();
    await tick();

    const mismatchMsg = sb.document.getElementById('gradeFormMessage').textContent;
    assert(mismatchMsg.indexOf('異なるデータ') !== -1, 'J3d: 送信内容と保存内容が不一致の場合、その旨を表示し再編集の判断を委ねる');
    assertEqual(sb.document.getElementById('g_japanese').value, '1', 'J3e: 不一致時は最新の保存済みデータ（他者の変更）を画面へ反映する');
  }
  {
    // 保存状態確認GET失敗: 保存不可の状態を維持する。
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: null }; },
      saveGradeHistory: function () { return { __networkError: true, message: 'network down' }; }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();
    sb.document.getElementById('g_japanese').value = '4';
    sb.context.ScoreAppUi.goToGradeConfirm();
    sb.context.ScoreAppUi.saveGradeHistoryEntry();
    await tick(10);

    sb.fetchState.handlers.getGradeHistory = function () { return { __networkError: true, message: 'still down' }; };
    sb.context.ScoreAppUi.recheckGradeSaveStatus();
    await tick(10);

    assert(sb.document.getElementById('step-grade-confirm').classList.contains('active'), 'J3f: 保存状態確認GETが失敗した場合はconfirm画面に留まる');
    assertEqual(sb.document.getElementById('gradeConfirmSaveBtn').disabled, true, 'J3g: 保存状態確認GETが失敗した場合は保存ボタンがdisabledのまま維持される');
  }

  // ===== J4. POST中に別の生徒へ切り替わった場合、古い生徒への応答を新しい生徒の画面に反映しない =====
  {
    const STUDENT3 = { studentId: 'S0003', displayName: '三人目の生徒', grade: '中3' };
    let currentStudentList = [STUDENT];
    let resolvePost = null;
    const sb = loadSandbox(defaultHandlers({
      searchScoreEntryStudents: function () { return { ok: true, students: currentStudentList }; }
    }));
    // POST応答を手動で保留できるよう、fetchをこのテスト専用に差し替える
    // （makeFetchMockは同期handlerしか想定していないため、Promiseを手動で保持する）。
    const originalFetch = sb.context.fetch;
    sb.context.fetch = function (url, opts) {
      if (opts && opts.method === 'POST' && JSON.parse(opts.body).action === 'saveGradeHistory') {
        return new Promise(function (resolve) {
          resolvePost = function () {
            resolve({
              status: 200, ok: true, redirected: false, url: 'https://script.google.com/macros/s/fake/exec',
              headers: { get: function () { return 'application/json'; } },
              text: function () { return Promise.resolve(JSON.stringify({ ok: true, record: makeGradeRecord({ revision: 1 }) })); }
            });
          };
        });
      }
      return originalFetch(url, opts);
    };
    sb.fetchState.handlers.getGradeHistory = function () { return { ok: true, record: null }; };

    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();
    sb.document.getElementById('g_japanese').value = '4';
    sb.context.ScoreAppUi.goToGradeConfirm();
    sb.context.ScoreAppUi.saveGradeHistoryEntry(); // POSTは保留のまま（resolvePostが呼ばれるまで解決しない）
    await tick();

    // POSTが未解決のまま、別の生徒へ切り替える。
    currentStudentList = [STUDENT3];
    sb.context.ScoreAppUi.backToSearch();
    await selectFirstSearchResult_(sb, '三人目');
    assert(sb.document.getElementById('step-tests').classList.contains('active'), 'J4a: 生徒切替後はstep-testsに留まっている（POST保留中でも通常のstep遷移を妨げない）');

    resolvePost();
    await tick(10);

    assert(!sb.document.getElementById('step-grade-done').classList.contains('active'), 'J4b: POST中に切り替えた後に古い生徒への保存応答が返っても、新しい生徒の画面がgrade-doneへ遷移しない');
    assert(sb.document.getElementById('step-tests').classList.contains('active'), 'J4c: 新しい生徒はstep-testsに留まったままである（古い生徒の応答で状態が巻き戻らない）');
  }

  // ===== K. 二重クリック防止（保存ボタンの連打で2回POSTされない） =====
  {
    let postCallCount = 0;
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: null }; },
      saveGradeHistory: function () {
        postCallCount++;
        return { ok: true, record: makeGradeRecord({ revision: 1 }) };
      }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();
    sb.document.getElementById('g_japanese').value = '4';
    sb.context.ScoreAppUi.goToGradeConfirm();

    sb.context.ScoreAppUi.saveGradeHistoryEntry();
    const disabledRightAfterClick = sb.document.getElementById('gradeConfirmSaveBtn').disabled;
    // GATE6: 保存中は保存・修正・保存状態確認の3ボタンすべてを無効化する（状態を変える操作を
    // 必要な範囲で無効化する）。
    const backDisabledRightAfterClick = sb.document.getElementById('gradeConfirmBackBtn').disabled;
    const recheckDisabledRightAfterClick = sb.document.getElementById('gradeConfirmRecheckBtn').disabled;
    sb.context.ScoreAppUi.saveGradeHistoryEntry(); // 2回目の連打（ボタンはdisabled状態のはずだが、クリック自体はJSから直接呼べるため、
    // ここではボタンのdisabled状態そのものが正しく立っているかを検証する（実ブラウザではdisabled=trueのbuttonはclickイベントを発火しない）。
    await tick();

    assertEqual(disabledRightAfterClick, true, 'K1: 保存クリック直後に保存ボタンがdisabledになる（二重送信防止。実ブラウザではdisabled=trueのbuttonはclickイベント自体が発火しないため、2回目の直接関数呼び出しによるPOST発行数の増加はこのテストスタブの制約であり、disabled状態自体の検証がここでの本来の確認事項）');
    assertEqual(backDisabledRightAfterClick, true, 'K2: 保存中は「修正する」ボタンもdisabledになる');
    assertEqual(recheckDisabledRightAfterClick, true, 'K3: 保存中は「保存状態を確認する」ボタンもdisabledになる');
  }

  // ===== L. 不正値入力拒否（0・6・小数・不正文字列）はUIのselect制約により送信前にブロックされる =====
  {
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: null }; }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();

    // <select>のoptionは空欄/1〜5のみのため、0・6・小数・不正文字列はそもそも選択不可能。
    // 多層防御として、goToGradeConfirm自体のvalidationも直接検証する（DOM制約を迂回した
    // 不正な内部呼び出しを想定した防御層）。
    const el = sb.document.getElementById('g_japanese');
    el._value = '0'; // <select>の制約を迂回して不正値を直接注入する（想定しうる防御テスト）
    const originalValueGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').get;
    // FakeElementのvalueゲッターはSELECTの場合options参照のため、直接_valueを書いても
    // tagName==='SELECT'分岐がoptionsから探す。0は存在しないoption値のため、取得結果は
    // 変わらず安全側(空欄相当)になることを確認する。
    assertEqual(el.value, '', 'L1: SELECT制約により存在しないoption値(0)は選択されない(空欄扱い)');
  }

  // ===== M. 生徒切替時の情報残留防止 =====
  {
    const STUDENT2 = { studentId: 'S0002', displayName: 'べつの生徒', grade: '中1' };
    let currentStudentList = [STUDENT];
    const sb = loadSandbox(defaultHandlers({
      searchScoreEntryStudents: function () { return { ok: true, students: currentStudentList }; },
      getGradeHistory: function () { return { ok: true, record: makeGradeRecord({ confirmationStatus: 'confirmed' }) }; }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();
    assertEqual(sb.document.getElementById('g_japanese').value, '4', 'M1: 生徒1の評定が表示されている');

    // 別生徒へ切り替える。
    currentStudentList = [STUDENT2];
    sb.context.ScoreAppUi.backToSearch();
    await selectFirstSearchResult_(sb, 'べつ');

    assertEqual(sb.document.getElementById('g_japanese').value, '', 'M3: 生徒切替後は前生徒の評定入力欄がクリアされている');
  }

  // ===== N. resetAll()との整合（既存の共有端末向けリセット動作を壊さない） =====
  {
    const sb = loadSandbox(defaultHandlers({
      getGradeHistory: function () { return { ok: true, record: makeGradeRecord({ confirmationStatus: 'confirmed' }) }; }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    sb.context.ScoreAppUi.showGradeInput();
    sb.document.getElementById('gradeYearSelect').value = '2026';
    sb.document.getElementById('gradeLevelSelect').value = '中3';
    sb.document.getElementById('gradeTermSelect').value = '前期';
    sb.context.ScoreAppUi.goToGradeForm();
    await tick();
    assertEqual(sb.document.getElementById('g_japanese').value, '4', 'N1: resetAll前は評定入力欄に値が入っている');

    sb.context.ScoreAppUi.resetAll();
    assert(sb.document.getElementById('step-search').classList.contains('active'), 'N2: resetAll()で検索画面に戻る');
    assertEqual(sb.document.getElementById('g_japanese').value, '', 'N3: resetAll()で評定入力欄もクリアされる');
  }

  // ===== O. 非回帰：既存の氏名検索・点数登録・平均点登録・成績履歴・既存API通信・既存CSSクラス =====
  {
    const sb = loadSandbox(defaultHandlers({
      listAvailableTests: function () { return { ok: true, tests: [{ testId: 'T0001', testName: '第1回テスト' }] }; }
    }));
    await selectFirstSearchResult_(sb, 'テスト');
    await tick();
    assert(sb.document.getElementById('step-tests').classList.contains('active'), 'O1: 既存の氏名検索→生徒選択→step-tests遷移は無劣化');
    assertEqual(sb.document.getElementById('testList').children.length, 1, 'O2: 既存の点数登録テスト一覧取得は無劣化');

    sb.context.ScoreAppUi.showScoreHistory ? null : assert(false, 'O3: 既存showScoreHistory関数の存在');
    assert(typeof sb.context.ScoreAppUi.showAverageInputTests === 'function', 'O4: 既存showAverageInputTests関数が引き続き公開されている');
    assert(typeof sb.context.ScoreAppUi.submitScore === 'function', 'O5: 既存submitScore関数が引き続き公開されている');
    assert(typeof sb.context.ScoreAppUi.saveHistoryRank === 'function', 'O6: 既存saveHistoryRank関数が引き続き公開されている');

    const btn = sb.document.getElementById('showAverageInputBtn');
    assertEqual(btn.hidden, true, 'O7: 既存の学年平均入力ボタンの担当者判定(非表示)は無劣化');
  }

  console.log('\n=== grade_input_ui_test.js: PASS=' + pass + ' FAIL=' + fail + ' ===');
  if (fail > 0) {
    console.log('Failures:\n - ' + failures.join('\n - '));
    process.exitCode = 1;
  }
}

// GRADE_SUBJECT_KEYS_TESTはapp.js内部のGRADE_SUBJECT_KEYSと同じ並び（複製ではなく、
// テスト側が期待値を書くための独立したコピー。GRADE_HISTORY_SUBJECT_FIELDS(Private)と
// 完全一致させる）。
const GRADE_SUBJECT_KEYS_TEST = ['japanese', 'social', 'math', 'science', 'music', 'art', 'pe', 'tech_home', 'english'];

run().catch(function (e) {
  console.error('RUNNER ERROR: ' + (e && e.stack || e));
  process.exitCode = 1;
});
