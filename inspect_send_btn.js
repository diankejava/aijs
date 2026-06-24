const { chromium } = require('playwright');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('请扫码登录 DeepSeek，然后在输入框里输入几个字（如"你好"），但不要发送。');
  console.log('确保发送按钮已出现后，回到控制台按回车...');

  rl.on('line', async () => {
    console.log('\n=== 寻找发送按钮 ===\n');

    // 1. 找到 textarea，然后在其父元素及其相邻区域查找可点击元素
    const info = await page.evaluate(() => {
      const results = [];
      const textarea = document.querySelector('textarea[placeholder*="DeepSeek"]');
      if (!textarea) return results;

      const taRect = textarea.getBoundingClientRect();
      // 在 textarea 右侧和下方查找元素
      const siblings = textarea.parentElement?.parentElement?.querySelectorAll('*') || [];
      for (const el of siblings) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // 元素在 textarea 右侧 (x > taRect.right - 50) 且接近 textarea 的垂直范围
        if (rect.x > taRect.right - 50 && rect.x < taRect.right + 100 &&
            rect.y + rect.height > taRect.y && rect.y < taRect.y + taRect.height) {
          results.push({
            tag: el.tagName,
            className: el.className?.slice(0, 100),
            id: el.id,
            ariaLabel: el.getAttribute('aria-label'),
            text: (el.textContent || '').trim().slice(0, 60),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            cursor: window.getComputedStyle(el).cursor
          });
        }
      }
      return results.slice(0, 20);
    });

    console.log('--- textarea 右侧可点击元素 ---');
    for (const el of info) {
      console.log(`[${el.tag}] class="${el.className}" aria-label="${el.ariaLabel}" cursor=${el.cursor}`);
      console.log(`  位置: (${el.x},${el.y}) 尺寸: ${el.w}x${el.h} 文本: "${el.text}"`);
      console.log();
    }

    // 2. 查找所有带 role 属性的元素
    const roles = await page.evaluate(() => {
      const results = [];
      const els = document.querySelectorAll('[role]');
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          results.push({
            tag: el.tagName,
            role: el.getAttribute('role'),
            className: el.className?.slice(0, 60),
            x: Math.round(rect.x),
            y: Math.round(rect.y)
          });
        }
      }
      return results.slice(0, 20);
    });

    if (roles.length > 0) {
      console.log('--- 带 role 属性的元素 ---');
      for (const el of roles) {
        console.log(`[${el.tag}] role="${el.role}" class="${el.className}" pos=(${el.x},${el.y})`);
      }
      console.log();
    }

    // 3. 查找所有 svg 元素 (可能是图标按钮)
    const svgs = await page.evaluate(() => {
      const results = [];
      const els = document.querySelectorAll('svg');
      for (const el of els) {
        const parent = el.closest('[class]');
        const rect = el.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) {
          results.push({
            className: el.className?.baseVal?.slice(0, 60),
            parentClass: parent?.className?.slice(0, 60),
            parentTag: parent?.tagName,
            x: Math.round(rect.x),
            y: Math.round(rect.y)
          });
        }
      }
      return results.slice(0, 10);
    });

    if (svgs.length > 0) {
      console.log('--- SVG 图标元素 (可能为发送按钮) ---');
      for (const el of svgs) {
        console.log(`[${el.parentTag}] parentClass="${el.parentClass}" svgClass="${el.className}" pos=(${el.x},${el.y})`);
      }
      console.log();
    }

    console.log('=== 检测完毕 ===');
    rl.close();
    await browser.close();
    process.exit(0);
  });
})();
