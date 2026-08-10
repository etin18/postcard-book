/**
 * 邊界流程測試：從空白狀態開始，走一遍最容易出錯的路徑。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-flows.js
 *
 * 重點在搬家（同一個 personId 多列）與刪除朋友後寄信紀錄要留著 ——
 * 這兩條在 UI 上看不太出來，但資料錯了就很難救。
 */

const { chromium } = require(process.env.PW_CORE);

const BASE = 'http://localhost:8788';

let pass = 0;
let fail = 0;

function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const readFriends = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('pc.friends') || '[]'));
const readCards = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('pc.cards') || '[]'));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept()); // 搬家與刪除都會跳 confirm

  // 從完全空白開始
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  /* ---------- A. 空狀態 ---------- */
  console.log('\nA. 空狀態');
  check('顯示「通訊錄還是空的」', await page.isVisible('#send-empty'));

  await page.click('#fab');
  await page.waitForTimeout(400);
  await page.fill('#f-name', '小美');
  await page.fill('#f-recipient', 'Chen Hsiao-Mei');
  await page.fill('#f-address', 'No. 1, Sec. 1, Roosevelt Rd.');
  await page.fill('#f-city', 'Taipei');
  await page.fill('#f-postal', '100');
  await page.fill('#f-country', 'Taiwan');
  await page.click('#btn-friend-submit');
  await page.waitForTimeout(500);

  let friends = await readFriends(page);
  check('新增後有 1 位朋友', friends.length === 1, `實際 ${friends.length}`);
  check('狀態是現用', friends[0] && friends[0].status === '現用');
  check('id 與 personId 相同（第一筆）', friends[0] && friends[0].id === friends[0].personId);
  check('標記為待建立', friends[0] && friends[0]._op === 'create');
  check('列表出現該朋友', (await page.textContent('#friend-list')).includes('小美'));

  /* ---------- B. 必填驗證 ---------- */
  console.log('\nB. 必填驗證');
  await page.click('#fab');
  await page.waitForTimeout(400);
  await page.fill('#f-name', '沒填地址的人');
  await page.click('#btn-friend-submit');
  await page.waitForTimeout(300);
  check('缺地址時擋下來', await page.isVisible('#friend-error'));
  check('錯誤訊息說要填地址',
    (await page.textContent('#friend-error')).includes('地址'));
  friends = await readFriends(page);
  check('沒有被存進去', friends.length === 1, `實際 ${friends.length}`);
  await page.click('#btn-friend-cancel');
  await page.waitForTimeout(400);

  /* ---------- C. 搜尋不到就地新增 ---------- */
  console.log('\nC. 搜尋不到就地新增');
  await page.fill('#search', '阿龍');
  await page.waitForTimeout(300);
  check('顯示查無此人', await page.isVisible('#search-noresult'));
  await page.click('#btn-add-from-search');
  await page.waitForTimeout(450);
  check('名字自動帶入表單', (await page.inputValue('#f-name')) === '阿龍');
  await page.click('#btn-friend-cancel');
  await page.waitForTimeout(400);

  // 搜尋英文收件人名也要找得到
  await page.fill('#search', 'Hsiao-Mei');
  await page.waitForTimeout(300);
  check('用英文收件人名搜得到',
    (await page.textContent('#friend-list')).includes('小美'));

  /* ---------- D. 寄一張 ---------- */
  console.log('\nD. 寄一張明信片');
  await page.fill('#search', '小美');
  await page.waitForTimeout(300);
  await page.click('.friend__open');
  await page.waitForTimeout(500);
  check('展開時浮動 ＋ 收起來', await page.isHidden('#fab'));
  check('地址完整顯示',
    (await page.textContent('.addr')).includes('Roosevelt'));
  check('展開時搜尋框不再浮動（會蓋住地址）',
    await page.evaluate(() =>
      document.querySelector('.searchbar').classList.contains('is-static')));
  check('展開時其他人收起來',
    await page.evaluate(() =>
      document.getElementById('friend-list').classList.contains('is-focused')));

  // 快選那排只反映輸入框的值，不能自己當一份狀態
  await page.fill('#send-country', 'Iceland');
  await page.waitForTimeout(200);
  await page.click('#send-date-quick [data-offset="-1"]');
  await page.waitForTimeout(200);
  check('點「昨天」會填進日期欄',
    (await page.inputValue('#send-date')) !== new Date().toISOString().slice(0, 10));
  check('「昨天」亮起來、「今天」暗掉', await page.evaluate(() => {
    const on = document.querySelector('#send-date-quick [data-offset="-1"]');
    const off = document.querySelector('#send-date-quick [data-offset="0"]');
    return on.classList.contains('is-on') && !off.classList.contains('is-on');
  }));
  await page.click('#send-date-quick [data-offset="0"]');
  await page.waitForTimeout(200);

  await page.fill('#send-country', 'Iceland');
  await page.fill('#send-note', '在雷克雅維克');
  await page.click('#send-form button[type="submit"]');
  await page.waitForTimeout(600);

  let cards = await readCards(page);
  check('紀錄了 1 張', cards.length === 1, `實際 ${cards.length}`);
  check('存了朋友名稱快照', cards[0] && cards[0].friendName === '小美');
  check('預設未收到', cards[0] && cards[0].received === false);
  check('送出後搜尋框清空', (await page.inputValue('#search')) === '');
  check('浮動 ＋ 回來了', await page.isVisible('#fab'));
  check('聚焦模式已解除', await page.evaluate(() =>
    !document.getElementById('friend-list').classList.contains('is-focused')));

  // 展開後直接打字搜尋（不按收合）也要能離開聚焦，
  // 否則 is-focused 留著會把整份列表藏起來
  await page.fill('#search', '小美');
  await page.waitForTimeout(300);
  await page.click('.friend__open');
  await page.waitForTimeout(400);
  await page.fill('#search', '小');
  await page.waitForTimeout(350);
  check('展開中改搜尋字也會離開聚焦', await page.evaluate(() =>
    !document.getElementById('friend-list').classList.contains('is-focused')));
  check('列表沒有整個消失', await page.locator('.friend').count() > 0);
  check('搜尋框恢復浮動', await page.evaluate(() =>
    !document.querySelector('.searchbar').classList.contains('is-static')));

  /* ---------- E. 搬家 ---------- */
  console.log('\nE. 搬家');
  await page.fill('#search', '小美');
  await page.waitForTimeout(300);
  await page.click('.friend__open');
  await page.waitForTimeout(450);
  await page.click('[data-edit]');
  await page.waitForTimeout(500);

  await page.fill('#f-address', 'No. 50, Ln. 8, Dunhua S. Rd.');
  await page.fill('#f-city', 'Kaohsiung');
  await page.fill('#f-postal', '802');
  await page.click('#btn-moved');
  await page.waitForTimeout(700);

  friends = await readFriends(page);
  const current = friends.filter((f) => f.status === '現用');
  const moved = friends.filter((f) => f.status === '已搬家');

  check('總共兩列', friends.length === 2, `實際 ${friends.length}`);
  check('一列現用', current.length === 1, `實際 ${current.length}`);
  check('一列已搬家', moved.length === 1, `實際 ${moved.length}`);
  check('兩列共用同一個 personId',
    friends.length === 2 && friends[0].personId === friends[1].personId);
  check('現用是新地址',
    current[0] && current[0].city === 'Kaohsiung', current[0] && current[0].city);
  check('舊地址保留在歷史',
    moved[0] && moved[0].city === 'Taipei', moved[0] && moved[0].city);

  await page.fill('#search', '小美');
  await page.waitForTimeout(350);
  const rows = await page.locator('.friend').count();
  check('搜尋只回傳一筆（不含已搬家）', rows === 1, `實際 ${rows}`);

  await page.click('.friend__open');
  await page.waitForTimeout(450);
  const detail = await page.textContent('.friend__detail');
  check('詳情看得到「以前住過」', detail.includes('以前住過'));
  check('主要地址顯示新的', (await page.textContent('.addr')).includes('Dunhua'));

  const oldBlock = await page.textContent('.history-old');
  check('以前住過列的是舊地址',
    oldBlock.includes('Roosevelt') && !oldBlock.includes('Dunhua'));
  check('寄過幾張有顯示', detail.includes('寄過 1 張'));

  /* ---------- F. 刪除朋友，寄信紀錄要留著 ---------- */
  console.log('\nF. 刪除朋友');
  await page.click('[data-edit]');
  await page.waitForTimeout(500);
  await page.click('#btn-friend-delete');
  await page.waitForTimeout(700);

  friends = await readFriends(page);
  cards = await readCards(page);
  const alive = friends.filter((f) => f._op !== 'delete');

  check('通訊錄查不到他了', alive.length === 0, `實際 ${alive.length}`);
  check('寄信紀錄還在', cards.length === 1, `實際 ${cards.length}`);
  check('紀錄仍記得名字', cards[0] && cards[0].friendName === '小美');
  check('回到空狀態畫面', await page.isVisible('#send-empty'));

  await page.click('.tab[data-page="history"]');
  await page.waitForTimeout(400);
  check('歷史頁仍看得到那張',
    (await page.textContent('#card-list')).includes('小美'));

  /* ---------- G. 勾選已收到 ---------- */
  console.log('\nG. 標記已收到');
  await page.click('[data-toggle-received]');
  await page.waitForTimeout(500);
  cards = await readCards(page);
  check('已收到被記錄下來', cards[0] && cards[0].received === true);
  check('畫面出現已收到標記',
    (await page.textContent('#card-list')).includes('已收到'));

  await page.click('.filters__row--foot .toggle');
  await page.waitForTimeout(400);
  check('「只看還沒收到的」會把它濾掉',
    (await page.textContent('#history-count')).includes('共 0 張'));

  /* ---------- 結果 ---------- */
  console.log(`\nJS 錯誤：${errors.length ? '' : '無'}`);
  errors.forEach((e) => console.log('   ✗', e));

  console.log(`\n通過 ${pass} 項，失敗 ${fail + errors.length} 項`);

  await browser.close();
  process.exit(fail + errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
