/**
 * PM2 ecosystem 設定
 * 監聽 signal/ 目錄，寫入 signal/RESTART 觸發重啟
 * dist/ 變更（tsc 編譯）不會觸發重啟
 */
module.exports = {
  apps: [{
    name: "catclaw",
    script: "dist/index.js",
    watch: ["signal"],
    watch_delay: 1000,
    autorestart: true,
  }]
};
