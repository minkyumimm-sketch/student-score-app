// GitHub Pages版 点数入力アプリ。生徒検索→テスト選択→点数入力→確認→保存。
// 既存GAS版 StudentScoreEntry.html と異なり、生年月日認証は行わない（教室共用タブレット用途で
// 毎回8桁入力させる負担を優先し、誤登録は最終確認画面の生徒名強調表示＋講師側の修正/削除運用で
// 対応する方針。既存GAS版StudentScoreEntry.htmlの生年月日認証はそのまま維持している）。
// 教科の並び順（英語→数学→理科→社会→国語）は既存GAS版を踏襲する。

(function () {
  var SEARCH_DEBOUNCE_MS = 250; // 既存GAS版と同じdebounce値
  var SUBJECT_KEYS = ['english', 'math', 'science', 'social', 'japanese']; // 既存GAS版と同じ順序
  // Phase 2C: 学年平均との相対成長の表示用ラベル。SUBJECT_KEYSと同じ並び順で使う。
  var SUBJECT_LABELS_ = { english: '英語', math: '数学', science: '理科', social: '社会', japanese: '国語' };
  // R3-Public: 学年順位（任意）。keyはPrivate repoのScoreRepository.gs（SCORE_RANK_FIELDS）・
  // PublicApi.gs（handleSubmitStudentScore_）と完全一致させる（別名を作らない）。
  var RANK_FIELDS = [
    { key: 'englishRank', id: 'r_english', label: '英語' },
    { key: 'mathRank', id: 'r_math', label: '数学' },
    { key: 'scienceRank', id: 'r_science', label: '理科' },
    { key: 'socialRank', id: 'r_social', label: '社会' },
    { key: 'japaneseRank', id: 'r_japanese', label: '国語' },
    { key: 'totalRank', id: 'r_total', label: '5科合計' }
  ];
  // STEP B: 学年順位の後追い入力（結果詳細画面）。RANK_FIELDSと同じkey・同じ並び順だが、
  // 同一DOM内でstep-scoreの入力欄(r_*)と共存するためid・safe response上のkeyを分けている。
  // snakeKeyはPrivate repoのmapScoreHistoryEntryForExternalApi_が返すsnake_caseフィールド名
  // （既存のcamelCase keyとは別名、複製ではなく変換のためのペア定義）。
  var HISTORY_RANK_FIELDS = [
    { key: 'englishRank', snakeKey: 'english_rank', id: 'hdr_english', label: '英語' },
    { key: 'mathRank', snakeKey: 'math_rank', id: 'hdr_math', label: '数学' },
    { key: 'scienceRank', snakeKey: 'science_rank', id: 'hdr_science', label: '理科' },
    { key: 'socialRank', snakeKey: 'social_rank', id: 'hdr_social', label: '社会' },
    { key: 'japaneseRank', snakeKey: 'japanese_rank', id: 'hdr_japanese', label: '国語' },
    { key: 'totalRank', snakeKey: 'total_rank', id: 'hdr_total', label: '5科合計' }
  ];
  // クライアント側入力補助のみの上限値。サーバー側（validateScoreInput_）には意図的に
  // 上限チェックがない（配点が異なるテストに対応するため、既存の意図的仕様）ため、
  // ここでの100という値も入力のしやすさのためだけで、100点超の送信自体は拒否しない。
  var MAX_SCORE = 100;

  // STEP 3の点数入力・保存を含め、状態はこの1箇所にまとめる。
  // 生年月日認証は廃止したため、認証関連の状態は持たない（localStorage/sessionStorageへの
  // 保存もこれまで通り行わない。reload時は最初からやり直し）。
  var state = {
    currentStep: 'search',
    selectedStudent: null, // {studentId, displayName, grade, hasBirthDate}
    availableTests: [],
    selectedTest: null, // {testId, testName}
    pendingSubjects: null, // 確認画面へ渡す直前に確定した5教科の入力値
    pendingRanks: null, // R3-Public: 確認画面へ渡す直前に確定した学年順位6項目の入力値（すべて任意）
    // Phase 2B STEP 5: 学年平均入力用のstate。通常点数入力state（上記4項目）とは
    // 完全に分離し、混線させない（通常フローのロジックはこれらを一切参照しない）。
    isAverageMember: false,
    averageAvailableTests: [],
    averageSelectedTest: null, // {testId, testName}
    averagePendingSubjects: null,
    // STEP C: 楽観的ロック用。getSchoolGradeAverageが返したupdated_at(nullまたはISO文字列)を
    // 保持し、保存時にそのままexpectedUpdatedAtとして送り返す。
    averageExpectedUpdatedAt: null,
    // Phase 2D STEP 3: 後日フィードバック（これまでの結果を見る）用のstate。
    // 通常点数入力state・学年平均入力stateとは完全に分離し、混線させない。
    scoreHistory: [],
    selectedHistoryEntry: null // getScoreHistoryの1件（{test_id, test_name, japanese, math, english, science, social, five_subject_total}）
  };

  var searchTimer = null;

  // PERF-4C(案B): 検索候補1位の生徒だけ、候補表示が完了した「後」にbackgroundで
  // listAvailableTestsをpreloadする。stateオブジェクトとは意図的に分離する
  // （resetStudentDependentState_によるリセットへ巻き込まれないようにするため。
  // PERF-4Bのモデル検証で確認済みの設計）。searchScoreEntryStudentsのレスポンス生成・
  // renderStudentListの描画処理自体には一切手を加えない（検索クリティカルパス不変）。
  var TOP_CANDIDATE_PRELOAD_TTL_MS = 5000; // PERF-4B比較検討により採用した値。断定的な最適値ではない。
  var topCandidatePreload_ = null; // { studentId, promise, status: 'pending'|'resolved'|'failed', result, timestamp }

  function isTopCandidatePreloadFresh_(entry) {
    return !!entry && (Date.now() - entry.timestamp) < TOP_CANDIDATE_PRELOAD_TTL_MS;
  }

  function startTopCandidatePreload_(studentId) {
    var entry = { studentId: studentId, status: 'pending', result: null, timestamp: Date.now() };
    entry.promise = ScoreApi.get('listAvailableTests', { studentId: studentId }).then(function (result) {
      entry.status = 'resolved';
      entry.result = result;
      return result;
    }, function (err) {
      entry.status = 'failed';
      throw err;
    });
    entry.promise.catch(function () {}); // preloadは裏方のため、誰も拾わなくてもunhandled rejectionにしない。
    topCandidatePreload_ = entry;
  }

  // 同じ検索候補1位が続けて現れる場合（名前を1文字ずつ入力する間、上位候補が変わらないことが多い）に
  // 重複GETを発行しないための判定。新しい候補1位が現れたとき、または有効期限切れのときだけ再発火する。
  function maybeStartTopCandidatePreload_(students) {
    if (!students.length) return;
    var topId = students[0].studentId;
    if (topCandidatePreload_ && topCandidatePreload_.studentId === topId && isTopCandidatePreloadFresh_(topCandidatePreload_)) {
      return;
    }
    startTopCandidatePreload_(topId);
  }

  function resetStudentDependentState_() {
    // 生徒を選び直したときに、前の生徒のテスト一覧・入力途中の点数を必ずクリアする
    // （共用タブレットのため、次の生徒へ前の生徒の情報を引き継がない）。
    state.availableTests = [];
    state.selectedTest = null;
    state.pendingSubjects = null;
    state.pendingRanks = null;
    // Phase 2B STEP 5: 担当者判定・平均入力の状態も同じ理由で必ずクリアする。
    state.isAverageMember = false;
    state.averageAvailableTests = [];
    state.averageSelectedTest = null;
    state.averagePendingSubjects = null;
    state.averageExpectedUpdatedAt = null;
    var averageButton = document.getElementById('showAverageInputBtn');
    if (averageButton) averageButton.hidden = true;
    // Phase 2D STEP 3: 生徒を選び直したときに、前の生徒の結果履歴・選択中の詳細を必ずクリアする
    // （共用タブレットのため、次の生徒へ前の生徒の結果を一瞬たりとも引き継がない）。
    state.scoreHistory = [];
    state.selectedHistoryEntry = null;
    var historyListEl = document.getElementById('historyList');
    if (historyListEl) historyListEl.innerHTML = '';
    var historyMessageEl = document.getElementById('historyMessage');
    if (historyMessageEl) showMessage('historyMessage', '', '');
    clearHistoryDetailDisplay_();
  }

  // Phase 2D STEP 3: 結果詳細画面の表示をクリアする（前の生徒・前のテストの表示が
  // 一瞬でも残らないようにする、doneRelativeGrowthのresetAllクリアと同じ考え方）。
  function clearHistoryDetailDisplay_() {
    var feedbackEl = document.getElementById('historyFeedback');
    if (feedbackEl) feedbackEl.innerHTML = '';
    var growthItemsEl = document.getElementById('historyRelativeGrowthItems');
    if (growthItemsEl) growthItemsEl.innerHTML = '';
    var growthEl = document.getElementById('historyRelativeGrowth');
    if (growthEl) growthEl.hidden = true;
  }

  function applyScoreInputRange_() {
    SUBJECT_KEYS.forEach(function (key) {
      var el = document.getElementById('s_' + key);
      el.min = 0;
      el.max = MAX_SCORE;
    });
  }

  function goToStep(name) {
    state.currentStep = name;
    document.querySelectorAll('.step').forEach(function (el) { el.classList.remove('active'); });
    document.getElementById('step-' + name).classList.add('active');
  }

  function showMessage(elId, type, text) {
    var el = document.getElementById(elId);
    el.className = 'message' + (type ? ' ' + type : '');
    el.textContent = text || '';
  }

  // ===== Step 1: 生徒検索 =====

  function onStudentSearchInput() {
    clearTimeout(searchTimer);
    var keyword = document.getElementById('studentSearch').value.trim();
    var container = document.getElementById('studentList');
    if (!keyword) {
      container.innerHTML = '';
      return;
    }
    searchTimer = setTimeout(function () {
      ScoreApi.get('searchScoreEntryStudents', { keyword: keyword }).then(function (result) {
        // PERF-3B: 応答が返ってくる前に検索語が変わっていたら、古い応答を反映しない
        // （stale response guard。checkAverageInputMember_等、他箇所の既存パターンと同じ考え方）。
        var currentKeyword = document.getElementById('studentSearch').value.trim();
        if (currentKeyword !== keyword) return;
        if (!result.ok) {
          container.textContent = result.error;
          return;
        }
        renderStudentList(result.students);
        // PERF-4C(案B): 候補表示が完了した後にだけpreloadを開始する（検索のcritical pathには
        // 一切影響しない。renderStudentListは同期的なDOM描画のみのため、この時点で描画は完了済み）。
        maybeStartTopCandidatePreload_(result.students);
      });
    }, SEARCH_DEBOUNCE_MS);
  }

  function renderStudentList(students) {
    var container = document.getElementById('studentList');
    container.innerHTML = '';
    if (!students.length) {
      container.textContent = '該当する生徒が見つかりません。';
      return;
    }
    students.slice(0, 10).forEach(function (s) {
      var item = document.createElement('div');
      item.className = 'tap-item';
      item.textContent = s.displayName + '（' + s.grade + '）';
      item.onclick = function () { selectStudent(s); };
      container.appendChild(item);
    });
  }

  // 生年月日認証は廃止したため、生徒選択後は確認画面を挟まず直接テスト一覧を取得する
  // （誤選択への対策は最終確認画面の生徒名強調表示で担保する、追加の1タップ確認は入れない）。
  function selectStudent(s) {
    state.selectedStudent = s;
    resetStudentDependentState_();
    document.getElementById('testsStudentLabel').textContent = s.displayName + ' さん';
    loadAvailableTests();
    checkAverageInputMember_(); // 通常点数入力(loadAvailableTests)とは独立して並行実行する
  }

  // Phase 2B STEP 5: 学年平均入力担当者かどうかの判定。通常点数入力の可否には一切影響させない
  // （このAPI呼び出しが失敗・エラーになっても、loadAvailableTestsは独立して進行するため
  // 通常点数入力は引き続き利用できる。安全側として「担当者ボタンを出さない」に倒すだけ）。
  function checkAverageInputMember_() {
    var studentId = state.selectedStudent.studentId;
    ScoreApi.get('isAverageInputMember', { studentId: studentId }, window.SCORE_APP_CONFIG.AVERAGE_API_BASE_URL)
      .then(function (result) {
        // 判定結果が返ってくる前に生徒が切り替わっていたら、古い判定結果を反映しない。
        if (!state.selectedStudent || state.selectedStudent.studentId !== studentId) return;
        state.isAverageMember = !!(result && result.ok && result.isMember);
        var averageButton = document.getElementById('showAverageInputBtn');
        if (averageButton) averageButton.hidden = !state.isAverageMember;
      });
  }

  // ===== Step 2: 入力可能テスト一覧 =====

  // PERF-4C(案B): 応答が返ってくる前に別の生徒へ切り替わっていたら、古い結果を反映しない
  // （checkAverageInputMember_等、既存の他箇所と同じstaleガードの考え方。preload共有により
  // 応答到着までの時間が従来より延びる可能性があるため、このガードを新設する）。
  function applyAvailableTestsResult_(studentId, result) {
    if (!state.selectedStudent || state.selectedStudent.studentId !== studentId) return;
    if (!result.ok) {
      showMessage('testsMessage', '', result.error);
      return;
    }
    showMessage('testsMessage', '', '');
    state.availableTests = result.tests;
    renderTestList();
    goToStep('tests');
  }

  function loadAvailableTests() {
    showMessage('testsMessage', 'info', '読み込み中…');
    var studentId = state.selectedStudent.studentId;
    // PERF-4C(案B): 検索候補1位としてpreload済み/preload中の生徒を選んだ場合は、
    // 新規GETを発行せずpreloadの結果(または進行中のPromise)をそのまま使う。
    // 対象外・期限切れ・preload失敗時は、従来どおりの新規GETへ安全にfallbackする。
    var freshEntry = (topCandidatePreload_ && topCandidatePreload_.studentId === studentId && isTopCandidatePreloadFresh_(topCandidatePreload_)) ? topCandidatePreload_ : null;

    if (freshEntry && freshEntry.status === 'resolved') {
      applyAvailableTestsResult_(studentId, freshEntry.result);
      return;
    }
    if (freshEntry && freshEntry.status === 'pending') {
      freshEntry.promise.then(function (result) {
        applyAvailableTestsResult_(studentId, result);
      }, function () {
        ScoreApi.get('listAvailableTests', { studentId: studentId }).then(function (result) {
          applyAvailableTestsResult_(studentId, result);
        });
      });
      return;
    }
    ScoreApi.get('listAvailableTests', { studentId: studentId }).then(function (result) {
      applyAvailableTestsResult_(studentId, result);
    });
  }

  function renderTestList() {
    var container = document.getElementById('testList');
    container.innerHTML = '';
    if (!state.availableTests.length) {
      container.textContent = '現在入力できるテストはありません（提出済み、または入力期限を過ぎています）。';
      return;
    }
    state.availableTests.forEach(function (t) {
      var item = document.createElement('div');
      item.className = 'tap-item';
      item.textContent = t.testName;
      item.onclick = function () { selectTest(t); };
      container.appendChild(item);
    });
  }

  function selectTest(t) {
    state.selectedTest = t;
    document.getElementById('scoreLabel').textContent = state.selectedStudent.displayName + ' さん / ' + t.testName;
    SUBJECT_KEYS.forEach(function (key) {
      document.getElementById('s_' + key).value = '';
    });
    RANK_FIELDS.forEach(function (f) {
      document.getElementById(f.id).value = '';
    });
    showMessage('scoreMessage', '', '');
    goToStep('score');
  }

  // ===== Step 4: 5教科入力 =====

  function collectSubjects_() {
    var subjects = {};
    SUBJECT_KEYS.forEach(function (key) {
      subjects[key] = document.getElementById('s_' + key).value.trim();
    });
    return subjects;
  }

  // R3-Public: 学年順位（任意）。空欄はそのまま返す（未入力=null、Private側validateRankInput_と
  // 同じ扱い）。ここでのvalidationは送信前のUX補助であり、正本はサーバー側
  // （PublicApi.gs -> createScore -> validateRankInput_）が引き続き担う多層防御構成。
  function collectRanks_() {
    var ranks = {};
    RANK_FIELDS.forEach(function (f) {
      ranks[f.key] = document.getElementById(f.id).value.trim();
    });
    return ranks;
  }

  // クライアント側validationはUX用（早期に気づかせるためだけ）であり、正本はGAS側の
  // validateScoreInput_（全空欄拒否・非数値拒否・負数拒否）。100点超はここでも拒否しない
  // （既存の意図的仕様、配点が異なるテストに対応するため）。
  function goToConfirm() {
    var subjects = collectSubjects_();
    // STEP A: 生徒による新規登録は5科目すべて必須（UX用チェック、正本はサーバー側
    // validateStudentNewScoreInput_）。0点は入力済みとして扱う（=== ''のみ未入力判定）。
    var hasMissing = SUBJECT_KEYS.some(function (key) { return subjects[key] === ''; });
    if (hasMissing) {
      showMessage('scoreMessage', '', '5科目すべての点数を入力してください。');
      return;
    }
    var invalid = SUBJECT_KEYS.some(function (key) {
      return subjects[key] !== '' && (isNaN(Number(subjects[key])) || Number(subjects[key]) < 0);
    });
    if (invalid) {
      showMessage('scoreMessage', '', '点数は0以上の数値で入力してください。');
      return;
    }

    var ranks = collectRanks_();
    var invalidRank = RANK_FIELDS.some(function (f) {
      var v = ranks[f.key];
      if (v === '') return false;
      var n = Number(v);
      return isNaN(n) || !isFinite(n) || !Number.isInteger(n) || n <= 0;
    });
    if (invalidRank) {
      showMessage('scoreMessage', '', '学年順位は1以上の整数で入力してください（分からない教科は空欄のままでOKです）。');
      return;
    }
    showMessage('scoreMessage', '', '');

    state.pendingSubjects = subjects;
    state.pendingRanks = ranks;
    var total = 0;
    document.getElementById('c_student').textContent = state.selectedStudent.displayName;
    document.getElementById('c_test').textContent = state.selectedTest.testName;
    SUBJECT_KEYS.forEach(function (key) {
      var value = subjects[key];
      document.getElementById('c_' + key).textContent = value === '' ? '（未入力）' : value + '点';
      if (value !== '') total += Number(value);
    });
    document.getElementById('c_total').textContent = total + '点';

    // 順位は「1つ以上入力されている場合だけ」セクションごと表示し、入力された項目だけを並べる
    // （未入力の項目まで「未入力」と表示して確認画面を無駄に長くしない）。
    var rankRows = document.getElementById('c_rankRows');
    rankRows.innerHTML = '';
    var hasAnyRank = false;
    RANK_FIELDS.forEach(function (f) {
      var value = ranks[f.key];
      if (value === '') return;
      hasAnyRank = true;
      var row = document.createElement('div');
      row.className = 'summary-row';
      var labelSpan = document.createElement('span');
      labelSpan.textContent = f.label;
      var valueSpan = document.createElement('span');
      valueSpan.textContent = value + '位';
      row.appendChild(labelSpan);
      row.appendChild(valueSpan);
      rankRows.appendChild(row);
    });
    document.getElementById('c_rankSection').style.display = hasAnyRank ? 'block' : 'none';

    showMessage('confirmMessage', '', '');
    goToStep('confirm');
  }

  // ===== Step 5: 確認・送信 =====

  function submitScore() {
    var subjects = state.pendingSubjects;
    var ranks = state.pendingRanks || {};
    var btn = document.getElementById('submitScoreBtn');
    btn.disabled = true;
    showMessage('confirmMessage', 'info', '登録中…');

    var payload = {
      studentId: state.selectedStudent.studentId,
      testId: state.selectedTest.testId,
      english: subjects.english,
      math: subjects.math,
      science: subjects.science,
      social: subjects.social,
      japanese: subjects.japanese,
      englishRank: ranks.englishRank,
      mathRank: ranks.mathRank,
      scienceRank: ranks.scienceRank,
      socialRank: ranks.socialRank,
      japaneseRank: ranks.japaneseRank,
      totalRank: ranks.totalRank
    };

    ScoreApi.post('submitStudentScore', payload).then(function (result) {
      btn.disabled = false;
      if (!result.ok) {
        // 失敗時は完了画面へ進まない（期限切れ・重複・存在しない生徒・active=false・
        // test不存在・点数validation・通信失敗のいずれも確認画面に留まって再操作を促す）。
        showMessage('confirmMessage', '', result.error + '\n直し方が分からない場合は先生に伝えてください。');
        return;
      }

      var doneStudentName = state.selectedStudent.displayName;
      var doneTestName = state.selectedTest.testName;
      document.getElementById('doneStudent').textContent = doneStudentName;
      document.getElementById('doneTest').textContent = doneTestName;
      renderDoneFeedback_(result.feedback);
      renderDoneRelativeGrowth_(result.relativeGrowth);

      // 共用タブレットのため、保存成功後は生徒に関する状態を完全にクリアする。
      resetStudentDependentState_();
      state.selectedStudent = null;
      goToStep('done');
    });
  }

  // Phase 2A: 事実として確認できるプラスの成長だけを表示する（サーバー側で positive only
  // に絞り込み済みのfeedback配列をそのまま描画するだけ。0件なら何も追加表示しない＝
  // 完了メッセージのみになる。DOWN・平均比較・順位等は元々配列に含まれない）。
  // Phase 2D STEP 3: 完了画面(doneFeedback)と結果詳細画面(historyFeedback)の両方から
  // 同じ表示ロジックを使うため、描画先のcontainerIdだけを引数化した共通helperへ抽出した
  // （feedback selectionロジック自体はサーバー側のまま、ここではコピーしていない）。
  function renderFeedbackList_(containerId, feedback) {
    var container = document.getElementById(containerId);
    container.innerHTML = '';
    (feedback || []).forEach(function (item) {
      var el = document.createElement('div');
      el.className = 'feedback-item';
      el.textContent = item.text;
      container.appendChild(el);
    });
  }

  function renderDoneFeedback_(feedback) {
    renderFeedbackList_('doneFeedback', feedback);
  }

  // Phase 2C: 学年平均との相対成長（参考情報）。Phase 2Aのfeedbackとは完全に独立した
  // ブロックとして扱い、片方が0件・欠損でももう片方の表示には一切影響させない。
  // relativeGrowthはundefined/null（旧production@28・内部エラー時のfallback）の場合が
  // あり得るため、その場合と「比較可能な項目が1つもない場合」の両方でブロックごと非表示にする
  // （Phase 2Aの「0件なら何も追加表示しない」という既存方針をそのまま踏襲する。
  // 比較不能はネガティブな情報ではなく単に「まだ判断材料がない」だけなので、
  // その旨を説明するメッセージも出さない）。
  // Phase 2D STEP 3: 完了画面(doneRelativeGrowth)と結果詳細画面(historyRelativeGrowth)の
  // 両方から同じ表示ロジックを使うため、描画先のcontainerId/itemsContainerIdだけを引数化した
  // 共通helperへ抽出した（collectRelativeGrowthLines_・formatRelativeGrowthDiff_という
  // Phase 2Cの解釈ロジック自体は一切変更・複製せず、そのまま呼ぶだけ）。
  function renderRelativeGrowthList_(containerId, itemsContainerId, relativeGrowth) {
    var container = document.getElementById(containerId);
    var itemsContainer = document.getElementById(itemsContainerId);
    itemsContainer.innerHTML = '';

    var lines = collectRelativeGrowthLines_(relativeGrowth);
    if (!lines.length) {
      container.hidden = true;
      return;
    }
    lines.forEach(function (text) {
      var el = document.createElement('div');
      el.className = 'relative-growth-item';
      el.textContent = text; // XSS対策: 必ずtextContentを使う（innerHTML化しない）
      itemsContainer.appendChild(el);
    });
    container.hidden = false;
  }

  function renderDoneRelativeGrowth_(relativeGrowth) {
    renderRelativeGrowthList_('doneRelativeGrowth', 'doneRelativeGrowthItems', relativeGrowth);
  }

  // comparable:trueの項目（5教科合計・各科目）だけを表示対象として文字列化する。
  // ランキング・偏差値・順位には一切触れず、「学年平均との差が前回からどれだけ変化したか」
  // という数値（difference_change）のみを、悪化/下がった等の断定的な言葉を使わずに示す。
  // STEP RG-2: 「今回本人点と今回平均との差」(current_gap)を第一に表示する。前回データが
  // 欠損していても今回分の比較までは消さない（current_comparable===trueの行は必ず表示する）。
  // 前回との推移(gapChange/difference_change)は、前回も含めて比較可能(comparable===true)な
  // 場合だけ追加で括弧書きする。T0006本人点とT0002平均のような異なるテスト同士の比較や、
  // student_masterの現在学年による過去の無条件補完は、サーバー側(ScoreRelativeGrowthService.gs)
  // が一切行わない設計のため、ここでも行わない（取得したcurrent_gap/difference_changeを
  // そのまま文言化するだけ）。
  function collectRelativeGrowthLines_(relativeGrowth) {
    if (!relativeGrowth || typeof relativeGrowth !== 'object') return [];
    var lines = [];
    function pushLine(label, fact) {
      if (!fact || fact.current_comparable !== true) return; // current比較不可の行は表示しない
      // UI-AVG-1: 平均点を上回っている場合だけ表示する（同点・未満は非表示、代替文言も出さない）。
      // 表示文言(formatRelativeGrowthGap_)と同じ丸め処理(formatMagnitude_)で判定することで、
      // 「丸めると同点扱いになる値」が「学年平均と同じ」という文言で表示されてしまう事故を防ぐ
      // （表示の可否と表示文言の基準を一致させる）。
      if (typeof fact.current_gap !== 'number' || !isFinite(fact.current_gap)) return;
      if (formatMagnitude_(fact.current_gap).rounded <= 0) return;
      var text = label + '：' + formatRelativeGrowthGap_(fact.current_gap);
      if (fact.comparable === true) {
        text += '（' + formatRelativeGrowthChange_(fact.difference_change) + '）';
      }
      lines.push(text);
    }
    pushLine('5教科合計', relativeGrowth.five_subject);
    var subjects = relativeGrowth.subjects;
    if (subjects) {
      SUBJECT_KEYS.forEach(function (key) { pushLine(SUBJECT_LABELS_[key], subjects[key]); });
    }
    return lines;
  }

  // 小数第1位までに丸め、末尾の".0"を除去した絶対値の文字列表現と符号を返す共通helper。
  // ±0.05未満は0扱い（誤差吸収）。current_gap/difference_changeはサーバー側の設計上
  // NaN/Infinityにならないが、万一の異常値でも画面を壊さないよう呼び出し側で防御する。
  function formatMagnitude_(value) {
    var rounded = Math.round(value * 10) / 10;
    if (Math.abs(rounded) < 0.05) rounded = 0;
    return { rounded: rounded, text: Math.abs(rounded).toFixed(1).replace(/\.0$/, '') };
  }

  // 今回本人点と今回平均との差（current_gap）の文言。正なら「学年平均よりX点上」、
  // 負なら「学年平均よりX点下」、0なら「学年平均と同じ」。
  function formatRelativeGrowthGap_(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '学年平均と同じ';
    var m = formatMagnitude_(value);
    if (m.rounded === 0) return '学年平均と同じ';
    return '学年平均より' + m.text + '点' + (m.rounded > 0 ? '上' : '下');
  }

  // 前回との推移（difference_change）の文言。正はUP、負はDOWN、0は変化なし。
  function formatRelativeGrowthChange_(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '前回より変化なし';
    var m = formatMagnitude_(value);
    if (m.rounded === 0) return '前回より変化なし';
    return '前回より' + m.text + '点' + (m.rounded > 0 ? 'UP' : 'DOWN');
  }

  // ===== Phase 2D STEP 3: これまでの結果を見る（後日フィードバック） =====
  // 通常点数入力（生徒検索→テスト選択→点数入力→確認→保存）とは別画面・別stateとして扱う。
  // 本人確認画面は挟まない（Phase 2D STEP 1/2確定仕様どおり、氏名検索→生徒選択という
  // 既存Publicアプリのセキュリティ境界のまま）。Phase 2A/2Cの計算ロジックは一切複製せず、
  // 既存GET API（getScoreHistory/getScoreFeedback/getRelativeGrowth）が返した結果を
  // そのまま表示するだけに徹する。

  function showScoreHistory() {
    document.getElementById('historyStudentLabel').textContent = state.selectedStudent.displayName + ' さん';
    showMessage('historyMessage', 'info', '読み込み中…');
    document.getElementById('historyList').innerHTML = '';
    var studentId = state.selectedStudent.studentId;
    ScoreApi.get('getScoreHistory', { studentId: studentId }).then(function (result) {
      // 取得結果が返ってくる前に生徒が切り替わっていたら、古い結果を反映しない。
      if (!state.selectedStudent || state.selectedStudent.studentId !== studentId) return;
      if (!result.ok) {
        showMessage('historyMessage', '', result.error);
        return;
      }
      showMessage('historyMessage', '', '');
      // APIが返した順序をそのまま使う（Public側で独自ソートしない、入塾前点数も
      // 特別扱いせず通常の履歴項目としてそのまま並べる）。
      state.scoreHistory = result.history;
      renderScoreHistoryList_();
      goToStep('score-history');
    });
  }

  function renderScoreHistoryList_() {
    var container = document.getElementById('historyList');
    container.innerHTML = '';
    if (!state.scoreHistory.length) {
      container.textContent = 'まだ登録された結果はありません。';
      return;
    }
    state.scoreHistory.forEach(function (entry) {
      var item = document.createElement('div');
      item.className = 'tap-item';
      // five_subject_totalがnullの場合（5教科揃っていない）は合計を表示しない。
      item.textContent = (typeof entry.five_subject_total === 'number')
        ? entry.test_name + '（5教科合計：' + entry.five_subject_total + '点）'
        : entry.test_name;
      item.onclick = function () { selectHistoryEntry_(entry); };
      container.appendChild(item);
    });
  }

  // 0点は"0点"、null/未入力は"—"（0点扱いにしない）。科目・5教科合計の両方で使う共通format。
  function formatHistoryPointValue_(value) {
    return (typeof value === 'number') ? String(value) + '点' : '—';
  }

  // 基本点数は履歴一覧の取得結果からそのまま即時表示する（追加APIを呼ばない）。
  // Phase 2A feedback / Phase 2C relative growthは、この後で独立して追加取得する
  // （片方が失敗しても基本点数の表示は消さない。Gate H方針）。
  function selectHistoryEntry_(entry) {
    state.selectedHistoryEntry = entry;
    clearHistoryDetailDisplay_();

    document.getElementById('hd_test').textContent = entry.test_name;
    SUBJECT_KEYS.forEach(function (key) {
      document.getElementById('hd_' + key).textContent = formatHistoryPointValue_(entry[key]);
    });
    document.getElementById('hd_total').textContent = formatHistoryPointValue_(entry.five_subject_total);
    fillHistoryRankInputs_(entry);
    showMessage('hdRankMessage', '', '');

    goToStep('score-history-detail');
    fetchHistoryFeedback_(entry.test_id);
    fetchHistoryRelativeGrowth_(entry.test_id);
  }

  // STEP B: 既存順位があれば現在値を入力欄へ、未登録(null)なら空欄にする。
  function fillHistoryRankInputs_(entry) {
    HISTORY_RANK_FIELDS.forEach(function (f) {
      var value = entry[f.snakeKey];
      document.getElementById(f.id).value = (typeof value === 'number') ? String(value) : '';
    });
  }

  // Phase 2A feedbackの後日取得。renderDoneFeedback_と同じrenderFeedbackList_を再利用するだけで、
  // feedback selectionロジック自体はサーバー側（buildPositiveScoreFeedback_）のまま。
  // 失敗時はfeedbackブロックを単に空のままにする（完了画面の「0件なら何も追加表示しない」と同じ扱い）。
  function fetchHistoryFeedback_(testId) {
    var studentId = state.selectedStudent.studentId;
    ScoreApi.get('getScoreFeedback', { studentId: studentId, testId: testId }).then(function (result) {
      // 応答が返る前に別の生徒・別のテストへ切り替わっていたら反映しない（stale防止）。
      if (!state.selectedStudent || state.selectedStudent.studentId !== studentId) return;
      if (!state.selectedHistoryEntry || state.selectedHistoryEntry.test_id !== testId) return;
      renderFeedbackList_('historyFeedback', result.ok ? result.feedback : []);
    });
  }

  // Phase 2C relative growthの後日取得。renderDoneRelativeGrowth_と同じrenderRelativeGrowthList_を
  // 再利用するだけで、比較ロジック自体はサーバー側（computeScoreRelativeGrowthFacts_）のまま。
  // 失敗時はrelativeGrowthブロックを非表示のままにする（完了画面のundefined/null時と同じ扱い）。
  function fetchHistoryRelativeGrowth_(testId) {
    var studentId = state.selectedStudent.studentId;
    ScoreApi.get('getRelativeGrowth', { studentId: studentId, testId: testId }).then(function (result) {
      if (!state.selectedStudent || state.selectedStudent.studentId !== studentId) return;
      if (!state.selectedHistoryEntry || state.selectedHistoryEntry.test_id !== testId) return;
      renderRelativeGrowthList_('historyRelativeGrowth', 'historyRelativeGrowthItems', result.ok ? result.relativeGrowth : null);
    });
  }

  // STEP B: 学年順位の後追い入力・訂正の保存。点数5科目は一切再送信しない
  // （payloadに含めない＝サーバー側updateScoreRankも点数列には触れない既存設計）。
  // クライアント側validationはgoToConfirmの順位validationと同じルール（UX用、正本はサーバー側
  // validateRankInput_）。保存中は二重送信防止のためボタンをdisabledにする。
  function saveHistoryRank_() {
    var ranks = {};
    HISTORY_RANK_FIELDS.forEach(function (f) {
      ranks[f.key] = document.getElementById(f.id).value.trim();
    });
    var invalidRank = HISTORY_RANK_FIELDS.some(function (f) {
      var v = ranks[f.key];
      if (v === '') return false;
      var n = Number(v);
      return isNaN(n) || !isFinite(n) || !Number.isInteger(n) || n <= 0;
    });
    if (invalidRank) {
      showMessage('hdRankMessage', '', '学年順位は1以上の整数で入力してください（分からない教科は空欄のままでOKです）。');
      return;
    }

    var studentId = state.selectedStudent.studentId;
    var testId = state.selectedHistoryEntry.test_id;
    var btn = document.getElementById('saveHistoryRankBtn');
    btn.disabled = true;
    showMessage('hdRankMessage', 'info', '保存中…');

    var payload = {
      studentId: studentId,
      testId: testId,
      englishRank: ranks.englishRank,
      mathRank: ranks.mathRank,
      scienceRank: ranks.scienceRank,
      socialRank: ranks.socialRank,
      japaneseRank: ranks.japaneseRank,
      totalRank: ranks.totalRank
    };

    ScoreApi.post('saveScoreRank', payload).then(function (result) {
      btn.disabled = false;
      // 応答が返る前に別の生徒・別のテストへ切り替わっていたら反映しない（fetchHistoryFeedback_等と同じstale防止）。
      if (!state.selectedStudent || state.selectedStudent.studentId !== studentId) return;
      if (!state.selectedHistoryEntry || state.selectedHistoryEntry.test_id !== testId) return;

      if (!result.ok) {
        showMessage('hdRankMessage', '', result.error + '\n直し方が分からない場合は先生に伝えてください。');
        return;
      }

      // 保存成功後、サーバーが返した最新値(result.history)を正本として画面・stateへ反映する
      // （O-1/O-2で起きた「保存後に再取得されず古い表示が残る」問題の再発を防ぐため、
      // 別途GETし直すのではなく、この保存レスポンス自体を正本として使う設計）。
      // feedback/relative growthブロックには一切触れない（不必要に消したり再取得しない）。
      state.selectedHistoryEntry = result.history;
      var idx = state.scoreHistory.findIndex(function (e) { return e.test_id === testId; });
      if (idx !== -1) state.scoreHistory[idx] = result.history;
      fillHistoryRankInputs_(result.history);
      showMessage('hdRankMessage', 'success', '学年順位を保存しました。');
    });
  }

  function backToTestsFromHistory() {
    // 通常テスト一覧はstateに残っているため再取得しない（backToTestsFromAverageと同じ考え方）。
    renderTestList();
    goToStep('tests');
  }

  function backToScoreHistory() {
    // 取得済みの履歴一覧はstateに残っているため再取得しない（backToAverageTestsと同じ考え方）。
    renderScoreHistoryList_();
    goToStep('score-history');
  }

  // ===== Phase 2B STEP 5: 学年平均入力 =====
  // 通常点数入力（生徒検索→テスト選択→点数入力→確認→保存）とは別state・別画面として扱う。
  // 「学年平均を登録する」ボタン（担当者のみ表示、checkAverageInputMember_参照）から入る。

  function showAverageInputTests() {
    document.getElementById('avgTestsStudentLabel').textContent = state.selectedStudent.displayName + ' さん';
    showMessage('avgTestsMessage', 'info', '読み込み中…');
    document.getElementById('avgTestList').innerHTML = '';
    ScoreApi.get('listAverageInputTests', { studentId: state.selectedStudent.studentId }, window.SCORE_APP_CONFIG.AVERAGE_API_BASE_URL)
      .then(function (result) {
        if (!result.ok) {
          showMessage('avgTestsMessage', '', result.error);
          return;
        }
        showMessage('avgTestsMessage', '', '');
        // 入塾前点数の除外・入力期限の扱いはすべてサーバー(listAverageInputTests)の判断に従う。
        // クライアント側で再度term/deadlineを判定・フィルタしない。
        state.averageAvailableTests = result.tests;
        renderAverageTestList_();
        goToStep('avg-tests');
      });
  }

  function renderAverageTestList_() {
    var container = document.getElementById('avgTestList');
    container.innerHTML = '';
    if (!state.averageAvailableTests.length) {
      container.textContent = '現在、学年平均を登録できるテストはありません。';
      return;
    }
    state.averageAvailableTests.forEach(function (t) {
      var item = document.createElement('div');
      item.className = 'tap-item';
      item.textContent = t.testName;
      item.onclick = function () { selectAverageTest_(t); };
      container.appendChild(item);
    });
  }

  // テストを選ぶと、既存の学年平均(getSchoolGradeAverage)を取得してフォームへ初期表示する。
  // これにより同じ画面でCREATE（未登録→新規入力）とUPDATE（既存値を修正）の両方を扱える。
  // 既存平均の取得に失敗しても空欄のまま入力を継続できるようにする（保存自体は妨げない）。
  function selectAverageTest_(t) {
    state.averageSelectedTest = t;
    // STEP C: 取得前はnull(=「まだレコードが存在しないはず」)にしておく。取得が失敗した場合
    // もnullのままとなり、保存時にサーバー側がそれを基準に競合判定する（実際に既存レコードが
    // あればCONFLICTとして安全側に拒否される。無言の上書きより安全なfail-safe）。
    state.averageExpectedUpdatedAt = null;
    document.getElementById('avgFormLabel').textContent = t.testName;
    SUBJECT_KEYS.forEach(function (key) {
      document.getElementById('avg_' + key).value = '';
    });
    showMessage('avgFormMessage', 'info', '既存の平均を確認中…');
    goToStep('avg-form');

    ScoreApi.get('getSchoolGradeAverage', { studentId: state.selectedStudent.studentId, testId: t.testId }, window.SCORE_APP_CONFIG.AVERAGE_API_BASE_URL)
      .then(function (result) {
        // 取得結果が返ってくる前に選択テストが切り替わっていたら反映しない。
        if (!state.averageSelectedTest || state.averageSelectedTest.testId !== t.testId) return;
        showMessage('avgFormMessage', '', '');
        if (!result.ok || !result.average) return; // 未登録、または取得失敗時は空欄のまま(expectedUpdatedAtもnullのまま)
        var avg = result.average;
        state.averageExpectedUpdatedAt = avg.updated_at;
        SUBJECT_KEYS.forEach(function (key) {
          // サーバーはnull(未登録科目)または数値を返す。nullを"0"等へ変換しない。
          var value = avg[key];
          document.getElementById('avg_' + key).value = (typeof value === 'number') ? String(value) : '';
        });
      });
  }

  function collectAverageSubjects_() {
    var subjects = {};
    SUBJECT_KEYS.forEach(function (key) {
      subjects[key] = document.getElementById('avg_' + key).value.trim();
    });
    return subjects;
  }

  // クライアント側validationはUX用のみ。正本はGAS側のvalidateAverageInput_
  // （全空欄拒否・非数値拒否・負数拒否・NaN/Infinity拒否）。上限は追加しない（既存点数入力と同じ方針）。
  // 空欄("")はここで一切Number()化しない。"" のまま送信し、サーバー側でnull/0を区別させる
  // （Number("")===0という罠を避けるため、クライアントは文字列のまま持ち回るだけに徹する）。
  function goToAverageConfirm() {
    var subjects = collectAverageSubjects_();
    var hasAny = SUBJECT_KEYS.some(function (key) { return subjects[key] !== ''; });
    if (!hasAny) {
      showMessage('avgFormMessage', '', '少なくとも1教科の平均点を入力してください。');
      return;
    }
    var invalid = SUBJECT_KEYS.some(function (key) {
      return subjects[key] !== '' && (isNaN(Number(subjects[key])) || Number(subjects[key]) < 0);
    });
    if (invalid) {
      showMessage('avgFormMessage', '', '平均点は0以上の数値で入力してください。');
      return;
    }
    showMessage('avgFormMessage', '', '');

    state.averagePendingSubjects = subjects;
    document.getElementById('avgc_test').textContent = state.averageSelectedTest.testName;
    SUBJECT_KEYS.forEach(function (key) {
      var value = subjects[key];
      document.getElementById('avgc_' + key).textContent = value === '' ? '（未入力）' : value + '点';
    });
    // five_subject_totalは保存値ではなく派生値のため、部分入力時に合計を作って表示しない
    // （STEP 5では確認画面に合計行を設けない）。
    showMessage('avgConfirmMessage', '', '');
    goToStep('avg-confirm');
  }

  function saveAverageScore() {
    var subjects = state.averagePendingSubjects;
    var btn = document.getElementById('submitAverageBtn');
    btn.disabled = true;
    showMessage('avgConfirmMessage', 'info', '登録中…');

    // 保存先の特定はstudentId+testIdのみ。school_id/gradeはクライアントから送らない
    // （サーバー側でstudentIdから毎回再解決する設計、AverageInputService.gs参照）。
    // STEP C: expectedUpdatedAtを必ず含める(nullも明示的に送る)。複数の平均点担当者が
    // 同時に同じschool×grade×testを編集しても、古い画面からの保存が無言で最新値を
    // 上書きしないようにするための楽観的ロック。
    var payload = {
      studentId: state.selectedStudent.studentId,
      testId: state.averageSelectedTest.testId,
      english: subjects.english,
      math: subjects.math,
      science: subjects.science,
      social: subjects.social,
      japanese: subjects.japanese,
      expectedUpdatedAt: state.averageExpectedUpdatedAt
    };

    ScoreApi.post('saveSchoolGradeAverage', payload, window.SCORE_APP_CONFIG.AVERAGE_API_BASE_URL).then(function (result) {
      btn.disabled = false;
      if (!result.ok) {
        // STEP C: 競合(CONFLICT)の場合は、古い値のまま突き進ませず最新データを自動で
        // 読み直す（selectAverageTest_を再利用し、expectedUpdatedAtも最新化される）。
        // ユーザーは入力画面に戻り、最新値を確認してから編集・保存し直す。
        if (result.errorCode === 'CONFLICT') {
          showMessage('avgConfirmMessage', '', result.error);
          selectAverageTest_(state.averageSelectedTest);
          return;
        }
        // それ以外の失敗（権限なし・対象外テスト・validation失敗・通信失敗）は既存どおり
        // 確認画面に留まって再操作を促す（通常点数入力のsubmitScoreと同じ方針）。
        showMessage('avgConfirmMessage', '', result.error + '\n直し方が分からない場合は先生に伝えてください。');
        return;
      }

      document.getElementById('avgDoneTest').textContent = state.averageSelectedTest.testName;
      // 通常点数入力の保存成功時と同じく、共用タブレットのため生徒に関する状態を完全にクリアする
      // （resetStudentDependentState_が平均入力state自体も併せてクリアする）。
      resetStudentDependentState_();
      state.selectedStudent = null;
      goToStep('avg-done');
    });
  }

  function backToTestsFromAverage() {
    // 通常テスト一覧はstateに残っているため再取得しない（backToTestsと同じ考え方）。
    renderTestList();
    goToStep('tests');
  }

  function backToAverageTests() {
    renderAverageTestList_();
    goToStep('avg-tests');
  }

  function backToAverageForm() {
    // 入力欄の値には触れない（修正時に再入力を不要にするため、backToScoreと同じ方針）。
    goToStep('avg-form');
  }

  // ===== 戻る操作 =====

  function backToSearch() {
    resetStudentDependentState_();
    state.selectedStudent = null;
    goToStep('search');
  }

  function backToTests() {
    // 認証済み・取得済みのテスト一覧はstateに残っているため再取得しない。
    renderTestList();
    goToStep('tests');
  }

  function backToScore() {
    // 入力欄の値には触れない（修正時に点数の再入力を不要にするため）。
    goToStep('score');
  }

  function resetAll() {
    resetStudentDependentState_();
    state.selectedStudent = null;
    document.getElementById('studentSearch').value = '';
    document.getElementById('studentList').innerHTML = '';
    SUBJECT_KEYS.forEach(function (key) { document.getElementById('s_' + key).value = ''; });
    // Phase 2C: 次の生徒の完了画面に前の生徒の相対成長表示が一瞬でも残らないよう、
    // 明示的にクリアする（次回submitScore成功時にrenderDoneRelativeGrowth_で必ず
    // 上書きされるため必須ではないが、Phase 2Aのdoneフィードバックと同様に防御的に行う）。
    document.getElementById('doneRelativeGrowthItems').innerHTML = '';
    document.getElementById('doneRelativeGrowth').hidden = true;
    // Phase 2D STEP 3: 次の生徒の履歴画面に前の生徒の結果が一瞬でも残らないよう、
    // 明示的にクリアする（resetStudentDependentState_で既にstate/DOMともクリア済みだが、
    // Phase 2Aと同様に防御的に行う）。
    document.getElementById('historyList').innerHTML = '';
    goToStep('search');
  }

  // PERF-3B: ページ読み込み直後に、Spreadsheetへ一切アクセスしない軽量なping action
  // （PublicApi.gsのhandleGetPing_）を1回投げ、ユーザーが生徒検索欄へ入力を始める前に
  // GAS Web Appのcold start分を先取りする。結果は一切使わない(fire-and-forget)。
  // ScoreApi.getは内部でfetch失敗もok:falseへ正規化し例外を投げないため、ここでも
  // .catch等は不要（失敗してもUIには一切影響しない）。
  function warmUpApi_() {
    ScoreApi.get('ping', {});
  }

  applyScoreInputRange_();
  warmUpApi_();

  window.ScoreAppUi = {
    onStudentSearchInput: onStudentSearchInput,
    goToConfirm: goToConfirm,
    submitScore: submitScore,
    backToSearch: backToSearch,
    backToTests: backToTests,
    backToScore: backToScore,
    resetAll: resetAll,
    // Phase 2B STEP 5: 学年平均入力
    showAverageInputTests: showAverageInputTests,
    goToAverageConfirm: goToAverageConfirm,
    saveAverageScore: saveAverageScore,
    backToTestsFromAverage: backToTestsFromAverage,
    backToAverageTests: backToAverageTests,
    backToAverageForm: backToAverageForm,
    // Phase 2D STEP 3: これまでの結果を見る
    showScoreHistory: showScoreHistory,
    backToTestsFromHistory: backToTestsFromHistory,
    backToScoreHistory: backToScoreHistory,
    // STEP B: 学年順位の後追い入力
    saveHistoryRank: saveHistoryRank_
  };
})();
