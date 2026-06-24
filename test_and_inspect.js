const { chromium } = require('playwright');

(async () => {
  const testMsg = process.argv[2] || '你好';
  console.log('测试消息:', testMsg);

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  console.log('页面已加载，等待 5 秒...');
  await page.waitForTimeout(5000);

  const beforeLength = await page.evaluate(() => document.body.textContent.length);
  console.log('发送前 body 文本长度:', beforeLength);

  const editor = await page.$('textarea[placeholder*="发消息"]');
  if (!editor) { console.log('未找到输入框'); await browser.close(); process.exit(1); }

  await editor.click();
  await page.waitForTimeout(200);
  await editor.fill('');
  await editor.type(testMsg, { delay: 50 });
  await page.waitForTimeout(300);

  const btns = await page.$$('button[type="submit"]');
  let sendBtn = null;
  for (const btn of btns) {
    const cls = await btn.getAttribute('class');
    if (cls && cls.includes('rounded-full')) { sendBtn = btn; break; }
  }
  if (sendBtn) {
    await sendBtn.click();
    console.log('已点击发送按钮');
  } else {
    await editor.press('Enter');
    console.log('已按 Enter 发送');
  }

  // 等回复
  const startTime = Date.now();
  let replyFound = false;
  while (Date.now() - startTime < 120000) {
    await page.waitForTimeout(1500);
    const currentLen = await page.evaluate(() => document.body.textContent.length);
    if (currentLen > beforeLength + 20) {
      await page.waitForTimeout(3000);
      replyFound = true;
      break;
    }
  }

  const domInfo = await page.evaluate((bl) => {
    const clsStr = (el) => { try { const c = el.className; return typeof c === 'string' ? c : (c.baseVal || ''); } catch(e) { return ''; } };
    const result = {};
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        if (node.children.length === 0) return NodeFilter.FILTER_SKIP;
        if (!['DIV','SECTION','ARTICLE','P','PRE','LI','OL','UL','SPAN'].includes(node.tagName)) return NodeFilter.FILTER_SKIP;
        if (node.offsetParent === null) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const text = (el.textContent || '').trim();
      if (text.length > 30 && text.length < 50000 && !['SCRIPT','STYLE','LINK','META'].includes(el.tagName)) {
        const rect = el.getBoundingClientRect();
        candidates.push({
          tag: el.tagName, id: el.id || '', cls: clsStr(el).substring(0, 100),
          textLen: text.length, textPreview: text.substring(0, 300),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
        });
      }
    }
    candidates.sort((a, b) => a.rect.y - b.rect.y);
    result.candidates = candidates.slice(-20);

    const fullText = document.body.textContent || '';
    result.addedText = fullText.substring(bl).trim().substring(0, 2000);

    result.markdownEls = [];
    ['[class*="markdown"]','[class*="chat"]','[class*="message"]','[class*="bubble"]','[class*="content"]','[class*="reply"]','[class*="answer"]','[class*="turn"]','[class*="agent"]','[class*="assistant"]'].forEach(sel => {
      const els = document.querySelectorAll(sel);
      if (els.length > 0 && els.length < 20) {
        result.markdownEls.push({ selector: sel, count: els.length,
          samples: Array.from(els).slice(0, 3).map(e => ({ tag: e.tagName, cls: clsStr(e).substring(0, 80), text: (e.textContent || '').substring(0, 150) }))
        });
      }
    });
    return result;
  }, beforeLength);

  console.log('\n========== 新增文本（前2000字符） ==========');
  console.log(domInfo.addedText || '(无新增文本)');

  console.log('\n========== 候选消息容器（底部20个） ==========');
  domInfo.candidates.forEach((c, i) => {
    console.log(`[${i}] ${c.tag} id="${c.id}" cls="${c.cls}" pos=(${c.rect.x},${c.rect.y}) ${c.rect.w}x${c.rect.h}`);
    console.log(`   textLen=${c.textLen}, preview: ${c.textPreview.substring(0, 200)}`);
  });

  console.log('\n========== Markdown/消息相关元素 ==========');
  console.log(JSON.stringify(domInfo.markdownEls, null, 2));

  console.log('\n\n浏览器保持 120 秒供手动查看...');
  await page.waitForTimeout(120000);
  await browser.close();
})();
