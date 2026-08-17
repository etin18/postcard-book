/**
 * Bottom sheet 下拉關閉手勢測試。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-sheet-drag.js
 *
 * 用 CDP 送真的觸控事件（不是 JS 合成的 TouchEvent），
 * 這樣 touch-action、preventDefault 擋不擋得住捲動才測得準。
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

const CARDS = [
  { id: 'aaaaaaaa-1111-4aaa-9bbb-000000000001', personId: 'p1', friendName: '小明',
    country: '日本', date: '2026-08-01', note: '富士山下的郵筒', received: false,
    hasPhoto: false, createdAt: '2026-08-01T00:00:00Z' },
];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  /**
   * 從 (x,y) 往下拖 dist，分 steps 步。
   * CDP 每送一次事件本身就有 ~40ms 往返，所以「一步拉多遠」等於在調速度：
   * 步數少＝每步位移大＝甩得快。hold 是放手前停住不動的時間。
   */
  async function dragDown(x, y, dist, { steps = 8, pause = 16, release = true, hold = 0 } = {}) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x, y }],
    });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x, y: y + (dist * i) / steps }],
      });
      if (pause) await page.waitForTimeout(pause);
    }
    if (hold) await page.waitForTimeout(hold);
    if (release) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  }

  const openCardSheet = async () => {
    // 上一段沒關成功的話先收掉，不然點不到底下的分頁，錯誤會連環爆
    if (await page.isVisible('#card-sheet')) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
    await page.click('.tab[data-page="history"]');
    await page.waitForTimeout(200);
    await page.click('[data-edit-card]');
    await page.waitForTimeout(450);
  };

  const sheetState = () =>
    page.evaluate(`(() => {
      const s = document.getElementById('card-sheet');
      return {
        開著: !s.hidden && s.classList.contains('is-open'),
        位移: s.style.transform || '（無）',
        遮罩透明度: document.getElementById('scrim').style.opacity || '（無）',
      };
    })()`);

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((cards) => {
    localStorage.setItem('pc.cards', JSON.stringify(cards));
    localStorage.setItem('pc.friends', '[]');
  }, CARDS);
  await page.reload({ waitUntil: 'networkidle' });

  // 握把大概在 sheet 頂端往下 10px 處
  const gripY = async () => {
    const box = await page.locator('#card-sheet .sheet__grip').boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  // ---------- 拉夠遠 ----------
  console.log('\nA. 從握把往下拉 220px');
  await openCardSheet();
  check('視窗有開起來', (await sheetState()).開著);
  let g = await gripY();
  await dragDown(g.x, g.y, 220);
  await page.waitForTimeout(120);
  const midClose = await sheetState();
  check('放手後開始關閉', !midClose.開著, JSON.stringify(midClose));
  await page.waitForTimeout(350);
  check('關完後 sheet 收起來', await page.isHidden('#card-sheet'));
  check('遮罩也收了', await page.isHidden('#scrim'));
  check('inline 位移有清乾淨（不然下次開會歪掉）',
        (await sheetState()).位移 === '（無）', (await sheetState()).位移);

  // ---------- 再開一次，確認沒有殘留 ----------
  console.log('\nB. 關掉後再開');
  await openCardSheet();
  const reopened = await sheetState();
  check('正常開起來、沒有殘留位移',
        reopened.開著 && reopened.位移 === '（無）', JSON.stringify(reopened));

  // ---------- 拉一點點就放手 ----------
  console.log('\nC. 只拉 40px（拉不夠遠）');
  g = await gripY();
  await dragDown(g.x, g.y, 40, { steps: 6, pause: 40 });   // 慢慢拉，避免被判定成甩
  await page.waitForTimeout(400);
  const bounced = await sheetState();
  check('沒有關掉，彈回原位', bounced.開著, JSON.stringify(bounced));
  check('位移清掉了', bounced.位移 === '（無）', bounced.位移);
  check('遮罩透明度也還原', bounced.遮罩透明度 === '（無）', bounced.遮罩透明度);

  // ---------- 跟手 ----------
  console.log('\nD. 拉到一半還沒放手');
  g = await gripY();
  await dragDown(g.x, g.y, 90, { steps: 6, pause: 20, release: false });
  const holding = await sheetState();
  const px = parseFloat((holding.位移.match(/([\d.]+)px/) || [])[1] || '0');
  check('sheet 跟著手指移動', px > 60 && px < 120, holding.位移);
  check('遮罩跟著變淡',
        holding.遮罩透明度 !== '（無）' && parseFloat(holding.遮罩透明度) < 1,
        holding.遮罩透明度);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);
  check('放手後彈回（90px 還不到門檻）', (await sheetState()).開著);

  // ---------- 快速甩 ----------
  // 100px 不到 110 的距離門檻，關掉的話就是速度判定生效了
  console.log('\nE. 往下甩 100px（距離不夠，但最後一段夠快）');
  g = await gripY();
  await dragDown(g.x, g.y, 100, { steps: 2, pause: 0 });
  await page.waitForTimeout(150);
  check('甩得夠快就關掉', !(await sheetState()).開著);
  await page.waitForTimeout(350);

  console.log('\nE2. 一樣拉 100px，但放手前停住不動');
  await openCardSheet();
  g = await gripY();
  await dragDown(g.x, g.y, 100, { steps: 2, pause: 0, hold: 300 });
  await page.waitForTimeout(400);
  check('停住再放手不算甩，彈回去', (await sheetState()).開著, JSON.stringify(await sheetState()));

  // ---------- 內容捲動不該被搶走 ----------
  // 把視窗壓矮，逼出捲動條——這是最容易寫壞的一項：接管手勢時把捲動也搶走
  console.log('\nF. 內容捲到中間時往下拉（螢幕壓到 500px 高）');
  await page.setViewportSize({ width: 390, height: 500 });
  await openCardSheet();
  await page.evaluate(`document.getElementById('card-sheet').scrollTop = 60`);
  await page.waitForTimeout(100);
  const scrolled = await page.evaluate(`document.getElementById('card-sheet').scrollTop`);
  check('視窗確實需要捲動了', scrolled >= 10, `scrollTop=${scrolled}`);

  // 從表單中間起手，不是握把
  const body = await page.locator('#card-sheet .sheet__body').boundingBox();
  await dragDown(body.x + body.width / 2, body.y + 30, 80, { steps: 6, pause: 16 });
  await page.waitForTimeout(400);
  const afterScroll = await sheetState();
  check('沒有把視窗拉掉', afterScroll.開著, JSON.stringify(afterScroll));
  check('那是捲動，不是拖曳', afterScroll.位移 === '（無）', afterScroll.位移);
  const nowTop = await page.evaluate(`document.getElementById('card-sheet').scrollTop`);
  check('內容真的捲上去了', nowTop < scrolled, `${scrolled} → ${nowTop}`);

  console.log('\nF2. 捲回最頂之後再往下拉');
  await page.evaluate(`document.getElementById('card-sheet').scrollTop = 0`);
  await page.waitForTimeout(100);
  await dragDown(body.x + body.width / 2, body.y + 30, 200, { steps: 6, pause: 16 });
  await page.waitForTimeout(450);
  check('已經在最頂了，這次就關得掉', await page.isHidden('#card-sheet'));
  await page.setViewportSize({ width: 390, height: 844 });

  // ---------- 從輸入框起手 ----------
  console.log('\nG. 從輸入框往下拉');
  await openCardSheet();
  await page.evaluate(`document.getElementById('card-sheet').scrollTop = 0`);
  await page.waitForTimeout(100);
  const input = await page.locator('#card-sheet input[type="text"]').first().boundingBox();
  await dragDown(input.x + input.width / 2, input.y + input.height / 2, 150,
                 { steps: 6, pause: 16 });
  await page.waitForTimeout(400);
  check('從輸入框拉不會關掉（要讓人選字）', (await sheetState()).開著);

  // ---------- 原本的關法還在 ----------
  console.log('\nH. 原本的關法沒被弄壞');
  await page.click('#btn-card-cancel');
  await page.waitForTimeout(400);
  check('「取消」還能關', await page.isHidden('#card-sheet'));

  await openCardSheet();
  await page.click('#scrim', { position: { x: 10, y: 10 } });
  await page.waitForTimeout(400);
  check('點遮罩還能關', await page.isHidden('#card-sheet'));

  await openCardSheet();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Esc 還能關', await page.isHidden('#card-sheet'));

  // ---------- 朋友那張也要能拉 ----------
  console.log('\nI. 新增朋友那張視窗');
  await page.click('.tab[data-page="send"]');
  await page.waitForTimeout(200);
  await page.click('#fab');
  await page.waitForTimeout(450);
  check('視窗開起來', await page.isVisible('#friend-sheet'));
  const fg = await page.locator('#friend-sheet .sheet__grip').boundingBox();
  await dragDown(fg.x + fg.width / 2, fg.y + fg.height / 2, 220);
  await page.waitForTimeout(450);
  check('也能往下拉關掉', await page.isHidden('#friend-sheet'));

  console.log(`\nJS 錯誤：${errors.length ? errors.join(' | ') : '無'}`);
  if (errors.length) fail++;

  await browser.close();
  console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
