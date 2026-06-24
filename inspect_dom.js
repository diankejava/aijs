const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 120000 });

  console.log('页面已加载，等待 8 秒确保渲染完成...');
  await page.waitForTimeout(8000);

  const info = await page.evaluate(() => {
    const result = {};

    // 1. 所有 textarea
    const textareas = document.querySelectorAll('textarea');
    result.textareas = Array.from(textareas).map(t => ({
      tag: t.tagName,
      placeholder: t.placeholder,
      className: t.className,
      id: t.id,
      visible: t.offsetParent !== null,
      rect: t.getBoundingClientRect()
    }));

    // 2. 所有 contenteditable
    const editables = document.querySelectorAll('[contenteditable="true"]');
    result.contenteditables = Array.from(editables).map(e => ({
      tag: e.tagName,
      className: e.className,
      id: e.id,
      visible: e.offsetParent !== null,
      rect: e.getBoundingClientRect(),
      text: e.textContent ? e.textContent.substring(0, 100) : ''
    }));

    // 3. 所有 button
    const buttons = document.querySelectorAll('button');
    result.buttons = Array.from(buttons).filter(b => b.offsetParent !== null).map(b => ({
      text: b.textContent ? b.textContent.trim().substring(0, 50) : '',
      className: b.className,
      ariaLabel: b.getAttribute('aria-label'),
      type: b.type,
      rect: b.getBoundingClientRect()
    }));

    // 4. 带有 placeholder 的 input/textarea
    const inputsWithPlaceholder = document.querySelectorAll('input[placeholder], textarea[placeholder]');
    result.inputsWithPlaceholder = Array.from(inputsWithPlaceholder).map(e => ({
      tag: e.tagName,
      placeholder: e.placeholder,
      className: e.className,
      visible: e.offsetParent !== null
    }));

    // 5. 查找可能的聊天消息容器
    const messageSelectors = [
      '[class*="message"]',
      '[class*="chat"]',
      '[class*="bubble"]',
      '[class*="turn"]',
      '[class*="agent"]',
      '[class*="assistant"]',
      '[class*="reply"]',
      '[class*="answer"]',
      '[class*="conversation"]',
      '[class*="dialog"]',
      '[class*="thread"]'
    ];
    result.messageContainers = {};
    for (const sel of messageSelectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0 && els.length <= 50) {
        result.messageContainers[sel] = els.length;
      }
    }

    // 6. body 下直接子元素概览
    result.bodyChildren = Array.from(document.body.children).map(c => ({
      tag: c.tagName,
      className: c.className ? c.className.substring(0, 80) : '',
      id: c.id || ''
    }));

    // 7. 所有 visible 的 role 属性
    const roles = document.querySelectorAll('[role]');
    result.roles = {};
    for (const el of roles) {
      if (el.offsetParent !== null) {
        const role = el.getAttribute('role');
        result.roles[role] = (result.roles[role] || 0) + 1;
      }
    }

    return result;
  });

  console.log('\n========== DOM 结构分析 ==========\n');
  console.log(JSON.stringify(info, null, 2));

  // 保持浏览器打开 10 秒供手动查看
  console.log('\n\n浏览器将在 60 秒后关闭，你可以手动查看页面...');
  await page.waitForTimeout(60000);
  await browser.close();
})();
