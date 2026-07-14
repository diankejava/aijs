const { chromium } = require('playwright');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const http = require('http');
const config = require('./config.json');

const platformKey = process.argv[2] || config.default;
const platform = config.platforms[platformKey];

if (!platform) {
  console.error(`未知平台: ${platformKey}`);
  console.error(`可用平台: ${Object.keys(config.platforms).join(', ')}`);
  process.exit(1);
}

const userDataDir = path.join(__dirname, 'browser-data', platformKey);
const storageStateFile = path.join(userDataDir, 'storage-state.json');
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
});

async function main() {
  console.log(`正在启动浏览器，打开 ${platform.name}...`);
  const requestQueue = [];
  let isProcessing = false;

  async function processNextInQueue() {
    if (isProcessing) return;
    isProcessing = true;
    while (requestQueue.length > 0) {
      const { handler, resolve, reject } = requestQueue.shift();
      try {
        const result = await handler();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }
    isProcessing = false;
  }

  function enqueueTask(handler) {
    return new Promise((resolve, reject) => {
      requestQueue.push({ handler, resolve, reject });
      processNextInQueue();
    });
  }

  let storageState = null;
  if (fs.existsSync(storageStateFile)) {
    try {
      storageState = JSON.parse(fs.readFileSync(storageStateFile, 'utf8'));
      console.log('检测到已保存的登录凭证，尝试自动登录...');
    } catch (_) {
      console.log('存储状态文件损坏，将重新登录。');
      storageState = null;
    }
  }

  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--no-sandbox'],
    storageState: storageState || undefined
  });

  const page = browser.pages()[0] || await browser.newPage();

  await page.goto(platform.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`页面已打开，等待登录到 ${platform.name}...`);

  const editorSelectors = platform.editor.split(', ');
  let loggedIn = false;

  for (const sel of editorSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        loggedIn = true;
        break;
      }
    } catch (_) {}
  }

  if (loggedIn) {
    console.log('登录凭证有效，已自动登录！\n');
  } else {
    console.log('未检测到有效凭证，请在浏览器中扫码登录（最多等待5分钟）...');
    const loginStart = Date.now();
    let lastLog = 0;

    while (Date.now() - loginStart < 300000) {
      try {
        let editor = null;
        for (const sel of editorSelectors) {
          editor = await page.$(sel);
          if (editor && await editor.isVisible()) {
            break;
          } else {
            editor = null;
          }
        }
        if (editor) { loggedIn = true; break; }
      } catch (e) {
        if (e.message && e.message.includes('Execution context')) {
          console.log('  检测到页面跳转，等待稳定后重试...');
          try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch (_) {}
        } else {
          throw e;
        }
      }
      const elapsed = Math.round((Date.now() - loginStart) / 1000);
      if (elapsed - lastLog >= 10) {
        console.log(`  仍在等待登录... (已等待 ${elapsed} 秒)`);
        lastLog = elapsed;
      }
      await page.waitForTimeout(2000);
    }

    if (!loggedIn) {
      console.log('登录超时（5分钟），请重新运行。');
      await browser.close();
      process.exit(1);
    }

    try {
      const state = await browser.storageState();
      fs.writeFileSync(storageStateFile, JSON.stringify(state, null, 2));
      console.log('登录凭证已永久保存，下次启动无需重新登录。\n');
    } catch (e) {
      console.log('警告: 保存登录凭证失败，下次可能需要重新登录。');
    }
  }

  console.log('登录成功！可以开始对话了。\n');

  async function findEditor() {
    const selectors = platform.editor.split(', ');
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) return el;
    }
    return null;
  }

  async function findSendButton() {
    const selectors = platform.sendButton.split(', ');
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) return el;
    }
    return null;
  }

  // 等待并精准提取最后一条 AI 回复（纯文本内容）
  async function waitForReply(timeout = 300000) {
    console.log('\x1b[35m[DEBUG] 等待最新 AI 回复完成...\x1b[0m');
    const startTime = Date.now();
    const pollInterval = 1000;

    while (Date.now() - startTime < timeout) {
      // 不再主动检查 cancelState，让等待自然结束或超时
      try {
        const found = await page.evaluate(() => {
          const items = document.querySelectorAll('[data-virtual-list-item-key]');
          if (!items.length) return false;
          const last = items[items.length - 1];
          return !!(last.querySelector('.ds-assistant-message-main-content') && last.querySelector('.ds-flex'));
        });

        if (found) {
          console.log('\x1b[35m[DEBUG] 检测到完成信号，等待内容稳定...\x1b[0m');
          await page.waitForTimeout(300);
          let reply = await page.evaluate(() => {
              const items = document.querySelectorAll('[data-virtual-list-item-key]');
              const last = items[items.length - 1];
              const main = last.querySelector('.ds-assistant-message-main-content');
              if (!main) return '';

              // 优先从 innerHTML 中提取 <tool_call> 标签，因为 DeepSeek 可能使用实体编码
              const rawHTML = main.innerHTML;
              const toolCallMatch = rawHTML.match(/&lt;tool_call&gt;([\s\S]*?)&lt;\/tool_call&gt;/i);
              
              // 有工具调用时用 textContent，纯文本回复时用 innerText 保留换行
              let text = toolCallMatch
                ? main.textContent.trim()
                : main.innerText.trim();

              text = text.replace(/专家模式暂不支持搜索，请使用快速模式/g, '').trim();
              // 清洗页面 UI 杂讯（常见按钮文字、语言标签等）
              text = text.replace(/^(复制|下载|运行|调试|代码|powershell|bash|python|javascript|typescript|css|html|json|yaml|xml|markdown|shell|cmd|sh|java|cpp|csharp|go|rust|ruby|php|sql|swift|kotlin|scala|r|perl|lua|dart|plaintext|text|diff|patch|ini|toml|env|nginx|apache|makefile|dockerfile|yml)$/gmi, '');
              if (text.includes('User:') || text.includes('Assistant:')) return '';
              return text;
          });

          if (!reply) {
            await page.waitForTimeout(500);
            reply = await page.evaluate(() => {
              const items = document.querySelectorAll('[data-virtual-list-item-key]');
              const last = items[items.length - 1];
              const main = last.querySelector('.ds-assistant-message-main-content');
              if (!main) return '';
              const rawHTML2 = main.innerHTML;
              const hasToolCall2 = /<tool_call/i.test(rawHTML2);
              let text = hasToolCall2
                ? main.textContent.trim()
                : main.innerText.trim();
              text = text.replace(/专家模式暂不支持搜索，请使用快速模式/g, '').trim();
              text = text.replace(/^(复制|下载|运行|调试|代码|powershell|bash|python|javascript|typescript|css|html|json|yaml|xml|markdown|shell|cmd|sh|java|cpp|csharp|go|rust|ruby|php|sql|swift|kotlin|scala|r|perl|lua|dart|plaintext|text|diff|patch|ini|toml|env|nginx|apache|makefile|dockerfile|yml)$/gmi, '');
              if (text.includes('User:') || text.includes('Assistant:')) return '';
              return text;
            });
          }

          console.log('\x1b[32m[DEBUG] 成功提取回复，长度:\x1b[0m', reply ? reply.length : 0);
          return reply || '';
        }
      } catch (e) {
        if (e.message && e.message.includes('Execution context')) {
          console.log('\x1b[35m[DEBUG] 页面上下文失效，等待稳定...\x1b[0m');
          await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        } else {
          console.log('\x1b[31m[DEBUG] 轮询异常:\x1b[0m', e.message);
        }
      }

      await page.waitForTimeout(pollInterval);
    }

    console.log('\x1b[31m[DEBUG] waitForReply 超时\x1b[0m');
    return null;
  }

  async function sendAndWait(text, cancelState = null) {
    console.log('\x1b[36m[DEBUG] === 发送消息 ===\x1b[0m');
    console.log('\x1b[36m[DEBUG] 内容:\x1b[0m', text.slice(0, 100));

    const editor = await findEditor();
    if (!editor) {
      console.log('[HTTP] 错误: 未找到输入框');
      throw new Error('未找到输入框');
    }

    if (platformKey === 'deepseek') {
      try {
        const expertBtn = page.locator('[role="radio"]:has-text("专家模式")');
        if (await expertBtn.count() > 0) {
          const isSelected = await expertBtn.evaluate(el => el.getAttribute('aria-checked') === 'true');
          if (!isSelected) {
            await expertBtn.click();
            await page.waitForTimeout(500);
            console.log('[HTTP] 已切换到专家模式');
          }
        }
      } catch (e) {
        console.log('[HTTP] 专家模式切换异常:', e.message);
      }
    }

    // ========== 稳健输入策略：优先 insertText，降级为增强 DOM 注入（支持换行） ==========
    await editor.click();
    await page.waitForTimeout(200);

    // 清空输入框
    const tagName = await editor.evaluate(el => el.tagName.toLowerCase());
    const isRich = await editor.evaluate(el => el.getAttribute('contenteditable') === 'true');
    if (isRich || tagName === 'div') {
      await editor.evaluate(el => { el.textContent = ''; });
    } else {
      await editor.fill('');
    }

    let inputSuccess = false;
    try {
      // 方法1：使用 keyboard.insertText，不通过剪贴板，直接输入字符（包括换行）
      // 该 API 会逐字符派发 input 事件，完美兼容 React/Vue 且不会触发 Enter 发送
      await page.keyboard.insertText(text);
      inputSuccess = true;
      console.log('[HTTP] 使用 keyboard.insertText 输入成功');
    } catch (e) {
      console.log('[HTTP] insertText 失败，尝试增强 DOM 注入:', e.message);
    }

    if (!inputSuccess) {
      // 方法2：增强 DOM 注入 —— 将 \n 转为 <br> 元素，并派发事件
      console.log('[HTTP] 执行增强 DOM 注入（支持换行）');
      await editor.evaluate((el, t) => {
        const isRichEl = el.getAttribute('contenteditable') === 'true' || el.tagName.toLowerCase() === 'div';
        if (isRichEl) {
          // 清空并分行插入文本节点和 <br>
          el.innerHTML = '';
          const lines = t.split('\n');
          for (let i = 0; i < lines.length; i++) {
            el.appendChild(document.createTextNode(lines[i]));
            if (i < lines.length - 1) {
              el.appendChild(document.createElement('br'));
            }
          }
        } else {
          // 普通 input/textarea
          el.value = t;
        }
        // 派发多种事件，确保框架感知变化
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new CompositionEvent('compositionend', { data: t, bubbles: true }));
      }, text);
      // 短暂等待框架同步
      await page.waitForTimeout(400);
    } else {
      await page.waitForTimeout(300); // insertText 后等待渲染
    }

    // 等待发送按钮变为可用（最多等待 3 秒）
    const sendBtnSelector = platform.sendButton.split(', ')[0]; // 取第一个选择器
    try {
      await page.waitForFunction(
        (sel) => {
          const btn = document.querySelector(sel);
          return btn && !btn.disabled && btn.offsetParent !== null;
        },
        sendBtnSelector,
        { timeout: 3000 }
      );
    } catch (_) {
      console.log('[HTTP] 等待发送按钮可用超时，仍尝试发送');
    }

    // 点击发送按钮
    const sendBtn = await findSendButton();
    if (sendBtn) {
      console.log('\x1b[36m[DEBUG] 点击发送按钮\x1b[0m');
      await sendBtn.click();
    } else {
      console.log('\x1b[36m[DEBUG] Enter 发送\x1b[0m');
      await editor.press('Enter');
    }


    // 新增：自动检测并点击重试按钮（最多尝试 10 次，每次间隔 2 秒）
    const retryCheckInterval = 2000;
    const retryMaxAttempts = 10;
    for (let retryAttempt = 0; retryAttempt < retryMaxAttempts; retryAttempt++) {
      await page.waitForTimeout(retryCheckInterval);
      if (cancelState && cancelState.cancelled) break;

      const maybeReply = await page.evaluate(() => {
        const items = document.querySelectorAll('[data-virtual-list-item-key]');
        if (!items.length) return false;
        const last = items[items.length - 1];
        return !!last.querySelector('.ds-assistant-message-main-content');
      });
      if (maybeReply) break;

      // 更精准的选择器：图标路径 + 警告样式按钮
      let retryBtn = page.locator('[role="button"].ds-button--warning .ds-icon svg path[d^="M1.272 6.21348"]');
      if (await retryBtn.count() === 0) {
        // 备用：直接匹配包含图标的按钮
        retryBtn = page.locator('[role="button"]').filter({
          has: page.locator('.ds-icon svg path[d^="M1.272 6.21348"]')
        });
      }
      if (await retryBtn.count() > 0) {
        console.log('[HTTP] 检测到重试按钮，自动点击重试...');
        await retryBtn.first().click({ force: true });
        retryAttempt = -1; // 重置，继续监测
      }
    }

    // 通过页面上下文检测超限提示（不依赖类名）
    const isOverLimit = await page.evaluate(() => {
        const spans = document.querySelectorAll('span');
        const regex = /(over limit|超出限制|超过限制|超出).*?\d+%/i;
        for (const span of spans) {
            const text = span.textContent.trim();
            if (regex.test(text) && span.offsetParent !== null) {
                return text;
            }
        }
        return null;
    });

    if (isOverLimit) {
        console.log(`\x1b[31m[ERROR] 检测到上下文超限: ${isOverLimit}\x1b[0m`);
        return null;
    }

    console.log('\x1b[35m[DEBUG] 进入 waitForReply\x1b[0m');
    const reply = await waitForReply();
    if (reply) {
      console.log('\x1b[32m[DEBUG] === 收到回复 ===\x1b[0m');
      console.log('\x1b[32m[DEBUG] 长度:\x1b[0m', reply.length);
      console.log('\x1b[32m[DEBUG] 前 200 字符:\x1b[0m', reply.slice(0, 200));
      return reply;
    } else {
      console.log('\x1b[31m[DEBUG] 未收到回复\x1b[0m');
      return null;  // 不再递归重试
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.end(JSON.stringify({
        object: 'list',
        data: [{
          id: platformKey,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'user'
        }]
      }));
      return;
    }

    function safeJsonParse(text) {
      // 1. 将字符串值内的真实换行替换为 \n
      // 原理：用占位符保护字符串边界，正则匹配双引号包裹的内容
      let safeText = text.replace(/"((?:[^"\\]|\\.)*)"/g, (match, content) => {
        // 将内容里的真实换行、回车等转为转义形式
        const escaped = content
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
        return `"${escaped}"`;
      });
      // 还可以进一步处理未转义的英文双引号等（此处略）
      return JSON.parse(safeText);
    }

    // 解析模型输出中的工具调用（新格式：<tool_call name="函数名">参数JSON</tool_call>）
    function parseToolCall(text, allowedNames = []) {
      if (!text) return { found: false, success: false, toolCalls: [], toolCall: null };

      const results = [];
      const decodeEntities = (str) => {
        return str.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                  .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'");
      };

      const openTags = [
        { prefix: '<tool_call name="', suffix: '">', close: '</tool_call>' },
        { prefix: '&lt;tool_call name="', suffix: '"&gt;', close: '&lt;/tool_call&gt;' }
      ];

      for (const tag of openTags) {
        let searchFrom = 0;
        while (true) {
          const startIdx = text.indexOf(tag.prefix, searchFrom);
          if (startIdx === -1) break;

          const nameEnd = text.indexOf(tag.suffix, startIdx + tag.prefix.length);
          if (nameEnd === -1) break;

          const rawName = text.substring(startIdx + tag.prefix.length, nameEnd).trim();
          if (!rawName) {
            results.push({ success: false, error: 'name 属性不能为空' });
            searchFrom = nameEnd + tag.suffix.length;
            continue;
          }

          const closeIdx = text.indexOf(tag.close, nameEnd + tag.suffix.length);
          if (closeIdx === -1) break;

          const rawArgs = text.substring(nameEnd + tag.suffix.length, closeIdx).trim();
          let parsedArgs;
          try {
            parsedArgs = JSON.parse(decodeEntities(rawArgs));
          } catch (e) {
            let fixedArgs = rawArgs.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
            try {
              parsedArgs = JSON.parse(fixedArgs);
            } catch (e2) {
              // 步骤1：修复未转义的反斜杠（Windows 路径等）
              let rebuilt = '';
              for (let i = 0; i < fixedArgs.length; i++) {
                const ch = fixedArgs[i];
                if (ch === '\\') {
                  const next = fixedArgs[i + 1];
                  // 保留所有 JSON 合法转义字符：", \, /, b, f, n, r, t, u
                  if (next === '"' || next === '\\' || next === '/') {
                    rebuilt += '\\';
                  } else {
                    rebuilt += '\\\\';
                  }
                } else {
                  rebuilt += ch;
                }
              }
              try {
                parsedArgs = JSON.parse(rebuilt);
              } catch (e3) {
                // 步骤2：尝试修复未转义的双引号（常见于 XML 属性值）
                let rebuilt2 = rebuilt;
                // 检测是否包含类似 property="value" 的模式
                if (/="[^"]*"/.test(rebuilt2)) {
                  // 将 ="..." 形式的属性值内部的双引号转义
                  rebuilt2 = rebuilt2.replace(/=("[^"]*")/g, (fullMatch, quoted) => {
                    // 把 quoted 里面的所有双引号转义为 \"
                    return '=' + quoted.replace(/"/g, '\\"');
                  });
                  try {
                    parsedArgs = JSON.parse(rebuilt2);
                  } catch (e4) {
                    results.push({ success: false, error: `参数 JSON 解析失败，如果JSON中有单斜杆\\注意要转义：${e.message},失败的JSON: ${rawArgs}` });
                    searchFrom = closeIdx + tag.close.length;
                    continue;
                  }
                } else {
                  // 步骤3：通用嵌套双引号修复（状态机扫描字符串值内部）
                  const fixNestedQuotes = (jsonStr) => {
                    let result = '';
                    let inString = false;
                    let prevBackslash = false; // 前一个字符是否是反斜杠（在字符串内）
                    for (let i = 0; i < jsonStr.length; i++) {
                      const ch = jsonStr[i];
                      if (!inString) {
                        if (ch === '"') {
                          inString = true;
                          prevBackslash = false;
                          result += ch;
                        } else {
                          result += ch;
                        }
                      } else {
                        if (prevBackslash) {
                          // 前一个字符是反斜杠，当前字符被转义，直接输出
                          result += ch;
                          prevBackslash = false;
                        } else if (ch === '\\') {
                          // 遇到反斜杠，可能是转义开始
                          prevBackslash = true;
                          result += ch;
                        } else if (ch === '"') {
                          // 前瞻判断是否为字符串结束
                          let j = i + 1;
                          while (j < jsonStr.length && /\s/.test(jsonStr[j])) j++;
                          const nextCh = jsonStr[j];
                          if (nextCh === ':' || nextCh === ',' || nextCh === '}' || nextCh === ']' || j === jsonStr.length) {
                            // 确实是字符串结束
                            inString = false;
                            result += '"';
                          } else {
                            // 内部未转义的双引号，自动添加转义
                            result += '\\"';
                          }
                        } else {
                          result += ch;
                        }
                      }
                    }
                    return result;
                  };
                  const rebuilt3 = fixNestedQuotes(rebuilt2);
                  try {
                    parsedArgs = JSON.parse(rebuilt3);
                  } catch (e5) {
                    // 步骤4：尝试修复常见的 Java 代码 content 字段中的双引号
                    if (/\"content\"\s*:\s*\"[^"]*\\/.test(rebuilt2)) { // 粗略检测 content 字段存在且内含代码
                      const contentFix = rebuilt2.replace(/("content"\s*:\s*")([^"]*?)(")/g, (match, key, val, endQuote) => {
                        // 将 val 中的所有双引号转义
                        return key + val.replace(/"/g, '\\"') + endQuote;
                      });
                      try {
                        parsedArgs = JSON.parse(contentFix);
                      } catch (e6) {
                        results.push({ success: false, error: `参数 JSON 解析失败，如果JSON中有单斜杆\\注意要转义：${e.message},失败的JSON: ${rawArgs}` });
                        searchFrom = closeIdx + tag.close.length;
                        continue;
                      }
                    } else {
                      results.push({ success: false, error: `参数 JSON 解析失败，如果JSON中有单斜杆\\注意要转义：${e.message},失败的JSON: ${rawArgs}` });
                      searchFrom = closeIdx + tag.close.length;
                      continue;
                    }
                  }
                }
              }
            }
          }

          if (typeof parsedArgs !== 'object' || parsedArgs === null) {
            results.push({ success: false, error: 'arguments 必须是一个 JSON 对象' });
          } else if (allowedNames.length > 0 && !allowedNames.includes(rawName)) {
            results.push({ success: false, error: `无效的函数名 "${rawName}"，允许的函数名：${allowedNames.join(', ')}` });
          } else {
            // 如果解析成功，清理字符串中可能被错误转义的换行/制表符
            if (typeof parsedArgs === 'object' && parsedArgs !== null) {
              const fixStringValues = (obj) => {
                for (const key of Object.keys(obj)) {
                  if (typeof obj[key] === 'string') {
                    obj[key] = obj[key].replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
                  } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                    fixStringValues(obj[key]);
                  }
                }
              };
              fixStringValues(parsedArgs);
            }
            // 然后推入结果
            results.push({ success: true, toolCall: { name: rawName, arguments: parsedArgs } });
          }
          searchFrom = closeIdx + tag.close.length;
        }
      }

      if (results.length === 0) {
        if (/<(tool_calls|invoke|parameter|function_call|tool_use)/i.test(text)) {
          return { found: true, success: false, toolCalls: [], toolCall: null, error: '检测到禁止的标签格式（如 <tool_calls>, <invoke>, <parameter>），必须使用 <tool_call name="函数名">参数JSON</tool_call>' };
        }
        if (text.includes('<tool_call') || text.includes('&lt;tool_call')) {
          return { found: true, success: false, toolCalls: [], toolCall: null, error: '存在 <tool_call> 标签但无法解析，正确格式：<tool_call name="函数名">参数JSON</tool_call>' };
        }
        return { found: false, success: false, toolCalls: [], toolCall: null };
      }

      // 收集所有成功的工具调用
      const successful = results.filter(r => r.success).map(r => r.toolCall);
      const allSuccess = results.every(r => r.success);

      return {
        found: true,
        success: allSuccess,
        toolCalls: successful,
        toolCall: successful.length > 0 ? successful[0] : null,
        error: allSuccess ? null : results.find(r => !r.success)?.error || '部分工具调用解析失败'
      };
    }

    /**
     * 清洗回复中的“任务已完成”标记，保留正常文本
     * @param {string} text - 可能包含“任务已完成”的原始文本
     * @returns {string|null} 清洗后的有效文本，若为空则返回 null
     */
    function cleanTaskCompletedMark(text) {
      if (!text) return null;
      // 移除“任务已完成”及其后的可选标点，同时去除首尾空白
      const cleaned = text.replace(/任务已完成[。！？.!?\s]*/g, '').trim();
      return cleaned.length > 0 ? cleaned : null;
    }

    async function getFinalReplyWithTools(promptText, toolsText, instruction, toolNames, cancelState) {
      const hasTools = toolsText && toolsText !== '无';
      let prompt = `【可用工具】\n${toolsText}${instruction}\n\n${promptText}`;
      let reply = await sendAndWait(prompt, cancelState);
      let rawOutput = (reply && reply.trim()) || '【系统提示】DeepSeek 未返回有效回复。';
      const firstOutput = rawOutput; // 保存模型第一次的原始回答，作为回退使用
      console.log('[HTTP] 首次输出:', rawOutput.slice(0, 150));

      // ----- 如果首次输出中就包含“任务已完成”，清洗后再决定是否立即结束 -----
      const cleanedFirst = cleanTaskCompletedMark(rawOutput);
      if (rawOutput.includes('任务已完成')) {
        if (cleanedFirst) {
          // 如果清洗后仍有有效内容，直接返回给客户端（不再继续工具流程）
          console.log('[ToolCall] 首次回复即包含任务完成标记，清洗后返回有效内容');
          return { toolCall: null, rawOutput: cleanedFirst };
        } else {
          // 清洗后为空，说明模型只说了“任务已完成”几个字，回退到 firstOutput（但 firstOutput 本身就只是这几个字）
          // 此时没有更早的“正常输出”，只能返回一个空字符串或默认提示，这里返回空字符串让客户端自行处理
          console.log('[ToolCall] 首次回复仅为“任务已完成”，无有效内容，返回空响应');
          return { toolCall: null, rawOutput: '' };
        }
      }

      let parseResult = parseToolCall(rawOutput, toolNames);

      // 无论是否声明了工具，只要回复中包含了工具调用标签，就尝试解析或纠正
      if (parseResult.found) {
        // 已发现工具调用标签，进行无限纠正直到解析成功或任务完成
        while (true) {
          if (parseResult.success) {
            return { toolCall: parseResult.toolCall, toolCalls: parseResult.toolCalls, rawOutput };
          }
          console.log('[ToolCall] 格式错误，继续纠正...');
          // 构造修正示例（取第一个失败的）
          let errorDetail = parseResult.error;
          let fixExample = '';
          const failedJsonMatch = errorDetail.match(/失败的JSON:\s*(.*)/);
          if (failedJsonMatch) {
            const failedJson = failedJsonMatch[1].trim();
            let fixedJson = failedJson.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
            // 如果错误输出中疑似包含未转义的双引号（如 XML 属性），额外进行提示并展示正确转义
            const hasUnescapedQuote = /"[^"\\]*(?:\\.[^"\\]*)*"/g.test(failedJson) && // 有字符串值
                                      /="[^"]*"/.test(failedJson); // 且包含 ="..."
            if (hasUnescapedQuote) {
              fixExample = `\n  【双引号转义错误】你的 JSON 字符串值内包含了未转义的双引号，如：property="createTime"。` +
                `\n  【你的错误输出】（已截取）：${failedJson.slice(0, 200)}` +
                `\n  【修正后应写为】请将值内部的双引号全部写成 \\"，例如 property=\\"createTime\\"。` +
                `\n  下面是你应该输出的完整 JSON（所有双引号已正确转义）：` +
                `\n  ${fixedJson.replace(/="/g, '=\\"').replace(/"\s/g, '\\" ').replace(/"\//g, '\\"/').replace(/"\n/g, '\\"\n')}`;
            } else {
              fixExample = `\n  【你的错误输出】（已截取）：${failedJson.slice(0, 200)}\n  【修正后应写为】：${fixedJson.slice(0, 200)}`;
            }
          }
          const retryPrompt = `${promptText}\n\n【工具格式纠正请求 - 仅输出一行工具调用，必须严格按照要求】\n` +
            `上一轮你的工具调用格式错误，具体错误：${parseResult.error}${fixExample}\n` +
            `【请立即按以下规则输出正确的工具调用，整个回复只能有一行，不能有任何其他内容】
  - 正确格式（单行，无额外文字）：
    <tool_call name="函数名">单行合法JSON</tool_call>
  - 关键要求（必须100%遵守）：
    0. 严禁使用 <tool_calls>、<invoke>、<parameter> 等任何其他标签，只允许 <tool_call name="函数名">JSON</tool_call>。
    1. 路径中的反斜杠必须写成 \\\\，例如 "E:\\\\geo-boot\\\\..."，绝对不能只写单个 \\。
    2. 如果 JSON 字符串内需要包含双引号（例如 Java 代码、命令行参数），必须将内部的双引号写成 \\" 转义，或者改用单引号。
       - 错误（Java 代码未转义）：{"content": "... @ApiModelProperty(value = "主键") ..."}
       - 正确：{"content": "... @ApiModelProperty(value = \\"主键\\") ..."}
       - 命令行错误：{"command": "echo "hello""}
       - 命令行正确：{"command": "echo \\"hello\\""} 或 {"command": "echo 'hello'"}
    3. 如果内容包含换行，必须使用 \\n 转义，绝对禁止输入真实换行符（按回车）。
    4. JSON 不能有多余逗号，不能换行，不能缩进，必须紧凑在一行。
    5. 不要输出任何解释、道歉、感叹词，只输出这一行调用。
  - 再次强调正确示例：
    <tool_call name="save_note">{"title": "笔记", "body": "第一行\\n第二行，引用\\"内容\\"结束"}</tool_call>
  如果任务已完成，请输出“任务已完成”。`;

          reply = await sendAndWait(retryPrompt, cancelState);
          if (reply && reply.trim()) {
            rawOutput = reply.trim();
          } else {
            console.log('[ToolCall] 纠正请求未获得有效回复，保留上一轮输出');
          }
          console.log('[HTTP] 纠正后输出:', rawOutput);

          if (rawOutput.includes('任务已完成')) {
            const cleaned = cleanTaskCompletedMark(rawOutput);
            if (cleaned) {
              console.log('[ToolCall] 格式纠正时返回任务完成标记，清洗后返回');
              return { toolCall: null, toolCalls: [], rawOutput: cleaned };
            } else {
              const fallback = cleanTaskCompletedMark(firstOutput) || '';
              console.log('[ToolCall] 格式纠正时仅返回“任务已完成”，回退到首次正常输出');
              return { toolCall: null, toolCalls: [], rawOutput: fallback };
            }
          }

          parseResult = parseToolCall(rawOutput, toolNames);
          if (!parseResult.found) {
            console.log('[ToolCall] 模型仍未输出工具调用，继续要求...');
            parseResult = { found: false, success: false, error: '仍未看到工具调用，必须输出 <tool_call name="...">...</tool_call>' };
            // return { toolCall: null, toolCalls: [], rawOutput: cleanedOutput.trim() || rawOutput };
          }
        }
      } else {
        // 没有任何工具调用标签，直接返回纯文本（finish_reason: stop）
        const cleaned = cleanTaskCompletedMark(rawOutput);
        return { toolCall: null, rawOutput: cleaned || rawOutput };
      }
    }

    // 原有的请求处理部分（仅展示核心修改）
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => body += chunk);
      const cancelState = { cancelled: false, retryCount: 0 };
      req.on('close', () => {
        cancelState.cancelled = true;
        console.log('[HTTP] 客户端已断开连接');
      });
      const MAX_QUEUE_SIZE = 5; // 最多允许排队的请求数
      const TASK_TIMEOUT = 5 * 60 * 1000; // 单个任务总体超时 5 分钟

      req.on('end', () => {
        // 队列已满，直接拒绝，避免内存无限堆积
        if (requestQueue.length >= MAX_QUEUE_SIZE) {
          console.log('[HTTP] 请求队列已满，拒绝新请求');
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Server busy, please retry later', type: 'server_error' } }));
          return;
        }

        // 包装一个带超时的任务
        const task = async () => {
          try {
            console.log('\x1b[36m[DEBUG] === 收到请求 ===\x1b[0m');
            // console.log('\x1b[36m[DEBUG] 内容:\x1b[0m', body);
            const data = JSON.parse(body);
            const messages = data.messages || [];

            // 辅助函数：安全地从 content 中提取文本（兼容字符串、数组、null）
            function extractTextContent(content) {
              if (typeof content === 'string') return content;
              if (Array.isArray(content)) {
                return content.map(part => {
                  if (part.type === 'text') return part.text || '';
                  return '[非文本内容]'; // 图片等类型使用占位符
                }).join('');
              }
              if (content === null || content === undefined) return '';
              return JSON.stringify(content); // 其他对象尝试序列化
            }

            const userMsgs = messages.filter(m => m.role === 'user');
            let userMsg = userMsgs.length ? extractTextContent(userMsgs[userMsgs.length - 1].content) : '';
            const tools = data.tools || [];
            const toolNames = tools.map(t => t.function.name);

            console.log('[HTTP] 可用工具:', toolNames.join(', '));
            if (!userMsg) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: 'No message content', type: 'invalid_request_error' } }));
              return;
            }
            
            // 防重放过滤器（保留）
            // if (userMsg.includes('User:') || userMsg.includes('Assistant:')) {
            //   console.log('\x1b[31m[网关拦截] 检测到回流的对话历史，已拒绝:\x1b[0m', userMsg.slice(0, 80));
            //   res.writeHead(200, { 'Content-Type': 'application/json' });
            //   res.end(JSON.stringify({
            //     choices: [{
            //       message: { role: 'assistant', content: '请求已被拦截，请勿发送包含对话历史的脏数据。' },
            //       finish_reason: 'stop'
            //     }]
            //   }));
            //   return;
            // }

            const MAX_HISTORY = 20;
            const recentMessages = messages.slice(-MAX_HISTORY);
            let promptText = "";
            for (const msg of recentMessages) {
              const rawContent = extractTextContent(msg.content);
              const content = rawContent.slice(0, 2000);
              if (msg.role === 'system') {
                promptText += `【系统提示】\n${content}`;
              } else if (msg.role === 'user') {
                promptText += `【用户消息】\n${content}`;
              } else if (msg.role === 'assistant') {
                promptText += `【模型回复】\n${content}`;
              } else if (msg.role === 'tool') {
                promptText += `【工具信息】\n${content}`;
              }
            }


            console.log('[HTTP] 收到消息:', userMsg.slice(0, 50), '...');

            const toolsText = tools.length > 0
              ? tools.map(t => `- ${t.function.name}: ${t.function.description}`).join('\n')
              : '无';
                        const toolCallInstructions = tools.length > 0
  ? `【关键工具调用规则 - 必须严格遵守，不允许任何偏差】
  - 当你需要调用工具时，可以输出一个或多个 <tool_call> 块，每个块一行，不能有其他文字。
  - 格式：<tool_call name="函数名">参数JSON</tool_call>
  - name 必须与可用函数名完全一致。
  - 参数JSON对象必须合法、紧凑、单行，并严格遵守JSON转义规范：
    1. 所有字符串用英文双引号包裹，内部的英文双引号必须用反斜杠转义，如 \\"text\\"。
    2. 任何字符串值中如果含有换行，必须使用 \\n 转义，绝对、绝对不要输入真实的换行符。
    3. 不能有多余逗号（如末尾逗号）。
    4. 整个JSON必须在一行内，不允许换行，不允许缩进。
    5. 如果字符串值中包含反斜杠（例如 Windows 路径），必须写成 \\\\，例如 "E:\\\\abc\\\\..."。
  - 正确示例（注意双引号转义）：
    <tool_call name="send_message">{"content": "他说：\\"你好，世界\\"\\n第二行内容"}</tool_call>
  - 正确示例（多参数无特殊字符）：
    <tool_call name="search">{"query": "今天天气", "limit": 5}</tool_call>
  - 特别注意：如果你的 old_str、new_str、content 等参数包含 XML 或 HTML 标签，其中的属性必须转义双引号。
  - 如果你的 content 参数包含 Java 代码或任何含双引号的文本，请务必将代码中的每一个双引号都写成 \\" 转义，否则 JSON 无法解析。
    错误：{"oldString": "<result property="createTime" />"}
    正确：{"oldString": "<result property=\\"createTime\\" />"}
  - 多工具正确示例：
    <tool_call name="glob">{"path": "E:\\\\project", "pattern": "**/*.java"}</tool_call>
    <tool_call name="read">{"filePath": "E:\\\\project\\\\Main.java", "offset": 1, "limit": 50}</tool_call>

  【执行修改后必须验证】
  - 如果你调用了任何修改文件系统、数据库或配置的工具（如 write_file, replace_content, execute_command 等），在收到工具执行结果后，你必须紧接着调用读取或检查工具来验证修改是否成功。
  - 验证成功后，你可以输出简短的确认信息（如“文件已成功修改”）；如果验证失败，必须报告具体错误。
  - 示例流程（修改文件后读取验证）：
    <tool_call name="replace_content">{"filePath": "E:\\\\project\\\\App.java", "old_str": "...", "new_str": "..."}</tool_call>
    <tool_call name="read">{"filePath": "E:\\\\project\\\\App.java", "offset": 1, "limit": 30}</tool_call>

  【绝对禁止的格式（会导致严重错误）】
  1. 禁止使用 <tool_calls>、<invoke>、<parameter>、<function_call> 等任何其他标签，只能使用 <tool_call>。
  2. 禁止在标签内使用 XML 属性（如 string="true"），参数必须全部写在 JSON 对象中。
  3. JSON 内部禁止出现真实换行。
  4. 标签外禁止附加任何解释、道歉或描述。
  5. 禁止使用旧格式 <tool_call>{"name":"xx","arguments":{}}</tool_call>。

  如果不需要使用工具，直接输出文本回复。`
  : '';

            const { toolCall, toolCalls, rawOutput } = await getFinalReplyWithTools(
              promptText, toolsText, toolCallInstructions,toolNames,cancelState
            );

            const hasTool = toolCalls && toolCalls.length > 0;
            const finishReason = hasTool ? 'tool_calls' : 'stop';

            // 检查工具参数大小，防止超大响应导致 RangeError（包括序列化自身失败）
            const MAX_ARG_SIZE = 512 * 1024; // 512 KB
            if (hasTool) {
              let argsStr;
              try {
                argsStr = JSON.stringify(toolCall.arguments);
              } catch (serializeErr) {
                console.log(`[HTTP] 工具参数序列化失败: ${serializeErr.message}，拒绝生成响应`);
                const errorResponse = {
                  id: 'chatcmpl-' + Date.now(),
                  object: 'chat.completion',
                  created: Math.floor(Date.now() / 1000),
                  model: 'deepseek-chat',
                  choices: [{
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: '工具参数过大无法处理，请要求 AI 使用更小的参数或拆分步骤。'
                    },
                    finish_reason: 'stop'
                  }],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                };
                if (res.writable) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify(errorResponse));
                } else {
                  console.log('[HTTP] 参数序列化失败且连接不可写，丢弃结果');
                }
                return;
              }

              if (argsStr.length > MAX_ARG_SIZE) {
                console.log(`[HTTP] 工具参数过大 (${argsStr.length} bytes)，拒绝生成响应`);
                const errorResponse = {
                  id: 'chatcmpl-' + Date.now(),
                  object: 'chat.completion',
                  created: Math.floor(Date.now() / 1000),
                  model: 'deepseek-chat',
                  choices: [{
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: `工具参数过大，无法返回（${(argsStr.length / 1024).toFixed(1)} KB）。请要求 AI 使用更小的参数或拆分步骤。`
                    },
                    finish_reason: 'stop'
                  }],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                };
                if (res.writable) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify(errorResponse));
                } else {
                  console.log('[HTTP] 参数过大且连接不可写，丢弃结果');
                }
                return;
              }
            }

            // ---- 流式响应（简单处理：工具调用时不流式，直接一次性返回；纯文本保持原逻辑）----
            if (data.stream === true) {
              // 先设置响应头
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
              });

              // 监听响应流异常/关闭
              let responseEnded = false;
              const markEnded = (reason) => {
                if (!responseEnded) {
                  responseEnded = true;
                  console.log(`[HTTP] 响应流中断: ${reason}`);
                }
              };
              res.on('error', (err) => markEnded(`error: ${err.message}`));
              res.on('close', () => markEnded('close'));

              const chunkId = 'chatcmpl-' + Date.now();
              const model = 'deepseek-chat';

              // 1. 发送第一个 delta，包含 role
              if (!responseEnded && res.writable) {
                const firstChunk = {
                  id: chunkId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{
                    index: 0,
                    delta: { role: 'assistant', content: null },
                    finish_reason: null
                  }]
                };
                res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
              }

              if (hasTool) {
                // 2. 工具调用流式发送（支持多个）
                for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
                  const tc = toolCalls[tcIdx];
                  const toolCallId = 'call_' + Math.random().toString(36).substr(2, 9);
                  const argsStr = JSON.stringify(tc.arguments);

                  // 发送 tool_call 开始块
                  if (!responseEnded && res.writable) {
                    const toolStartChunk = {
                      id: chunkId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      choices: [{
                        index: 0,
                        delta: {
                          tool_calls: [{
                            index: tcIdx,
                            id: toolCallId,
                            type: 'function',
                            function: {
                              name: tc.name,
                              arguments: ''
                            }
                          }]
                        },
                        finish_reason: null
                      }]
                    };
                    res.write(`data: ${JSON.stringify(toolStartChunk)}\n\n`);
                  }

                  // 逐步发送 arguments
                  for (let i = 0; i < argsStr.length; i++) {
                    if (responseEnded || !res.writable) {
                      console.log('[HTTP] 流式发送 arguments 过程中检测到连接断开，提前终止');
                      break;
                    }
                    const argChunk = {
                      id: chunkId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      choices: [{
                        index: 0,
                        delta: {
                          tool_calls: [{
                            index: tcIdx,
                            function: {
                              arguments: argsStr[i]
                            }
                          }]
                        },
                        finish_reason: null
                      }]
                    };
                    res.write(`data: ${JSON.stringify(argChunk)}\n\n`);
                    await new Promise(r => setTimeout(r, 5));
                  }

                  if (responseEnded || !res.writable) break;
                }

                // 发送 finish_reason 和 DONE
                if (!responseEnded && res.writable) {
                  const finalChunk = {
                    id: chunkId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: 'tool_calls'
                    }]
                  };
                  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                  res.write('data: [DONE]\n\n');
                  res.end();
                } else {
                  console.log('[HTTP] 工具调用流式响应结束，但连接已不可写，跳过发送结束标记');
                }
              } else {
                // 3. 普通文本流式输出
                for (const char of rawOutput) {
                  if (responseEnded || !res.writable) {
                    console.log('[HTTP] 普通文本流式发送过程中检测到连接断开，提前终止');
                    break;
                  }
                  const chunk = {
                    id: chunkId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                      index: 0,
                      delta: { content: char },
                      finish_reason: null
                    }]
                  };
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  await new Promise(r => setTimeout(r, 20));
                }

                if (!responseEnded && res.writable) {
                  const finalChunk = {
                    id: chunkId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: 'stop'
                    }]
                  };
                  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                  res.write('data: [DONE]\n\n');
                  res.end();
                } else {
                  console.log('[HTTP] 普通文本流式响应结束，但连接已不可写，跳过发送结束标记');
                }
              }
              return;
            }

                        // ---- 非流式响应 ----
            const response = {
              id: 'chatcmpl-' + Date.now(),
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'deepseek-chat',
              choices: [{
                index: 0,
                message: {},
                finish_reason: finishReason
              }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            };

            if (hasTool) {
              response.choices[0].message = {
                role: 'assistant',
                content: null,
                tool_calls: toolCalls.map(tc => ({
                  id: 'call_' + Math.random().toString(36).substr(2, 9),
                  type: 'function',
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments)
                  }
                }))
              };
            } else {
              response.choices[0].message = {
                role: 'assistant',
                content: rawOutput
              };
            }

            if (res.writable) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(response));
            } else {
              console.log('[HTTP] 非流式响应时连接已不可写，丢弃结果');
            }

          } catch (e) {
            console.log('[HTTP] 处理请求异常:', e.message);
            // 尝试发送错误响应，无论客户端是否提前断开
            try {
              if (res.writable && !res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
              }
            } catch (_) {
              console.log('[HTTP] 发送错误响应失败');
            }
          }
        };

        // 用 Promise.race 实现任务超时
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Request timeout')), TASK_TIMEOUT)
        );

        enqueueTask(() => Promise.race([task(), timeoutPromise]))
          .catch(e => {
            if (e.message === 'Request timeout') {
              console.error('[队列] 任务超时，已丢弃');
              if (!res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Request timeout', type: 'server_error' } }));
              }
            } else {
              console.error('[队列] 未捕获异常:', e.message);
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
              }
            }
          });
      });
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, HOST, () => {
    console.log(`HTTP 接口已启动，监听 ${HOST}:${PORT}`);
    console.log(`模型列表: GET http://${HOST}:${PORT}/v1/models`);
    console.log(`对话接口: POST http://${HOST}:${PORT}/v1/chat/completions\n`);
  });

  async function sendMessage(text) {
    if (text === '/quit') {
      console.log('退出程序...');
      try {
        const state = await browser.storageState();
        fs.writeFileSync(storageStateFile, JSON.stringify(state, null, 2));
      } catch (_) {}
      server.close();
      await browser.close();
      process.exit(0);
    }

    try {
      console.log('\x1b[33m⏳ 等待回复中...\x1b[0m');
      const reply = await sendAndWait(text);
      process.stdout.write('\x1b[1A\x1b[K');
      if (reply) {
        console.log(`[${platform.name}]:`, reply, '\n');
      } else {
        console.log('超时: 未收到回复。\n');
      }
    } catch (e) {
      console.log('错误:', e.message, '\n');
    }
  }

  rl.prompt();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (text) await sendMessage(text);
    rl.prompt();
  });

  rl.on('close', async () => {
    console.log('\n正在关闭浏览器...');
    try {
      const state = await browser.storageState();
      fs.writeFileSync(storageStateFile, JSON.stringify(state, null, 2));
    } catch (_) {}
    server.close();
    await browser.close();
    process.exit(0);
  });
}

main().catch(async (err) => {
  console.error('发生错误:', err.message);
  process.exit(1);
});