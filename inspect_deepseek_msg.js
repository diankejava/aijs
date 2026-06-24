const { chromium } = require('playwright');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('请扫码登录 DeepSeek，登录完成后回到控制台按回车...');

  rl.on('line', async () => {
    console.log('\n=== 寻找 AI 回复容器 ===\n');

    // 1. 查找包含 "DeepSeek" 或 "AI" 标识的容器
    const containers = await page.evaluate(() => {
      const results = [];
      // 常见 AI 聊天容器的 class 名模式
      const selectors = [
        '[class*="message"]',
        '[class*="chat"]',
        '[class*="conversation"]',
        '[class*="response"]',
        '[class*="answer"]',
        '[class*="bubble"]',
        '[class*="reply"]',
        '[class*="assistant"]',
        '[class*="ai"]',
        'main',
        'article',
        '[role="log"]',
        '[role="list"]'
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const text = (el.textContent || '').trim();
          if (text.length > 20 && text.length < 5000) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 200 && rect.height > 100) {
              results.push({
                selector: sel,
                tag: el.tagName,
                className: el.className?.slice(0, 80),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                textPreview: text.slice(0, 150)
              });
            }
          }
        }
      }
      return results.slice(0, 20);
    });

    console.log('--- 可能的消息容器 ---');
    for (const c of containers) {
      console.log(`  [${c.tag}] class="${c.className}" pos=(${c.x},${c.y}) size=${c.width}x${c.height}`);
      console.log(`    选择器: ${c.selector}`);
      console.log(`    文本: ${c.textPreview}`);
      console.log();
    }

    // 2. 查找所有带有 data- 属性的元素 (DeepSeek 常用 data 属性标记消息)
    const dataAttrs = await page.evaluate(() => {
      const results = [];
      const all = document.querySelectorAll('[data-testid], [data-id], [data-message], [data-chat], [data-index]');
      for (const el of all) {
        const attrs = {};
        for (const attr of el.attributes) {
          if (attr.name.startsWith('data-')) attrs[attr.name] = attr.value;
        }
        const rect = el.getBoundingClientRect();
        results.push({
          tag: el.tagName,
          className: el.className?.slice(0, 80),
          attrs: JSON.stringify(attrs),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          text: (el.textContent || '').slice(0, 200)
        });
      }
      return results.slice(0, 15);
    });

    if (dataAttrs.length > 0) {
      console.log('--- 带 data-* 属性的元素 ---');
      for (const d of dataAttrs) {
        console.log(`  [${d.tag}] class="${d.className}" attrs=${d.attrs} pos=(${d.x},${d.y}) size=${d.width}x${d.height}`);
        console.log(`    文本: ${d.text}`);
        console.log();
      }
    }

    // 3. 查找所有 article 标签
    const articles = await page.evaluate(() => {
      const results = [];
      const els = document.querySelectorAll('article, [role="article"]');
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        results.push({
          tag: el.tagName,
          className: el.className?.slice(0, 80),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          text: (el.textContent || '').slice(0, 200)
        });
      }
      return results;
    });

    if (articles.length > 0) {
      console.log('--- article 标签 ---');
      for (const a of articles) {
        console.log(`  [${a.tag}] class="${a.className}" pos=(${a.x},${a.y}) size=${a.width}x${a.height}`);
        console.log(`    文本: ${a.text}`);
        console.log();
      }
    }

    console.log('=== 检测完毕 ===');
    rl.close();
    await browser.close();
    process.exit(0);
  });
})();
