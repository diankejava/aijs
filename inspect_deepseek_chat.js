const { chromium } = require('playwright');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('请扫码登录 DeepSeek，并至少发送一条消息（如"你好"），待 AI 回复后再按回车...');

  rl.on('line', async () => {
    console.log('\n=== 扫描对话消息区域 (x>260 且 overflow-y: auto/scroll) ===\n');

    const elements = await page.evaluate(() => {
      const results = [];
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.x > 260 && rect.x + rect.width <= window.innerWidth && rect.y >= 0) {
          const text = (el.textContent || '').trim();
          if (text.length > 10) {
            const style = window.getComputedStyle(el);
            const overflowY = style.overflowY;
            // 重点关注有滚动的区域，以及包含较长文本的容器
            if (overflowY === 'auto' || overflowY === 'scroll' || text.length > 50) {
              results.push({
                tag: el.tagName,
                id: el.id,
                className: el.className?.slice(0, 100),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                overflowY: overflowY,
                childCount: el.children.length,
                text: text.slice(0, 350)
              });
            }
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
    const top = unique.slice(0, 30);

    console.log(`找到 ${unique.length} 个对话区域元素，显示前 30 个:\n`);
    for (const el of top) {
      console.log(`[${el.tag}] id="${el.id}" class="${el.className}"`);
      console.log(`  位置: (${el.x}, ${el.y}) 尺寸: ${el.width}x${el.height} overflow-y: ${el.overflowY} 子元素: ${el.childCount}`);
      console.log(`  文本: ${el.text}`);
      console.log('---');
    }

    console.log('\n=== 检测完毕 ===');
    rl.close();
    await browser.close();
    process.exit(0);
  });
})();
