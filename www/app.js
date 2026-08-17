/* ==========================================================================
   明信片通訊錄 — 應用程式邏輯

   資料流：本機是操作的即時真相，Google 試算表是同步目標。
   每筆變更先寫進本機（畫面立刻更新），再排隊送上試算表；
   沒網路時就留在佇列裡，等有網路自動補送。

   這個 App 最重要的離線情境是「人在國外站在郵局裡查地址」，
   所以通訊錄整份留在本機，沒訊號也一定查得到。
   ========================================================================== */

'use strict';

/* ---------- 常數 ---------- */

const LS = {
  apiUrl: 'pc.apiUrl',
  secret: 'pc.secret',
  friends: 'pc.friends',
  cards: 'pc.cards',
  lastSync: 'pc.lastSync',
  theme: 'pc.theme',
};

const STATUS_CURRENT = '現用';
const STATUS_MOVED = '已搬家';

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

/* ---------- 狀態 ---------- */

const state = {
  friends: [],          // 所有地址列，含已搬家的歷史
  cards: [],
  apiUrl: '',
  secret: '',
  lastSync: null,
  syncing: false,
  lastError: null,

  theme: 'light',    // light | dark | auto
  page: 'send',
  query: '',
  openPersonId: null,   // 目前展開中的朋友

  editingFriendId: null,
  editingCardId: null,

  sendPhoto: null,      // 展開表單裡待寫入的 {full, thumb}
  cardPhoto: null,      // 編輯明信片時待寫入的
  cardPhotoCleared: false,

  filters: { friend: '', country: '', from: '', to: '', unreceived: false },
};

const thumbUrls = new Map(); // cardId -> objectURL，避免每次重繪都重建

/* ---------- 小工具 ---------- */

const $ = (id) => document.getElementById(id);

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return toDateStr(d);
}

function toDateStr(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** '2026-08-07' → { y, m, d, wd, date }，用本地時區解析避免跨日誤差 */
function parseDate(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return { y, m, d, wd: WEEKDAYS[date.getDay()], date };
}

/** 今年的日期省略年份，前天以內講「今天／昨天」 */
function fmtDate(str) {
  if (!str) return '';
  if (str === todayStr()) return '今天';
  if (str === todayStr(-1)) return '昨天';
  const { y, m, d } = parseDate(str);
  const thisYear = new Date().getFullYear();
  return y === thisYear ? `${m}月${d}日` : `${y}年${m}月${d}日`;
}

function daysSince(str) {
  if (!str) return 0;
  const { date } = parseDate(str);
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-open'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-open');
    setTimeout(() => { el.hidden = true; }, 220);
  }, 2400);
}

/* ==========================================================================
   本機儲存
   ========================================================================== */

function loadLocal() {
  try {
    state.apiUrl = localStorage.getItem(LS.apiUrl) || '';
    state.secret = localStorage.getItem(LS.secret) || '';
    state.friends = JSON.parse(localStorage.getItem(LS.friends) || '[]');
    state.cards = JSON.parse(localStorage.getItem(LS.cards) || '[]');
    state.lastSync = localStorage.getItem(LS.lastSync) || null;
    state.theme = localStorage.getItem(LS.theme) || 'light';
  } catch (err) {
    console.warn('讀取本機資料失敗', err);
  }
}

function saveLocal() {
  try {
    localStorage.setItem(LS.friends, JSON.stringify(state.friends));
    localStorage.setItem(LS.cards, JSON.stringify(state.cards));
    if (state.lastSync) localStorage.setItem(LS.lastSync, state.lastSync);
  } catch (err) {
    toast('本機儲存空間不足');
  }
}

/* ==========================================================================
   照片：IndexedDB（只存在這支手機）
   ========================================================================== */

const PhotoDB = (() => {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('postcard-book', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('photos', mode);
      const store = t.objectStore('photos');
      const req = fn(store);
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    });
  }

  return {
    get: (id) => tx('readonly', (s) => s.get(id)),
    put: (id, value) => tx('readwrite', (s) => s.put(value, id)),
    remove: (id) => tx('readwrite', (s) => s.delete(id)),
    clear: () => tx('readwrite', (s) => s.clear()),
    async all() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const out = [];
        const t = db.transaction('photos', 'readonly');
        const req = t.objectStore('photos').openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve(out);
          out.push({ id: cur.key, value: cur.value });
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },
  };
})();

/** 縮到指定邊長後轉 JPEG，手機直接拍的大圖不會塞爆本機空間 */
async function compressImage(file, maxSide, quality) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (err) {
    bitmap = await loadViaImgTag(file); // 舊版 Safari 或不支援的格式
  }

  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function loadViaImgTag(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取圖片')); };
    img.src = url;
  });
}

async function pickPhoto(file) {
  const [full, thumb] = await Promise.all([
    compressImage(file, 1400, 0.78),
    compressImage(file, 240, 0.7),
  ]);
  return { full, thumb };
}

async function getThumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const rec = await PhotoDB.get(id);
  if (!rec || !rec.thumb) return null;
  const url = URL.createObjectURL(rec.thumb);
  thumbUrls.set(id, url);
  return url;
}

function forgetThumb(id) {
  const url = thumbUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  thumbUrls.delete(id);
}

/* ==========================================================================
   API（Google Apps Script）
   ========================================================================== */

/**
 * 所有讀寫都走 POST，密語放在 body 裡（不放網址，免得出現在伺服器日誌）。
 * Content-Type 用 text/plain 讓瀏覽器當成「簡單請求」，
 * 才不會發出 Apps Script 無法回應的 OPTIONS 預檢。
 */
async function apiCall(payload) {
  const res = await fetch(state.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret: state.secret || '' }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`連線失敗（${res.status}）`);
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.error || '伺服器回報錯誤');
    if (data.authError) err.authError = true; // 密語錯誤，讓上層特別提示
    throw err;
  }
  return data;
}

/* ==========================================================================
   同步
   ========================================================================== */

function setSyncStatus(kind, text) {
  const chip = $('sync-chip');
  chip.className = 'sync-chip' + (kind ? ` is-${kind}` : '');
  $('sync-text').textContent = text;
}

function pendingCount() {
  return state.friends.filter((f) => f._op).length + state.cards.filter((c) => c._op).length;
}

function refreshSyncChip() {
  const n = pendingCount();
  if (!state.apiUrl) return setSyncStatus('', '尚未設定');
  if (state.syncing) return setSyncStatus('busy', '同步中');
  if (n > 0) return setSyncStatus('wait', `${n} 筆待同步`);
  if (!navigator.onLine) return setSyncStatus('', '離線');
  return setSyncStatus('ok', '已同步');
}

function friendPayload(f) {
  return {
    id: f.id,
    personId: f.personId,
    name: f.name,
    recipient: f.recipient,
    address: f.address,
    city: f.city,
    postalCode: f.postalCode,
    country: f.country,
    status: f.status,
  };
}

function cardPayload(c) {
  return {
    id: c.id,
    personId: c.personId,
    friendName: c.friendName,
    country: c.country,
    date: c.date,
    note: c.note,
    received: !!c.received,
    hasPhoto: !!c.hasPhoto,
  };
}

/**
 * 先把本機佇列推上去，再拉回完整清單。
 * 推送失敗的項目保留 _op 標記，下次同步再試。
 */
async function sync({ silent = true } = {}) {
  if (!state.apiUrl) {
    refreshSyncChip();
    if (!silent) toast('請先到設定填入試算表網址');
    return false;
  }
  if (state.syncing) return false;
  if (!navigator.onLine) {
    refreshSyncChip();
    if (!silent) toast('目前離線，紀錄會先存在手機裡');
    return false;
  }

  state.syncing = true;
  refreshSyncChip();

  let hadError = null;

  try {
    // 1) 推送朋友佇列。刪除是整個人（含搬家歷史），所以先收集 personId 去重
    const deletedPersons = new Set();
    for (const f of state.friends.filter((x) => x._op === 'delete')) {
      deletedPersons.add(f.personId);
    }
    for (const personId of deletedPersons) {
      try {
        // 只在伺服器上真的存在過才需要送刪除
        const everSynced = state.friends.some(
          (f) => f.personId === personId && f._op === 'delete' && f._synced
        );
        if (everSynced) await apiCall({ action: 'deleteFriend', personId });
        state.friends = state.friends.filter((f) => f.personId !== personId);
      } catch (err) {
        if (/找不到這位朋友/.test(err.message)) {
          state.friends = state.friends.filter((f) => f.personId !== personId);
        } else {
          hadError = err;
        }
      }
    }

    for (const f of state.friends.filter((x) => x._op)) {
      try {
        const action = f._op === 'create' ? 'createFriend' : 'updateFriend';
        await apiCall({ action, friend: friendPayload(f) });
        delete f._op;
        f._synced = true;
      } catch (err) {
        if (f._op === 'update' && /找不到這位朋友/.test(err.message)) {
          // 伺服器端已被刪掉，改用新增補回去
          f._op = 'create';
        } else {
          hadError = err;
        }
      }
    }

    // 2) 推送明信片佇列
    for (const c of state.cards.filter((x) => x._op)) {
      try {
        if (c._op === 'delete') {
          if (c._synced) await apiCall({ action: 'deleteCard', id: c.id });
          state.cards = state.cards.filter((x) => x.id !== c.id);
        } else {
          const action = c._op === 'create' ? 'createCard' : 'updateCard';
          await apiCall({ action, card: cardPayload(c) });
          delete c._op;
          c._synced = true;
        }
      } catch (err) {
        if (/找不到這張明信片/.test(err.message)) {
          if (c._op === 'delete') {
            state.cards = state.cards.filter((x) => x.id !== c.id);
          } else {
            c._op = 'create';
          }
        } else {
          hadError = err;
        }
      }
    }

    // 3) 拉回伺服器版本，疊上仍未同步的本機變更
    const data = await apiCall({ action: 'list' });

    state.friends = mergeById(data.friends || [], state.friends);
    state.cards = mergeById(data.cards || [], state.cards);
    state.lastSync = new Date().toISOString();
    saveLocal();
  } catch (err) {
    hadError = err;
  } finally {
    state.syncing = false;
  }

  render();
  refreshSyncChip();
  state.lastError = hadError || null;

  if (hadError) {
    setSyncStatus('error', hadError.authError ? '密語錯誤' : '同步失敗');
    if (!silent) toast(hadError.message || '同步失敗');
    return false;
  }
  return true;
}

/** 伺服器版本為底，本機還沒送出去的變更蓋在上面 */
function mergeById(serverRows, localRows) {
  const map = new Map(serverRows.map((r) => [r.id, { ...r, _synced: true }]));
  for (const local of localRows) {
    if (local._op) map.set(local.id, local);
  }
  return [...map.values()];
}

/* ==========================================================================
   朋友資料查詢
   ========================================================================== */

/** 沒被刪除的列 */
function liveFriends() {
  return state.friends.filter((f) => f._op !== 'delete');
}

/** 每人現用的那一列 */
function currentFriends() {
  return liveFriends().filter((f) => f.status !== STATUS_MOVED);
}

function friendOf(personId) {
  return currentFriends().find((f) => f.personId === personId) || null;
}

/** 某人的舊地址，新的在前 */
function movedAddresses(personId) {
  return liveFriends()
    .filter((f) => f.personId === personId && f.status === STATUS_MOVED)
    .sort((a, b) => (b.createdAt || '') < (a.createdAt || '') ? -1 : 1);
}

/** 名稱、收件人、城市、國家都能比對得到 */
function searchFriends(query) {
  const list = currentFriends().sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-Hant')
  );
  const q = query.trim().toLowerCase();
  if (!q) return list;

  return list.filter((f) => (
    [f.name, f.recipient, f.city, f.country]
      .some((v) => String(v || '').toLowerCase().includes(q))
  ));
}

/** 明信片上要寫的完整地址，一行一段 */
function formatAddress(f) {
  const lines = [];
  lines.push(f.recipient || f.name);
  if (f.address) lines.push(f.address);

  const cityLine = [f.city, f.postalCode].filter(Boolean).join(' ');
  if (cityLine) lines.push(cityLine);

  if (f.country) lines.push(f.country.toUpperCase());
  return lines.join('\n');
}

/** 用過的國家，最近用的排前面 —— 寄信時多半還在同一國 */
function knownCountries() {
  const seen = new Map();
  const sorted = [...state.cards].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const c of sorted) {
    if (c.country && !seen.has(c.country)) seen.set(c.country, true);
  }
  for (const f of currentFriends()) {
    if (f.country && !seen.has(f.country)) seen.set(f.country, true);
  }
  return [...seen.keys()];
}

function cardsOf(personId) {
  return state.cards.filter((c) => c._op !== 'delete' && c.personId === personId);
}

/* ==========================================================================
   渲染
   ========================================================================== */

function render() {
  if (state.page === 'send') {
    // 有人正展開著（可能正在填寫寄送欄位），這時重繪會把輸入清掉。
    // 背景同步完成也會走到這裡，所以一定要讓路。
    if (!state.openPersonId) renderFriendList();
  }
  if (state.page === 'history') renderHistory();
  if (state.page === 'settings') renderSettings();
  renderCountryDatalist();
  refreshSyncChip();
}

function renderCountryDatalist() {
  $('country-list').innerHTML = knownCountries()
    .map((c) => `<option value="${escapeHtml(c)}"></option>`)
    .join('');
}

/* ---------- 分頁 1：朋友列表 ---------- */

function renderFriendList() {
  const box = $('friend-list');
  exitFocus();   // 重繪等於展開的內容沒了，聚焦狀態要跟著收
  const all = currentFriends();
  const results = searchFriends(state.query);
  const searching = state.query.trim().length > 0;

  $('send-empty').hidden = all.length > 0;
  $('search-noresult').hidden = !(searching && results.length === 0);
  if (searching && results.length === 0) {
    $('noresult-term').textContent = state.query.trim();
  }

  box.innerHTML = results.map(friendRowHtml).join('');
}

/** 頭像色跟著「人」固定 —— 用 personId 決定，排序或搜尋都不會換色 */
function avatarTone(personId) {
  let h = 0;
  for (let i = 0; i < personId.length; i++) {
    h = (h * 31 + personId.charCodeAt(i)) % 4;
  }
  return h + 1;
}

function friendRowHtml(f) {
  const loc = [f.city, f.country].filter(Boolean).join(' · ');
  const initial = (f.name || '?').trim().charAt(0);
  const tone = avatarTone(f.personId);

  return `
    <div class="friend" data-person="${escapeHtml(f.personId)}">
      <div class="friend__row">
        <button class="friend__open" type="button" data-open="${escapeHtml(f.personId)}">
          <span class="friend__avatar friend__avatar--${tone}" aria-hidden="true">${escapeHtml(initial)}</span>
          <span class="friend__main">
            <span class="friend__name">${escapeHtml(f.name)}</span>
            <span class="friend__loc">${escapeHtml(loc || '沒有填城市與國家')}</span>
          </span>
          <svg class="friend__chev" viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
            <path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="friend__copy" type="button" data-copy="${escapeHtml(f.personId)}"
                aria-label="複製 ${escapeHtml(f.name)} 的地址">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/>
            <path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5"
                  stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="friend__detail" hidden></div>
    </div>`;
}

/* ---------- 展開：地址 ＋ 寄一張 ---------- */

function openDetail(personId) {
  const wrap = document.querySelector(`.friend[data-person="${CSS.escape(personId)}"]`);
  const f = friendOf(personId);
  if (!wrap || !f) return;

  const box = wrap.querySelector('.friend__detail');
  box.innerHTML = detailHtml(f);
  box.hidden = false;
  wrap.classList.add('is-open');

  state.sendPhoto = null;
  bindSendForm(f);

  // 展開後表單很長，浮動的 ＋ 會壓在「記下這張明信片」上面
  $('fab').hidden = true;

  // 其他人收起來、搜尋框不再浮動（浮著會蓋住正在抄的地址）
  $('friend-list').classList.add('is-focused');
  document.querySelector('.searchbar').classList.add('is-static');

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * 收掉聚焦模式。獨立成一個函式是因為離開聚焦有兩條路：
 * 一是收合展開的人，二是搜尋時整份列表重繪（那時舊的 DOM 已經不在了）。
 * 少走其中一條就會留下 is-focused，列表會整個看不見。
 */
function exitFocus() {
  $('friend-list').classList.remove('is-focused');
  document.querySelector('.searchbar').classList.remove('is-static');
  if (state.page === 'send') $('fab').hidden = false;
  state.sendPhoto = null;
}

function closeDetail(personId) {
  exitFocus();

  const wrap = document.querySelector(`.friend[data-person="${CSS.escape(personId)}"]`);
  if (!wrap) return;
  const box = wrap.querySelector('.friend__detail');
  box.hidden = true;
  box.innerHTML = '';
  wrap.classList.remove('is-open');
}

/**
 * 編輯／搬家／刪除都是從展開的詳情裡進去的，改完得先收起來，
 * 否則 render() 會為了保護填寫中的表單而跳過列表重繪，畫面就停在舊資料。
 */
function resetDetail() {
  if (!state.openPersonId) return;
  closeDetail(state.openPersonId);
  state.openPersonId = null;
}

function detailHtml(f) {
  const cityLine = [f.city, f.postalCode].filter(Boolean).join(' ');
  const old = movedAddresses(f.personId);
  const sent = cardsOf(f.personId);
  const countries = knownCountries().slice(0, 3);

  const lastSent = sent.length
    ? [...sent].sort((a, b) => (a.date < b.date ? 1 : -1))[0]
    : null;

  // 地址區塊用 white-space: pre-line 呈現，模板裡不能有多餘換行，
  // 否則會在畫面上變成真的空行
  const addrBlock =
    `<div class="addr">` +
    `<span class="addr__name">${escapeHtml(f.recipient || f.name)}</span>` +
    `${escapeHtml(f.address)}${cityLine ? '\n' + escapeHtml(cityLine) : ''}` +
    `<span class="addr__country">${escapeHtml(f.country)}</span>` +
    `</div>`;

  const pinIcon = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"
            stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="12" cy="10" r="2.4" stroke="currentColor" stroke-width="2"/>
    </svg>`;

  const cardIcon = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
      <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" stroke-width="2"/>
      <path d="M13 10h5M13 14h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 6v12" stroke="currentColor" stroke-width="2"/>
    </svg>`;

  return `
    <div class="detail-lookup">
      <p class="zone-head">${pinIcon} 地址</p>
      ${addrBlock}

      <div class="detail-btns">
        <button class="btn" type="button" data-copy2="${escapeHtml(f.personId)}">複製地址</button>
        <button class="btn" type="button" data-edit="${escapeHtml(f.personId)}">編輯</button>
      </div>

      ${sent.length ? `
        <p class="sent-note">
          寄過 ${sent.length} 張給他${lastSent ? ` · 最後一次 ${escapeHtml(fmtDate(lastSent.date))}` : ''}
        </p>` : ''}

      ${old.length ? `
        <div class="history-old">
          <p class="history-old__title">以前住過</p>
          ${old.map((o) => `
            <p class="history-old__item">
              ${escapeHtml([o.address, o.city, o.country].filter(Boolean).join(', '))}
            </p>`).join('')}
        </div>` : ''}
    </div>

    <form class="sendform" id="send-form">
      <p class="zone-head">${cardIcon} 這次寄給 ${escapeHtml(f.name)} 的明信片</p>

      <div class="field">
        <span class="field__label">從哪個國家寄</span>
        <input class="input" id="send-country" type="text" placeholder="例如 日本"
               maxlength="40" autocomplete="off" list="country-list" required>
        ${countries.length ? `
          <span class="quickpick" id="send-country-quick">
            <span class="quickpick__label">最近寄過</span>
            ${countries.map((c) => `
              <button class="quickpick__item" type="button"
                      data-country="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}
          </span>` : ''}
      </div>

      <div class="field">
        <span class="field__label">寄出日期</span>
        <input class="input input--date" id="send-date" type="date"
               value="${todayStr()}" required>
        <span class="quickpick" id="send-date-quick">
          <button class="quickpick__item is-on" type="button" data-offset="0">今天</button>
          <button class="quickpick__item" type="button" data-offset="-1">昨天</button>
        </span>
      </div>

      <div class="field">
        <span class="field__label">備註</span>
        <textarea class="input input--area" id="send-note" rows="2"
                  placeholder="寫了什麼、當下的心情（選填）" maxlength="200"></textarea>
      </div>

      <div class="field">
        <span class="field__label">照片</span>
        <div class="photo-row">
          <label class="photo-btn">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
              <path d="M4 8h3l1.5-2h7L17 8h3v11H4V8z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
              <circle cx="12" cy="13" r="3.2" stroke="currentColor" stroke-width="1.8"/>
            </svg>
            <span id="send-photo-text">拍照或選圖</span>
            <input type="file" id="send-photo" accept="image/*" hidden>
          </label>
          <div class="photo-preview" id="send-photo-preview" hidden>
            <img id="send-photo-img" alt="明信片預覽">
            <button class="photo-preview__x" id="send-photo-remove" type="button"
                    aria-label="移除照片">✕</button>
          </div>
        </div>
        <span class="field__hint">照片只存在這支手機，不會上傳</span>
      </div>

      <p class="form-error" id="send-error" hidden></p>

      <button class="btn btn--submit" type="submit">記下這張明信片</button>
    </form>`;
}

/* ---------- 分頁 2：寄信歷史 ---------- */

function filteredCards() {
  const { friend, country, from, to, unreceived } = state.filters;

  return state.cards
    .filter((c) => c._op !== 'delete')
    .filter((c) => !friend || c.personId === friend)
    .filter((c) => !country || c.country === country)
    .filter((c) => !from || (c.date && c.date >= from))
    .filter((c) => !to || (c.date && c.date <= to))
    .filter((c) => !unreceived || !c.received)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.createdAt || '') < (a.createdAt || '') ? -1 : 1;
    });
}

function hasActiveFilter() {
  const f = state.filters;
  return !!(f.friend || f.country || f.from || f.to || f.unreceived);
}

function renderHistory() {
  renderFilterOptions();

  const cards = filteredCards();
  const total = state.cards.filter((c) => c._op !== 'delete').length;

  $('history-count').textContent = hasActiveFilter()
    ? `共 ${cards.length} 張（全部 ${total} 張）`
    : `共 ${cards.length} 張`;

  $('btn-clear-filters').hidden = !hasActiveFilter();

  const empty = $('history-empty');
  empty.hidden = cards.length > 0;
  if (!cards.length) {
    $('history-empty-title').textContent = total
      ? '這個條件下沒有明信片'
      : '還沒有寄出任何明信片';
    $('history-empty-hint').textContent = total
      ? '換個篩選條件試試'
      : '到「寄明信片」記下第一張';
  }

  $('card-list').innerHTML = cards.map(cardHtml).join('');
  hydrateThumbs(cards);
}

function renderFilterOptions() {
  // 有寄信紀錄的人 ＋ 通訊錄現有的人
  const names = new Map();
  for (const f of currentFriends()) names.set(f.personId, f.name);
  for (const c of state.cards) {
    if (c._op === 'delete') continue;
    if (!names.has(c.personId)) names.set(c.personId, c.friendName || '（已刪除的朋友）');
  }

  const friendSel = $('filter-friend');
  friendSel.innerHTML = '<option value="">所有朋友</option>' +
    [...names.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], 'zh-Hant'))
      .map(([id, name]) =>
        `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('');
  friendSel.value = state.filters.friend;

  const countries = [...new Set(
    state.cards.filter((c) => c._op !== 'delete').map((c) => c.country).filter(Boolean)
  )].sort();

  const countrySel = $('filter-country');
  countrySel.innerHTML = '<option value="">所有國家</option>' +
    countries.map((c) =>
      `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  countrySel.value = state.filters.country;
}

function cardHtml(c) {
  const waited = daysSince(c.date);

  const tags = [];
  if (c.received) {
    tags.push('<span class="badge badge--ok">✓ 已收到</span>');
  } else {
    tags.push(`<span class="badge">${waited <= 0 ? '今天寄出' : `寄出 ${waited} 天`}</span>`);
  }
  if (c._op) tags.push('<span class="badge badge--pending">待同步</span>');

  return `
    <div class="pcard" data-card="${escapeHtml(c.id)}">
      ${c.hasPhoto ? `<img class="pcard__thumb" data-thumb="${escapeHtml(c.id)}" alt="">` : ''}
      <button class="pcard__body" type="button" data-edit-card="${escapeHtml(c.id)}">
        <span class="pcard__top">
          <span class="pcard__to">${escapeHtml(c.friendName || '（未知）')}</span>
          <span class="pcard__date">${escapeHtml(fmtDate(c.date))}</span>
        </span>
        <span class="pcard__from">
          <svg class="pcard__pin" viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
            <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"
                  stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
            <circle cx="12" cy="10" r="2.4" stroke="currentColor" stroke-width="1.8"/>
          </svg>
          ${escapeHtml(c.country)}
        </span>
        ${c.note ? `<span class="pcard__note">${escapeHtml(c.note)}</span>` : ''}
        <span class="pcard__tags">${tags.join('')}</span>
      </button>
      <button class="pcard__check ${c.received ? 'is-on' : ''}" type="button"
              data-toggle-received="${escapeHtml(c.id)}"
              aria-label="${c.received ? '取消已收到' : '標記為已收到'}">
        <svg viewBox="0 0 24 24" width="21" height="21" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/>
          <path d="M8 12.3l2.6 2.6L16 9.6" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>`;
}

/** 縮圖是非同步從 IndexedDB 取的，畫面先出來再補圖 */
async function hydrateThumbs(cards) {
  for (const c of cards) {
    if (!c.hasPhoto) continue;
    const img = document.querySelector(`[data-thumb="${CSS.escape(c.id)}"]`);
    if (!img) continue;
    const url = await getThumbUrl(c.id);
    if (url) { img.src = url; continue; }

    // 照片在別支手機拍的，這台沒有。留個位子講清楚，不然看起來像憑空不見
    const slot = document.createElement('div');
    slot.className = 'pcard__thumb pcard__thumb--missing';
    slot.innerHTML = '<span>照片在</span><span>別支手機</span>';
    img.replaceWith(slot);
  }
}

/* ---------- 外觀主題 ---------- */

/* 行動瀏覽器的狀態列會吃這個色，用頁面背景色跟畫面融成一片 */
const THEME_BG = { light: '#f5fbfd', dark: '#101f26' };

function resolveTheme(pref) {
  if (pref === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref === 'dark' ? 'dark' : 'light';
}

function applyTheme(pref) {
  state.theme = pref;
  try { localStorage.setItem(LS.theme, pref); } catch (err) { /* 無痕模式 */ }

  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  $('theme-color').setAttribute('content', THEME_BG[resolved]);

  renderThemeChips();
}

function renderThemeChips() {
  document.querySelectorAll('[data-theme-pref]').forEach((chip) => {
    chip.classList.toggle('is-on', chip.dataset.themePref === state.theme);
  });
}

/* ---------- 設定 ---------- */

async function renderSettings() {
  renderThemeChips();

  $('api-url').value = state.apiUrl;
  $('api-secret').value = state.secret;
  $('stat-friends').textContent = `${currentFriends().length} 人`;
  $('stat-cards').textContent = `${state.cards.filter((c) => c._op !== 'delete').length} 張`;
  $('stat-pending').textContent = `${pendingCount()} 筆`;
  $('stat-lastsync').textContent = state.lastSync
    ? new Date(state.lastSync).toLocaleString('zh-TW', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '—';

  const photos = await PhotoDB.all();
  const bytes = photos.reduce((sum, p) => {
    const v = p.value || {};
    return sum + (v.full ? v.full.size : 0) + (v.thumb ? v.thumb.size : 0);
  }, 0);
  $('photo-count').textContent = `${photos.length} 張`;
  $('photo-size').textContent = bytes > 0
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : '0 MB';

  // hasPhoto 是從試算表同步來的，本機卻沒圖，就代表照片留在別支手機
  const stored = new Set(photos.map((p) => p.id));
  const missing = state.cards.filter(
    (c) => c._op !== 'delete' && c.hasPhoto && !stored.has(c.id)
  ).length;
  const el = $('photo-missing');
  el.hidden = missing === 0;
  if (missing) {
    el.textContent = `另有 ${missing} 張照片在別支手機上。`
      + '到那支手機按「匯出照片」，把檔案傳過來再匯入就會回來。';
  }
}

/* ==========================================================================
   分頁切換
   ========================================================================== */

function switchPage(page) {
  if (state.openPersonId) {
    closeDetail(state.openPersonId);
    state.openPersonId = null;
  }

  state.page = page;

  ['send', 'history', 'settings'].forEach((p) => {
    $(`page-${p}`).hidden = p !== page;
  });

  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.page === page;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });

  $('topbar-title').textContent =
    { send: '寄明信片', history: '寄信歷史', settings: '設定' }[page];
  $('btn-settings').classList.toggle('is-on', page === 'settings');
  $('fab').hidden = page !== 'send';

  window.scrollTo({ top: 0 });
  render();
}

/* ==========================================================================
   複製地址
   ========================================================================== */

async function copyAddress(personId, btn) {
  const f = friendOf(personId);
  if (!f) return;

  const text = formatAddress(f);
  let ok = false;

  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (err) {
    // 非 https 或舊瀏覽器沒有 clipboard API，退回舊招
    ok = legacyCopy(text);
  }

  if (!ok) return toast('這台裝置不讓程式複製，請長按地址手動選取');

  toast(`已複製 ${f.name} 的地址`);
  if (btn && btn.classList.contains('friend__copy')) {
    btn.classList.add('is-done');
    setTimeout(() => btn.classList.remove('is-done'), 1400);
  }
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-999px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

/* ==========================================================================
   寄一張（展開表單）
   ========================================================================== */

function bindSendForm(friend) {
  const form = $('send-form');
  if (!form) return;

  // 國家一律留空讓使用者自己決定 —— 自動帶入上次的國家，
  // 在「已經換國家了」的時候會安靜地記錯，而那正是這個 App 最常見的情境。
  // 想沿用上次的，點下面「最近寄過」那排即可。

  /** 快選那排只反映輸入框現在的值，不自己當一份狀態 */
  const syncCountryPick = () => {
    const val = $('send-country').value.trim();
    const box = $('send-country-quick');
    if (!box) return;
    box.querySelectorAll('[data-country]').forEach((item) => {
      item.classList.toggle('is-on', item.dataset.country === val);
    });
  };

  const syncDatePick = () => {
    const val = $('send-date').value;
    $('send-date-quick').querySelectorAll('[data-offset]').forEach((item) => {
      item.classList.toggle('is-on', todayStr(Number(item.dataset.offset)) === val);
    });
  };

  const countryBox = $('send-country-quick');
  if (countryBox) {
    countryBox.addEventListener('click', (e) => {
      const item = e.target.closest('[data-country]');
      if (!item) return;
      $('send-country').value = item.dataset.country;
      syncCountryPick();
    });
  }
  $('send-country').addEventListener('input', syncCountryPick);
  syncCountryPick();

  $('send-date-quick').addEventListener('click', (e) => {
    const item = e.target.closest('[data-offset]');
    if (!item) return;
    $('send-date').value = todayStr(Number(item.dataset.offset));
    syncDatePick();
  });
  $('send-date').addEventListener('change', syncDatePick);

  $('send-photo').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    $('send-photo-text').textContent = '處理中…';
    try {
      state.sendPhoto = await pickPhoto(file);
      $('send-photo-img').src = URL.createObjectURL(state.sendPhoto.thumb);
      $('send-photo-preview').hidden = false;
      $('send-photo-text').textContent = '換一張';
    } catch (err) {
      toast('這張圖讀不到，換一張試試');
      $('send-photo-text').textContent = '拍照或選圖';
    }
  });

  $('send-photo-remove').addEventListener('click', () => {
    state.sendPhoto = null;
    $('send-photo-preview').hidden = true;
    $('send-photo-text').textContent = '拍照或選圖';
    $('send-photo').value = '';
  });

  form.addEventListener('submit', (e) => submitSend(e, friend));
}

async function submitSend(e, friend) {
  e.preventDefault();

  const country = $('send-country').value.trim();
  const date = $('send-date').value;
  const err = $('send-error');

  const fail = (msg) => {
    err.textContent = msg;
    err.hidden = false;
  };

  if (!country) return fail('請填寫從哪個國家寄的');
  if (!date) return fail('請選擇寄出日期');
  err.hidden = true;

  const id = uuid();

  if (state.sendPhoto) {
    await PhotoDB.put(id, state.sendPhoto);
    forgetThumb(id);
  }

  state.cards.push({
    id,
    personId: friend.personId,
    friendName: friend.name,
    country,
    date,
    note: $('send-note').value.trim(),
    received: false,
    hasPhoto: !!state.sendPhoto,
    createdAt: new Date().toISOString(),
    _op: 'create',
  });

  saveLocal();

  // 收起這位朋友、清空搜尋，方便直接查下一個人
  closeDetail(friend.personId);
  state.openPersonId = null;
  state.query = '';
  $('search').value = '';
  $('search-clear').hidden = true;

  renderFriendList();
  refreshSyncChip();
  toast(`已記下寄給 ${friend.name} 的明信片`);

  sync(); // 背景送出，失敗就留在佇列
}

/* ==========================================================================
   新增 / 編輯朋友
   ========================================================================== */

function openFriendSheet(personId = null, presetName = '') {
  state.editingFriendId = null;

  const f = personId ? friendOf(personId) : null;
  if (f) state.editingFriendId = f.id;

  $('friend-sheet-title').textContent = f ? '編輯朋友' : '新增朋友';
  $('btn-friend-delete').hidden = !f;
  $('btn-moved').hidden = !f;
  $('moved-hint').hidden = !f;

  $('f-name').value = f ? f.name : presetName;
  $('f-recipient').value = f ? f.recipient : '';
  $('f-address').value = f ? f.address : '';
  $('f-city').value = f ? f.city : '';
  $('f-postal').value = f ? f.postalCode : '';
  $('f-country').value = f ? f.country : '';
  $('friend-error').hidden = true;

  renderCountryDatalist();
  openSheet('friend-sheet');

  if (!f) setTimeout(() => $('f-name').focus(), 280);
}

function readFriendForm() {
  return {
    name: $('f-name').value.trim(),
    recipient: $('f-recipient').value.trim(),
    address: $('f-address').value.trim(),
    city: $('f-city').value.trim(),
    postalCode: $('f-postal').value.trim(),
    country: $('f-country').value.trim(),
  };
}

function validateFriendForm(data) {
  const err = $('friend-error');
  const fail = (msg) => {
    err.textContent = msg;
    err.hidden = false;
    return false;
  };
  if (!data.name) return fail('請填寫名稱');
  if (!data.address) return fail('請填寫地址');
  if (!data.country) return fail('請填寫國家');
  err.hidden = true;
  return true;
}

function submitFriend(e) {
  e.preventDefault();

  const data = readFriendForm();
  if (!validateFriendForm(data)) return;

  const editing = state.editingFriendId
    ? state.friends.find((f) => f.id === state.editingFriendId)
    : null;

  if (editing) {
    Object.assign(editing, data);
    if (!editing._op) editing._op = 'update';

    // 名字改了，之前寄過的紀錄也跟著改稱呼
    for (const c of state.cards) {
      if (c.personId === editing.personId && c.friendName !== data.name) {
        c.friendName = data.name;
        if (!c._op) c._op = 'update';
      }
    }
  } else {
    const id = uuid();
    state.friends.push({
      id,
      personId: id,
      ...data,
      status: STATUS_CURRENT,
      createdAt: new Date().toISOString(),
      _op: 'create',
    });
  }

  saveLocal();
  closeSheet('friend-sheet');
  resetDetail();
  toast(editing ? '已更新' : `已加入 ${data.name}`);
  render();
  sync();
}

/**
 * 搬家：舊地址不覆蓋，改標成「已搬家」留在歷史裡，
 * 表單上的內容成為新的現用地址。
 */
function markMoved() {
  const data = readFriendForm();
  if (!validateFriendForm(data)) return;

  const old = state.friends.find((f) => f.id === state.editingFriendId);
  if (!old) return;

  if (old.address === data.address && old.city === data.city) {
    $('friend-error').textContent = '地址跟現在的一樣，先改成新地址再按這個';
    $('friend-error').hidden = false;
    return;
  }

  if (!confirm(`把「${old.address}」標成舊地址，改用新填的地址？`)) return;

  old.status = STATUS_MOVED;
  if (!old._op) old._op = 'update';

  const id = uuid();
  state.friends.push({
    id,
    personId: old.personId,
    ...data,
    status: STATUS_CURRENT,
    createdAt: new Date().toISOString(),
    _op: 'create',
  });

  saveLocal();
  closeSheet('friend-sheet');
  resetDetail();
  toast('已更新地址，舊的留在歷史裡');
  render();
  sync();
}

function deleteFriend() {
  const f = state.friends.find((x) => x.id === state.editingFriendId);
  if (!f) return;

  const sent = cardsOf(f.personId).length;
  const extra = sent ? `\n寄給他的 ${sent} 張明信片紀錄會保留。` : '';
  if (!confirm(`確定要刪除「${f.name}」和他的地址嗎？${extra}`)) return;

  for (const row of state.friends) {
    if (row.personId !== f.personId) continue;
    if (row._op === 'create' && !row._synced) {
      row._remove = true;   // 從沒上傳過，本機直接丟掉
    } else {
      row._op = 'delete';
    }
  }
  state.friends = state.friends.filter((row) => !row._remove);

  saveLocal();
  closeSheet('friend-sheet');
  resetDetail();
  toast('已刪除');
  render();
  sync();
}

/* ==========================================================================
   編輯明信片
   ========================================================================== */

function openCardSheet(cardId) {
  const c = state.cards.find((x) => x.id === cardId);
  if (!c) return;

  state.editingCardId = cardId;
  state.cardPhoto = null;
  state.cardPhotoCleared = false;

  $('c-friend').textContent = c.friendName || '（未知）';
  $('c-country').value = c.country;
  $('c-date').value = c.date;
  $('c-note').value = c.note || '';
  $('c-received').checked = !!c.received;
  $('card-error').hidden = true;
  $('c-photo').value = '';

  $('c-photo-preview').hidden = true;
  $('c-photo-text').textContent = '拍照或選圖';
  if (c.hasPhoto) {
    getThumbUrl(c.id).then((url) => {
      if (url && state.editingCardId === cardId) {
        $('c-photo-img').src = url;
        $('c-photo-preview').hidden = false;
        $('c-photo-text').textContent = '換一張';
      }
    });
  }

  renderCountryDatalist();
  openSheet('card-sheet');
}

async function submitCard(e) {
  e.preventDefault();

  const c = state.cards.find((x) => x.id === state.editingCardId);
  if (!c) return;

  const country = $('c-country').value.trim();
  const date = $('c-date').value;
  const err = $('card-error');

  if (!country) {
    err.textContent = '請填寫寄出國家';
    err.hidden = false;
    return;
  }
  if (!date) {
    err.textContent = '請選擇寄出日期';
    err.hidden = false;
    return;
  }
  err.hidden = true;

  let hasPhoto = !!c.hasPhoto;
  if (state.cardPhotoCleared) {
    await PhotoDB.remove(c.id);
    forgetThumb(c.id);
    hasPhoto = false;
  }
  if (state.cardPhoto) {
    await PhotoDB.put(c.id, state.cardPhoto);
    forgetThumb(c.id);
    hasPhoto = true;
  }

  Object.assign(c, {
    country,
    date,
    note: $('c-note').value.trim(),
    received: $('c-received').checked,
    hasPhoto,
  });
  if (!c._op) c._op = 'update';

  saveLocal();
  closeSheet('card-sheet');
  toast('已更新');
  render();
  sync();
}

async function deleteCard() {
  const c = state.cards.find((x) => x.id === state.editingCardId);
  if (!c) return;
  if (!confirm(`確定要刪除寄給「${c.friendName}」的這張紀錄嗎？`)) return;

  await PhotoDB.remove(c.id);
  forgetThumb(c.id);

  if (c._op === 'create' && !c._synced) {
    state.cards = state.cards.filter((x) => x.id !== c.id);
  } else {
    c._op = 'delete';
  }

  saveLocal();
  closeSheet('card-sheet');
  toast('已刪除');
  render();
  sync();
}

function toggleReceived(cardId) {
  const c = state.cards.find((x) => x.id === cardId);
  if (!c) return;

  c.received = !c.received;
  if (!c._op) c._op = 'update';

  saveLocal();
  renderHistory();
  refreshSyncChip();
  toast(c.received ? '標記為已收到' : '取消已收到');
  sync();
}

/* ==========================================================================
   Bottom sheet 開關
   ========================================================================== */

function openSheet(id) {
  $('scrim').hidden = false;
  $(id).hidden = false;
  requestAnimationFrame(() => {
    $('scrim').classList.add('is-open');
    $(id).classList.add('is-open');
  });
}

function closeSheet(id) {
  $(id).classList.remove('is-open');
  $('scrim').classList.remove('is-open');
  setTimeout(() => {
    $(id).hidden = true;
    $('scrim').hidden = true;
  }, 280);
}

function anyOpenSheet() {
  if (!$('friend-sheet').hidden) return 'friend-sheet';
  if (!$('card-sheet').hidden) return 'card-sheet';
  return null;
}

/* ==========================================================================
   匯出
   ========================================================================== */

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv(filename, rows) {
  const csv = rows
    .map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  // 加 BOM，Excel 開中文才不會變亂碼
  downloadBlob(filename, new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
}

function exportFriends() {
  const rows = [['名稱', '收件人', '地址', '城市', '郵遞區號', '國家', '狀態']];
  for (const f of liveFriends()) {
    rows.push([f.name, f.recipient, f.address, f.city, f.postalCode, f.country, f.status]);
  }
  if (rows.length === 1) return toast('通訊錄是空的');
  downloadCsv(`明信片通訊錄_${todayStr()}.csv`, rows);
}

function exportCards() {
  const rows = [['日期', '寄給', '寄出國家', '備註', '已收到']];
  for (const c of filteredCards()) {
    rows.push([c.date, c.friendName, c.country, c.note, c.received ? '是' : '']);
  }
  if (rows.length === 1) return toast('沒有紀錄可以匯出');
  downloadCsv(`寄信紀錄_${todayStr()}.csv`, rows);
}

/* ==========================================================================
   ZIP（store 模式，不壓縮）

   照片搬家用的容器。JPEG 已經壓過了，再 deflate 一次只是白費 CPU，
   所以一律用 store；自己寫這幾十行，就不必為了換手機引進外部函式庫。
   ========================================================================== */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zip 沿用 1980 年代的 MS-DOS 時間格式：日期時間各擠在 16 bits 裡 */
function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * entries: [{ name, blob }] → 一個 zip Blob。
 * 檔名一律用 ASCII（UUID 跟 manifest.json），免得踩到編碼旗標的坑。
 */
async function makeZip(entries) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const parts = [];    // 檔案本體，依序串起來
  const central = [];  // 中央目錄，全部檔案之後才接上
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const bytes = new Uint8Array(await e.blob.arrayBuffer());
    const crc = crc32(bytes);
    const size = bytes.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);  // 本地檔頭簽章
    local.setUint16(4, 20, true);          // 解壓需要的版本
    local.setUint16(6, 0, true);           // 旗標
    local.setUint16(8, 0, true);           // 0 = store，不壓縮
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);       // 壓縮後大小（store 兩者相同）
    local.setUint32(22, size, true);       // 原始大小
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);          // extra field 長度
    parts.push(local.buffer, name, e.blob);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);     // 中央目錄簽章
    cd.setUint16(4, 20, true);             // 建立者版本
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);        // 這個檔的本地檔頭在哪
    central.push(cd.buffer, name);

    offset += 30 + name.length + size;
  }

  const cdSize = central.reduce((n, b) => n + b.byteLength, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);        // 中央目錄的起點

  return new Blob([...parts, ...central, eocd.buffer], { type: 'application/zip' });
}

async function inflateRaw(blob) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('這個瀏覽器無法解開壓縮過的 zip，請用原本匯出的檔案');
  }
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).blob();
}

/**
 * 解 zip → Map<檔名, Blob>。
 * 從中央目錄讀而不是掃檔頭，這樣別人用電腦重新壓過的檔也吃得下。
 */
async function readZip(blob) {
  const tailSize = Math.min(blob.size, 65557);  // EOCD 22 bytes + 註解上限 65535
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());

  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('這不是有效的 zip 檔');

  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = new Map();

  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const size = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;  // 目錄項目沒有內容

    // 本地檔頭的 extra field 長度可能跟中央目錄不一樣，要各讀各的
    const lh = new DataView(await blob.slice(localOffset, localOffset + 30).arrayBuffer());
    const start = localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const data = blob.slice(start, start + size);

    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, await inflateRaw(data));
    else throw new Error(`不支援的壓縮方式（${method}）`);
  }
  return out;
}

/* ==========================================================================
   照片搬家
   ========================================================================== */

const PHOTO_ZIP_VERSION = 1;

/** slice 只是換個標籤，不會複製底層資料 */
const asJpeg = (b) => (b.type === 'image/jpeg' ? b : b.slice(0, b.size, 'image/jpeg'));

/** 照片在 IndexedDB 裡就是以明信片 id 當 key，檔名沿用 id，匯入時自然對得回去 */
async function exportPhotos() {
  const photos = (await PhotoDB.all()).filter((p) => p.value);
  if (!photos.length) return toast('這支手機還沒有照片');

  const btn = $('btn-export-photos');
  btn.disabled = true;
  btn.textContent = '打包中…';
  try {
    const cardById = new Map(state.cards.map((c) => [c.id, c]));
    const entries = [];
    const items = [];

    for (const { id, value } of photos) {
      if (value.full) entries.push({ name: `photos/${id}.jpg`, blob: value.full });
      if (value.thumb) entries.push({ name: `photos/${id}.thumb.jpg`, blob: value.thumb });

      const c = cardById.get(id);
      items.push({
        id,
        date: c ? c.date : '',
        friendName: c ? c.friendName : '',
        country: c ? c.country : '',
        note: c ? c.note : '',
      });
    }

    // 對照表：萬一哪天試算表出事，光看這個檔也知道哪張照片是寄給誰的
    const manifest = {
      app: 'postcard-book',
      version: PHOTO_ZIP_VERSION,
      exportedAt: new Date().toISOString(),
      count: items.length,
      photos: items,
    };
    entries.push({
      name: 'manifest.json',
      blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
    });

    downloadBlob(`明信片照片_${todayStr()}.zip`, await makeZip(entries));
    toast(`已匯出 ${items.length} 張照片`);
  } catch (err) {
    toast(`匯出失敗：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '匯出照片';
  }
}

/** 合併而不是取代：這支手機已經有的照片留著，同 id 才覆蓋 */
async function importPhotos(file) {
  const btn = $('btn-import-photos');
  btn.disabled = true;
  btn.textContent = '匯入中…';
  try {
    const files = await readZip(file);

    // 只認檔名不管路徑，別人用電腦解開再壓、多包一層資料夾也還原得回來
    const byName = new Map();
    for (const [path, blob] of files) {
      if (path.startsWith('__MACOSX/')) continue;
      const base = path.split('/').pop();
      if (base) byName.set(base, blob);
    }

    const ids = new Set();
    for (const base of byName.keys()) {
      const m = base.match(/^(.+?)(\.thumb)?\.jpg$/i);
      if (m) ids.add(m[1]);
    }
    if (!ids.size) throw new Error('檔案裡找不到照片');

    const cardById = new Map(state.cards.map((c) => [c.id, c]));
    let added = 0;
    let orphans = 0;

    for (const id of ids) {
      let full = byName.get(`${id}.jpg`);
      let thumb = byName.get(`${id}.thumb.jpg`);
      if (!full && !thumb) continue;

      // 從 zip 切出來的 Blob 沒有 MIME，補回 image/jpeg；
      // 少了它，blob: 網址丟進 <img> 有些瀏覽器不肯畫
      if (full) full = asJpeg(full);
      if (thumb) thumb = asJpeg(thumb);
      // 縮圖漏了就從主圖重做一張，不然清單上會空一格
      if (!thumb) thumb = await compressImage(full, 240, 0.7);
      await PhotoDB.put(id, { full: full || thumb, thumb });
      forgetThumb(id);
      added++;

      const c = cardById.get(id);
      if (!c) {
        orphans++;                       // 紀錄還沒同步下來，照片先收著
      } else if (!c.hasPhoto) {
        c.hasPhoto = true;
        if (!c._op) c._op = 'update';
      }
    }

    saveLocal();
    render();
    await renderSettings();

    if (!added) toast('沒有可以匯入的照片');
    else if (orphans) toast(`已匯入 ${added} 張，其中 ${orphans} 張等同步後才會顯示`);
    else toast(`已匯入 ${added} 張照片`);
  } catch (err) {
    toast(`匯入失敗：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '匯入照片';
  }
}

/* ==========================================================================
   事件綁定
   ========================================================================== */

function bindEvents() {
  // 分頁
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchPage(tab.dataset.page));
  });
  $('btn-settings').addEventListener('click', () => {
    switchPage(state.page === 'settings' ? 'send' : 'settings');
  });

  // 搜尋
  $('search').addEventListener('input', (e) => {
    state.query = e.target.value;
    $('search-clear').hidden = !state.query;
    state.openPersonId = null; // 重繪會把展開的內容一起換掉
    renderFriendList();
  });
  $('search-clear').addEventListener('click', () => {
    state.query = '';
    $('search').value = '';
    $('search-clear').hidden = true;
    state.openPersonId = null;
    renderFriendList();
    $('search').focus();
  });

  // 朋友列表
  $('friend-list').addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) return copyAddress(copyBtn.dataset.copy, copyBtn);

    const copy2 = e.target.closest('[data-copy2]');
    if (copy2) return copyAddress(copy2.dataset.copy2, copy2);

    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) return openFriendSheet(editBtn.dataset.edit);

    const openBtn = e.target.closest('[data-open]');
    if (openBtn) {
      const personId = openBtn.dataset.open;
      if (state.openPersonId === personId) {
        closeDetail(personId);
        state.openPersonId = null;
      } else {
        if (state.openPersonId) closeDetail(state.openPersonId);
        state.openPersonId = personId;
        openDetail(personId);
      }
    }
  });

  // 新增朋友
  $('fab').addEventListener('click', () => openFriendSheet());
  $('btn-add-from-search').addEventListener('click', () => {
    openFriendSheet(null, state.query.trim());
  });

  $('friend-form').addEventListener('submit', submitFriend);
  $('btn-friend-cancel').addEventListener('click', () => closeSheet('friend-sheet'));
  $('btn-friend-delete').addEventListener('click', deleteFriend);
  $('btn-moved').addEventListener('click', markMoved);

  // 明信片
  $('card-list').addEventListener('click', (e) => {
    const check = e.target.closest('[data-toggle-received]');
    if (check) return toggleReceived(check.dataset.toggleReceived);

    const thumb = e.target.closest('[data-thumb]');
    if (thumb) return openViewer(thumb.dataset.thumb);

    const edit = e.target.closest('[data-edit-card]');
    if (edit) return openCardSheet(edit.dataset.editCard);
  });

  $('card-form').addEventListener('submit', submitCard);
  $('btn-card-cancel').addEventListener('click', () => closeSheet('card-sheet'));
  $('btn-card-delete').addEventListener('click', deleteCard);

  $('c-photo').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    $('c-photo-text').textContent = '處理中…';
    try {
      state.cardPhoto = await pickPhoto(file);
      state.cardPhotoCleared = false;
      $('c-photo-img').src = URL.createObjectURL(state.cardPhoto.thumb);
      $('c-photo-preview').hidden = false;
      $('c-photo-text').textContent = '換一張';
    } catch (err) {
      toast('這張圖讀不到，換一張試試');
      $('c-photo-text').textContent = '拍照或選圖';
    }
  });

  $('c-photo-remove').addEventListener('click', () => {
    state.cardPhoto = null;
    state.cardPhotoCleared = true;
    $('c-photo-preview').hidden = true;
    $('c-photo-text').textContent = '拍照或選圖';
    $('c-photo').value = '';
  });

  // 篩選器
  $('filter-friend').addEventListener('change', (e) => {
    state.filters.friend = e.target.value;
    renderHistory();
  });
  $('filter-country').addEventListener('change', (e) => {
    state.filters.country = e.target.value;
    renderHistory();
  });
  $('filter-from').addEventListener('change', (e) => {
    state.filters.from = e.target.value;
    renderHistory();
  });
  $('filter-to').addEventListener('change', (e) => {
    state.filters.to = e.target.value;
    renderHistory();
  });
  $('filter-unreceived').addEventListener('change', (e) => {
    state.filters.unreceived = e.target.checked;
    renderHistory();
  });
  $('btn-clear-filters').addEventListener('click', () => {
    state.filters = { friend: '', country: '', from: '', to: '', unreceived: false };
    $('filter-from').value = '';
    $('filter-to').value = '';
    $('filter-unreceived').checked = false;
    renderHistory();
  });

  // 遮罩 / 檢視器
  $('scrim').addEventListener('click', () => {
    const open = anyOpenSheet();
    if (open) closeSheet(open);
  });
  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer').addEventListener('click', (e) => {
    if (e.target === $('viewer')) closeViewer();
  });

  // 設定
  $('btn-save-api').addEventListener('click', async () => {
    const url = $('api-url').value.trim();
    const status = $('api-status');

    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
      status.className = 'hint is-error';
      status.textContent = '網址格式怪怪的，應該是 https://script.google.com/macros/s/.../exec';
      return;
    }

    state.apiUrl = url;
    state.secret = $('api-secret').value.trim();
    localStorage.setItem(LS.apiUrl, url);
    localStorage.setItem(LS.secret, state.secret);
    status.className = 'hint';
    status.textContent = '連線測試中…';

    const ok = await sync({ silent: false });
    status.className = ok ? 'hint is-ok' : 'hint is-error';
    if (ok) {
      status.textContent = state.secret
        ? '連線成功，資料已同步（密語已啟用）'
        : '連線成功，資料已同步';
    } else if (state.lastError && state.lastError.authError) {
      status.textContent = '通關密語不對，請確認和後端 Code.gs 的 SECRET 一模一樣';
    } else {
      status.textContent = '連線失敗，請確認部署設定是「任何人」都可存取';
    }
  });

  $('btn-sync-now').addEventListener('click', () => sync({ silent: false }));
  $('sync-chip').addEventListener('click', () => sync({ silent: false }));

  $('btn-clear-photos').addEventListener('click', async () => {
    if (!confirm('清除全部明信片照片？地址與寄信紀錄不受影響，但照片無法復原。')) return;
    await PhotoDB.clear();
    for (const id of [...thumbUrls.keys()]) forgetThumb(id);
    for (const c of state.cards) {
      if (c.hasPhoto) {
        c.hasPhoto = false;
        if (!c._op) c._op = 'update';
      }
    }
    saveLocal();
    render();
    toast('照片已清除');
    sync();
  });

  $('btn-export-friends').addEventListener('click', exportFriends);
  $('btn-export-cards').addEventListener('click', exportCards);

  $('btn-export-photos').addEventListener('click', exportPhotos);
  $('btn-import-photos').addEventListener('click', () => $('import-photos-file').click());
  $('import-photos-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';   // 清掉才能連選同一個檔兩次
    if (file) await importPhotos(file);
  });

  // 外觀
  $('theme-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-theme-pref]');
    if (chip) applyTheme(chip.dataset.themePref);
  });

  // 選了「跟隨系統」時，系統日夜切換要跟著變
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'auto') applyTheme('auto');
  });

  // 連線狀態
  window.addEventListener('online', () => { refreshSyncChip(); sync(); });
  window.addEventListener('offline', refreshSyncChip);

  // 回到前景時補同步
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
  });

  // Esc 先關最上層的面板
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('viewer').hidden) return closeViewer();
    const open = anyOpenSheet();
    if (open) return closeSheet(open);
    if (state.openPersonId) {
      closeDetail(state.openPersonId);
      state.openPersonId = null;
    }
  });
}

async function openViewer(cardId) {
  const rec = await PhotoDB.get(cardId);
  if (!rec || !rec.full) return;
  $('viewer-img').src = URL.createObjectURL(rec.full);
  $('viewer').hidden = false;
}

function closeViewer() {
  const img = $('viewer-img');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.src = '';
  $('viewer').hidden = true;
}

/* ==========================================================================
   啟動
   ========================================================================== */

function init() {
  loadLocal();
  applyTheme(state.theme);   // head 的 inline script 已先上色，這裡只是接手同步狀態
  bindEvents();
  switchPage('send');

  if (state.apiUrl) sync();
  else refreshSyncChip();

  if ('serviceWorker' in navigator) {
    const isLocal = ['localhost', '127.0.0.1', ''].includes(location.hostname);

    if (isLocal) {
      // 本機開發根本不需要 Service Worker，還會拿舊快取蓋掉剛改好的檔案。
      // 連同以前註冊過的一起註銷，免得改了程式卻看不到。
      navigator.serviceWorker.getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      caches.keys()
        .then((keys) => keys.forEach((k) => caches.delete(k)))
        .catch(() => {});
    } else {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
  }
}

init();
