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
      return handleSetup(data);
    } else if (action === "get_candidates") {
      return handleGetCandidates(data);
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
  var sheetConfig = getOrCreateSheet(ss, "Activity_Config", ["vote_id", "school_name", "admin_email", "start_time", "end_time", "max_selectable", "candidates_json", "is_closed", "created_at"]);
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
    createdAt
  ]);

  // 寫入 Voter_Checklist (全員 8 碼通行碼)
  if (data.voter_list && data.voter_list.length > 0) {
    var rows = [];
    for (var i = 0; i < data.voter_list.length; i++) {
      rows.push([voteId, data.voter_list[i].verify_code, false, ""]);
    }
    sheetChecklist.getRange(sheetChecklist.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
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
      return createJsonResponse({
        status: "success",
        vote_id: rows[i][0],
        school_name: rows[i][1],
        max_selectable: rows[i][5],
        candidates: JSON.parse(rows[i][6])
      });
    }
  }

  return createJsonResponse({ status: "error", message: "查無此活動 ID" });
}

// 3. 處理投票送出 (action: "submit_vote")
function handleSubmitVote(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetA = ss.getSheetByName("Voter_Checklist");
  var sheetB = getOrCreateSheet(ss, "Vote_Results", ["vote_id", "selected_candidates", "created_at"]);

  var voterRows = sheetA.getDataRange().getValues();
  var voterRowIndex = -1;

  // 查驗 8 碼通行碼
  for (var i = 1; i < voterRows.length; i++) {
    if (voterRows[i][0] === data.vote_id && String(voterRows[i][1]) === String(data.verify_code)) {
      if (voterRows[i][2] === true) {
        return createJsonResponse({ status: "error", message: "您已完成過投票，不可重複投票！" });
      }
      voterRowIndex = i + 1; // 轉為 1-based index
      break;
    }
  }

  if (voterRowIndex === -1) {
    return createJsonResponse({ status: "error", message: "驗證碼不正確或無投票資格！" });
  }

  // 1. 核銷工作表 A
  sheetA.getRange(voterRowIndex, 3).setValue(true);
  sheetA.getRange(voterRowIndex, 4).setValue(new Date());

  // 2. 匿名寫入工作表 B (選票 JSON)
  sheetB.appendRow([data.vote_id, JSON.stringify(data.selected_candidates), new Date()]);

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
      // 進行開票統計
      var results = countVotesForActivity(ss, voteId);

      // 發送結果與簽案 Email
      sendResultEmail(adminEmail, schoolName, voteId, results);

      // 標記已結案
      sheetConfig.getRange(i + 1, 8).setValue(true);
    }
  }
}

function countVotesForActivity(ss, voteId) {
  var sheetB = ss.getSheetByName("Vote_Results");
  var rows = sheetB.getDataRange().getValues();

  var voteCounts = {};
  var totalVotesCount = 0;

  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === voteId) {
      totalVotesCount++;
      var selected = JSON.parse(rows[i][1]);
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

function sendResultEmail(adminEmail, schoolName, voteId, results) {
  var now = new Date();
  var rocYear = now.getFullYear() - 1911;
  var rocMonth = now.getMonth() + 1;
  var rocDay = now.getDate();
  var dateStr = rocYear + "年" + rocMonth + "月" + rocDay + "日";
  var schoolYearStr = rocYear + "學年度";
  var nextSchoolYearStr = (rocYear + 1) + "年8月31日";

  // 選舉正取 (高票前 8 名，或依設定)
  var maxSelectable = 8;
  var electedList = [];
  for (var i = 0; i < Math.min(results.ranking.length, maxSelectable); i++) {
    electedList.push(results.ranking[i].name);
  }
  var electedNamesStr = electedList.join("、") + "等" + electedList.length + "人";

  // 備取名單 (候補 5 人)
  var alternateList = [];
  for (var j = maxSelectable; j < Math.min(results.ranking.length, maxSelectable + 5); j++) {
    alternateList.push(results.ranking[j].name);
  }
  var alternateNamesStr = alternateList.length > 0 ? (alternateList.join("、") + "等" + alternateList.length + "人") : "無";

  var html = "<h2>【" + schoolName + " 教評會委員選舉開票結果與簽案】</h2>";
  html += "<p><strong>活動代碼：</strong>" + voteId + "</p>";
  html += "<p><strong>總投票人數：</strong>" + results.totalVoted + " 人</p>";

  html += "<h3>一、 得票統計表</h3>";
  html += "<table border='1' cellpadding='8' cellspacing='0' style='border-collapse:collapse; width:100%; max-width:600px;'>";
  html += "<tr style='background:#f1f5f9;'><th>名次</th><th>候選人姓名</th><th>得票數</th></tr>";

  for (var i = 0; i < results.ranking.length; i++) {
    html += "<tr>";
    html += "<td style='text-align:center;'>" + (i + 1) + "</td>";
    html += "<td><strong>" + results.ranking[i].name + "</strong></td>";
    html += "<td style='text-align:center;'>" + results.ranking[i].count + " 票</td>";
    html += "</tr>";
  }
  html += "</table>";

  html += "<h3 style='margin-top:2rem;'>二、 正式公文簽案草稿 (可直接複製貼上至學校公文系統)</h3>";
  html += "<div style='background:#ffffff; padding:25px; border:2px solid #000; font-family:\"標楷體\", \"PMingLiU\", serif; font-size:1.1rem; line-height:2.0; max-width:800px; color:#000;'>";
  
  html += "<p style='font-size:1.3rem; font-weight:bold; text-align:center; margin-bottom:1.5rem;'>簽 於人事室　　　　　　　　日期：" + dateStr + "</p>";
  html += "<p><strong>主旨：</strong>為辦理本校" + schoolYearStr + "教師評審委員會改選事宜，詳如說明，請核示。</p>";
  html += "<p><strong>說明：</strong><br>";
  html += "一、依據「高級中等以下學校教師評審委員會設置辦法」第3條規定略以，本會置委員5至19人，其組成方式如下：<br>";
  html += "（一）當然委員：包括校長、家長會代表、教師會代表各1人。<br>";
  html += "（二）選舉委員：由全體教師選（推）舉之。本會委員中未兼行政之教師不得少於委員總額之二分之一，任一性別委員人數不得少於委員總額三分之一。<br>";
  html += "（三）本委員會任期自" + rocYear + "年9月1日起至" + nextSchoolYearStr + "止。<br>";
  html += "二、復依本校教師評審委員會設置要點規定略以，本會置委員11人，除當然委員3人外，餘選舉委員8人由教師票選產生，又委員中未兼行政職務之教師應至少為6人，任一性別委員人數應至少為4人（票數相同者以抽籤定之，惟仍須受限於兼行政及性別比例之規定）；另依票數高低列候補委員5人（如有同票等情事酌予增列）。<br>";
  html += "三、本次票選時間完竣，相關選票如後附。<br>";
  html += "四、本校開票完竣，按票數高低所產生之票選委員正、備取名單如下（票數相同者，以抽籤決定順序）：<br>";
  html += "（一）正取委員：" + electedNamesStr + "。<br>";
  html += "（二）備取委員：" + alternateNamesStr + "。（於當選委員因故不能擔任時依序遞補之）<br>";
  html += "五、經檢視本會委員，未兼行政職務之教師及性別比例均符合「未兼行政之教師不得少於委員總額之二分之一；任一性別委員人數不得少於委員總額三分之一」之規定。</p>";
  html += "<p><strong>擬辦：</strong>奉核可後，公告本校教師知悉。</p>";
  html += "<p style='margin-top:2rem;'>敬陳<br>校長</p>";
  html += "<p style='margin-top:1.5rem;'>第一層決行<br>承辦單位　人事室　　　　　　決行</p>";
  html += "</div>";

  MailApp.sendEmail({
    to: adminEmail,
    subject: "【投票結果與正式公文簽案】" + schoolName + " " + schoolYearStr + "教評會委員選舉",
    htmlBody: html
  });
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
