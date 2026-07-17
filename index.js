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
              if (!items.length) return '';
              const last = items[items.length - 1];
              const main = last.querySelector('.ds-assistant-message-main-content');
              if (!main) return '';
              // 使用 innerText 完美保留所有视觉换行
              return main.innerText.trim();
          });

          if (!reply) {
            await page.waitForTimeout(500);
            reply = await page.evaluate(() => {
              const items = document.querySelectorAll('[data-virtual-list-item-key]');
              if (!items.length) return '';
              const last = items[items.length - 1];
              const main = last.querySelector('.ds-assistant-message-main-content');
              if (!main) return '';
              let text = main.innerText.trim();
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

    // 解析模型输出中的工具调用（新格式：<tool_call name="函数名">====== 参数名 ++++++ 参数值 </tool_call>）
    function parseToolCall(text, allowedNames = []) {
      if (!text) return { found: false, success: false, toolCalls: [], toolCall: null };

      const results = [];

      // 支持用任意数量的 = 或 + 组成的独立行作为分隔符
      const parseKeyValueArgs = (text) => {
        const args = {};
        const lines = text.split('\n');
        let currentKey = null;
        let currentValueLines = [];

        const flush = () => {
          if (currentKey) {
            let value = currentValueLines.join('\n').trim();
            // 去除末尾空行
            value = value.replace(/\n+$/, '');
            // 智能类型转换：纯数字字符串自动转 Number
            const cleanedValue = value.replace(/\s+/g, '');
            const numVal = Number(cleanedValue);
            if (cleanedValue !== '' && !isNaN(numVal) && String(numVal) === cleanedValue) {
              args[currentKey] = numVal;
            } else {
              args[currentKey] = value;
            }
            currentKey = null;
            currentValueLines = [];
          }
        };

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // 判断当前行（去除空白后）是否包含连续至少5个 =，视为参数分隔行
          if (/={5,}/.test(line.trim())) {
            flush();
            continue;
          }
          // 判断当前行（去除空白后）是否包含连续至少5个 +，视为键值分隔行
          if (/\+{5,}/.test(line.trim())) {
            if (currentKey) {
              continue;
            }
            continue;
          }

          // 正常行
          if (!currentKey) {
            // 还没有 key，则本行作为 key（去除首尾空白及所有内部空白）
            currentKey = line.trim().replace(/\s+/g, '');
          } else {
            // 已有 key，追加到 value 行
            currentValueLines.push(line);
          }
        }
        flush(); // 处理最后一个参数
        return Object.keys(args).length > 0 ? args : null;
      };

      // 清理 <tool_call name="... "> 中引号与 > 之间的换行/空格，防止解析失败
      text = text.replace(/(<tool_call\s+name\s*=\s*")([^"]*)("\s*)(>)/gi, (m, p1, name, p3, p4) => p1 + name.trim() + '">');
      // 正则匹配完整的 <tool_call name="函数名"> ... </tool_call>（支持换行）
      const toolCallRegex = /<tool_call\s+name\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/tool_call>/gi;
      let match;
      while ((match = toolCallRegex.exec(text)) !== null) {
        const rawName = match[1].trim();
        const rawArgs = match[2].trim();

        if (!rawName) {
          results.push({ success: false, error: 'name 属性不能为空' });
          continue;
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawName)) {
          results.push({ success: false, error: `无效的函数名格式 "${rawName}"，函数名只能包含字母、数字和下划线` });
          continue;
        }
        if (allowedNames.length > 0 && !allowedNames.includes(rawName)) {
          results.push({ success: false, error: `无效的函数名 "${rawName}"，允许的函数名：${allowedNames.join(', ')}` });
          continue;
        }

        // 直接使用原始参数文本，仅确保首尾有换行（innerText 已提供正确换行）
        let fixedArgs = '\n' + rawArgs.trim() + '\n';
        const parsedArgs = parseKeyValueArgs(fixedArgs);
        if (!parsedArgs) {
          console.log('[ToolCall] 失败的参数文本：', rawArgs);
          results.push({ success: false, error: `参数格式错误，请使用 ====== / ++++++ 分隔格式，失败的参数文本：${rawArgs.slice(0, 100)}` });
        } else {
          // 额外校验：只保留合法的参数名，并丢弃完全无效的键
          const validArgs = {};
          let hasInvalidKey = false;
          for (const [k, v] of Object.entries(parsedArgs)) {
            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
              validArgs[k] = v;
            } else {
              console.log('[ToolCall] 忽略非法参数名:', k);
              hasInvalidKey = true;
            }
          }
          if (Object.keys(validArgs).length === 0) {
            results.push({ success: false, error: `参数格式错误，未提取到有效参数名，失败的参数文本：${rawArgs.slice(0, 100)}` });
          } else {
            if (hasInvalidKey) {
              console.log('[ToolCall] 部分参数被忽略，已提取的有效参数:', JSON.stringify(validArgs));
            }
            results.push({ success: true, toolCall: { name: rawName, arguments: validArgs } });
          }
        }
      }

      if (results.length === 0) {
        if (/<(tool_calls|invoke|parameter|function_call|tool_use)/i.test(text)) {
          return { found: true, success: false, toolCalls: [], toolCall: null, error: '检测到禁止的标签格式，必须使用 <tool_call name="函数名">====== ... ++++++ ... </tool_call>' };
        }
        if (text.includes('<tool_call') || text.includes('&lt;tool_call')) {
           return { found: true, success: false, toolCalls: [], toolCall: null, error: '存在 <tool_call> 标签但无法解析，必须使用 ====== / ++++++ 分隔参数' };
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
          let cleanedOutput = cleanedFirst
            .replace(/专家模式暂不支持搜索，请使用快速模式/g, '')
            .replace(/(复制|下载|运行|调试|代码)/g, '');
          return { toolCall: null, rawOutput: cleanedOutput };
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
          let fixExample = ''; // 必须初始化
          const failedMatch = parseResult.error.match(/失败的参数文本：\s*(.*)/);
          if (failedMatch) {
            const failedText = failedMatch[1].trim();
            fixExample = `\n  【你的错误输出】：${failedText.slice(0, 200)}`;
          }
          const retryPrompt = `${promptText}\n\n【工具格式纠正请求 - 必须使用“====== / ++++++”分隔参数】\n`  +
            `上一轮你的工具调用格式错误：${parseResult.error}${fixExample}\n` +
            `【请按以下格式输出工具调用，整个回复只能包含工具调用标签】
  - 每个参数以独占一行的 “======” 开始，下一行是参数名，再下一行是独占一行的 “++++++”，然后直到下一个 “======” 或结束的所有行都是参数值。
  - 重要：每个 “======” 和 “++++++” 必须独占一行，前后必须有换行。不能写成 ======pattern++++++value 这种紧凑形式！
  - 注意：分隔符必须是恰好 6 个等号（======）和 6 个加号（++++++），不能多也不能少。
  - 每个 <tool_call> 必须用 </tool_call> 闭合
  - 注意是tool_call不是tool_calls
  - 绝对禁止使用 <parameter> 标签！不要使用 <parameter name="xxx">value</parameter> 这种格式！
  - 正确示例：
    <tool_call name="read">
    ======
    filePath
    ++++++
    E:\data\test.xml
    ======
    offset
    ++++++
    10
    ======
    </tool_call>
    <tool_call name="write">
    ======
    filePath
    ++++++
    E:\data\Demo.java
    ======
    content
    ++++++
    public class Demo {
        private String name = "示例";
    }
    ======
    </tool_call>
  - 错误示例（禁止）：
    <tool_call name="read">
    <parameter name="filePath">E:\data\test.xml</parameter>
    </tool_call>
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
              cleaned = cleaned
                .replace(/专家模式暂不支持搜索，请使用快速模式/g, '')
                .replace(/(复制|下载|运行|调试|代码)/g, '');
              return { toolCall: null, toolCalls: [], rawOutput: cleaned };
            } else {
              const fallback = cleanTaskCompletedMark(firstOutput) || '';
              console.log('[ToolCall] 格式纠正时仅返回“任务已完成”，回退到首次正常输出');
              fallback = fallback
                .replace(/专家模式暂不支持搜索，请使用快速模式/g, '')
                .replace(/(复制|下载|运行|调试|代码)/g, '');
              return { toolCall: null, toolCalls: [], rawOutput: fallback };
            }
          }

          parseResult = parseToolCall(rawOutput, toolNames);
          if (!parseResult.found) {
            // 模型拒绝输出工具调用，将当前文本作为最终回复返回
            console.log('[ToolCall] 模型仍未输出工具调用，将其视为最终回复');
            const langKeywords = /^(java|python|javascript|typescript|go|ruby|rust|c|cpp|csharp|bash|shell|powershell|sql|html|css|xml|json|yaml|swift|kotlin|scala|perl|php|r|dart|elixir|erlang|haskell|clojure|lua|matlab|objective-c|rust)$/i;
            let finalText = rawOutput
              .replace(/专家模式暂不支持搜索，请使用快速模式/g, '')
              .replace(/(复制|下载|运行|调试|代码)/g, '')
              .replace(/任务已完成[。！？.!?\s]*/g, '')
              .split('\n')
              .filter(line => !langKeywords.test(line.trim()))
              .join('\n')
              .trim();
            return { toolCall: null, toolCalls: [], rawOutput: finalText || rawOutput };
          }
        }
      } else {
        // 没有任何工具调用标签，直接返回纯文本（finish_reason: stop）
        // 清洗 UI 杂讯，仅在纯文本模式下进行
        const langKeywords = /^(java|python|javascript|typescript|go|ruby|rust|c|cpp|csharp|bash|shell|powershell|sql|html|css|xml|json|yaml|swift|kotlin|scala|perl|php|r|dart|elixir|erlang|haskell|clojure|lua|matlab|objective-c|rust)$/i;
        let cleanText = rawOutput
          .replace(/专家模式暂不支持搜索，请使用快速模式/g, '')
          .replace(/(复制|下载|运行|调试|代码)/g, '')
          .split('\n')
          .filter(line => !langKeywords.test(line.trim()))
          .join('\n');
        const cleaned = cleanTaskCompletedMark(cleanText);
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
              let rawContent = extractTextContent(msg.content);
              // 只清洗 assistant 消息中的 UI 杂讯，保护工具返回的原始文件内容
              if (msg.role === 'assistant') {
                  rawContent = rawContent
                      .replace(/(复制|下载|运行|调试|代码)/g, '')
                      .replace(/任务已完成[。！？.!?\s]*/g, '');  // 增加此行，清除历史中的“任务已完成”
              }
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
  - 每个 <tool_call> 必须用 </tool_call> 闭合
  - 注意是tool_call，不是tool_calls
  - 每个 <tool_call> 块使用以下格式传递参数，完全不需要任何转义：
    <tool_call name="函数名">
    ======
    参数名
    ++++++
    参数值（可以包含多行、双引号、反斜杠等）
    ======
    ...
    </tool_call>
  - 每条参数以独占一行的 “======” 开始，下一行是参数名，再下一行是独占一行的 “++++++”，之后直到下一个 “======” 之前的所有行都是该参数的值（可包含任意字符）。
  - 注意：分隔符必须是恰好 6 个等号（======）和 6 个加号（++++++），不能多也不能少。
  - 简单参数示例：
    <tool_call name="read">
    ======
    filePath
    ++++++
    E:\kytion-boot\video\src\main\resources\mapper\matrix\UserImsIceMapper.xml
    ======
    offset
    ++++++
    10
    ======
    limit
    ++++++
    20
    ======
    </tool_call>
  - 多行/复杂内容示例：
    <tool_call name="write">
    ======
    filePath
    ++++++
    E:\project\Demo.java
    ======
    content
    ++++++
    public class Demo {
        private String name = "示例";
    }
    ======
    </tool_call>
  - 可同时输出多个 <tool_call> 块。
  【注意】：参数值中请勿包含独占一行的 “======” 或 “++++++”，否则会导致解析错误。如果必须包含，请用 Base64 编码等替代方式。
  【执行修改后必须验证】
  - 如果你调用了任何修改文件系统、数据库或配置的工具（如 write_file, replace_content, execute_command 等），在收到工具执行结果后，你必须紧接着调用读取或检查工具来验证修改是否成功。
  - 验证成功后，你可以输出简短的确认信息（如“文件已成功修改”）；如果验证失败，必须报告具体错误。
  【绝对禁止的格式】
  1. 禁止使用 JSON 格式。
  2. 禁止使用 <parameter> 标签传递参数，必须使用 ======/++++++ 分隔。
  3. 禁止使用 <tool_calls> 等其他标签。
  如果不需要工具，直接回复文本。`
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