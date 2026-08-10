/**
 * 用 Playwright 開 App、灌入測試資料、走完主要流程並截圖檢查版面。
 * 執行：node scripts/screenshot.js
 *
 * 順便把 console 錯誤收集起來 —— 版面對不對用眼睛看，
 * 但 JS 有沒有炸掉要靠這個。
 */

// 直接引用 npx 快取裡已安裝的 playwright-core（瀏覽器在 ~/Library/Caches/ms-playwright）
const { chromium } = require(process.env.PW_CORE);

const OUT = require('path').join(__dirname, '..', 'shots');
require('fs').mkdirSync(OUT, { recursive: true });

const BASE = 'http://localhost:8788';

/* 一份有搬家歷史、有跨國寄送的假資料 */
const SEED = {
  friends: [
    // [id, personId, 名稱, 收件人, 地址, 城市, 郵遞區號, 國家, 狀態]
    ['f1', 'p1', '小明', 'Wang Xiao-Ming', 'No. 7, Sec. 5, Xinyi Rd., Xinyi Dist.', 'Taipei', '110', 'Taiwan', '現用'],
    ['f2', 'p2', 'Yuki', 'Yuki Tanaka', '2-1-1 Nishi-Shinjuku, Shinjuku-ku', 'Tokyo', '160-0023', 'Japan', '現用'],
    ['f3', 'p3', '阿德', 'Chen Ta-Wei', '100 Queen St W', 'Toronto', 'M5H 2N2', 'Canada', '現用'],
    ['f4', 'p4', 'Emma', 'Emma Schmidt', 'Musterstraße 12', 'Berlin', '10115', 'Germany', '現用'],
    // 小華搬過一次家：舊高雄、新台南
    ['f5', 'p5', '小華', 'Lin Hsiao-Hua', 'No. 99, Zhongshan 1st Rd.', 'Kaohsiung', '801', 'Taiwan', '已搬家'],
    ['f6', 'p5', '小華', 'Lin Hsiao-Hua', 'No. 12, Ln. 3, Minsheng Rd.', 'Tainan', '700', 'Taiwan', '現用'],
  ],
  cards: [
    // [id, personId, 朋友名稱, 寄出國家, 日期, 備註, 已收到]
    ['c1', 'p1', '小明', 'Japan', '2026-07-28', '在京都的郵局寄的，這裡的貓超多', true],
    ['c2', 'p2', 'Yuki', 'Japan', '2026-07-28', '', true],
    ['c3', 'p5', '小華', 'Japan', '2026-07-30', '大阪城前面買的明信片', false],
    ['c4', 'p3', '阿德', 'Japan', '2026-08-01', '最後一天了，機場寄的', false],
    ['c5', 'p1', '小明', 'Iceland', '2026-03-14', '藍湖旁邊，手凍到快寫不出字', true],
    ['c6', 'p4', 'Emma', 'Iceland', '2026-03-16', '極光看到了！', true],
    ['c7', 'p5', '小華', 'Portugal', '2025-09-05', '里斯本的電車', true],
  ],
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' }); // 用系統 Chrome
  let totalErrors = 0;

  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, // iPhone 14 尺寸
      deviceScaleFactor: 3,
      colorScheme: scheme,
      isMobile: true,
      hasTouch: true,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // 先進頁面，灌 localStorage，再重載
    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate((seed) => {
      const now = Date.now();
      const friends = seed.friends.map((r, i) => ({
        id: r[0], personId: r[1], name: r[2], recipient: r[3], address: r[4],
        city: r[5], postalCode: r[6], country: r[7], status: r[8],
        createdAt: new Date(now - (seed.friends.length - i) * 86400000).toISOString(),
        _synced: true,
      }));
      const cards = seed.cards.map((r, i) => ({
        id: r[0], personId: r[1], friendName: r[2], country: r[3], date: r[4],
        note: r[5], received: r[6], hasPhoto: false,
        createdAt: new Date(now - (seed.cards.length - i) * 3600000).toISOString(),
        _synced: true,
      }));
      localStorage.setItem('pc.friends', JSON.stringify(friends));
      localStorage.setItem('pc.cards', JSON.stringify(cards));
      localStorage.setItem('pc.lastSync', new Date().toISOString());
    }, SEED);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // 1) 通訊錄列表
    await page.screenshot({ path: `${OUT}/${scheme}-1-list.png` });

    // 2) 搜尋
    await page.fill('#search', '小');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${scheme}-2-search.png` });

    // 3) 展開：地址 ＋ 寄信表單（小華有搬家歷史，看得到「以前住過」）
    await page.fill('#search', '小華');
    await page.waitForTimeout(250);
    await page.click('.friend__open');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${scheme}-3-detail.png`, fullPage: true });

    // 4) 真的記一張明信片下去，確認流程跑得通
    await page.fill('#send-country', 'Norway');
    await page.fill('#send-note', '峽灣邊上寫的');
    await page.click('#send-form button[type="submit"]');
    await page.waitForTimeout(600);
    const cardCount = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('pc.cards') || '[]').length);
    console.log(`[${scheme}] 記下明信片後共 ${cardCount} 張${cardCount === 8 ? ' ✓' : ' ✗ 應該是 8'}`);
    if (cardCount !== 8) totalErrors++;

    // 5) 寄信歷史
    await page.click('.tab[data-page="history"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${scheme}-4-history.png` });

    // 6) 篩選：只看還沒收到的
    await page.click('.filters__row--foot .toggle');
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${OUT}/${scheme}-5-filter.png` });
    const shown = await page.textContent('#history-count');
    console.log(`[${scheme}] 未收到篩選 → ${shown.trim()}`);

    // 7) 日期區間篩選（回顧某一趟旅行）
    await page.click('.filters__row--foot .toggle');
    await page.fill('#filter-from', '2026-03-01');
    await page.fill('#filter-to', '2026-03-31');
    await page.waitForTimeout(350);
    const tripCount = await page.textContent('#history-count');
    console.log(`[${scheme}] 2026 年 3 月那趟 → ${tripCount.trim()}`);
    await page.screenshot({ path: `${OUT}/${scheme}-6-trip.png` });

    // 8) 新增朋友表單
    await page.click('#btn-clear-filters');
    await page.click('.tab[data-page="send"]');
    await page.waitForTimeout(250);
    await page.click('#fab');
    await page.waitForTimeout(500);
    await page.fill('#f-name', '阿凱');
    await page.fill('#f-recipient', 'Kai Wu');
    await page.fill('#f-address', '5 Rue de Rivoli');
    await page.fill('#f-city', 'Paris');
    await page.fill('#f-postal', '75004');
    await page.fill('#f-country', 'France');
    await page.screenshot({ path: `${OUT}/${scheme}-7-newfriend.png`, fullPage: true });

    // 9) 編輯既有朋友（會多出「他搬家了」的按鈕）
    await page.click('#btn-friend-cancel');
    await page.waitForTimeout(350);
    await page.fill('#search', 'Yuki');
    await page.waitForTimeout(250);
    await page.click('.friend__open');
    await page.waitForTimeout(400);
    await page.click('[data-edit]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${scheme}-8-editfriend.png`, fullPage: true });

    // 10) 設定
    await page.click('#btn-friend-cancel');
    await page.waitForTimeout(350);
    await page.click('#btn-settings');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${scheme}-9-settings.png`, fullPage: true });

    console.log(`[${scheme}] 截圖完成${errors.length ? '，但有錯誤：' : '，無 JS 錯誤'}`);
    errors.forEach((e) => console.log('   ✗', e));
    totalErrors += errors.length;

    await context.close();
  }

  await browser.close();
  console.log(totalErrors ? `\n共 ${totalErrors} 個問題` : '\n全部通過');
  process.exit(totalErrors ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
