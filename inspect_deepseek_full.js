const { chromium } = require('playwright');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('请扫码登录 DeepSeek，登录完成后回到控制台按回车...');

  rl.on('line', async () => {
    console.log('\n=== 扫描中央聊天区域 (x > 260) ===\n');

    const elements = await page.evaluate(() => {
      const results = [];
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        // 只扫描中央聊天区：x > 260，排除侧边栏
        if (rect.x > 260 && rect.x + rect.width <= window.innerWidth && rect.y >= 0) {
          const text = (el.textContent || '').trim();
          if (text.length > 0) {
            const computedStyle = window.getComputedStyle(el);
            results.push({
              tag: el.tagName,
              id: el.id,
              className: el.className?.slice(0, 100),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              overflowY: computedStyle.overflowY,
              text: text.slice(0, 300)
            });
          }
        }
      }
      return results;
    });

    // 去重
    const unique = [];
    const seen = new Set();
    for (const el of elements) {
      const key = `${el.tag}-${el.x}-${el.y}-${el.width}-${el.height}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(el);
      }
    }
    const top = unique.slice(0, 50);

    console.log(`找到 ${unique.length} 个中央区域元素，显示前 50 个:\n`);
    for (const el of top) {
      console.log(`[${el.tag}] id="${el.id}" class="${el.className}"`);
      console.log(`  位置: (${el.x}, ${el.y}) 尺寸: ${el.width}x${el.height} overflow-y: ${el.overflowY}`);
      console.log(`  文本: ${el.text}`);
      console.log('---');
    }

    console.log('\n=== 检测完毕 ===');
    rl.close();
    await browser.close();
    process.exit(0);
  });
})();
