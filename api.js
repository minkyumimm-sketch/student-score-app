// GAS Web App との通信共通処理。GET / POST(text/plain) の2種類のみを扱う。
// 通信PoC（STEP 1）の実測結果に基づき、POSTはContent-Type: text/plain固定とする
// （application/jsonはCORS preflightで失敗することを実機確認済みのため使用しない）。
// 自動retryは行わない（点数送信時の二重送信リスクを避けるため、STEP 3以降も含めて
// 常にユーザー操作による再試行とする）。
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

  // fetchの結果をGAS APIの{ok, ...}契約に正規化する。
  // ネットワーク到達失敗（CORS含む）とGAS側のok:falseを区別して呼び出し元へ返す。
  function normalizeResult_(promise) {
    return promise
      .then(function (res) {
        return res.text().then(function (text) {
          var parsed;
          try {
            parsed = JSON.parse(text);
          } catch (e) {
            return { ok: false, error: '通信エラー: レスポンスを解釈できませんでした。' };
          }
          return parsed;
        });
      })
      .catch(function (err) {
        return { ok: false, error: '通信エラー: ' + (err && err.message ? err.message : String(err)) };
      });
  }

  // 匿名fetch。credentialsは明示的に送らない（Googleログイン状態に依存しないことを
  // 通信PoCで確認済みの構成を維持するため）。redirectもbrowser標準挙動のまま。
  // baseOverrideは省略可（省略時は既存どおりAPI_BASE_URL/productionを使う）。
  function get(action, params, baseOverride) {
    return normalizeResult_(fetch(buildGetUrl(action, params, baseOverride)));
  }

  function post(action, payload, baseOverride) {
    var body = JSON.stringify(Object.assign({ action: action }, payload || {}));
    return normalizeResult_(fetch(baseOverride || baseUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body
    }));
  }

  return { get: get, post: post };
})();
