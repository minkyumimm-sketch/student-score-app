// GAS Web App URLをこの1箇所だけで管理する。
// 正式API deployment（score-api-production、version23、固定旧本番@19とは別物）を指す。
// 開発中はscore-api-poc deploymentを使っていたが、正式公開に伴いこの値だけを差し替えた
// （ロジック変更なし）。今後の開発・検証はscore-api-pocを引き続き使う想定。
//
// 秘密情報（Spreadsheet ID・LINE URL・birth_date実データ・token等）はこのファイル・
// このディレクトリのいずれにも置かない。GAS Web App URLは秘密情報ではないため公開してよい。
window.SCORE_APP_CONFIG = {
  // 正式API: score-api-production deployment（version23、固定旧本番@19ではない）
  API_BASE_URL: 'https://script.google.com/macros/s/AKfycbwkhC42EmkWWAfLJV9DVL59yaeVE8oYSMP5VfYTxuHTnDL0a1hcOZQE7wDa999Oef3apA/exec'
};
