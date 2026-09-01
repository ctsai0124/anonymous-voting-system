/**
 * 專案名稱：教評會線上無記名投票系統 GAS 後端 API (Code.gs)
 * 作者：Leo Tsai 人事雲端工具站 (leotsai.me)
 * 說明：處理前端 API 請求、雙工作表完全切斷身分與選票之匿名寫入、併發鎖定與到期自動統計發信。
 */

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000); // 最多等待 10 秒
  } catch (err) {
    return createJsonResponse({ status: "error", message: "系統繁忙，請稍後再試" });
  }

  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    if (action === "setup") {
      // 2026-09-01：handleSetup 原本沒有任何驗證——只要知道 GAS_API_URL（本來就寫在
      // 前端原始碼裡，公開可見），任何人都能直接呼叫這支 API 在正式試算表裡建立假
      // 投票活動、並讓系統用開發者自己的 Gmail 寄通知信到任意信箱。這裡加一組固定
      // 密鑰檢查：前端頁面會自動夾帶同一組密鑰，同仁不用多做任何操作；密鑰存在
      // Script Properties（不寫死在原始碼裡），即使 Code.gs 被人看到也不會外洩。
      // 這個防護擋的是「完全沒看過網頁、直接亂打 API」的隨機攻擊/掃描工具，不是真的
      // 想深入分析前端原始碼的人——前端那份密鑰終究是公開可見的，這點刻意不假裝
      // 做到完全防護。get_candidates／verify_code／submit_vote 維持原本不需要密鑰。
      var expectedSecret = PropertiesService.getScriptProperties().getProperty("SETUP_API_SECRET");
      if (!expectedSecret || data.setup_secret !== expectedSecret) {
        return createJsonResponse({ status: "error", message: "無效的請求，無法建立投票活動。" });
      }
      return handleSetup(data);
    } else if (action === "get_candidates") {
      return handleGetCandidates(data);
    } else if (action === "verify_code") {
      return handleVerifyCode(data);
    } else if (action === "submit_vote") {
      return handleSubmitVote(data);
    } else {
      return createJsonResponse({ status: "error", message: "無效的 Action 路由" });
    }
  } catch (err) {
    return createJsonResponse({ status: "error", message: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var action = e.parameter.action;
  if (action === "get_candidates") {
    return handleGetCandidates(e.parameter);
  }
  return createJsonResponse({ status: "success", message: "GAS Voting API 運作中" });
}

// 1. 建立活動 (action: "setup")
function handleSetup(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  // 2026-08-10：新增第 10 欄 ex_officio_json，存當然委員（校長/家長會代表/教師會代表）
  // 的姓名與性別，供結案信計算「委員總額」性別比例用。candidates_json 那欄現在存的
  // 是 {name, gender, isAdmin} 物件陣列（以前只存姓名字串），供結案時算未兼行政人數。
  var sheetConfig = getOrCreateSheet(ss, "Activity_Config", ["vote_id", "school_name", "admin_email", "start_time", "end_time", "max_selectable", "candidates_json", "is_closed", "created_at", "ex_officio_json", "committee_type", "max_selectable_pr", "candidates_json_pr", "ex_officio_json_pr"]);
  // 如果是舊的、已經存在的工作表（欄位是後來才加的），把缺的表頭補上，不影響既有資料列。
  if (sheetConfig.getRange(1, 10).getValue() === "") {
    sheetConfig.getRange(1, 10).setValue("ex_officio_json");
  }
  // 2026-08-11：新增第 11 欄 committee_type，區分「教評會 (teacher_review)」與
  // 「教師成績考核委員會 (performance_review)」——兩種委員會的法定組成規則、未兼行政
  // 門檻公式、簽呈法規引用文字都不同，結案時要靠這欄知道該套用哪一套規則。舊資料列
  // 沒有這欄，checkAndCloseVotes 讀取時會 fallback 成 "teacher_review"，行為跟改版前一致。
  if (sheetConfig.getRange(1, 11).getValue() === "") {
    sheetConfig.getRange(1, 11).setValue("committee_type");
  }
  // 2026-08-11：新增「同時辦理 (joint)」模式——一場活動同時票選教評會與考核會委員，
  // 用同一份名冊、同一次登入、一起送出。既有的 max_selectable/candidates_json/
  // ex_officio_json 三欄繼續代表「教評會那組」不動；這裡新增 12~14 欄專門存
  // 「考核會那組」，只有 committee_type === "joint" 時才會用到，單選模式的活動
  // 這三欄永遠是空的，不影響既有邏輯。
  if (sheetConfig.getRange(1, 12).getValue() === "") {
    sheetConfig.getRange(1, 12).setValue("max_selectable_pr");
  }
  if (sheetConfig.getRange(1, 13).getValue() === "") {
    sheetConfig.getRange(1, 13).setValue("candidates_json_pr");
  }
  if (sheetConfig.getRange(1, 14).getValue() === "") {
    sheetConfig.getRange(1, 14).setValue("ex_officio_json_pr");
  }
  var sheetChecklist = getOrCreateSheet(ss, "Voter_Checklist", ["vote_id", "verify_code", "is_voted", "voted_at"]);
  
  var voteId = "v_" + new Date().getTime().toString(36);
  var createdAt = new Date();

  // 寫入 Activity_Config
  sheetConfig.appendRow([
    voteId,
    data.school_name,
    data.admin_email,
    data.start_time,
    data.end_time,
    data.max_selectable,
    JSON.stringify(data.candidate_list),
    false,
    createdAt,
    JSON.stringify(data.ex_officio_members || []),
    data.committee_type || "teacher_review",
    data.max_selectable_pr || "",
    data.candidate_list_pr ? JSON.stringify(data.candidate_list_pr) : "",
    data.ex_officio_members_pr ? JSON.stringify(data.ex_officio_members_pr) : ""
  ]);

  // 寫入 Voter_Checklist (全員 8 碼通行碼)
  if (data.voter_list && data.voter_list.length > 0) {
    var rows = [];
    for (var i = 0; i < data.voter_list.length; i++) {
      rows.push([voteId, data.voter_list[i].verify_code, false, ""]);
    }
    var writeStartRow = sheetChecklist.getLastRow() + 1;
    // 2026-08-10：驗證碼是「身分證後4碼+生日MMDD」組成的 8 位數字字串，只要身分證
    // 後4碼剛好 0 開頭（機率約十分之一），Sheets 儲存格若沒先設成純文字格式，寫入時
    // 會被自動當成數字存，開頭的 0 會直接消失（"06070326" 變成數字 6070326），
    // 導致這位同仁拿著系統算出來的正確碼卻登入不了。這裡先把 verify_code 那一欄
    // 強制設成純文字格式，再寫入，避免以後新匯入的資料再發生同樣的問題。
    sheetChecklist.getRange(writeStartRow, 2, rows.length, 1).setNumberFormat("@");
    sheetChecklist.getRange(writeStartRow, 1, rows.length, 4).setValues(rows);
  }

  SpreadsheetApp.flush();

  // 發送建立成功通知信給管理者
  try {
    MailApp.sendEmail({
      to: data.admin_email,
      subject: "【活動建立通知】" + data.school_name + " 教評會線上投票 (代碼: " + voteId + ")",
      htmlBody: "<h3>" + data.school_name + " 教評會委員線上投票活動已成功建立</h3>" +
                "<p><strong>活動代碼：</strong>" + voteId + "</p>" +
                "<p><strong>應選人數上限：</strong>" + data.max_selectable + " 人</p>" +
                "<p><strong>投票時間：</strong>" + data.start_time + " ~ " + data.end_time + "</p>" +
                "<p>系統將於結束時間到期後自動計算結果並發送簽案報告至此信箱。</p>"
    });
  } catch (mailErr) {
    Logger.log("Email 發送失敗: " + mailErr);
  }

  return createJsonResponse({
    status: "success",
    vote_id: voteId,
    message: "活動建立成功"
  });
}

// 2. 獲取候選人名單 (action: "get_candidates")
function handleGetCandidates(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetConfig = ss.getSheetByName("Activity_Config");
  if (!sheetConfig) return createJsonResponse({ status: "error", message: "查無活動設定" });

  var rows = sheetConfig.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === data.vote_id) {
      // candidates_json 現在存的是 {name, gender, isAdmin} 物件陣列（結案統計要用），
      // 但投票畫面只需要姓名——性別/是否兼行政不對匿名投票者公開，這裡只回傳姓名。
      var candidateObjs = JSON.parse(rows[i][6]);
      var candidateNames = candidateObjs.map(function (c) {
        return (typeof c === "string") ? c : c.name; // 相容舊資料（曾經只存過純姓名字串）
      });
      var committeeType = rows[i][10] || "teacher_review";
      var response = {
        status: "success",
        vote_id: rows[i][0],
        school_name: rows[i][1],
        max_selectable: rows[i][5],
        candidates: candidateNames,
        committee_type: committeeType
      };
      // 同時辦理：多回傳一組考核會候選人資料，投票畫面才能同時渲染兩份選票。
      // 第13欄 candidates_json_pr 舊活動一律是空字串，這裡只有 joint 活動才會有值。
      if (committeeType === "joint") {
        var candidateObjsPr = JSON.parse(rows[i][12] || "[]");
        response.candidates_pr = candidateObjsPr.map(function (c) {
          return (typeof c === "string") ? c : c.name;
        });
        response.max_selectable_pr = rows[i][11];
      }
      return createJsonResponse(response);
    }
  }

  return createJsonResponse({ status: "error", message: "查無此活動 ID" });
}

// 2026-08-10：比對驗證碼時一律先補滿 8 位數（前面補 0）再比較，而不是直接用字串相等。
// 原因：驗證碼是「身分證後4碼+生日MMDD」組成的純數字字串，只要身分證後4碼剛好 0 開頭
// （機率約十分之一），Sheets 儲存格如果沒有先設成純文字格式就寫入，開頭的 0 會被自動
// 當成數字存而消失（"06070326" 變成 6070326），導致完全比對永遠失敗，讓中獎的人怎麼
// 輸入正確的碼都進不去。這裡用 padStart 兩邊都補齊 8 位再比，不管 Sheet 裡存的是被
// 吃掉零的數字、還是正常的完整字串，都能正確比對到——對已經匯入、已經被吃過零的
// 舊資料也有效，不用重新匯入名冊。（寫入時也已經改成強制用純文字格式存，見
// handleSetup，兩邊一起防，不只靠這裡的補救。）
function normalizeVerifyCode(v) {
  return String(v == null ? "" : v).padStart(8, "0");
}

// 2.5 驗證通行碼是否合法且尚未使用 (action: "verify_code")
// 2026-08-10：新增這個端點是為了讓前端在使用者輸入通行碼、按下一步時就能先檢查，
// 不用等到選完候選人送出投票才發現碼不對。刻意「不」區分「這組碼根本不存在」跟
// 「這組碼存在但已經投過票」——兩種情況一律回同一句籠統訊息，避免有心人拿這支
// API 窮舉通行碼時，能靠錯誤訊息的差異反推出「這組碼是不是某位真實同仁的合法碼」。
// handleSubmitVote 最後真正送出投票時，也必須用同一套判斷邏輯與同一句訊息文字，
// 否則等於繞了一圈又把同樣的側信道留在最後一步。
function handleVerifyCode(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetA = ss.getSheetByName("Voter_Checklist");
  if (!sheetA) {
    return createJsonResponse({ status: "error", message: "驗證碼不正確或無投票資格！" });
  }

  var voterRows = sheetA.getDataRange().getValues();
  for (var i = 1; i < voterRows.length; i++) {
    if (voterRows[i][0] === data.vote_id && normalizeVerifyCode(voterRows[i][1]) === normalizeVerifyCode(data.verify_code)) {
      if (voterRows[i][2] === true) {
        return createJsonResponse({ status: "error", message: "驗證碼不正確或無投票資格！" });
      }
      return createJsonResponse({ status: "success", message: "驗證碼有效" });
    }
  }

  return createJsonResponse({ status: "error", message: "驗證碼不正確或無投票資格！" });
}

// 3. 處理投票送出 (action: "submit_vote")
function handleSubmitVote(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetA = ss.getSheetByName("Voter_Checklist");
  var sheetB = getOrCreateSheet(ss, "Vote_Results", ["vote_id", "selected_candidates", "created_at", "selected_candidates_pr"]);
  // 舊的 Vote_Results 工作表可能還沒有第4欄，補上表頭不影響既有資料列。
  if (sheetB.getRange(1, 4).getValue() === "") {
    sheetB.getRange(1, 4).setValue("selected_candidates_pr");
  }

  var voterRows = sheetA.getDataRange().getValues();
  var voterRowIndex = -1;

  // 查驗 8 碼通行碼（訊息文字必須與 handleVerifyCode 完全一致，理由同上方註解；
  // 比對邏輯也要跟 handleVerifyCode 一致用 normalizeVerifyCode，理由見該函式註解）
  for (var i = 1; i < voterRows.length; i++) {
    if (voterRows[i][0] === data.vote_id && normalizeVerifyCode(voterRows[i][1]) === normalizeVerifyCode(data.verify_code)) {
      if (voterRows[i][2] === true) {
        return createJsonResponse({ status: "error", message: "驗證碼不正確或無投票資格！" });
      }
      voterRowIndex = i + 1; // 轉為 1-based index
      break;
    }
  }

  if (voterRowIndex === -1) {
    return createJsonResponse({ status: "error", message: "驗證碼不正確或無投票資格！" });
  }

  // 1. 核銷工作表 A（一次核銷，涵蓋這次送出的所有委員會——同時辦理模式下教評會跟
  // 考核會的圈選是同一個 submit_vote 請求一起送出，這裡本來就只做一次，不會發生
  // 「教評會投過但考核會沒投」這種中間狀態，兩邊的防重複投票天生綁在同一個核銷動作上。
  sheetA.getRange(voterRowIndex, 3).setValue(true);
  sheetA.getRange(voterRowIndex, 4).setValue(new Date());

  // 2. 匿名寫入工作表 B (選票 JSON)。同時辦理模式下 data.selected_candidates_pr
  // 會同時存在，跟教評會的 selected_candidates 一起寫進同一列；單選模式沒有這個欄位，
  // 存空字串，不影響既有計票邏輯（countVotesForActivity 只讀對應欄位）。
  sheetB.appendRow([
    data.vote_id,
    JSON.stringify(data.selected_candidates),
    new Date(),
    data.selected_candidates_pr ? JSON.stringify(data.selected_candidates_pr) : ""
  ]);

  SpreadsheetApp.flush();

  return createJsonResponse({ status: "success", message: "投票成功！選票已完全匿名寫入。" });
}

// 4. 定時觸發器：自動結案、開票統計與發送公文簽案
function checkAndCloseVotes() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetConfig = ss.getSheetByName("Activity_Config");
  var sheetB = ss.getSheetByName("Vote_Results");
  if (!sheetConfig || !sheetB) return;

  var now = new Date();
  var configs = sheetConfig.getDataRange().getValues();

  for (var i = 1; i < configs.length; i++) {
    var voteId = configs[i][0];
    var schoolName = configs[i][1];
    var adminEmail = configs[i][2];
    var endTime = new Date(configs[i][4]);
    var isClosed = configs[i][7];

    if (!isClosed && now >= endTime) {
      // 2026-08-18：admin_email 空白或格式不正確時，以前會讓 MailApp.sendEmail 直接
      // 拋例外，整個 checkAndCloseVotes 中斷執行——不只這筆活動沒處理到，連排在
      // 它後面、原本該正常結案的其他活動這次觸發也全部沒跑到。而且因為例外發生在
      // 「標記已結案」(第 8 欄 is_closed) 之前，isClosed 永遠不會被設成 true，
      // 導致每次觸發器重跑都在同一筆資料上再炸一次，並讓 Apps Script 對外寄送
      // 「執行失敗」通知信，實測會每 5~10 分鐘轟炸使用者信箱一次。
      // 修法：把單筆活動的結案動作包進 try/catch，失敗就記錄到 Error_Log 工作表、
      // 跳過這筆繼續處理下一筆，不讓一筆壞資料拖垮整個觸發器執行、也不再對外報錯。
      try {
        if (!isValidEmailAddress(adminEmail)) {
          throw new Error("admin_email 空白或格式不正確：「" + adminEmail + "」，略過此活動的自動結案信，請至 Activity_Config 補齊後手動或等下次觸發重試。");
        }

        // 進行開票統計
        var results = countVotesForActivity(ss, voteId);

        // 2026-08-10：candidates_json 現在存 {name, gender, isAdmin} 物件陣列，
        // ex_officio_json（第10欄，舊資料列可能不存在，用 || "[]" 保底）存當然委員資料，
        // 結案信要靠這兩份資料才能真的算「未兼行政人數」跟「性別比例」，並用來做
        // 保障名額調整（見 selectCommitteeWithQuota），不是憑空宣稱合規。
        var maxSelectable = configs[i][5];
        var candidatesData = JSON.parse(configs[i][6] || "[]");
        var exOfficioMembers = JSON.parse(configs[i][9] || "[]");
        // 第11欄 committee_type：舊資料列（改版前建立的活動）沒有這欄，fallback 為
        // "teacher_review"，行為跟改版前完全一致，不會讓舊活動結案時跑錯規則。
        var committeeType = configs[i][10] || "teacher_review";

        if (committeeType === "joint") {
          // 2026-08-11：同時辦理模式——同一批 Vote_Results 要分別計票兩次
          // （教評會讀 index 1 的 selected_candidates，考核會讀 index 3 的
          // selected_candidates_pr），並各自帶著自己的候選人/當然委員資料，
          // 呼叫 sendJointResultEmail 一次寄出合併信、附四個獨立檔案。
          var resultsPr = countVotesForActivity(ss, voteId, 3);
          var maxSelectablePr = configs[i][11];
          var candidatesDataPr = JSON.parse(configs[i][12] || "[]");
          var exOfficioMembersPr = JSON.parse(configs[i][13] || "[]");

          sendJointResultEmail(
            adminEmail, schoolName, voteId,
            results, resultsPr,
            maxSelectable, maxSelectablePr,
            candidatesData, candidatesDataPr,
            exOfficioMembers, exOfficioMembersPr
          );
        } else {
          // 發送結果與簽案 Email
          sendResultEmail(adminEmail, schoolName, voteId, results, maxSelectable, candidatesData, exOfficioMembers, committeeType);
        }

        // 標記已結案
        sheetConfig.getRange(i + 1, 8).setValue(true);
      } catch (err) {
        logActivityError(ss, voteId, schoolName, err);
      }
    }
  }
}

// 2026-08-18：簡單信箱格式檢查，擋掉空白、缺 @、缺網域這類明顯無效值，避免直接呼叫
// MailApp.sendEmail 才因為 "no recipient" 之類的例外中斷整個 checkAndCloseVotes。
function isValidEmailAddress(email) {
  if (!email || typeof email !== "string") return false;
  var trimmed = email.trim();
  if (!trimmed) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

// 2026-08-18：把 checkAndCloseVotes 單筆活動處理失敗的原因記錄到獨立的 Error_Log
// 工作表（沒有就自動建立），讓使用者事後能查是哪筆活動、什麼時間、什麼錯誤，
// 而不是被 Apps Script 系統寄的「執行失敗」通知信轟炸信箱。這個函式本身也包一層
// try/catch——萬一連寫入 Error_Log 都失敗（例如剛好也在鎖定中），退而求其次寫進
// 執行記錄 Logger，總之不能讓例外再往外拋、跳出 checkAndCloseVotes 的迴圈。
function logActivityError(ss, voteId, schoolName, err) {
  var message = (err && err.message) ? err.message : String(err);
  try {
    var sheet = ss.getSheetByName("Error_Log");
    if (!sheet) {
      sheet = ss.insertSheet("Error_Log");
      sheet.appendRow(["timestamp", "vote_id", "school_name", "error"]);
    }
    sheet.appendRow([new Date(), voteId, schoolName, message]);
  } catch (logErr) {
    Logger.log("logActivityError 寫入 Error_Log 失敗：" + logErr + "（原始錯誤：" + message + "）");
  }
  Logger.log("checkAndCloseVotes 跳過活動 " + voteId + "（" + schoolName + "）：" + message);
}

// 2026-08-11：新增 columnIndex 參數（預設第1欄=index 1，即 selected_candidates），
// 同時辦理模式結案時要對同一批 Vote_Results 列分別計票兩次——教評會讀 index 1，
// 考核會讀新增的 selected_candidates_pr（index 3）。totalVoted 兩邊算出來的數字
// 理論上會一樣（因為同一次送出同時填兩欄），這是設計上的自然結果，不是巧合。
function countVotesForActivity(ss, voteId, columnIndex) {
  var colIdx = columnIndex === undefined ? 1 : columnIndex;
  var sheetB = ss.getSheetByName("Vote_Results");
  var rows = sheetB.getDataRange().getValues();

  var voteCounts = {};
  var totalVotesCount = 0;

  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === voteId) {
      totalVotesCount++;
      var raw = rows[i][colIdx];
      var selected = raw ? JSON.parse(raw) : [];
      for (var j = 0; j < selected.length; j++) {
        var cand = selected[j];
        voteCounts[cand] = (voteCounts[cand] || 0) + 1;
      }
    }
  }

  // 排序
  var sorted = [];
  for (var candName in voteCounts) {
    sorted.push({ name: candName, count: voteCounts[candName] });
  }
  sorted.sort(function(a, b) { return b.count - a.count; });

  return {
    totalVoted: totalVotesCount,
    ranking: sorted
  };
}

// 2026-08-10：保障名額選任邏輯。原本只是單純「票數前 N 名」，事後才檢查性別/未兼行政
// 比例合不合格——這個順序是錯的，真實選務規則是「當選名單本身就要滿足保障名額」，
// 名次較後但能補足名額的人可能會遞補到名次較前、但屬於已超額類別的人前面。
// 演算法：依票數由高到低逐一考慮每位候選人，用「後面剩餘人選 + 剩餘名額」做可行性檢查
// ——如果納入這位候選人後，剩下的名額與candidate池仍然「湊得出」滿足門檻的組合，就納入；
// 否則跳過（該員移入備取），改看下一位。兩個門檻（未兼行政、性別）各自獨立檢查，
// 不處理「顧此失彼」的複雜交互情況（例如硬湊性別會讓未兼行政不夠的極端案例）——
// 這種情況會在 quotaUnmet 標記出來，信裡會請人事室自行確認，不會自己決定犧牲哪個門檻。
function selectCommitteeWithQuota(ranking, candidateInfoByName, N, nonAdminMin, maleMin, femaleMin) {
  var pool = ranking.map(function (r) {
    var info = candidateInfoByName[r.name] || {};
    return { name: r.name, count: r.count, gender: info.gender || null, isAdmin: info.isAdmin === true };
  });
  var n = pool.length;

  // 後綴計數：suffixX[k] = pool[k..n-1] 裡符合 X 條件的人數
  var suffixNonAdmin = new Array(n + 1).fill(0);
  var suffixMale = new Array(n + 1).fill(0);
  var suffixFemale = new Array(n + 1).fill(0);
  for (var k = n - 1; k >= 0; k--) {
    suffixNonAdmin[k] = suffixNonAdmin[k + 1] + (pool[k].isAdmin === false ? 1 : 0);
    suffixMale[k] = suffixMale[k + 1] + (pool[k].gender === "M" ? 1 : 0);
    suffixFemale[k] = suffixFemale[k + 1] + (pool[k].gender === "F" ? 1 : 0);
  }

  var elected = [];
  var deferred = []; // 因保障名額被跳過的人（依票數序），優先進備取
  var haveNonAdmin = 0, haveMale = 0, haveFemale = 0;
  var remainingSlots = N;

  for (var idx = 0; idx < n && remainingSlots > 0; idx++) {
    var cand = pool[idx];
    var afterNonAdmin = haveNonAdmin + (cand.isAdmin === false ? 1 : 0);
    var afterMale = haveMale + (cand.gender === "M" ? 1 : 0);
    var afterFemale = haveFemale + (cand.gender === "F" ? 1 : 0);

    var slotsLeftIfAdmit = remainingSlots - 1;
    var needNonAdmin = Math.max(0, nonAdminMin - afterNonAdmin);
    var needMale = Math.max(0, maleMin - afterMale);
    var needFemale = Math.max(0, femaleMin - afterFemale);

    var restCount = n - (idx + 1);
    var restNonAdmin = suffixNonAdmin[idx + 1];
    var restMale = suffixMale[idx + 1];
    var restFemale = suffixFemale[idx + 1];

    // feasibleIfAdmit 除了「後面剩的人裡湊得出所需類別」之外，還必須「剩下的名額數量本身
    // 就足夠塞得下這些還缺的人數」——少了 slotsLeftIfAdmit >= needX 這幾個條件的話，
    // 當名額快用完但某類別缺額還很多時，演算法會誤判成可行，一路把名額用光在不需要
    // 保障的類別上，導致最後真正該保障的名額根本沒被留住（實測發現過這個 bug）。
    var feasibleIfAdmit =
      restCount >= slotsLeftIfAdmit &&
      restNonAdmin >= needNonAdmin &&
      restMale >= needMale &&
      restFemale >= needFemale &&
      slotsLeftIfAdmit >= needNonAdmin &&
      slotsLeftIfAdmit >= needMale &&
      slotsLeftIfAdmit >= needFemale;

    if (feasibleIfAdmit) {
      elected.push(cand);
      haveNonAdmin = afterNonAdmin;
      haveMale = afterMale;
      haveFemale = afterFemale;
      remainingSlots--;
    } else {
      deferred.push(cand);
    }
  }

  // 保障名額湊不出來（例如符合條件的人票數太低、根本沒被選進候選人池）：
  // 名額還是要填滿，剩下的名額改回純票數序遞補，不隱瞞、不硬湊。
  if (remainingSlots > 0) {
    for (var d = 0; d < deferred.length && remainingSlots > 0; d++) {
      elected.push(deferred[d]);
      deferred.splice(d, 1);
      d--;
      remainingSlots--;
    }
  }

  // 用最終定案的 elected 名單重新統計一次人數——fallback 遞補（上面那段）不會經過
  // 前面可行性迴圈的計數邏輯，如果沿用迴圈中途的 have* 變數，遇到「名額真的湊不滿」
  // 的情況統計會跟實際當選名單對不起來（實測發現過這個 bug）。
  haveNonAdmin = elected.filter(function (c) { return c.isAdmin === false; }).length;
  haveMale = elected.filter(function (c) { return c.gender === "M"; }).length;
  haveFemale = elected.filter(function (c) { return c.gender === "F"; }).length;
  var quotaUnmet = { nonAdmin: haveNonAdmin < nonAdminMin, male: haveMale < maleMin, female: haveFemale < femaleMin };

  // 找出因保障名額被「跳過」的人（原始票數排名在最終正取名單之外、但票數其實比某些
  // 已當選者高）——這些人要在信裡清楚交代，不能悄悄跳過。
  var electedNameSet = {};
  elected.forEach(function (c) { electedNameSet[c.name] = true; });
  var promoted = []; // 名次原本在 N 名之外、但因保障名額遞補為正取
  var bumped = [];   // 名次原本在 N 名之內、但因保障名額被移出正取
  for (var p = 0; p < n; p++) {
    var inNaiveTopN = p < N;
    var inFinalElected = !!electedNameSet[pool[p].name];
    if (inNaiveTopN && !inFinalElected) bumped.push(pool[p]);
    if (!inNaiveTopN && inFinalElected) promoted.push(pool[p]);
  }

  // 備取：正取以外的人，依票數序取 5 名（deferred 優先，其餘照票數序補上）
  var electedNames2 = electedNameSet;
  var remainderPool = pool.filter(function (c) { return !electedNames2[c.name]; });
  var alternates = remainderPool.slice(0, 5);

  // 同票邊界提醒：正取最後一名 vs 緊接在後未入選者同票；備取最後一名 vs 緊接在後未入選者同票。
  // 這種情況法規上要真人抽籤決定，系統不自己用亂數假裝抽過。
  var tieWarnings = [];
  if (elected.length > 0) {
    var lastElectedCount = elected[elected.length - 1].count;
    var nextOutside = remainderPool.find(function (c) { return c.count === lastElectedCount; });
    if (nextOutside) {
      tieWarnings.push("正取最後一名（" + elected[elected.length - 1].name + "，" + lastElectedCount + " 票）與 " + nextOutside.name + "（" + nextOutside.count + " 票）票數相同，正取名單此處由系統依保障名額規則暫定，正式結果請人事室依規定辦理抽籤確認。");
    }
  }
  if (alternates.length === 5) {
    var lastAltCount = alternates[4].count;
    var rest5 = remainderPool.slice(5);
    var nextAfterAlt = rest5.find(function (c) { return c.count === lastAltCount; });
    if (nextAfterAlt) {
      tieWarnings.push("備取最後一名（" + alternates[4].name + "，" + lastAltCount + " 票）與 " + nextAfterAlt.name + "（" + nextAfterAlt.count + " 票）票數相同，請人事室依規定辦理抽籤確認備取順序。");
    }
  }

  return {
    elected: elected,
    alternates: alternates,
    promoted: promoted,
    bumped: bumped,
    quotaUnmet: quotaUnmet,
    tieWarnings: tieWarnings,
    haveNonAdmin: haveNonAdmin,
    haveMale: haveMale,
    haveFemale: haveFemale
  };
}

function sendResultEmail(adminEmail, schoolName, voteId, results, maxSelectable, candidatesData, exOfficioMembers, committeeType) {
  var now = new Date();
  var rocYear = now.getFullYear() - 1911;
  var rocMonth = now.getMonth() + 1;
  var rocDay = now.getDate();
  var dateStr = rocYear + "年" + rocMonth + "月" + rocDay + "日";
  var schoolYearStr = rocYear + "學年度";
  var nextSchoolYearStr = (rocYear + 1) + "年8月31日";

  // 2026-08-11：試算/保障名額選任/simeText/docx/xlsx 產生這一大段，同時辦理模式結案時
  // 要對教評會、考核會分別各跑一次，所以抽成 computeCommitteeSection 共用——這裡單選
  // 模式呼叫一次，輸出內容跟抽出前逐字相同，純粹是把同一段程式碼搬進另一個函式，沒有
  // 改任何邏輯或文字。
  var section = computeCommitteeSection({
    committeeType: committeeType,
    schoolName: schoolName,
    results: results,
    maxSelectable: maxSelectable,
    candidatesData: candidatesData,
    exOfficioMembers: exOfficioMembers,
    dateStr: dateStr,
    schoolYearStr: schoolYearStr,
    rocYear: rocYear,
    nextSchoolYearStr: nextSchoolYearStr
  });

  var html = "<h2>【" + schoolName + " " + section.committeeLabel + "選舉開票結果與簽案】</h2>";
  html += "<p><strong>活動代碼：</strong>" + voteId + "</p>";
  html += "<p><strong>總投票人數：</strong>" + results.totalVoted + " 人</p>";
  html += section.noticesHtml;
  html += section.tableHtml;
  html += section.memoHtml;

  var mailOptions = {
    to: adminEmail,
    subject: "【投票結果與正式公文簽案】" + schoolName + " " + schoolYearStr + section.committeeLabel + "選舉",
    htmlBody: html
  };
  var attachments = [];
  if (section.docxBlob) attachments.push(section.docxBlob);
  if (section.xlsxBlob) attachments.push(section.xlsxBlob);
  if (attachments.length > 0) {
    mailOptions.attachments = attachments;
  }

  MailApp.sendEmail(mailOptions);
}

// 2026-08-11：同時辦理 (joint) 模式用的結案信——同一場活動同時票選教評會與考核會，
// 結案時要分別算兩邊的組成門檻、保障名額選任、簽呈，最後合成一封信、附四個獨立檔案
// (教評會docx+xlsx、考核會docx+xlsx，不合併成一份)。兩邊都是呼叫同一個
// computeCommitteeSection，教評會/考核會各自的既有規則完全不受影響。
function sendJointResultEmail(adminEmail, schoolName, voteId, resultsTr, resultsPr, maxSelectableTr, maxSelectablePr, candidatesDataTr, candidatesDataPr, exOfficioMembersTr, exOfficioMembersPr) {
  var now = new Date();
  var rocYear = now.getFullYear() - 1911;
  var rocMonth = now.getMonth() + 1;
  var rocDay = now.getDate();
  var dateStr = rocYear + "年" + rocMonth + "月" + rocDay + "日";
  var schoolYearStr = rocYear + "學年度";
  var nextSchoolYearStr = (rocYear + 1) + "年8月31日";

  var sectionTr = computeCommitteeSection({
    committeeType: "teacher_review",
    schoolName: schoolName,
    results: resultsTr,
    maxSelectable: maxSelectableTr,
    candidatesData: candidatesDataTr,
    exOfficioMembers: exOfficioMembersTr,
    dateStr: dateStr,
    schoolYearStr: schoolYearStr,
    rocYear: rocYear,
    nextSchoolYearStr: nextSchoolYearStr
  });
  var sectionPr = computeCommitteeSection({
    committeeType: "performance_review",
    schoolName: schoolName,
    results: resultsPr,
    maxSelectable: maxSelectablePr,
    candidatesData: candidatesDataPr,
    exOfficioMembers: exOfficioMembersPr,
    dateStr: dateStr,
    schoolYearStr: schoolYearStr,
    rocYear: rocYear,
    nextSchoolYearStr: nextSchoolYearStr
  });

  var html = "<h2>【" + schoolName + " 教評會／教師成績考核委員會 同時辦理開票結果與簽案】</h2>";
  html += "<p><strong>活動代碼：</strong>" + voteId + "</p>";
  html += "<p><strong>總投票人數：</strong>" + resultsTr.totalVoted + " 人（同一次投票同時完成兩個委員會的圈選）</p>";
  html += "<p style='background:#eff6ff; border:1px solid #3b82f6; padding:10px 14px; border-radius:8px; color:#1e3a8a;'>本次為「同時辦理」活動，以下依序為 <strong>Part A 教評會</strong> 與 <strong>Part B 教師成績考核委員會</strong> 兩份獨立結果，各自的得票統計、簽呈、附件互不影響。</p>";

  html += "<hr style='margin:2rem 0; border:none; border-top:2px solid #1e293b;'>";
  html += "<h2 style='color:#1e40af;'>Part A：" + sectionTr.committeeLabel + "選舉結果</h2>";
  html += sectionTr.noticesHtml;
  html += sectionTr.tableHtml;
  html += sectionTr.memoHtml;

  html += "<hr style='margin:2rem 0; border:none; border-top:2px solid #1e293b;'>";
  html += "<h2 style='color:#b45309;'>Part B：" + sectionPr.committeeLabel + "選舉結果</h2>";
  html += sectionPr.noticesHtml;
  html += sectionPr.tableHtml;
  html += sectionPr.memoHtml;

  var mailOptions = {
    to: adminEmail,
    subject: "【投票結果與正式公文簽案】" + schoolName + " " + schoolYearStr + "教評會／教師成績考核委員會（同時辦理）選舉",
    htmlBody: html
  };
  var attachments = [];
  if (sectionTr.docxBlob) attachments.push(sectionTr.docxBlob);
  if (sectionTr.xlsxBlob) attachments.push(sectionTr.xlsxBlob);
  if (sectionPr.docxBlob) attachments.push(sectionPr.docxBlob);
  if (sectionPr.xlsxBlob) attachments.push(sectionPr.xlsxBlob);
  if (attachments.length > 0) {
    mailOptions.attachments = attachments;
  }

  MailApp.sendEmail(mailOptions);
}

// 單一委員會的完整試算＋文件產生邏輯（教評會/考核會共用同一個函式，用 committeeType
// 分支）。回傳的 html 片段刻意不含最外層的活動代碼/總投票人數/信件標題，那些由呼叫端
// （sendResultEmail 或 sendJointResultEmail）自己組，這個函式只管單一委員會自己的部分。
function computeCommitteeSection(p) {
  var committeeType = p.committeeType;
  var schoolName = p.schoolName;
  var results = p.results;
  var maxSelectable = p.maxSelectable;
  var candidatesData = p.candidatesData;
  var exOfficioMembers = p.exOfficioMembers;
  var dateStr = p.dateStr;
  var schoolYearStr = p.schoolYearStr;
  var rocYear = p.rocYear;
  var nextSchoolYearStr = p.nextSchoolYearStr;

  var isPerformanceReview = committeeType === "performance_review";
  var N = maxSelectable || 8;

  var candidateInfoByName = {};
  (candidatesData || []).forEach(function (c) {
    if (c && c.name) candidateInfoByName[c.name] = { gender: c.gender || null, isAdmin: c.isAdmin === true };
  });

  // 當然委員：教評會固定 3 人（校長/家長會代表/教師會代表）；考核會人數彈性（各校處室
  // 主管數量不同 + 教師會代表）。只有陣列裡每一位「姓名+性別都填」才視為資料齊全，
  // 納入「委員總額」計算，否則只用選舉委員 N 人當分母，並在信裡清楚註明。
  var exList = exOfficioMembers || [];
  var exFilled = exList.filter(function (m) { return m && m.name && (m.gender === "M" || m.gender === "F"); });
  var exComplete = exList.length > 0 && exFilled.length === exList.length;
  var exMaleCount = exFilled.filter(function (m) { return m.gender === "M"; }).length;
  var exFemaleCount = exFilled.filter(function (m) { return m.gender === "F"; }).length;
  var exCountForTotal = exList.length;

  var nonAdminMin, totalForGender;
  if (isPerformanceReview) {
    // 考核會規則（教師成績考核辦法第9條）：「委員每滿3人應有1人為未兼行政職務教師」，
    // 且「未兼行政職務教師人數之計算，應排除教師會代表」——所以分母要先扣掉教師會代表
    // 這一席，再以每滿 3 人的方式（無條件捨去）算下限。委員總額＝選舉委員 N 人＋當然
    // 委員（資料齊全時），資料不齊全時退而以 N 人估算，信裡會用 exGenderWarning 提醒。
    var hasTeacherAssoc = exFilled.some(function (m) { return (m.role || "").indexOf("教師會代表") !== -1; });
    var totalForNonAdmin = exComplete ? (N + exCountForTotal) : N;
    var teacherAssocExcl = (exComplete && hasTeacherAssoc) ? 1 : 0;
    nonAdminMin = Math.max(0, Math.floor((totalForNonAdmin - teacherAssocExcl) / 3));
    totalForGender = exComplete ? (N + exCountForTotal) : N;
  } else {
    // 教評會規則：既有計算方式不動。
    nonAdminMin = Math.ceil(N / 2);
    totalForGender = exComplete ? (N + 3) : N;
  }
  var minEachGender = Math.ceil(totalForGender / 3);
  var neededMaleFromElected = exComplete ? Math.max(0, minEachGender - exMaleCount) : minEachGender;
  var neededFemaleFromElected = exComplete ? Math.max(0, minEachGender - exFemaleCount) : minEachGender;

  var selection = selectCommitteeWithQuota(results.ranking, candidateInfoByName, N, nonAdminMin, neededMaleFromElected, neededFemaleFromElected);

  var electedList = selection.elected.map(function (c) { return c.name; });
  var electedNamesStr = electedList.length > 0 ? (electedList.join("、") + "等" + electedList.length + "人") : "無（無人得票）";
  var alternateList = selection.alternates.map(function (c) { return c.name; });
  var alternateNamesStr = alternateList.length > 0 ? (alternateList.join("、") + "等" + alternateList.length + "人") : "無";

  var totalMale = selection.haveMale + exMaleCount;
  var totalFemale = selection.haveFemale + exFemaleCount;

  // 動態組出「第五項」實際核算文字，不是寫死的空話。教評會與考核會的法規條文用語不同，
  // 分開組字串；教評會這支分支內容跟改動前逐字相同，不動既有行為。
  var item5Text;
  if (isPerformanceReview) {
    item5Text = "五、經檢視本會委員，未兼行政職務之教師共 " + selection.haveNonAdmin + " 人，";
    item5Text += exComplete
      ? ("又男性委員 " + totalMale + " 人，女性委員 " + totalFemale + " 人，")
      : ("性別部分本次僅計入選舉委員（男性 " + selection.haveMale + " 人、女性 " + selection.haveFemale + " 人），");
    item5Text += (selection.quotaUnmet.nonAdmin || selection.quotaUnmet.male || selection.quotaUnmet.female)
      ? "【" + (selection.quotaUnmet.nonAdmin ? "未兼行政職務教師未達應有之 " + nonAdminMin + " 人" : "") +
        (selection.quotaUnmet.nonAdmin && (selection.quotaUnmet.male || selection.quotaUnmet.female) ? "，" : "") +
        ((selection.quotaUnmet.male || selection.quotaUnmet.female) ? "任一性別委員未達應有之 " + minEachGender + " 人" : "") +
        "，請人事室確認】"
      : "符合";
    item5Text += "「委員每滿3人應有1人為未兼行政職務教師（計算排除教師會代表）；任一性別委員應占委員總數三分之一以上」之規定。";
  } else {
    item5Text = "五、經檢視本次當選之選舉委員（" + electedList.length + " 人）中，未兼行政職務之教師共 " + selection.haveNonAdmin + " 人，";
    item5Text += selection.quotaUnmet.nonAdmin
      ? "【未達應有之 " + nonAdminMin + " 人，請人事室確認】"
      : "符合";
    item5Text += "「未兼行政之教師不得少於委員總額之二分之一」之規定。";

    if (exComplete) {
      item5Text += "又連同當然委員 3 人（校長、家長會代表、教師會代表）在內，委員總額 " + totalForGender + " 人中，男性委員 " + totalMale + " 人、女性委員 " + totalFemale + " 人，";
      item5Text += (selection.quotaUnmet.male || selection.quotaUnmet.female)
        ? "【未達任一性別應有之 " + minEachGender + " 人，請人事室確認】"
        : "符合";
      item5Text += "「任一性別委員人數不得少於委員總額三分之一」之規定。";
    } else {
      item5Text += "性別部分，本次當選之選舉委員中男性委員 " + selection.haveMale + " 人、女性委員 " + selection.haveFemale + " 人，";
      item5Text += (selection.quotaUnmet.male || selection.quotaUnmet.female)
        ? "【未達任一性別應有之 " + minEachGender + " 人，請人事室確認】"
        : "符合";
      item5Text += "「任一性別委員人數不得少於委員總額三分之一」之規定。";
    }
  }

  // 當然委員資料不齊全時，「請人事室補資料再自行確認」這種操作性提醒不適合寫進正式簽呈，
  // 改成只在信件內文顯示的提醒橫幅，簽呈檔案（docx/HTML 公文預覽）維持制式內容。
  var exGenderWarning = "";
  if (!exComplete) {
    var exOfficioDesc = isPerformanceReview ? "各處室主管、教師會代表" : "校長、家長會代表、教師會代表";
    exGenderWarning = "<p style='background:#fff7ed; border:1px solid #f59e0b; padding:12px; border-radius:8px;'><strong>⚠ 性別比例提醒：</strong>當然委員（" + exOfficioDesc + "）姓名/性別尚未完整填寫，簽呈中的性別比例僅以本次選舉委員 " + electedList.length + " 人計算，未併入當然委員與委員總額。請人事室補齊當然委員資料後，自行確認全體委員是否仍符合相關比例規定。</p>";
  }

  var adjustmentNote = "";
  if (selection.promoted.length > 0 || selection.bumped.length > 0) {
    adjustmentNote += "<p style='background:#fff7ed; border:1px solid #f59e0b; padding:12px; border-radius:8px;'><strong>⚠ 名額調整說明：</strong>為符合未兼行政教師與性別比例保障名額規定，系統依票數高低並保留保障名額，對原始票數排名做了以下調整：</p><ul>";
    selection.promoted.forEach(function (c) {
      adjustmentNote += "<li>" + c.name + "（" + c.count + " 票）因保障名額遞補為正取。</li>";
    });
    selection.bumped.forEach(function (c) {
      adjustmentNote += "<li>" + c.name + "（" + c.count + " 票）原票數排名在應選人數內，因保障名額已滿，移入備取。</li>";
    });
    adjustmentNote += "</ul>";
  }

  var tieNote = "";
  if (selection.tieWarnings.length > 0) {
    tieNote = "<p style='background:#fef2f2; border:1px solid #ef4444; padding:12px; border-radius:8px;'><strong>⚠ 同票提醒：</strong><br>" + selection.tieWarnings.join("<br>") + "</p>";
  }

  // 考核會當然委員清單文字（「教務主任王小明、學務主任...及教師會代表...」），姓名空白的
  // 成員略過不列名，只列有登記姓名的人——docx 跟 html 公文預覽都用這一份，不重複組字串。
  var exOfficioListText = exFilled.map(function (m) { return (m.role || "") + m.name; }).join("、");
  var totalCommitteeCount = exComplete ? (N + exCountForTotal) : N;

  // 2026-09-01：教師成績考核辦法第9條但書──「參加考核之教師人數未滿20人者，得降低委員
  // 人數，最低不得少於5人，其中當然委員至多2人」。前端沒有把「參加考核教師人數」這個
  // 數字送進後端，但但書成不成立最終還是反映在「實際組成的委員總額」上：只要
  // totalCommitteeCount 低於本文下限 9 人，唯一合法的依據就是這條但書，所以用這個已經
  // 算好的委員總額直接反推是否適用但書，不用另外多傳一個欄位、也不用管理者自己判斷。
  // 9～17 人（含）維持原本本文用語；低於 9 人才切換成但書用語。
  var isSmallCommittee = isPerformanceReview && totalCommitteeCount > 0 && totalCommitteeCount < 9;

  // 2026-08-10：Word 附件產生要放在組 html 之前執行，這樣失敗訊息才能直接寫進信件內文，
  // 不用再去挖執行紀錄（Apps Script 的「執行項目」面板實測常常延遲或找不到記錄，
  // 不是可靠的除錯管道，直接把錯誤寫進信裡使用者自己看得到，比較好排查）。
  var docxBlob = null;
  var docxErrorNote = "";
  try {
    if (isPerformanceReview) {
      docxBlob = generateAssessmentMemoDocx({
        schoolName: schoolName,
        dateStr: dateStr,
        schoolYearStr: schoolYearStr,
        rocYear: rocYear,
        maxSelectable: N,
        totalCommitteeCount: totalCommitteeCount,
        exCountForTotal: exCountForTotal,
        exOfficioListText: exOfficioListText,
        nonAdminMin: nonAdminMin,
        minEachGender: minEachGender,
        electedNamesStr: electedNamesStr,
        alternateNamesStr: alternateNamesStr,
        item5Text: item5Text,
        isSmallCommittee: isSmallCommittee
      });
    } else {
      docxBlob = generateOfficialMemoDocx({
        schoolName: schoolName,
        dateStr: dateStr,
        schoolYearStr: schoolYearStr,
        nextSchoolYearStr: nextSchoolYearStr,
        rocYear: rocYear,
        maxSelectable: N,
        electedNamesStr: electedNamesStr,
        alternateNamesStr: alternateNamesStr,
        item5Text: item5Text
      });
    }
  } catch (docErr) {
    docxErrorNote = "<p style='background:#fef2f2; border:1px solid #ef4444; padding:12px; border-radius:8px;'><strong>⚠ Word 簽案草稿附件產生失敗：</strong>" + String(docErr) + "<br>信件本身仍正常寄出，下方 HTML 版草稿一樣可以直接複製使用。若錯誤訊息包含「permission」或「authorization」等字樣，通常是 Google 文件／雲端硬碟的存取權限還沒授權完成——請到 Apps Script 編輯器，從函式下拉選單任選一個函式執行一次，跳出的授權視窗點到底（檢查權限 → 選帳號 → 進階 → 前往專案 → 允許），授權完成後下次結案信就會正常有附件。</p>";
    Logger.log("Word 簽案草稿產生失敗: " + docErr);
  }

  // 2026-08-10：得票統計表也做一份 .xlsx 附件（標題列上色、正取/備取列標色、自動欄寬），
  // 用的是跟 Word 附件一樣的機制（建立暫存 Google 檔案 → 匯出格式 → 刪掉暫存檔），
  // 已經有 Drive 權限了，不需要再多要新的授權範圍。
  var electedNameSet = {};
  selection.elected.forEach(function (c) { electedNameSet[c.name] = true; });
  var alternateNameSet = {};
  selection.alternates.forEach(function (c) { alternateNameSet[c.name] = true; });

  var xlsxBlob = null;
  var xlsxErrorNote = "";
  try {
    xlsxBlob = generateVoteTallyXlsx({
      schoolName: schoolName,
      ranking: results.ranking,
      electedNameSet: electedNameSet,
      alternateNameSet: alternateNameSet,
      candidateInfoByName: candidateInfoByName,
      committeeLabel: isPerformanceReview ? "教師成績考核委員會" : "教評會"
    });
  } catch (xlsxErr) {
    xlsxErrorNote = "<p style='background:#fef2f2; border:1px solid #ef4444; padding:12px; border-radius:8px;'><strong>⚠ 得票統計表 .xlsx 附件產生失敗：</strong>" + String(xlsxErr) + "<br>信件本身仍正常寄出，下方 HTML 版統計表一樣可以直接查看。</p>";
    Logger.log("得票統計表 .xlsx 產生失敗: " + xlsxErr);
  }

  var committeeLabel = isPerformanceReview ? "教師成績考核委員會" : "教評會委員";

  var tableHtml = "<h3>一、 得票統計表</h3>";
  tableHtml += "<table border='1' cellpadding='8' cellspacing='0' style='border-collapse:collapse; width:100%; max-width:600px;'>";
  tableHtml += "<tr style='background:#f1f5f9;'><th>名次</th><th>候選人姓名</th><th>得票數</th></tr>";

  for (var i = 0; i < results.ranking.length; i++) {
    tableHtml += "<tr>";
    tableHtml += "<td style='text-align:center;'>" + (i + 1) + "</td>";
    tableHtml += "<td><strong>" + results.ranking[i].name + "</strong></td>";
    tableHtml += "<td style='text-align:center;'>" + results.ranking[i].count + " 票</td>";
    tableHtml += "</tr>";
  }
  tableHtml += "</table>";

  var memoHtml = "<h3 style='margin-top:2rem;'>二、 正式公文簽案草稿 (可直接複製貼上至學校公文系統，或直接使用附件 Word 檔)</h3>";
  memoHtml += "<div style='background:#ffffff; padding:25px; border:2px solid #000; font-family:\"標楷體\", \"PMingLiU\", serif; font-size:1.1rem; line-height:2.0; max-width:800px; color:#000;'>";

  if (isPerformanceReview) {
    memoHtml += "<p style='font-size:1.3rem; font-weight:bold; text-align:center; margin-bottom:1.5rem;'>簽 於人事室　　　　　　　　日期：" + dateStr + "</p>";
    memoHtml += "<p><strong>主旨：</strong>為辦理本校" + schoolYearStr + "教師成績考核委員會改選事宜，請核示。</p>";
    memoHtml += "<p><strong>說明：</strong><br>";
    memoHtml += (isSmallCommittee
      ? "一、依據「公立高級中等以下學校教師成績考核辦法」第9條規定略以：教師成績考核委員會由委員9至17人組成，除掌理教務、學生事務、輔導、人事業務之單位主管及教師會代表1人為當然委員外，其餘由本校教師票選產生，並由委員互推1人為主席；但參加考核之教師人數未滿20人者，得降低委員人數，最低不得少於5人，其中當然委員至多2人，除教師會代表外，其餘由校長指定之。本校依前開但書規定辦理，委員中每滿3人應有1人為未兼行政職務教師（計算排除教師會代表），任一性別委員應占委員總數三分之一以上，其任期自" + rocYear + "年9月1日至" + (rocYear + 1) + "年8月31日止。<br>"
      : "一、依據「公立高級中等以下學校教師成績考核辦法」第9條規定略以：教師成績考核委員會由委員9至17人組成，除掌理教務、學生事務、輔導、人事業務之單位主管及教師會代表1人為當然委員外，其餘由本校教師票選產生，並由委員互推1人為主席，其中委員每滿3人應有1人為未兼行政職務教師（計算排除教師會代表），任一性別委員應占委員總數三分之一以上，其任期自" + rocYear + "年9月1日至" + (rocYear + 1) + "年8月31日止。<br>");
    memoHtml += "二、本校教師成績考核委員會組成人數，經校務會議決議設置委員人數" + totalCommitteeCount + "人，" + (exOfficioListText ? "依規定由" + exOfficioListText + "，合計" + exCountForTotal + "人為當然委員" : "當然委員" + exCountForTotal + "人") + "；另應票選委員" + N + "人，且委員中未兼行政職務教師應至少" + nonAdminMin + "人，任一性別委員應至少" + minEachGender + "人（票數相同者以抽籤定之，惟仍須受限於兼行政及性別比例之規定）；另依票數高低列候補委員若干人（如有同票等情事酌予增列）。<br>";
    memoHtml += "三、本次票選時間完竣（票選統計請參見附件），相關選票如後附。<br>";
    memoHtml += "四、本校開票完竣，按票數高低所產生之票選委員正、備取名單如下（票數相同者，以抽籤決定順序）：<br>";
    memoHtml += "（一）正取委員：" + electedNamesStr + "。<br>";
    memoHtml += "（二）備取委員：" + alternateNamesStr + "。（於當選委員因故不能擔任時依序遞補之）<br>";
    memoHtml += item5Text + "</p>";
    memoHtml += "<p><strong>擬辦：</strong>奉核可後，公告本校教師同仁知悉。</p>";
    memoHtml += "<p style='margin-top:2rem;'>敬陳<br>校長</p>";
    memoHtml += "<p style='margin-top:1.5rem;'>第一層決行<br>承辦單位　人事室　　　　　　決行</p>";
  } else {
    memoHtml += "<p style='font-size:1.3rem; font-weight:bold; text-align:center; margin-bottom:1.5rem;'>簽 於人事室　　　　　　　　日期：" + dateStr + "</p>";
    memoHtml += "<p><strong>主旨：</strong>為辦理本校" + schoolYearStr + "教師評審委員會改選事宜，詳如說明，請核示。</p>";
    memoHtml += "<p><strong>說明：</strong><br>";
    memoHtml += "一、依據「高級中等以下學校教師評審委員會設置辦法」第3條規定略以，本會置委員5至19人，其組成方式如下：<br>";
    memoHtml += "（一）當然委員：包括校長、家長會代表、教師會代表各1人。<br>";
    memoHtml += "（二）選舉委員：由全體教師選（推）舉之。本會委員中未兼行政之教師不得少於委員總額之二分之一，任一性別委員人數不得少於委員總額三分之一。<br>";
    memoHtml += "（三）本委員會任期自" + rocYear + "年9月1日起至" + nextSchoolYearStr + "止。<br>";
    memoHtml += "二、復依本校教師評審委員會設置要點規定略以，本會置委員11人，除當然委員3人外，餘選舉委員" + N + "人由教師票選產生（票數相同者以抽籤定之，惟仍須受限於兼行政及性別比例之規定）；另依票數高低列候補委員若干人（如有同票等情事酌予增列）。<br>";
    memoHtml += "三、本次票選時間完竣，相關選票如後附。<br>";
    memoHtml += "四、本校開票完竣，按票數高低所產生之票選委員正、備取名單如下（票數相同者，以抽籤決定順序）：<br>";
    memoHtml += "（一）正取委員：" + electedNamesStr + "。<br>";
    memoHtml += "（二）備取委員：" + alternateNamesStr + "。（於當選委員因故不能擔任時依序遞補之）<br>";
    memoHtml += item5Text + "</p>";
    memoHtml += "<p><strong>擬辦：</strong>奉核可後，公告本校教師知悉。</p>";
    memoHtml += "<p style='margin-top:2rem;'>敬陳<br>校長</p>";
    memoHtml += "<p style='margin-top:1.5rem;'>第一層決行<br>承辦單位　人事室　　　　　　決行</p>";
  }
  memoHtml += "</div>";

  var noticesHtml = adjustmentNote + tieNote + exGenderWarning + docxErrorNote + xlsxErrorNote;

  return {
    committeeLabel: committeeLabel,
    noticesHtml: noticesHtml,
    tableHtml: tableHtml,
    memoHtml: memoHtml,
    docxBlob: docxBlob,
    xlsxBlob: xlsxBlob
  };
}

// 產生一份美化過的得票統計表 .xlsx：標題列上色、正取/備取列標色、置中對齊、自動欄寬、凍結表頭。
function generateVoteTallyXlsx(p) {
  var ss = SpreadsheetApp.create("得票統計表-" + p.schoolName + "-" + new Date().getTime());
  var sheet = ss.getSheets()[0];
  sheet.setName("得票統計表");

  var headers = ["名次", "候選人姓名", "得票數", "結果", "身分別", "性別"];

  sheet.getRange(1, 1, 1, headers.length).merge();
  var titleCell = sheet.getRange(1, 1);
  titleCell.setValue("【" + p.schoolName + "】" + (p.committeeLabel || "教評會") + "選舉得票統計表");
  titleCell.setFontSize(14).setFontWeight("bold").setHorizontalAlignment("center");
  sheet.setRowHeight(1, 34);

  sheet.getRange(2, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(2, 1, 1, headers.length)
    .setFontWeight("bold")
    .setBackground("#2563eb")
    .setFontColor("#ffffff")
    .setHorizontalAlignment("center");

  var rows = p.ranking.map(function (r, idx) {
    var info = p.candidateInfoByName[r.name] || {};
    var result = p.electedNameSet[r.name] ? "正取" : (p.alternateNameSet[r.name] ? "備取" : "未入列");
    var category = info.isAdmin === true ? "兼行政教師" : (info.isAdmin === false ? "未兼行政教師" : "未知");
    var genderText = info.gender === "M" ? "男" : (info.gender === "F" ? "女" : "未知");
    return [idx + 1, r.name, r.count, result, category, genderText];
  });

  if (rows.length > 0) {
    var dataRange = sheet.getRange(3, 1, rows.length, headers.length);
    dataRange.setValues(rows);
    dataRange.setHorizontalAlignment("center");
    dataRange.setBorder(true, true, true, true, true, true, "#cbd5e1", SpreadsheetApp.BorderStyle.SOLID);

    for (var r = 0; r < rows.length; r++) {
      var rowRange = sheet.getRange(3 + r, 1, 1, headers.length);
      if (rows[r][3] === "正取") {
        rowRange.setBackground("#d1fae5");
      } else if (rows[r][3] === "備取") {
        rowRange.setBackground("#fef3c7");
      }
    }
  }

  sheet.getRange(2, 1, 1, headers.length).setBorder(true, true, true, true, true, true, "#1e40af", SpreadsheetApp.BorderStyle.SOLID);
  sheet.setFrozenRows(2);
  for (var col = 1; col <= headers.length; col++) {
    sheet.autoResizeColumn(col);
  }

  SpreadsheetApp.flush();
  var fileId = ss.getId();
  var xlsxBlob = exportDriveFileAs(
    fileId,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ).setName("得票統計表-" + p.schoolName + ".xlsx");

  // 轉檔用的暫存 Google 試算表不需要留在雲端硬碟裡，轉完就丟到垃圾桶。
  DriveApp.getFileById(fileId).setTrashed(true);

  return xlsxBlob;
}

// 用 Drive REST API 的 export 端點把 Google 文件/試算表轉成 Office 格式。
// DriveApp.File.getAs() 對這種轉檔情境不穩定，官方建議改走 export 端點。
function exportDriveFileAs(fileId, mimeType) {
  var url =
    "https://www.googleapis.com/drive/v3/files/" +
    fileId +
    "/export?mimeType=" +
    encodeURIComponent(mimeType);
  var resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error(
      "Drive export 失敗 (" + resp.getResponseCode() + "): " + resp.getContentText()
    );
  }
  return resp.getBlob();
}

// 用 Google 文件服務組出跟範例格式一致的簽案草稿，轉存成 .docx 當附件。
// 需要 Google 文件／雲端硬碟的存取權限（見 appsscript.json 的 oauthScopes）。
function generateOfficialMemoDocx(p) {
  var doc = DocumentApp.create("簽-" + p.schoolName + "教評委員改選-" + new Date().getTime());
  var body = doc.getBody();
  body.setMarginTop(56).setMarginBottom(56).setMarginLeft(56).setMarginRight(56);

  addDocPara(body, "簽 於人事室\t\t\t\t\t日期：" + p.dateStr, 0, true, 16);
  addDocPara(body, "", 0);
  addDocPara(body, "主旨：為辦理本校" + p.schoolYearStr + "教師評審委員會改選事宜，詳如說明，請核示。", 0);
  addDocPara(body, "說明：", 0);
  addDocPara(body, "一、依據「高級中等以下學校教師評審委員會設置辦法」第3條規定略以，本會置委員5至19人，其組成方式如下：", 1);
  addDocPara(body, "（一）當然委員：包括校長、家長會代表、教師會代表各1人。", 2);
  addDocPara(body, "（二）選舉委員：由全體教師選（推）舉之。本會委員中未兼行政之教師不得少於委員總額之二分之一，任一性別委員人數不得少於委員總額三分之一。", 2);
  addDocPara(body, "（三）本委員會任期自" + p.rocYear + "年9月1日起至" + p.nextSchoolYearStr + "止。", 2);
  addDocPara(body, "二、復依本校教師評審委員會設置要點規定略以，本會置委員11人，除當然委員3人外，餘選舉委員" + p.maxSelectable + "人由教師票選產生（票數相同者以抽籤定之，惟仍須受限於兼行政及性別比例之規定）；另依票數高低列候補委員若干人（如有同票等情事酌予增列）。", 1);
  addDocPara(body, "三、本次票選時間完竣，相關選票如後附。", 1);
  addDocPara(body, "四、本校開票完竣，按票數高低所產生之票選委員正、備取名單如下（票數相同者，以抽籤決定順序）：", 1);
  addDocPara(body, "（一）正取委員：" + p.electedNamesStr + "。", 2);
  addDocPara(body, "（二）備取委員：" + p.alternateNamesStr + "。（於當選委員因故不能擔任時依序遞補之）", 2);
  addDocPara(body, p.item5Text, 1);
  addDocPara(body, "擬辦：奉核可後，公告本校教師知悉。", 0);
  addDocPara(body, "", 0);
  addDocPara(body, "敬陳", 0);
  addDocPara(body, "校長", 0);
  addDocPara(body, "第一層決行", 0);
  addDocPara(body, "承辦單位　　　　　　　　　決行", 0);

  doc.saveAndClose();
  var docId = doc.getId();
  var docxBlob = exportDriveFileAs(
    docId,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ).setName("簽-" + p.schoolName + "教評委員改選.docx");

  // 轉檔用的暫存 Google 文件不需要留在雲端硬碟裡，轉完就丟到垃圾桶。
  DriveApp.getFileById(docId).setTrashed(true);

  return docxBlob;
}

// 考核會版簽案草稿。跟 generateOfficialMemoDocx 分開寫成獨立函式（不是共用同一份文字再
// 用 if 分支），是為了不去動已經穩定運作的教評會產字邏輯——兩邊格式雖然神似，但法規條文、
// 當然委員組成、未兼行政門檻公式都不同，硬共用反而容易在教評會那邊產生非預期的回歸。
function generateAssessmentMemoDocx(p) {
  var doc = DocumentApp.create("簽-" + p.schoolName + "成績考核委員改選-" + new Date().getTime());
  var body = doc.getBody();
  body.setMarginTop(56).setMarginBottom(56).setMarginLeft(56).setMarginRight(56);

  var exOfficioClause = p.exOfficioListText
    ? ("依規定由" + p.exOfficioListText + "，合計" + p.exCountForTotal + "人為當然委員")
    : ("當然委員" + p.exCountForTotal + "人");

  addDocPara(body, "簽 於人事室\t\t\t\t\t日期：" + p.dateStr, 0, true, 16);
  addDocPara(body, "", 0);
  addDocPara(body, "主旨：為辦理本校" + p.schoolYearStr + "教師成績考核委員會改選事宜，請核示。", 0);
  addDocPara(body, "說明：", 0);
  addDocPara(body, (p.isSmallCommittee
    ? "一、依據「公立高級中等以下學校教師成績考核辦法」第9條規定略以：教師成績考核委員會由委員9至17人組成，除掌理教務、學生事務、輔導、人事業務之單位主管及教師會代表1人為當然委員外，其餘由本校教師票選產生，並由委員互推1人為主席；但參加考核之教師人數未滿20人者，得降低委員人數，最低不得少於5人，其中當然委員至多2人，除教師會代表外，其餘由校長指定之。本校依前開但書規定辦理，委員中每滿3人應有1人為未兼行政職務教師（計算排除教師會代表），任一性別委員應占委員總數三分之一以上，其任期自" + p.rocYear + "年9月1日至" + (p.rocYear + 1) + "年8月31日止。"
    : "一、依據「公立高級中等以下學校教師成績考核辦法」第9條規定略以：教師成績考核委員會由委員9至17人組成，除掌理教務、學生事務、輔導、人事業務之單位主管及教師會代表1人為當然委員外，其餘由本校教師票選產生，並由委員互推1人為主席，其中委員每滿3人應有1人為未兼行政職務教師（計算排除教師會代表），任一性別委員應占委員總數三分之一以上，其任期自" + p.rocYear + "年9月1日至" + (p.rocYear + 1) + "年8月31日止。"), 1);
  addDocPara(body, "二、本校教師成績考核委員會組成人數，經校務會議決議設置委員人數" + p.totalCommitteeCount + "人，" + exOfficioClause + "；另應票選委員" + p.maxSelectable + "人，且委員中未兼行政職務教師應至少" + p.nonAdminMin + "人，任一性別委員應至少" + p.minEachGender + "人（票數相同者以抽籤定之，惟仍須受限於兼行政及性別比例之規定）；另依票數高低列候補委員若干人（如有同票等情事酌予增列）。", 1);
  addDocPara(body, "三、本次票選時間完竣（票選統計請參見附件），相關選票如後附。", 1);
  addDocPara(body, "四、本校開票完竣，按票數高低所產生之票選委員正、備取名單如下（票數相同者，以抽籤決定順序）：", 1);
  addDocPara(body, "（一）正取委員：" + p.electedNamesStr + "。", 2);
  addDocPara(body, "（二）備取委員：" + p.alternateNamesStr + "。（於當選委員因故不能擔任時依序遞補之）", 2);
  addDocPara(body, p.item5Text, 1);
  addDocPara(body, "擬辦：奉核可後，公告本校教師同仁知悉。", 0);
  addDocPara(body, "", 0);
  addDocPara(body, "敬陳", 0);
  addDocPara(body, "校長", 0);
  addDocPara(body, "第一層決行", 0);
  addDocPara(body, "承辦單位　　　　　　　　　決行", 0);

  doc.saveAndClose();
  var docId = doc.getId();
  var docxBlob = exportDriveFileAs(
    docId,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ).setName("簽-" + p.schoolName + "成績考核委員改選.docx");

  // 轉檔用的暫存 Google 文件不需要留在雲端硬碟裡，轉完就丟到垃圾桶。
  DriveApp.getFileById(docId).setTrashed(true);

  return docxBlob;
}

function addDocPara(body, text, indentLevel, bold, fontSize) {
  var para = body.appendParagraph(text);
  var textEl = para.editAsText();
  textEl.setFontSize(fontSize || 12);
  if (bold) textEl.setBold(true);
  if (indentLevel) para.setIndentStart(indentLevel * 28);
  return para;
}

function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
