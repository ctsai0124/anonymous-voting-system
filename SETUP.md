# 教評會無記名投票系統 (Leo Tsai 工具站子頁) 部署指南

本專案位於 `C:\Users\ctsai\.gemini\antigravity\scratch\anonymous-voting-system\`。

## 📁 專案檔案結構
- `index.html`：前端萬用網頁（整合管理者建置頁面、A4 選票列印、名單解析、與投票者卡片頁面）
- `Code.gs`：Google Apps Script (GAS) 後端 Web App 腳本（處理雙工作表寫入、LockService 併發鎖定與開票簽案 Email）
- `SETUP.md`：本部署說明文件

---

## 🚀 部署步驟 1：建立 Google Sheets 與 GAS Web App

1. 打開 [Google Sheets ( Google 試算表 )](https://sheets.google.com/)，建立一個新的空白試算表。
2. 命名為 `教評會投票系統_資料庫`。
3. 點擊頂部選單 **「擴充功能」 ➡️ 「Apps Script」**。
4. 將專案中的 `Code.gs` 程式碼複製並貼上取代原本的內容。
5. 點擊右上角 **「發布」 ➡️ 「新部署」 (Deploy as Web App)**：
   * **執行身份 (Execute as)**：`我 (Me / 您的 Google 帳號)`
   * **誰有存取權 (Who has access)**：`所有人 (Anyone)`
6. 點擊 **「部署」** 並完成 Google 帳號權限授權。
7. 複製獲得的 **Web App URL**（格式類似 `https://script.google.com/macros/s/AKfycb.../exec`）。
8. 設定時間驅動觸發器 (Cron Trigger)：
   * 點擊 Apps Script 左側邊欄的 ⏰ **「觸發器」 (Triggers)**。
   * 新增觸發器：選擇函數 `checkAndCloseVotes` ➡️ 時間驅動 ➡️ 每 5 分鐘或 10 分鐘執行一次。

---

## 🌐 部署步驟 2：配置前端與發布至子網域 (`vote.leotsai.me`)

1. 開啟 `index.html` 檔案，在 JS 頂部找到：
   ```javascript
   const GAS_API_URL = "YOUR_GAS_WEB_APP_URL";
   ```
   將 `YOUR_GAS_WEB_APP_URL` 替換為步驟 1 取得的 GAS Web App URL。

2. **部署至子網域**：
   * 可將 `index.html` 放入 Cloudflare Pages / GitHub Pages / 或您的 Mac Studio 本機伺服器中。
   * 在 DNS 設定（如 Cloudflare）中新增 CNAME 或 A 紀錄指向該子網域（如 `vote.leotsai.me`）。

---

## 🎯 測試與驗證流程

1. **管理者流程**：
   * 開啟 `https://vote.leotsai.me/`。
   * 直接將學校人事系統匯出的 `.csv` 或 `.xlsx` 檔案拖入上傳區。
   * 系統將自動過濾非教師與代理教師，僅保留專任教師並生成 8 碼通行碼。
   * 點擊 **「【按鈕 1】產製紙本選票」** ➡️ 可直接印出 A4 教評會委員選票。
   * 點擊 **「【按鈕 2】發布線上無記名投票」** ➡️ 取得發布網址與 Line/Email 宣導通知文字。

2. **投票者流程**：
   * 使用手機或電腦開啟 `https://vote.leotsai.me/?vote_id=XXXXX`。
   * 輸入 8 碼通行碼（身分證後4碼 + 生日MMDD）。
   * 勾選候選人卡片（動態防錯上限），確定送出選票。
