// GAS Web App との通信共通処理。GET / POST(text/plain) の2種類のみを扱う。
// 通信PoC（STEP 1）の実測結果に基づき、POSTはContent-Type: text/plain固定とする
// （application/jsonはCORS preflightで失敗することを実機確認済みのため使用しない）。
// 自動retryは行わない（点数送信時の二重送信リスクを避けるため、STEP 3以降も含めて
// 常にユーザー操作による再試行とする）。
//
// NET-2B: 「通信エラー: レスポンスを解釈できませんでした。」の原因を次回の実機再現で
// 一意に特定できるよう、異常時だけconsole.warnへ診断metadataを出す。正常なJSON response
// （GAS business errorを含む）の場合、呼び出し元へ返る値・経路とも変更前と完全に同じ。
// studentId・氏名・点数・keyword・query string・redirect token・response本文原文は
// 一切ログに出さない（sanitizeUrl_/classifyBody_参照）。requestIdはfrontendローカル限定の
// 識別子で、server送信・Spreadsheet保存・PropertiesService/CacheServiceはいずれも使わない。
//
// NET-2D: NET-2Cで、GAS Web Appのredirect(302→script.googleusercontent.com/macros/echo)が
// 稀にGoogle側インフラ層で約30秒待たされた末に404 HTMLを返す間欠障害を確認した。自アプリの
// GASコードは実行されれば必ずJSONを返す設計のため、この種の異常は常にJSON.parse失敗
// （またはfetch自体の失敗）として観測される。これを踏まえ、GET actionに限り、
// ①一定時間で打ち切るtimeout、②正常なJSONとして解釈できなかった場合に限り元の/exec URLへ
// 1回だけ再試行、を追加する。POSTは submitStudentScore 等の非冪等な保存処理を含むため、
// timeout・retryとも一切適用しない（fetch回数・挙動は変更前と完全に同じ）。
window.ScoreApi = (function () {
  // NET-2D: GET専用の定数。POSTには一切使用しない。
  var GET_TIMEOUT_MS = 12000; // 正常なcold start(実測で最大約5秒程度)に十分な余裕を持たせつつ、
  // 異常時に観測された約30秒よりは大幅に短く打ち切るための値（Gate 4参照、断定的な最適値ではない）。
  var GET_MAX_ATTEMPTS = 2; // 初回+retry 1回のみ。無限retry・exponential backoffは行わない。
  var GET_RETRY_DELAY_MS = 500; // Google側の一時的な障害が一瞬で解消する可能性を考慮した短い待機。

  function baseUrl() {
    return window.SCORE_APP_CONFIG.API_BASE_URL;
  }

  function delay_(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Phase 2B STEP 5: 学年平均入力APIだけscore-api-poc（別deployment）を使うための
  // 追加base URL。既存の呼び出し（baseOverride省略）は引き続きAPI_BASE_URL（production）を使い、
  // 挙動は一切変えない。
  function buildGetUrl(action, params, baseOverride) {
    var url = (baseOverride || baseUrl()) + '?action=' + encodeURIComponent(action);
    Object.keys(params || {}).forEach(function (key) {
      url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    });
    return url;
  }

  // NET-2B: console診断ログを見分けるためだけのローカル識別子。serverへは一切送らない
  // （API payload・query stringのいずれにも含めない）。衝突耐性の強い生成方式は不要なため
  // crypto.randomUUID等には依存しない。
  function generateRequestId_() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // NET-2B: response.urlをそのままログへ出すと、GAS redirect先のuser_content_key等の
  // 使い捨てtokenやquery stringが残ってしまうため、origin+pathnameだけに切り詰める。
  // URL解析自体が失敗しても診断処理が本処理へ影響しないよう、ここで必ず吸収する。
  function sanitizeUrl_(url) {
    try {
      var u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) {
      return 'unknown';
    }
  }

  // NET-2B: response本文の原文はログに出さず、先頭パターンだけで大まかな種別に分類する
  // （本文そのものを引数に取るが、戻り値は分類名のみで本文自体は呼び出し元へ返さない）。
  function classifyBody_(text) {
    var trimmed = (text || '').trim();
    if (!trimmed) return 'empty';
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') return 'json_like';
    if (/^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed)) return 'html_like';
    return 'text';
  }

  // NET-2B: 異常時だけconsole.warnへ構造化objectを1件出す（正常通信ではログせず、
  // 本番運用のconsoleを汚染しない）。診断処理自体が例外を投げても本来のAPI処理を
  // 壊さないよう、必ずtry/catchで囲む。ここに含めてよいのはaction/method/requestId/
  // timestamp/status/ok/redirected/sanitized URL/Content-Type/bodyLength/bodyKind/
  // jsonParseSuccess/errorStage等のメタ情報のみ。studentId・氏名・点数・keyword・
  // query string・redirect token・response本文原文は絶対に含めない。
  function emitDiagnostic_(info) {
    try {
      if (typeof console === 'undefined' || !console.warn) return;
      console.warn(Object.assign({ type: 'score-api-diagnostic', timestamp: new Date().toISOString() }, info));
    } catch (e) {
      // 診断処理自体の失敗で本来のresponse処理を壊さない。
    }
  }

  // NET-2D: ctx.attempt/maxAttemptsが設定されているGET経路のときだけ、retry判定用の
  // willRetry/retryReasonを診断へ付与する。POST(attemptを渡さない)では常に{}のままとなり、
  // 診断payloadの形を一切変えない。
  function retryDiagFields_(ctx, shouldRetry, reason) {
    if (typeof ctx.attempt !== 'number' || typeof ctx.maxAttempts !== 'number') return {};
    return { willRetry: !!(shouldRetry && ctx.attempt < ctx.maxAttempts), retryReason: reason };
  }

  // fetchの結果をGAS APIの{ok, ...}契約に正規化する。
  // ネットワーク到達失敗（CORS含む）とGAS側のok:falseを区別して呼び出し元へ返す。
  // ctx: { requestId, action, method, attempt?, maxAttempts?, timeoutMs? }（診断ログ専用。
  // 呼び出し元への返却値には一切混ぜない）。
  // retryOpts: { classify: true } のときだけ { result, retryInfo } を返す（GET retry判定専用）。
  // 省略時（postからの呼び出しを含む既存の全呼び出し）は従来どおりresultそのものを返す
  // ＝post()の挙動・戻り値は一切変更しない。
  function normalizeResult_(promise, ctx, retryOpts) {
    ctx = ctx || {};
    var wantRetryInfo = !!(retryOpts && retryOpts.classify);
    function finish(result, shouldRetry, reason) {
      return wantRetryInfo ? { result: result, retryInfo: { shouldRetry: !!shouldRetry, reason: reason } } : result;
    }
    return promise
      .then(function (res) {
        var status, ok, redirected;
        try { status = res.status; ok = res.ok; redirected = res.redirected; } catch (e) { /* 取得できなくても本処理は続行する */ }
        var contentType = null;
        try { contentType = (res.headers && res.headers.get) ? res.headers.get('content-type') : null; } catch (e) { contentType = null; }
        var sanitizedUrl = sanitizeUrl_(res.url);

        return res.text().then(function (text) {
          var bodyLength = text ? text.length : 0;
          var bodyKind = classifyBody_(text);
          var parsed;
          try {
            parsed = JSON.parse(text);
          } catch (e) {
            emitDiagnostic_(Object.assign({}, ctx, {
              status: status, ok: ok, redirected: redirected, url: sanitizedUrl, contentType: contentType,
              bodyLength: bodyLength, bodyKind: bodyKind, jsonParseSuccess: false,
              errorStage: 'parse_json', parseErrorName: e && e.name
            }, retryDiagFields_(ctx, true, 'parse_json')));
            return finish({ ok: false, error: '通信エラー: レスポンスを解釈できませんでした。' }, true, 'parse_json');
          }
          // NET-2A: JSON.parseには成功するがokフィールドが無い等、期待schemaと異なる場合が
          // ある。既存の返却object(parsed)は一切変更せず、診断としてのみ検知する。
          // NET-2D: schemaUnexpectedはGoogleインフラ障害ではなくAPI契約異常の可能性が高いため、
          // retry対象にはしない（Gate 7の方針どおり）。
          if (!parsed || typeof parsed.ok !== 'boolean') {
            emitDiagnostic_(Object.assign({}, ctx, {
              status: status, ok: ok, redirected: redirected, url: sanitizedUrl, contentType: contentType,
              bodyLength: bodyLength, bodyKind: bodyKind, jsonParseSuccess: true,
              errorStage: 'schema', schemaUnexpected: true
            }, retryDiagFields_(ctx, false, 'schema')));
            return finish(parsed, false, 'schema');
          }
          // NET-2D: HTTP status(4xx/5xx含む)に関わらず、正常にparseできたJSON business response
          // はそのまま返しretryしない（Gate 7の方針どおり、既存business response処理を壊さない）。
          return finish(parsed, false, null);
        }, function (bodyErr) {
          emitDiagnostic_(Object.assign({}, ctx, {
            status: status, ok: ok, redirected: redirected, url: sanitizedUrl, contentType: contentType,
            errorStage: 'read_body', errorName: bodyErr && bodyErr.name
          }, retryDiagFields_(ctx, true, 'read_body')));
          return finish({ ok: false, error: '通信エラー: ' + (bodyErr && bodyErr.message ? bodyErr.message : String(bodyErr)) }, true, 'read_body');
        });
      })
      .catch(function (err) {
        // NET-2D: GET専用のtimeout(fetchGetWithTimeout_)がAbortによって投げるTimeoutErrorを、
        // 通常のfetch reject(ネットワーク到達失敗等)と区別して診断へ記録する。POSTはこの
        // timeout機構を一切使わないため、POSTのfetchがTimeoutErrorになることはない。
        var isTimeout = !!(err && err.name === 'TimeoutError');
        var stage = isTimeout ? 'timeout' : 'fetch';
        emitDiagnostic_(Object.assign({}, ctx, { errorStage: stage, errorName: err && err.name }, retryDiagFields_(ctx, true, stage)));
        return finish({ ok: false, error: '通信エラー: ' + (err && err.message ? err.message : String(err)) }, true, stage);
      });
  }

  // NET-2D: GET専用のtimeout付きfetch。AbortControllerが使える環境では実際にrequestを
  // 中断し、timeoutMs経過でTimeoutErrorとしてrejectする。使えない古い環境でもPromise.raceで
  // 上位のtimeout判定だけは機能させる（元のfetch自体は中断できないが、GETはread-onlyのため
  // 裏で継続してもデータ破壊等の実害はない）。POSTには一切使用しない。
  function fetchGetWithTimeout_(url, timeoutMs) {
    if (typeof AbortController !== 'undefined') {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
      return fetch(url, { signal: controller.signal }).then(function (res) {
        clearTimeout(timer);
        return res;
      }, function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') {
          var timeoutErr = new Error('timeout');
          timeoutErr.name = 'TimeoutError';
          throw timeoutErr;
        }
        throw err;
      });
    }
    // AbortController未対応環境向けのfallback。
    var timer2;
    var timeoutPromise = new Promise(function (_, reject) {
      timer2 = setTimeout(function () {
        var timeoutErr = new Error('timeout');
        timeoutErr.name = 'TimeoutError';
        reject(timeoutErr);
      }, timeoutMs);
    });
    var fetchPromise = fetch(url);
    fetchPromise.catch(function () {}); // race敗北後に遅れて解決/拒否されても未処理rejectionにしない
    return Promise.race([fetchPromise, timeoutPromise]).then(function (res) {
      clearTimeout(timer2);
      return res;
    }, function (err) {
      clearTimeout(timer2);
      throw err;
    });
  }

  // NET-2D: GET限定のtimeout+最大1回retryのオーケストレーション。retryは必ず同じurl
  // （常に元のAPI_BASE_URL/exec、引数で渡された時点で固定済み）へ新しいfetchを送る。
  // 302で得られるgoogleusercontent.com/macros/echoのredirect URLを直接再利用することは
  // 構造上あり得ない（res.urlは診断ログのsanitize用にしか使っていない）。
  function performGetWithRetry_(action, url, requestId) {
    function attempt(n) {
      var ctx = { requestId: requestId, action: action, method: 'GET', attempt: n, maxAttempts: GET_MAX_ATTEMPTS, timeoutMs: GET_TIMEOUT_MS };
      return normalizeResult_(fetchGetWithTimeout_(url, GET_TIMEOUT_MS), ctx, { classify: true }).then(function (outcome) {
        if (outcome.retryInfo.shouldRetry && n < GET_MAX_ATTEMPTS) {
          return delay_(GET_RETRY_DELAY_MS).then(function () { return attempt(n + 1); });
        }
        return outcome.result;
      });
    }
    return attempt(1);
  }

  // 匿名fetch。credentialsは明示的に送らない（Googleログイン状態に依存しないことを
  // 通信PoCで確認済みの構成を維持するため）。redirectもbrowser標準挙動のまま。
  // baseOverrideは省略可（省略時は既存どおりAPI_BASE_URL/productionを使う）。
  // NET-2D: GETはtimeout(GET_TIMEOUT_MS)付きで送信し、正常なJSONとして解釈できなかった
  // 場合に限り、同じurl（常に元の/exec）へ最大1回だけ自動retryする。POSTには一切適用しない。
  function get(action, params, baseOverride) {
    var url = buildGetUrl(action, params, baseOverride);
    var requestId = generateRequestId_();
    return performGetWithRetry_(action, url, requestId);
  }

  // NET-2D: POSTはtimeout・retryとも一切追加しない（submitStudentScore等の非冪等な保存を
  // 含むため、通信失敗時の自動再送は常に禁止。fetch回数は常に1のまま、既存契約を完全維持）。
  function post(action, payload, baseOverride) {
    var ctx = { requestId: generateRequestId_(), action: action, method: 'POST' };
    var body = JSON.stringify(Object.assign({ action: action }, payload || {}));
    return normalizeResult_(fetch(baseOverride || baseUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body
    }), ctx);
  }

  return { get: get, post: post };
})();
