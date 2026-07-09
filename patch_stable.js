const fs = require('fs');
const f = 'e:/ai-js/index.js';
let c = fs.readFileSync(f, 'utf8');

const old =           console.log('\\x1b[35m[DEBUG] 最新 AI 回复已完成\\x1b[0m');
          await page.waitForTimeout(300);;
const rep =           console.log('\\x1b[35m[DEBUG] 检测到完成信号，等待内容稳定...\\x1b[0m');
          let sc = 0, lc = null;
          while (sc < 3 && Date.now() - startTime < timeout) {
            await page.waitForTimeout(pollInterval);
            try {
              const cur = await page.evaluate(() => {
                const items = document.querySelectorAll('[data-virtual-list-item-key]');
                if (!items.length) return '';
                const lst = items[items.length - 1];
                const m = lst.querySelector('.ds-assistant-message-main-content');
                return m ? m.textContent.trim() : '';
              });
              if (cur && cur === lc) { sc++; } else { sc = 0; lc = cur; }
            } catch (e) { sc = 0; }
          }
          console.log('\\x1b[35m[DEBUG] 内容已稳定，提取回复\\x1b[0m');
          await page.waitForTimeout(300);;

if (!c.includes(old)) {
  console.log('OLD STRING NOT FOUND');
  process.exit(1);
}
c = c.replace(old, rep);
fs.writeFileSync(f, c, 'utf8');
console.log('STABLE PATCH APPLIED');
