const fs = require('fs');
const content = fs.readFileSync('e:/ai-js/index.js', 'utf8');

const oldBlock =         if (found) {
          console.log('\\x1b[35m[DEBUG] 最新 AI 回复已完成\\x1b[0m');
          await page.waitForTimeout(300);
          let reply = await page.evaluate(() => {;

const newBlock =         if (found) {
          console.log('\\x1b[35m[DEBUG] 检测到回复内容，等待稳定...\\x1b[0m');
          let stableCount = 0;
          let lastContent = null;
          while (stableCount < 3 && Date.now() - startTime < timeout) {
            await page.waitForTimeout(pollInterval);
            try {
              const cur = await page.evaluate(() => {
                const items = document.querySelectorAll('[data-virtual-list-item-key]');
                if (!items.length) return '';
                const lst = items[items.length - 1];
                const m = lst.querySelector('.ds-assistant-message-main-content');
                return m ? m.textContent.trim() : '';
              });
              if (cur && cur === lastContent) {
                stableCount++;
              } else {
                stableCount = 0;
                lastContent = cur;
              }
            } catch (e) {
              stableCount = 0;
            }
          }
          console.log('\\x1b[35m[DEBUG] 回复已稳定，提取内容\\x1b[0m');
          await page.waitForTimeout(300);
          let reply = await page.evaluate(() => {;

const newContent = content.replace(oldBlock, newBlock);

if (content === newContent) {
  console.log('No changes made - string not found');
  process.exit(1);
}

fs.writeFileSync('e:/ai-js/index.js', newContent, 'utf8');
console.log('Patch applied successfully');
