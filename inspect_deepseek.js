const { chromium } = require('playwright');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('请扫码登录 DeepSeek，登录完成后回到控制台按回车...');

  rl.on('line', async () => {
    console.log('\n=== 检测页面元素 ===\n');

    // 1. 所有 textarea
    const textareas = await page.$$('textarea');
    console.log(`--- textarea (${textareas.length}) ---`);
    for (const ta of textareas) {
      const visible = await ta.isVisible();
      const placeholder = await ta.getAttribute('placeholder');
      const box = await ta.boundingBox();
      if (box) {
        console.log(`  placeholder="${placeholder}" visible=${visible} pos=(${Math.round(box.x)},${Math.round(box.y)}) size=${Math.round(box.width)}x${Math.round(box.height)}`);
      } else {
        console.log(`  placeholder="${placeholder}" visible=${visible} (no bounding box)`);
      }
    }

    // 2. 所有 contenteditable
    const editables = await page.$$('[contenteditable="true"]');
    console.log(`\n--- contenteditable (${editables.length}) ---`);
    for (const el of editables) {
      const visible = await el.isVisible();
      const box = await el.boundingBox();
      const text = (await el.textContent() || '').slice(0, 80);
      if (box) {
        console.log(`  visible=${visible} pos=(${Math.round(box.x)},${Math.round(box.y)}) size=${Math.round(box.width)}x${Math.round(box.height)} text="${text}"`);
      } else {
        console.log(`  visible=${visible} (no box) text="${text}"`);
      }
    }

    // 3. 所有 button
    const buttons = await page.$$('button');
    console.log(`\n--- button (${buttons.length}) ---`);
    for (const btn of buttons) {
      const visible = await btn.isVisible();
      if (!visible) continue;
      const box = await btn.boundingBox();
      const aria = await btn.getAttribute('aria-label');
      const cls = await btn.getAttribute('class');
      if (box) {
        console.log(`  aria-label="${aria}" class="${cls?.slice(0, 60)}" pos=(${Math.round(box.x)},${Math.round(box.y)}) size=${Math.round(box.width)}x${Math.round(box.height)}`);
      } else {
        console.log(`  aria-label="${aria}" class="${cls?.slice(0, 60)}" (no box)`);
      }
    }

    // 4. 所有带 placeholder 的 div
    const divsWithPH = await page.$$('div[data-placeholder], div[placeholder]');
    console.log(`\n--- div with placeholder (${divsWithPH.length}) ---`);
    for (const d of divsWithPH) {
      const ph = await d.getAttribute('data-placeholder') || await d.getAttribute('placeholder');
      const visible = await d.isVisible();
      console.log(`  placeholder="${ph}" visible=${visible}`);
    }

    // 5. body 文本摘要
    const bodyText = await page.evaluate(() => document.body.textContent?.slice(0, 300) || '');
    console.log(`\n--- body 前300字符 ---\n${bodyText}\n`);

    console.log('=== 检测完毕，可关闭浏览器 ===');
    rl.close();
    await browser.close();
    process.exit(0);
  });
})();
