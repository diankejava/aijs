const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 120000 });

  console.log('页面已加载，等待 8 秒...');
  await page.waitForTimeout(8000);

  const info = await page.evaluate(() => {
    const result = {};

    // 1. conversation 容器的深层结构
    const conv = document.querySelector('[class*="conversation"]');
    if (conv) {
      // 递归获取前3层的子元素结构
      function getStructure(el, depth) {
        if (depth > 2 || !el || el.children.length === 0) {
          return {
            tag: el ? el.tagName : 'null',
            cls: el ? (el.className || '').substring(0, 80) : '',
            text: el ? (el.textContent || '').substring(0, 100) : ''
          };
        }
        return {
          tag: el.tagName,
          cls: (el.className || '').substring(0, 80),
          children: Array.from(el.children).map(c => getStructure(c, depth + 1))
        };
      }
      result.conversationTree = getStructure(conv, 0);
    }

    // 2. 找所有包含大量文本的叶子节点(疑似AI回复)
    const allEls = document.querySelectorAll('*');
    const textNodes = [];
    for (const el of allEls) {
      if (el.children.length === 0 && el.textContent && el.textContent.length > 50) {
        textNodes.push({
          tag: el.tagName,
          cls: (el.className || '').substring(0, 100),
          textLength: el.textContent.length,
          textPreview: el.textContent.substring(0, 200)
        });
      }
    }
    result.largeTextNodes = textNodes.slice(0, 10);

    // 3. 找 article 标签
    const articles = document.querySelectorAll('article');
    result.articles = Array.from(articles).map(a => ({
      tag: a.tagName,
      cls: (a.className || '').substring(0, 100),
      textPreview: (a.textContent || '').substring(0, 200)
    }));

    // 4. 查找 role="article" 或类似
    const roleArticles = document.querySelectorAll('[role="article"]');
    result.roleArticles = Array.from(roleArticles).map(a => ({
      tag: a.tagName,
      textPreview: (a.textContent || '').substring(0, 200)
    }));

    // 5. 查找可能的 AI 消息容器 - 从 dialog 往下找
    const dialogs = document.querySelectorAll('[class*="dialog"]');
    result.dialogsDeep = Array.from(dialogs).slice(0, 3).map((d, i) => {
      // 找 dialog 内所有带文本的 p 标签
      const paragraphs = d.querySelectorAll('p');
      const paragraphsText = Array.from(paragraphs).slice(0, 5).map(p => p.textContent.substring(0, 100));
      return {
        index: i,
        tag: d.tagName,
        cls: (d.className || '').substring(0, 100),
        totalText: (d.textContent || '').substring(0, 150),
        pCount: paragraphs.length,
        pTexts: paragraphsText
      };
    });

    return result;
  });

  console.log('\n========== 深层 DOM 分析 ==========\n');
  console.log(JSON.stringify(info, null, 2));

  console.log('\n\n浏览器将在 60 秒后关闭...');
  await page.waitForTimeout(60000);
  await browser.close();
})();
