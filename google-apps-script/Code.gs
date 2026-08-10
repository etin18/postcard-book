/**
 * 明信片通訊錄 App 後端 API — Google Apps Script
 *
 * 部署方式：
 *   1. 開啟目標 Google 試算表 → 擴充功能 → Apps Script
 *   2. 把本檔內容整份貼上，存檔
 *   3. 部署 → 新增部署作業 → 類型選「網頁應用程式」
 *      - 執行身分：我
 *      - 具有存取權的使用者：任何人
 *   4. 複製產生的網址（結尾是 /exec），貼進 App 的「設定」
 *
 * 兩個資料表都會在第一次呼叫時自動建立：
 *   「朋友」    — 通訊錄。同一個人搬家後會有多列，用 personId 串起來
 *   「明信片」  — 每一張寄出的明信片
 *
 * ★★ 通關密語（重要，建議一定要設）★★
 *   把下面的 SECRET 改成你自己的一組密語（英數字，例如 'postcard2026kk'），
 *   再到 App 設定填入「同一組」密語。這樣就算有人拿到你的網址，
 *   沒有密語也讀不到、改不了你的資料 —— 這裡面是朋友的住家地址，要當密碼保管。
 *
 *   ⚠️ 改好密語的這份程式是貼在「你自己的」Apps Script 編輯器裡，
 *      密語只存在 Google 端。請「不要」把含有真實密語的版本貼回 GitHub
 *      或任何公開的地方 —— 那等於把鑰匙公開。
 *
 *   （SECRET 留空字串代表不驗證，任何知道網址的人都能存取，僅供測試。）
 */

var SECRET = '';   // ← 改成你自己的通關密語，例如 'postcard2026kk'

var FRIEND_SHEET_NAME = '朋友';
var CARD_SHEET_NAME = '明信片';

var FRIEND_HEADERS = [
  'id', 'personId', 'name', 'recipient', 'address',
  'city', 'postalCode', 'country', 'status', 'createdAt'
];

var CARD_HEADERS = [
  'id', 'personId', 'friendName', 'country', 'date',
  'note', 'received', 'hasPhoto', 'createdAt'
];

var STATUS_CURRENT = '現用';
var STATUS_MOVED = '已搬家';

/* ---------- 進入點 ---------- */

/**
 * 用瀏覽器直接開這個網址時的回應。
 * 不從這裡讀資料 —— 讀寫一律走 POST 並驗證密語，避免有人用 GET 繞過。
 */
function doGet(e) {
  return respond({ ok: true, service: '明信片通訊錄 API', message: '這是 API 端點，請從 App 使用。' });
}

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ ok: false, error: '無法解析請求內容' });
  }
  return respond(route(payload));
}

/**
 * 所有操作都在 script lock 內執行，避免同時送出時互相蓋掉。
 */
function route(payload) {
  var action = payload.action || 'list';

  // 通關密語驗證（SECRET 留空則略過）。放最前面，錯的密語連鎖都不用搶。
  var expected = String(SECRET || '').trim();
  if (expected && String(payload.secret || '').trim() !== expected) {
    return { ok: false, error: '通關密語錯誤，請到設定確認', authError: true };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return { ok: false, error: '系統忙碌中，請稍後再試' };
  }

  try {
    switch (action) {
      case 'list':
        return { ok: true, friends: listFriends(), cards: listCards() };
      case 'createFriend':
        return { ok: true, friend: createFriend(payload.friend) };
      case 'updateFriend':
        return { ok: true, friend: updateFriend(payload.friend) };
      case 'deleteFriend':
        return { ok: true, personId: deleteFriend(payload.personId) };
      case 'createCard':
        return { ok: true, card: createCard(payload.card) };
      case 'updateCard':
        return { ok: true, card: updateCard(payload.card) };
      case 'deleteCard':
        return { ok: true, id: deleteCard(payload.id) };
      default:
        return { ok: false, error: '未知的操作：' + action };
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    lock.releaseLock();
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ==========================================================================
   朋友（通訊錄）

   搬家的作法：不覆蓋舊地址，而是把舊列的 status 改成「已搬家」，
   再新增一列「現用」，兩列共用同一個 personId。
   App 搜尋只看現用那列，舊地址留在詳情裡當歷史。
   ========================================================================== */

function getFriendSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(FRIEND_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(FRIEND_SHEET_NAME);
    sheet.getRange(1, 1, 1, FRIEND_HEADERS.length).setValues([FRIEND_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, FRIEND_HEADERS.length).setFontWeight('bold');
    // 郵遞區號設純文字，否則像 '05001' 這種開頭是 0 的會被 Sheets 吃成 5001
    sheet.getRange(2, 7, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
    sheet.setColumnWidth(1, 250); // id
    sheet.setColumnWidth(2, 250); // personId
    sheet.setColumnWidth(5, 300); // address
  }
  return sheet;
}

function listFriends() {
  var sheet = getFriendSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, FRIEND_HEADERS.length).getValues();
  var friends = [];

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue; // 略過空列
    friends.push({
      id: String(row[0]),
      personId: String(row[1] || row[0]),
      name: String(row[2] || ''),
      recipient: String(row[3] || ''),
      address: String(row[4] || ''),
      city: String(row[5] || ''),
      postalCode: String(row[6] || ''),
      country: String(row[7] || ''),
      status: String(row[8] || STATUS_CURRENT),
      createdAt: normalizeTimestamp(row[9])
    });
  }
  return friends;
}

function createFriend(friend) {
  validateFriend(friend);
  var sheet = getFriendSheet();

  var record = normalizeFriend(friend);
  record.id = friend.id || Utilities.getUuid();
  record.personId = friend.personId || record.id;
  record.createdAt = new Date().toISOString();

  sheet.appendRow(friendToRow(record));
  sheet.getRange(sheet.getLastRow(), 7).setNumberFormat('@');

  return record;
}

function updateFriend(friend) {
  if (!friend || !friend.id) throw new Error('缺少要更新的朋友 id');
  validateFriend(friend);

  var sheet = getFriendSheet();
  var rowIndex = findRowById(sheet, friend.id);
  if (rowIndex === -1) throw new Error('找不到這位朋友，可能已被刪除');

  var existing = sheet.getRange(rowIndex, 1, 1, FRIEND_HEADERS.length).getValues()[0];

  var record = normalizeFriend(friend);
  record.id = friend.id;
  record.personId = friend.personId || String(existing[1] || friend.id);
  record.createdAt = normalizeTimestamp(existing[9]) || new Date().toISOString();

  sheet.getRange(rowIndex, 1, 1, FRIEND_HEADERS.length).setValues([friendToRow(record)]);
  sheet.getRange(rowIndex, 7).setNumberFormat('@');

  return record;
}

/**
 * 刪除一位朋友＝刪掉他名下所有地址列（含搬家歷史）。
 * 已寄出的明信片紀錄不動 —— 那些是寄信歷史，朋友刪了也該留著。
 */
function deleteFriend(personId) {
  if (!personId) throw new Error('缺少要刪除的朋友編號');

  var sheet = getFriendSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return personId;

  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var removed = 0;

  // 由下往上刪，才不會因為刪列而讓後面的索引位移
  for (var i = values.length - 1; i >= 0; i--) {
    var rowPersonId = String(values[i][1] || values[i][0]);
    if (rowPersonId === String(personId)) {
      sheet.deleteRow(i + 2);
      removed++;
    }
  }

  if (!removed) throw new Error('找不到這位朋友，可能已被刪除');
  return personId;
}

function friendToRow(f) {
  return [
    f.id, f.personId, f.name, f.recipient, f.address,
    f.city, f.postalCode, f.country, f.status, f.createdAt
  ];
}

function normalizeFriend(friend) {
  var status = String(friend.status || STATUS_CURRENT).trim();
  return {
    id: friend.id,
    personId: friend.personId,
    name: String(friend.name || '').trim(),
    recipient: String(friend.recipient || '').trim(),
    address: String(friend.address || '').trim(),
    city: String(friend.city || '').trim(),
    postalCode: String(friend.postalCode || '').trim(),
    country: String(friend.country || '').trim(),
    status: status === STATUS_MOVED ? STATUS_MOVED : STATUS_CURRENT,
    createdAt: friend.createdAt
  };
}

/* ==========================================================================
   明信片
   ========================================================================== */

function getCardSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CARD_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CARD_SHEET_NAME);
    sheet.getRange(1, 1, 1, CARD_HEADERS.length).setValues([CARD_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, CARD_HEADERS.length).setFontWeight('bold');
    // 日期欄設為純文字，避免 Sheets 自動把 2026-08-07 轉成本地日期格式
    sheet.getRange(2, 5, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
    sheet.setColumnWidth(1, 250); // id
    sheet.setColumnWidth(2, 250); // personId
    sheet.setColumnWidth(6, 260); // note
  }
  return sheet;
}

function listCards() {
  var sheet = getCardSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, CARD_HEADERS.length).getValues();
  var cards = [];

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue;
    cards.push({
      id: String(row[0]),
      personId: String(row[1] || ''),
      friendName: String(row[2] || ''),
      country: String(row[3] || ''),
      date: normalizeDate(row[4]),
      note: String(row[5] || ''),
      received: row[6] === true || String(row[6]).toUpperCase() === 'TRUE',
      hasPhoto: row[7] === true || String(row[7]).toUpperCase() === 'TRUE',
      createdAt: normalizeTimestamp(row[8])
    });
  }
  return cards;
}

function createCard(card) {
  validateCard(card);
  var sheet = getCardSheet();

  var record = normalizeCard(card);
  record.id = card.id || Utilities.getUuid();
  record.createdAt = new Date().toISOString();

  sheet.appendRow(cardToRow(record));
  sheet.getRange(sheet.getLastRow(), 5).setNumberFormat('@');

  return record;
}

function updateCard(card) {
  if (!card || !card.id) throw new Error('缺少要更新的明信片 id');
  validateCard(card);

  var sheet = getCardSheet();
  var rowIndex = findRowById(sheet, card.id);
  if (rowIndex === -1) throw new Error('找不到這張明信片，可能已被刪除');

  var existing = sheet.getRange(rowIndex, 1, 1, CARD_HEADERS.length).getValues()[0];

  var record = normalizeCard(card);
  record.id = card.id;
  record.createdAt = normalizeTimestamp(existing[8]) || new Date().toISOString();

  sheet.getRange(rowIndex, 1, 1, CARD_HEADERS.length).setValues([cardToRow(record)]);
  sheet.getRange(rowIndex, 5).setNumberFormat('@');

  return record;
}

function deleteCard(id) {
  if (!id) throw new Error('缺少要刪除的明信片 id');
  var sheet = getCardSheet();
  var rowIndex = findRowById(sheet, id);
  if (rowIndex === -1) throw new Error('找不到這張明信片，可能已被刪除');
  sheet.deleteRow(rowIndex);
  return id;
}

function cardToRow(c) {
  return [
    c.id, c.personId, c.friendName, c.country, c.date,
    c.note, c.received, c.hasPhoto, c.createdAt
  ];
}

function normalizeCard(card) {
  return {
    id: card.id,
    personId: String(card.personId || '').trim(),
    friendName: String(card.friendName || '').trim(),
    country: String(card.country || '').trim(),
    date: normalizeDate(card.date),
    note: String(card.note || ''),
    received: !!card.received,
    hasPhoto: !!card.hasPhoto,
    createdAt: card.createdAt
  };
}

/* ==========================================================================
   共用
   ========================================================================== */

function findRowById(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2; // +2：跳過表頭且轉 1-based
  }
  return -1;
}

function validateFriend(friend) {
  if (!friend) throw new Error('缺少朋友資料');
  if (!String(friend.name || '').trim()) throw new Error('請填寫朋友名稱');
  if (!String(friend.address || '').trim()) throw new Error('請填寫地址');
  if (!String(friend.country || '').trim()) throw new Error('請填寫國家');
}

function validateCard(card) {
  if (!card) throw new Error('缺少明信片資料');
  if (!String(card.personId || '').trim()) throw new Error('請選擇要寄給誰');
  if (!String(card.country || '').trim()) throw new Error('請填寫寄出國家');
  if (!card.date) throw new Error('缺少寄出日期');
}

/**
 * 試算表可能把日期回傳為 Date 物件或字串，統一輸出 YYYY-MM-DD。
 */
function normalizeDate(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var text = String(value || '').trim();
  var match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) {
    return match[1] + '-' + pad2(match[2]) + '-' + pad2(match[3]);
  }
  return text;
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || '');
}

function pad2(n) {
  n = String(n);
  return n.length < 2 ? '0' + n : n;
}
