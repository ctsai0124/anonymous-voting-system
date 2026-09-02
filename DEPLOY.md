# election.leotsai.me 部署說明

最後確認時間：2026-09-01（由 Claude 實地排查機器後確認並記錄）

## 1. 實際部署方式（已用機器上的設定檔＋即時 curl 驗證確認，非推測）

**前端（index.html）：本機常駐 Python 靜態伺服器 + Cloudflare Tunnel，沒有任何「上傳」步驟。**

- macOS LaunchAgent `com.leotsai.vote`（設定檔：`~/Library/LaunchAgents/com.leotsai.vote.plist`）
  在開機/登入時自動執行：
  ```
  /opt/homebrew/bin/python3 -m http.server 8101 --directory /Users/cheng-changtsai/anonymous-voting-system
  ```
  `RunAtLoad`＋`KeepAlive` 都是 true，代表這台 Mac 開機就會啟動，如果程序意外中止也會自動重啟。
  Log：`~/Library/Logs/vote-stdout.log`、`~/Library/Logs/vote-stderr.log`。

- 對外曝露靠共用的 Cloudflare Tunnel「mac-leotsai」（tunnel ID `e5c70ec0-c552-4368-a2f2-5ac6177d1d71`），
  由另一個 LaunchAgent `com.leotsai.mac-leotsai-tunnel` 執行 `cloudflared tunnel run mac-leotsai` 常駐。
  這一個 tunnel 同時服務好幾個 leotsai.me 子網域（leotsai.me 首頁、live-transcribe、smartdoc、badminton、laststand、n8n…），
  設定檔在 `~/.cloudflared/config.yml`，其中這一條就是 election.leotsai.me 的路由規則：
  ```yaml
  - hostname: election.leotsai.me
    service: http://127.0.0.1:8101
  ```

**結論：`~/anonymous-voting-system/index.html` 這個檔案本身就是正式站內容，改了存檔就是正式站的新內容，
不需要登入 Cloudflare、不需要 wrangler、不需要 GitHub Pages、也沒有 build/上傳流程。**
（先前一度以為可能是 Cloudflare Pages 直接上傳模式，已用上面這組設定檔＋實際 curl 測試排除，見下方「驗證方式」。）

GitHub repo `ctsai0124/anonymous-voting-system` 上的 GitHub Pages 是很早期就棄用的舊版本，跟正式站無關，
不要被它誤導成「以為正式站是靠 GitHub Pages 或某個 CI 部署」。

## 2. 具體操作步驟

**要更新前端內容：**
1. 直接編輯這個資料夾裡的 `index.html`（本機路徑：`/Users/cheng-changtsai/anonymous-voting-system/index.html`）。
2. 存檔即可，不需要重啟任何服務、不需要登入任何帳號——`http.server` 每次請求都會即時讀取硬碟上的最新內容。
3. 想確認是否已生效，可以直接看 `https://election.leotsai.me/`，或本機執行
   `curl http://localhost:8101/` 比對內容。

**不需要用到、之後也不用再排查的東西：** wrangler CLI（這台機器沒裝，也沒有 `~/.wrangler` 設定）、
Cloudflare Pages 專案、GitHub Actions（repo 裡沒有 `.github/workflows/`）。

**如果要重啟本機伺服器（通常不需要）：**
```
launchctl unload ~/Library/LaunchAgents/com.leotsai.vote.plist
launchctl load ~/Library/LaunchAgents/com.leotsai.vote.plist
```

## 3. 跟後端 Google Apps Script 專案的關聯

- 後端 GAS 專案名稱：**教評會投票系統_資料庫**（在 script.google.com，Script ID
  `1h2M9_2W1Y3O_0-1YTyLGuzQ8MmUxbrLB3S2NhHHTosOFRPPy-JzYUuUj`）。
- 本機有一份鏡像檔 `~/anonymous-voting-system/Code.gs`，但**真正在跑的是 Apps Script 編輯器裡的版本**，
  改本機這份檔案不會自動同步過去，要同步的話必須手動複製貼上到 Apps Script 編輯器再存檔。
- Web App 部署網址是**釘住特定版本**（不是自動跟著最新程式碼跑），目前部署 ID 對應的網址：
  ```
  https://script.google.com/macros/s/AKfycbw4YAGyjjS53p1LmuWDDKEiamSG-lSn9zlYzNzNr5EhYexW99ATHcnNDcbWYkpSx7VB/exec
  ```
  這個網址寫死在 `index.html` 的 `GAS_API_URL` 常數裡。
- **改完 Code.gs 一定要記得在 Apps Script 的「管理部署作業」裡建立新版本並部署**，
  否則存檔只是存到雲端硬碟的原始碼，正式站還是在跑舊版本的邏輯（這次修正就踩過這個坑，見下方紀錄）。
- 執行身分是「我」（開發者帳號），存取權限是「所有人」。
- 有一個時間驅動觸發器 `checkAndCloseVotes`，定期自動關閉已過期的投票案。

## 4. 2026-08-31 / 09-01 但書（proviso）修正紀錄

**修正的問題**：「公立高級中等以下學校教師成績考核辦法」第9條規定教師成績考核委員會正常應為9～17人，
但參加考核教師人數未滿20人時，得降到最低5人（當然委員至多2人）。election.leotsai.me 原本：
- 前端 `pr_committee_total_n` 滑桿寫死 `min="9"`，管理者完全無法選到5～8人的合法委員數；
- 後端自動產生的簽呈文字不管實際委員人數多少，永遠只印「9至17人組成」那段文字，沒有但書引用。

**前端修正**（`~/anonymous-voting-system/index.html`）：
- 新增「參加考核教師人數」欄位 `pr_exam_count`，會在匯入名冊時自動帶入受票選人數，也可手動修改；留空＝不判斷但書。
- `calculatePrComposition()` 改為依 `pr_exam_count` 動態調整滑桿 `min`（未滿20人時放寬到5）、顯示但書提示文字。
- 當然委員人數在但書生效時（委員總數<9人）強制上限鎖到2人（`getPrEffectiveExOfficioCount()`）。
- 備份檔：`index.html.bak-pre-proviso-20260901185918`（修改前的完整內容）。

**後端修正**（Code.gs，Apps Script 專案「教評會投票系統_資料庫」，第804～830行、第893～900行、第1078～1084行附近）：
- 新增 `isSmallCommittee`（第806行）：`totalCommitteeCount > 0 && totalCommitteeCount < 9` 時視為但書生效，
  不需要額外欄位、不用管理者自己判斷，直接用算好的委員總額反推。
- 簽呈文字（HTML信件內文＋Word附件兩處，邏輯相同）改成依 `isSmallCommittee` 動態切換：

  **修改前（永遠是這段，不管實際委員人數）：**
  > 一、依據「公立高級中等以下學校教師成績考核辦法」第9條規定略以：教師成績考核委員會由委員9至17人組成，除掌理教務、學生事務、輔導、人事業務之單位主管及教師會代表1人為當然委員外，其餘由本校教師票選產生，並由委員互推1人為主席，其中委員每滿3人應有1人為未兼行政職務教師（計算排除教師會代表），任一性別委員應占委員總數三分之一以上，其任期自○○年9月1日至○○年8月31日止。

  **修改後（`isSmallCommittee` 為 true 時，即委員總數<9人）：**
  > 一、依據「公立高級中等以下學校教師成績考核辦法」第9條規定略以：教師成績考核委員會由委員9至17人組成，除掌理教務、學生事務、輔導、人事業務之單位主管及教師會代表1人為當然委員外，其餘由本校教師票選產生，並由委員互推1人為主席；但參加考核之教師人數未滿20人者，得降低委員人數，最低不得少於5人，其中當然委員至多2人，除教師會代表外，其餘由校長指定之。本校依前開但書規定辦理，委員中每滿3人應有1人為未兼行政職務教師（計算排除教師會代表），任一性別委員應占委員總數三分之一以上，其任期自○○年9月1日至○○年8月31日止。

  （`isSmallCommittee` 為 false，即委員總數9～17人時，文字維持修改前那段，完全沒有改動。）
- 備份檔：`Code.gs.bak-pre-proviso-20260901185918`（本機鏡像，修改前的完整內容）。

**驗證方式**：
- 用 Node.js `vm` 模組載入 `Code.gs` 邏輯、`jsdom` 載入完整 `index.html`（含內嵌 script），
  在沙盒環境模擬「參加考核人數15人」的案例，確認滑桿可以選到5～8、但書提示會出現、
  簽呈文字正確切換成上面「修改後」那段——全程沒有碰任何正式在用的試算表資料。
- 後端存檔後在 Apps Script「管理部署作業」建立新版本（12版→13版，2026-09-01 晚上7:10部署），
  沿用原本的部署ID／網址，沒有換新網址，`index.html` 裡的 `GAS_API_URL` 不用改。
- 部署後用 `fetch` 打一個不存在的 `vote_id` 測試 `get_candidates`，確認回傳「查無此活動 ID」的正常錯誤訊息，
  代表新版本有正常運作，過程中沒有動到任何真實投票案資料。
- 前端存檔後直接用 `curl https://election.leotsai.me/` 確認正式站已經拿到新版內容（含 `pr_exam_count` 欄位），
  因為架構就是本機檔案即時透過 Tunnel 對外，存檔當下就已經是正式站在跑的版本，不需要額外部署動作。

## 5. 之後接手的人看這份文件要注意的事

- 這是正式在用、牽涉真實人事程序的系統，改 `index.html` 或 `Code.gs` 前務必先備份
  （`.bak-日期時間` 檔名格式，這個資料夾裡已經有前例可以參考）。
- 改完務必用模擬資料驗證過（Node vm / jsdom 或至少肉眼跑一次流程），不要直接在真實在用的資料上測試。
- 後端一定要記得在 Apps Script「管理部署作業」建立新版本，光存檔不會讓正式站生效。
- 前端不需要「部署」這個動作，存檔即生效；但也因為這樣，改錯了會立刻影響正式站，要更小心。

## 6. 2026-09-01 追加：`setup` API 密鑰驗證（防止陌生人直接打 API 建立假投票活動）

**修正的問題**：健檢時發現 `handleSetup`（建立投票活動）原本沒有任何驗證機制。`GAS_API_URL` 本來就寫在前端原始碼裡、公開可見，任何人只要知道這個網址，就可以繞過網頁介面直接 POST `action=setup`，在正式試算表裡建立假投票活動，還會觸發系統用開發者自己的 Gmail 寄通知信到任意信箱（可能被當寄信跳板或洗掉 GAS 免費額度）。`submit_vote`／`get_candidates`／`verify_code` 本來就有通行碼或唯讀限制，只有 `setup` 這支是完全開放的。

**修正方式**：
- 後端 `Code.gs` 的 `doPost` 路由層，`action === "setup"` 時多一道檢查：讀取 Apps Script「指令碼屬性（Script Properties）」裡的 `SETUP_API_SECRET`，跟 request 帶的 `setup_secret` 比對，不符或屬性未設定就直接回錯誤、不執行 `handleSetup`。
- 前端 `index.html` 在 `GAS_API_URL` 常數旁新增 `SETUP_API_SECRET` 常數（32 字元隨機字串），呼叫 setup 的 payload 自動夾帶 `setup_secret` 欄位，同仁不用多做任何操作。
- 密鑰值存在 Script Properties（Apps Script 專案設定頁「指令碼屬性」區塊），不寫死在 `Code.gs` 原始碼裡，即使原始碼被人看到也不會外洩後端那一份。**這個防護擋的是「完全沒看過網頁、直接亂打 API」的隨機攻擊/掃描工具，不是真的想深入分析前端原始碼的人**——前端那份密鑰終究是公開可見的，這是刻意的設計取捨，不是假裝做到完全防護。

**備份**：`Code.gs.bak-pre-setupsecret-20260901204213`、`index.html.bak-pre-setupsecret-20260901204213`（修改前的完整內容，在 `~/anonymous-voting-system/`）。

**部署紀錄**：Code.gs 存檔後在 Apps Script「管理部署作業」建立新版本（13版→14版，2026-09-01 晚上9:02 部署），沿用原本的部署 ID／網址，`index.html` 的 `GAS_API_URL` 不用改。

**驗證方式**：
- 本機用 Node.js `vm` 模組模擬 `doPost` 路由，測試「沒帶密鑰」「密鑰錯誤」都被擋下（回「無效的請求，無法建立投票活動。」），「密鑰正確」則放行進入 `handleSetup`；確認 `get_candidates`／`verify_code`／`submit_vote` 三個既有 action 完全不受影響（沒有被要求帶密鑰）。
- 部署後對正式站 `GAS_API_URL` 直接發送真實請求驗證：沒帶密鑰／密鑰錯誤兩種情況都正確回「無效的請求」；帶正確密鑰（讀取正式站當下的 `SETUP_API_SECRET` 常數）則成功建立了一筆測試活動 `vote_id: v_mtiok5wr`（`school_name` 標記為「zztest-cleanup-later」，`admin_email` 用假信箱 `test@example.com`、時間設在 2099 年、無匯入名冊，不會被投票也不會實際觸發結案寄信，但**這筆測試資料列還留在正式的 Activity_Config 工作表裡，尚未清除，需要手動去 Google Sheets 裡刪掉這一列**）；同時確認 `get_candidates`／`verify_code` 對既有（不存在）活動 ID 的回應跟改動前一致，沒有被這次改動影響。

## 7. 2026-09-02 追加：兩個實際使用中發現的前端邏輯 bug

**這兩個都是使用者在正式使用 election.leotsai.me 過程中發現、回報後查證確認為真的 bug（不是誤會），只動了 `index.html`，`Code.gs` 沒有變動。**

### 7.1 同時辦理模式下，教師會代表沒有被排除教評會候選資格

**問題**：名冊管理畫面裡，同時辦理（教評會＋考核會）模式會並排顯示兩欄候選資格。把某人角色標記為「教師會代表」時，考核會那一欄會正確自動換成「當然委員，無被選舉權」文字並排除候選資格；但教評會那一欄卻仍是一般勾選框，沒有跟著排除——教師會代表可能同時又以一般候選人身分出現在教評會的正式選票上。

**根因**：`renderVoterTable()` 裡同時辦理模式的教評會候選資格欄（`candidacyCell`）從一開始就沒有檢查 `v.exOfficioRole`，一律渲染成可勾選的checkbox；連動的 `setExOfficioRole()`／`removePrExOfficioRole()` 也只處理考核會用的 `isCandidatePr`，完全沒有碰教評會用的 `isCandidate`。

**法規依據（決定修法範圍要多窄）**：依「高級中等以下學校教師評審委員會設置辦法」第3條，教評會的當然委員是校長、家長會代表、教師會代表——教師會代表是唯一同時橫跨教評會＋考核會兩邊當然委員身分的角色；名冊上其餘四種可標記角色（教務／學務／輔導／人事主任）只是考核會專屬的當然委員身分，跟教評會候選資格無關，不能一起排除，否則會變成新的bug。

**修正內容**（`~/anonymous-voting-system/index.html`）：
- `renderVoterTable()` 的 `candidacyCell`：同時辦理模式下新增判斷，`v.exOfficioRole === '教師會代表'` 時改顯示「當然委員（教師會代表），無被選舉權」文字，不再渲染checkbox。
- `setExOfficioRole(idx, role)`：同時辦理模式下，角色被標記／取消標記為「教師會代表」時，額外連動設定/恢復 `v.isCandidate`（其餘四種角色維持原行為，不動 `isCandidate`）。
- `removePrExOfficioRole(idx)`：整個刪除「教師會代表」這個角色選項時，同樣要把已標記者的 `v.isCandidate` 恢復為 `true`，避免殘留在「不能參選教評會」的狀態。
- 備份檔：`index.html.bak-pre-teacherassoc-fix-20260902123531`。

**驗證方式**：用 jsdom 載入完整 `index.html`（含內嵌 script）模擬同時辦理模式的名冊資料，驗證：標記教師會代表後，教評會欄正確顯示排除文字、`isCandidate` 變 `false`、且不會出現在 `getCandidatesFor('teacher_review')`（正式選票候選名單的產生來源）裡；一般教師、以及標記為「學務主任」（非教師會代表的考核會專屬當然委員）的人完全不受影響、行為跟修改前一致；取消標記或整個刪除該角色選項都能正確恢復候選資格。全程沒有用到任何真實學校的名冊資料。

### 7.2 A4 選票／簽收清冊／計票單列印預覽多印出一張空白第二頁

**問題**：教評會選票列印/預覽時，選票內容（候選人清單＋發票人/監票人簽章＋印製日期）明明第一頁就結束了，卻仍多印出一張完全空白的第二頁。

**根因**：CSS 撰寫瑕疵，跟候選人數多寡無關（只有1位候選人一樣會重現）。共用的 `.a4-preview` 樣式在檔案裡出現兩次：`@media print` 區塊裡想把螢幕預覽用的 `min-height: 29.7cm`／`border: 1px solid #ccc` 在列印時重設成 `min-height: 0`／`border: none`（讓內容決定高度），但這段重設沒加 `!important`；而檔案裡**在這個 `@media print` 區塊之後**又有一條沒有 `@media` 限制、選擇器優先權相同（都是單一 class）的基礎規則，同樣定義了 `.a4-preview { min-height: 29.7cm; border: 1px solid #ccc; ... }`。CSS 在優先權相同時是看「原始碼順序」而不是「有沒有寫在 `@media print` 裡」，後出現的規則會贏——所以列印時那段重設其實完全沒生效，`.a4-preview` 仍被鎖死在剛好等於一整頁 A4 高度（29.7cm，`@page` 的 `margin` 又設 0，完全沒有容錯空間）。只要瀏覽器排版/字型量測有一丁點次像素捨入誤差，整個框就會多出一小段看不見的溢位，被印表機引擎硬生生擠成一張幾乎全空白的第二頁。

**修正內容**（`~/anonymous-voting-system/index.html`，`@media print` 區塊內的 `.a4-preview` 規則）：`box-shadow`、`border`、`min-height` 三個屬性都加上 `!important`，讓列印時確實蓋掉基礎規則，改回依內容自動撐高。因為 `.a4-preview` 是選票、簽收清冊、計票單三個列印功能共用的 class，這個修正同時修好了全部三個列印功能，不只是選票。
- 備份檔：跟 7.1 共用同一份 `index.html.bak-pre-teacherassoc-fix-20260902123531`（兩個修正是同一次改動session裡做的，這份備份是兩個修正都還沒動之前的版本）。

**驗證方式**：用 headless Chromium（Playwright）實際載入 `index.html`、模擬多種候選人數（1／5／10／16／20／25／30／40 人）分別觸發「產製紙本選票」「產製選票簽收清冊」「產製開票計票單」三個列印功能，`emulateMedia('print')` 後輸出 PDF 檢查頁數與截圖內容：
  - 修正前：不管候選人數多少（含極端案例「只有1人」）都固定多印一張空白第二頁。
  - 修正後：候選人數在一頁裝得下的範圍內（測試到16人，即回報案例的實際人數）都正確只印1頁、無多餘空白頁；候選人數多到真的裝不下一頁時（測試20人以上）正確產生第2頁，且第2頁是真實溢出的內容（最後幾筆候選人資料＋簽章欄），不是空白頁。全程用測試資料，沒有用到任何真實學校的名冊或試算表資料。

**尚未處理、之後可以考慮的相關項目（這次沒有動）**：單選「教評會」模式（非同時辦理）目前完全沒有UI可以把人標記成「教師會代表」，所以那個模式下無法排除教師會代表的教評會候選資格——這是另一個結構性的缺口，跟這次回報的兩個bug不是同一件事，需要另外評估是否要加。
