/**
 * 換手機流程測試：舊手機匯出照片 → 新手機匯入。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-photos.js
 *
 * 照片只存在本機，這條路徑壞掉就是真的救不回來，所以連
 * 「電腦解開再壓過的 zip」「重複匯入」「選到不是 zip 的檔」都一起測。
 */

const { chromium } = require(process.env.PW_CORE);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const BASE = 'http://localhost:8788';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'postcard-photos-'));
const ZIP = path.join(TMP, 'exported.zip');

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

const ID_A = 'aaaaaaaa-1111-4aaa-9bbb-000000000001';
const ID_B = 'bbbbbbbb-2222-4aaa-9bbb-000000000002';
const ID_C = 'cccccccc-3333-4aaa-9bbb-000000000003';  // 照片有、紀錄還沒同步下來

const CARDS = [
  { id: ID_A, personId: 'p1', friendName: '小明', country: '日本', date: '2026-08-01',
    note: '富士山下的郵筒', received: false, hasPhoto: true, createdAt: '2026-08-01T00:00:00Z' },
  { id: ID_B, personId: 'p2', friendName: '小華', country: '法國', date: '2026-08-05',
    note: '', received: true, hasPhoto: true, createdAt: '2026-08-05T00:00:00Z' },
];

/** 用 canvas 生出真的 JPEG，再走 App 自己的 PhotoDB 存進去 */
const SEED = `async (ids) => {
  const make = (text, size) => {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = Math.round(size * 0.75);
    const g = c.getContext('2d');
    g.fillStyle = '#3388cc';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff';
    g.font = '20px sans-serif';
    g.fillText(text, 8, 30);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  };
  for (const id of ids) {
    await PhotoDB.put(id, {
      full: await make(id.slice(0, 4), 400),
      thumb: await make(id.slice(0, 4), 120),
    });
  }
  return (await PhotoDB.all()).length;
}`;

const DUMP = `async () => {
  const all = await PhotoDB.all();
  return all.map((p) => ({
    id: p.id, full: p.value.full.size, thumb: p.value.thumb.size, type: p.value.full.type,
  }));
}`;

/** page.evaluate 收到字串是當「表達式」求值，所以要自己組成呼叫式 */
const run = (p, fn, ...args) =>
  p.evaluate(`(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`);

const readCards = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('pc.cards') || '[]'));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
  });

  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    return p;
  };

  // ---------- 舊手機 ----------
  console.log('\nA. 舊手機：2 張明信片、3 張照片');
  const page = watch(await context.newPage());
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((cards) => {
    localStorage.setItem('pc.cards', JSON.stringify(cards));
    localStorage.setItem('pc.friends', '[]');
  }, CARDS);
  await page.reload({ waitUntil: 'networkidle' });

  const seeded = await run(page, SEED, [ID_A, ID_B, ID_C]);
  check('照片存進 IndexedDB', seeded === 3, `得到 ${seeded}`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.click('.tab[data-page="history"]');
  await page.waitForTimeout(400);
  const src = await page.getAttribute(`[data-thumb="${ID_A}"]`, 'src');
  check('歷史頁縮圖有載入', !!src && src.startsWith('blob:'));

  await page.click('#btn-settings');
  await page.waitForTimeout(300);
  check('設定頁顯示 3 張', (await page.textContent('#photo-count')) === '3 張');
  check('沒有「在別支手機」提示', await page.isHidden('#photo-missing'));

  // ---------- 匯出 ----------
  console.log('\nB. 匯出');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-export-photos'),
  ]);
  await download.saveAs(ZIP);
  check('檔名帶日期', /^明信片照片_\d{4}-\d{2}-\d{2}\.zip$/.test(download.suggestedFilename()),
        download.suggestedFilename());
  check('zip 有內容', fs.statSync(ZIP).size > 1000);
  check('按鈕恢復可按', (await page.textContent('#btn-export-photos')).trim() === '匯出照片');

  let unzipOk = true;
  try {
    execSync(`unzip -t "${ZIP}"`, { stdio: 'pipe' });
  } catch (e) {
    unzipOk = false;
  }
  check('電腦的 unzip 打得開（CRC 全對）', unzipOk);

  const listing = execSync(`unzip -Z1 "${ZIP}"`, { encoding: 'utf8' }).trim().split('\n');
  check('照片以明信片 id 命名', listing.includes(`photos/${ID_A}.jpg`));
  check('縮圖分開放', listing.includes(`photos/${ID_A}.thumb.jpg`));
  const manifest = JSON.parse(execSync(`unzip -p "${ZIP}" manifest.json`, { encoding: 'utf8' }));
  check('manifest 記著寄給誰',
        manifest.photos.find((p) => p.id === ID_A).friendName === '小明');
  check('manifest 筆數正確', manifest.count === 3);

  const before = await run(page, DUMP);

  // ---------- 新手機 ----------
  console.log('\nC. 新手機：紀錄同步下來了，照片沒有');
  const page2 = watch(await context.newPage());
  await page2.goto(BASE, { waitUntil: 'networkidle' });
  // 清掉照片＝新手機。B 的 hasPhoto 先設 false，測匯入後會不會補回來
  await page2.evaluate(async (cards) => {
    await PhotoDB.clear();
    localStorage.setItem('pc.cards', JSON.stringify(
      cards.map((c) => (c.id.startsWith('bbbb') ? { ...c, hasPhoto: false } : c))
    ));
  }, CARDS);
  await page2.reload({ waitUntil: 'networkidle' });

  await page2.click('.tab[data-page="history"]');
  await page2.waitForTimeout(400);
  check('缺圖時留提示框，不是整個縮圖消失', !!(await page2.$('.pcard__thumb--missing')));
  check('提示講清楚照片在哪',
        (await page2.textContent('.pcard__thumb--missing')).replace(/\s+/g, '') === '照片在別支手機');

  await page2.click('#btn-settings');
  await page2.waitForTimeout(300);
  check('設定頁照片數歸零', (await page2.textContent('#photo-count')) === '0 張');
  const missingText = await page2.textContent('#photo-missing');
  check('提示還差幾張（只算 hasPhoto 的那 1 張）', missingText.includes('另有 1 張'), missingText);

  // ---------- 匯入 ----------
  console.log('\nD. 匯入');
  await page2.setInputFiles('#import-photos-file', ZIP);
  await page2.waitForTimeout(1500);

  const after = await run(page2, DUMP);
  check('3 張照片都回來了', after.length === 3, `得到 ${after.length}`);

  const now = Object.fromEntries(after.map((p) => [p.id, p]));
  const was = Object.fromEntries(before.map((p) => [p.id, p]));
  check('主圖 byte 數沒變', now[ID_A]?.full === was[ID_A]?.full,
        `${now[ID_A]?.full} vs ${was[ID_A]?.full}`);
  check('縮圖 byte 數沒變', now[ID_A]?.thumb === was[ID_A]?.thumb);
  check('MIME 補回 image/jpeg', now[ID_A]?.type === 'image/jpeg', now[ID_A]?.type);
  check('紀錄還沒同步的照片也先收著', !!now[ID_C]);

  const cards2 = await readCards(page2);
  check('hasPhoto 被補回 true', cards2.find((c) => c.id === ID_B).hasPhoto === true);
  check('補回時標記待同步', cards2.find((c) => c.id === ID_B)._op === 'update');
  check('本來就對的紀錄沒被亂改', !cards2.find((c) => c.id === ID_A)._op);
  check('提示有講孤兒照片的事',
        /已匯入 3 張，其中 1 張等同步後才會顯示/.test(await page2.textContent('#toast')));

  await page2.click('.tab[data-page="history"]');
  await page2.waitForTimeout(700);
  // 光看 src 不夠：MIME 掉了的 blob 一樣掛得上去，只是畫不出來
  const size = await page2.evaluate(
    `(() => { const i = document.querySelector('[data-thumb="${ID_A}"]');
              return i && { w: i.naturalWidth, h: i.naturalHeight }; })()`
  );
  check('縮圖真的解碼出來', size && size.w > 0 && size.h > 0, JSON.stringify(size));
  check('提示框收掉了', (await page2.$('.pcard__thumb--missing')) === null);

  await page2.click('#btn-settings');
  await page2.waitForTimeout(300);
  check('設定頁回到 3 張', (await page2.textContent('#photo-count')) === '3 張');
  check('「在別支手機」提示收起', await page2.isHidden('#photo-missing'));

  // ---------- 使用者在電腦上動過的 zip ----------
  console.log('\nE. 電腦解開再壓過的 zip（deflate、多一層資料夾、__MACOSX）');
  const repackDir = path.join(TMP, 'repack');
  const repacked = path.join(TMP, 'repacked.zip');
  execSync(`mkdir -p "${repackDir}/我的照片" && unzip -q "${ZIP}" -d "${repackDir}/我的照片"`);
  execSync(`mkdir -p "${repackDir}/__MACOSX" && echo junk > "${repackDir}/__MACOSX/._x"`);
  execSync(`cd "${repackDir}" && zip -q -r "${repacked}" .`);

  const page3 = watch(await context.newPage());
  await page3.goto(BASE, { waitUntil: 'networkidle' });
  await page3.evaluate(async (cards) => {
    await PhotoDB.clear();
    localStorage.setItem('pc.cards', JSON.stringify(cards));
  }, CARDS);
  await page3.reload({ waitUntil: 'networkidle' });
  await page3.click('#btn-settings');
  await page3.setInputFiles('#import-photos-file', repacked);
  await page3.waitForTimeout(2000);

  const fromRepack = await run(page3, DUMP);
  check('壓縮過的 zip 也吃得下', fromRepack.length === 3, `得到 ${fromRepack.length}`);
  const rp = Object.fromEntries(fromRepack.map((p) => [p.id, p]));
  check('解壓後內容一模一樣', rp[ID_A]?.full === was[ID_A]?.full,
        `${rp[ID_A]?.full} vs ${was[ID_A]?.full}`);
  check('__MACOSX 垃圾檔沒被當成照片', !fromRepack.some((p) => p.id.startsWith('._')));

  // ---------- 重複匯入 ----------
  console.log('\nF. 重複匯入同一個檔');
  await page2.setInputFiles('#import-photos-file', ZIP);
  await page2.waitForTimeout(1500);
  check('還是 3 張，沒有變成 6 張', (await run(page2, DUMP)).length === 3);

  // ---------- 壞檔 ----------
  console.log('\nG. 選到不是 zip 的檔案');
  const junk = path.join(TMP, 'junk.txt');
  fs.writeFileSync(junk, 'this is not a zip');
  await page2.setInputFiles('#import-photos-file', junk);
  await page2.waitForTimeout(800);
  check('給出中文錯誤訊息', (await page2.textContent('#toast')).includes('匯入失敗'));
  check('按鈕沒卡在「匯入中…」',
        (await page2.textContent('#btn-import-photos')).trim() === '匯入照片');
  check('原有照片沒被弄壞', (await run(page2, DUMP)).length === 3);

  console.log(`\nJS 錯誤：${errors.length ? errors.join(' | ') : '無'}`);
  if (errors.length) fail++;

  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
