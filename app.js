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
    // Phase 2B STEP 5: 学年平均入力用のstate。通常点数入力state（上記4項目）とは
    // 完全に分離し、混線させない（通常フローのロジックはこれらを一切参照しない）。
    isAverageMember: false,
    averageAvailableTests: [],
    averageSelectedTest: null, // {testId, testName}
    averagePendingSubjects: null,
    // Phase 2D STEP 3: 後日フィードバック（これまでの結果を見る）用のstate。
    // 通常点数入力state・学年平均入力stateとは完全に分離し、混線させない。
    scoreHistory: [],
    selectedHistoryEntry: null // getScoreHistoryの1件（{test_id, test_name, japanese, math, english, science, social, five_subject_total}）
  };

  var searchTimer = null;

  function resetStudentDependentState_() {
    // 生徒を選び直したときに、前の生徒のテスト一覧・入力途中の点数を必ずクリアする
    // （共用タブレットのため、次の生徒へ前の生徒の情報を引き継がない）。
    state.availableTests = [];
    state.selectedTest = null;
    state.pendingSubjects = null;
    // Phase 2B STEP 5: 担当者判定・平均入力の状態も同じ理由で必ずクリアする。
    state.isAverageMember = false;
    state.averageAvailableTests = [];
    state.averageSelectedTest = null;
    state.averagePendingSubjects = null;
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
        if (!result.ok) {
          container.textContent = result.error;
          return;
        }
        renderStudentList(result.students);
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

  function loadAvailableTests() {
    showMessage('testsMessage', 'info', '読み込み中…');
    ScoreApi.get('listAvailableTests', { studentId: state.selectedStudent.studentId }).then(function (result) {
      if (!result.ok) {
        showMessage('testsMessage', '', result.error);
        return;
      }
      showMessage('testsMessage', '', '');
      state.availableTests = result.tests;
      renderTestList();
      goToStep('tests');
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

  // クライアント側validationはUX用（早期に気づかせるためだけ）であり、正本はGAS側の
  // validateScoreInput_（全空欄拒否・非数値拒否・負数拒否）。100点超はここでも拒否しない
  // （既存の意図的仕様、配点が異なるテストに対応するため）。
  function goToConfirm() {
    var subjects = collectSubjects_();
    var hasAny = SUBJECT_KEYS.some(function (key) { return subjects[key] !== ''; });
    if (!hasAny) {
      showMessage('scoreMessage', '', '教科の点数を少なくとも1つ入力してください。');
      return;
    }
    var invalid = SUBJECT_KEYS.some(function (key) {
      return subjects[key] !== '' && (isNaN(Number(subjects[key])) || Number(subjects[key]) < 0);
    });
    if (invalid) {
      showMessage('scoreMessage', '', '点数は0以上の数値で入力してください。');
      return;
    }
    showMessage('scoreMessage', '', '');

    state.pendingSubjects = subjects;
    var total = 0;
    document.getElementById('c_student').textContent = state.selectedStudent.displayName;
    document.getElementById('c_test').textContent = state.selectedTest.testName;
    SUBJECT_KEYS.forEach(function (key) {
      var value = subjects[key];
      document.getElementById('c_' + key).textContent = value === '' ? '（未入力）' : value + '点';
      if (value !== '') total += Number(value);
    });
    document.getElementById('c_total').textContent = total + '点';
    showMessage('confirmMessage', '', '');
    goToStep('confirm');
  }

  // ===== Step 5: 確認・送信 =====

  function submitScore() {
    var subjects = state.pendingSubjects;
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
      japanese: subjects.japanese
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
  function collectRelativeGrowthLines_(relativeGrowth) {
    if (!relativeGrowth || typeof relativeGrowth !== 'object') return [];
    var lines = [];
    if (relativeGrowth.five_subject && relativeGrowth.five_subject.comparable === true) {
      lines.push('5教科合計：学年平均との差の変化 ' + formatRelativeGrowthDiff_(relativeGrowth.five_subject.difference_change) + '点');
    }
    var subjects = relativeGrowth.subjects;
    if (subjects) {
      SUBJECT_KEYS.forEach(function (key) {
        var subject = subjects[key];
        if (subject && subject.comparable === true) {
          lines.push(SUBJECT_LABELS_[key] + '：学年平均との差の変化 ' + formatRelativeGrowthDiff_(subject.difference_change) + '点');
        }
      });
    }
    return lines;
  }

  // 符号付き・小数第1位までに丸め、末尾の".0"は取り除く（例: 2.0→"+2", 2.5→"+2.5", -1→"-1"）。
  // difference_changeはサーバー側の設計上NaN/Infinityにならないが、万一の異常値でも
  // 画面を壊さないよう防御的に0扱いする。
  function formatRelativeGrowthDiff_(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '0';
    var rounded = Math.round(value * 10) / 10;
    if (Math.abs(rounded) < 0.05) rounded = 0; // -0表示・誤差吸収
    var text = Math.abs(rounded).toFixed(1).replace(/\.0$/, '');
    if (rounded > 0) return '+' + text;
    if (rounded < 0) return '-' + text;
    return text;
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

    goToStep('score-history-detail');
    fetchHistoryFeedback_(entry.test_id);
    fetchHistoryRelativeGrowth_(entry.test_id);
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
        if (!result.ok || !result.average) return; // 未登録、または取得失敗時は空欄のまま
        var avg = result.average;
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
    var payload = {
      studentId: state.selectedStudent.studentId,
      testId: state.averageSelectedTest.testId,
      english: subjects.english,
      math: subjects.math,
      science: subjects.science,
      social: subjects.social,
      japanese: subjects.japanese
    };

    ScoreApi.post('saveSchoolGradeAverage', payload, window.SCORE_APP_CONFIG.AVERAGE_API_BASE_URL).then(function (result) {
      btn.disabled = false;
      if (!result.ok) {
        // 失敗時は完了画面へ進まない（権限なし・対象外テスト・validation失敗・通信失敗のいずれも
        // 確認画面に留まって再操作を促す。通常点数入力のsubmitScoreと同じ方針）。
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

  applyScoreInputRange_();

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
    backToScoreHistory: backToScoreHistory
  };
})();
