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
window.ScoreApi = (function () {
  function baseUrl() {
    return window.SCORE_APP_CONFIG.API_BASE_URL;
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

  // fetchの結果をGAS APIの{ok, ...}契約に正規化する。
  // ネットワーク到達失敗（CORS含む）とGAS側のok:falseを区別して呼び出し元へ返す。
  // ctx: { requestId, action, method }（診断ログ専用。呼び出し元への返却値には一切混ぜない）。
  function normalizeResult_(promise, ctx) {
    ctx = ctx || {};
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
            }));
            return { ok: false, error: '通信エラー: レスポンスを解釈できませんでした。' };
          }
          // NET-2A: JSON.parseには成功するがokフィールドが無い等、期待schemaと異なる場合が
          // ある。既存の返却object(parsed)は一切変更せず、診断としてのみ検知する。
          if (!parsed || typeof parsed.ok !== 'boolean') {
            emitDiagnostic_(Object.assign({}, ctx, {
              status: status, ok: ok, redirected: redirected, url: sanitizedUrl, contentType: contentType,
              bodyLength: bodyLength, bodyKind: bodyKind, jsonParseSuccess: true,
              errorStage: 'schema', schemaUnexpected: true
            }));
          }
          return parsed;
        }, function (bodyErr) {
          emitDiagnostic_(Object.assign({}, ctx, {
            status: status, ok: ok, redirected: redirected, url: sanitizedUrl, contentType: contentType,
            errorStage: 'read_body', errorName: bodyErr && bodyErr.name
          }));
          return { ok: false, error: '通信エラー: ' + (bodyErr && bodyErr.message ? bodyErr.message : String(bodyErr)) };
        });
      })
      .catch(function (err) {
        emitDiagnostic_(Object.assign({}, ctx, { errorStage: 'fetch', errorName: err && err.name }));
        return { ok: false, error: '通信エラー: ' + (err && err.message ? err.message : String(err)) };
      });
  }

  // 匿名fetch。credentialsは明示的に送らない（Googleログイン状態に依存しないことを
  // 通信PoCで確認済みの構成を維持するため）。redirectもbrowser標準挙動のまま。
  // baseOverrideは省略可（省略時は既存どおりAPI_BASE_URL/productionを使う）。
  function get(action, params, baseOverride) {
    var ctx = { requestId: generateRequestId_(), action: action, method: 'GET' };
    return normalizeResult_(fetch(buildGetUrl(action, params, baseOverride)), ctx);
  }

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
