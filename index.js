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

  // ===== 浏览器自动恢复相关变量 =====
  let browser;
  let page;
  let isRestarting = false;
  let consecutiveRestarts = 0;
  const MAX_RESTARTS = 5; // 连续崩溃次数上限
  let sseDeltaHandler = null; // 当前 SSE 增量处理器（流式接收用）
  let sseRequestSeq = 0; // completion 请求计数（诊断用，判断是否分多请求输出）

  // 封装登录等待逻辑（原代码中的循环部分）
  async function waitForLogin(page) {
    const editorSelectors = platform.editor.split(',').map(s => s.trim());
    let loggedIn = false;

    // 先快速检查是否已经登录
    for (const sel of editorSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          loggedIn = true;
          break;
        }
      } catch (_) {}
    }

    if (loggedIn) return;

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
      throw new Error('登录超时（5分钟），无法恢复浏览器状态');
    }

    // 保存登录凭证（可能已更新）
    try {
        const state = await page.context().storageState();
        fs.writeFileSync(storageStateFile, JSON.stringify(state, null, 2));
        console.log('登录凭证已保存。');
    } catch (e) {
        console.log('警告: 保存登录凭证失败。');
    }
  }

  // 初始化浏览器和页面
  async function initBrowserAndPage() {
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

    const newBrowser = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: ['--no-sandbox'],
      storageState: storageState || undefined
    });

    // 监听崩溃事件
    newBrowser.on('disconnected', async () => {
      console.log('\x1b[31m[浏览器] 检测到浏览器进程断开，准备自动重启...\x1b[0m');
      if (isRestarting) return;
      isRestarting = true;

      if (consecutiveRestarts >= MAX_RESTARTS) {
        console.error(`[浏览器] 连续重启 ${MAX_RESTARTS} 次仍崩溃，请检查环境后手动重启程序。`);
        process.exit(1);
      }

      try {
        await new Promise(r => setTimeout(r, 3000)); // 等待资源释放
        const result = await initBrowserAndPage();    // 递归重启
        browser = result.browser;
        page = result.page;
        consecutiveRestarts = 0;                      // 成功重启后清零计数
        console.log('\x1b[32m[浏览器] 浏览器已成功恢复。\x1b[0m');
      } catch (e) {
        consecutiveRestarts++;
        console.error(`[浏览器] 重启失败 (${consecutiveRestarts}/${MAX_RESTARTS}):`, e.message);
        if (consecutiveRestarts >= MAX_RESTARTS) {
          console.error('[浏览器] 达到最大重启次数，退出程序。');
          process.exit(1);
        }
      } finally {
        isRestarting = false;
      }
    });

    const newPage = newBrowser.pages()[0] || await newBrowser.newPage();

    await newPage.goto(platform.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`页面已打开，等待登录到 ${platform.name}...`);

    await waitForLogin(newPage);
    console.log('登录成功！可以开始对话了。\n');

    // 注入 SSE 流式拦截：把 completion 响应的增量实时推给 Node（用于流式返回）
    await newPage.exposeFunction('__onSSEDelta', (chunk) => {
      if (sseDeltaHandler) sseDeltaHandler(chunk);
    });
    await newPage.exposeFunction('__onSSERequest', () => {
      sseRequestSeq++;
      console.log('[SSE] 新的 completion 请求 #' + sseRequestSeq + '（判断是否分多请求输出）');
    });
    await newPage.evaluate(() => {
      if (window.__sseInjected) return;
      window.__sseInjected = true;
      // DeepSeek 用 XHR 发送 completion 请求，拦截 XHR 实时读取 SSE 增量
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__url = url;
        return origOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        if (this.__url && String(this.__url).includes('/api/v0/chat/completion')) {
          if (window.__onSSERequest) window.__onSSERequest();
          let lastLen = 0;
          const flush = () => {
            try {
              const text = this.responseText || '';
              if (text.length > lastLen) {
                const delta = text.slice(lastLen);
                lastLen = text.length;
                if (window.__onSSEDelta) window.__onSSEDelta(delta);
              }
            } catch (e) {}
          };
          // progress 事件的 responseText 可能滞后，用 load/loadend 兜底，确保最后一段数据不丢
          this.addEventListener('progress', flush);
          this.addEventListener('load', flush);
          this.addEventListener('loadend', () => {
            flush();
            // 强制补一个换行，把解析器 buffer 里的最后一行（FINISHED 信号）刷出来
            if (window.__onSSEDelta) window.__onSSEDelta('\n');
          });
        }
        return origSend.call(this, ...args);
      };
    });

    return { browser: newBrowser, page: newPage };
  }

  // 初始化（替代原来的 const browser = ... 和 const page = ...）
  const initResult = await initBrowserAndPage();
  browser = initResult.browser;
  page = initResult.page;

  async function findEditor() {
    const selectors = platform.editor.split(',').map(s => s.trim());
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) return el;
    }
    return null;
  }

  async function findSendButton() {
    const selectors = platform.sendButton.split(',').map(s => s.trim());
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) return el;
    }
    return null;
  }

  // 检测重试按钮（中英文 + CSS 类名 + text/aria/title）
  async function detectRetryButton() {
    const retryPatterns = ['重试', '重新生成', '重新发送', 'Retry', 'Refresh', 'refresh', 'retry', '超时', 'timeout', 'Timeout', '重新加载', '生成失败', '重新回答'];
    try {
      const buttons = page.locator('button, [role="button"]');
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        const btn = buttons.nth(i);
        try {
          // 同时检查 text、aria-label、title（新版按钮可能无文字，只有 aria/title）
          let text = '';
          let aria = '';
          let title = '';
          try { text = await btn.innerText({ timeout: 1500 }); } catch (e) {}
          try { aria = await btn.getAttribute('aria-label') || ''; } catch (e) {}
          try { title = await btn.getAttribute('title') || ''; } catch (e) {}
          const combined = text + ' ' + aria + ' ' + title;
          for (const pattern of retryPatterns) {
            if (combined.includes(pattern)) {
              const visible = await btn.isVisible({ timeout: 1500 });
              if (visible) {
                console.log('[重试检测] 发现重试按钮: "' + combined.trim() + '"');
                return btn;
              }
            }
          }
        } catch (e) { }
      }
    } catch (e) { }
    try {
      const warningBtns = page.locator('[role="button"].ds-button--warning, button.ds-button--warning');
      if (await warningBtns.count() > 0) {
        const btn = warningBtns.first();
        if (await btn.isVisible({ timeout: 1500 })) {
          console.log('[重试检测] 发现 warning 按钮');
          return btn;
        }
      }
    } catch (e) { }
    return null;
  }

  // 检测"达到对话长度上限"提示，如果有，点击左上角"开启新对话"按钮
  async function detectAndHandleLimit() {
    try {
      const limitTip = page.locator('text=达到对话长度上限');
      if (await limitTip.count() > 0 && await limitTip.first().isVisible()) {
        console.log('[新对话] 检测到"达到对话长度上限"提示，点击"开启新对话"按钮...');
        const newChatBtn = page.locator('text="开启新对话"').first();
        if (await newChatBtn.count() > 0 && await newChatBtn.isVisible()) {
          await newChatBtn.click();
          console.log('[新对话] 已点击"开启新对话"，等待新对话加载...');
          await page.waitForTimeout(3000);
          return true;
        } else {
          console.log('[新对话] 未找到"开启新对话"按钮');
        }
      }
    } catch (e) {
      console.log('[新对话] 检测异常:', e.message);
    }
    return false;
  }
  // ★ 主动开启新对话（不依赖"达到对话长度上限"提示），用于死循环重置
  async function startNewChatIfPossible() {
    try {
      const newChatBtn = page.locator('button:has-text("开启新对话"), [role="button"]:has-text("开启新对话")').first();
      if (await newChatBtn.count() > 0 && await newChatBtn.isVisible()) {
        await newChatBtn.click();
        console.log('[新对话] 已主动开启新对话（重置上下文）');
        await page.waitForTimeout(3000);
        return true;
      }
      // 兜底：直接导航到主页
      await page.goto(platform.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      console.log('[新对话] 已通过导航到主页重置对话');
      return true;
    } catch (e) {
      console.log('[新对话] 重置失败:', e.message);
      return false;
    }
  }

  // 流式 SSE 解析器：处理增量 chunk，实时提取 RESPONSE（正文）增量；RESPONSE 空时用 THINK 兜底
  function createSSEParser(onResponseDelta, onFinished, onLimitExceeded) {
    let buffer = '';
    let lastPath = '';
    let lastOp = '';
    let currentFragmentType = null; // 未知，由初始 response 对象或 APPEND 的 type 字段决定
    let thinkContent = '';
    let responseContent = '';

    return (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留最后一个不完整行

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr.startsWith('{')) continue;
        let d;
        try { d = JSON.parse(dataStr); } catch (e) { continue; }

        // 处理初始 response 对象：从 fragments 数组判断 fragment 类型（THINK 还是 RESPONSE）
        if (d.v && d.v.response && Array.isArray(d.v.response.fragments)) {
          for (const f of d.v.response.fragments) {
            if (!f || typeof f.type !== 'string') continue;
            currentFragmentType = f.type;
            if (f.type === 'RESPONSE' && typeof f.content === 'string') {
              responseContent += f.content;
              onResponseDelta(f.content);
            } else if (f.type === 'THINK' && typeof f.content === 'string') {
              thinkContent += f.content;
            }
          }
          continue;
        }

        // 检测"对话长度上限"错误信号（hint 事件，finish_reason 为 context_length_exceeded）
        if (d.type === 'error' && d.finish_reason === 'context_length_exceeded') {
          console.log('[SSE] 检测到对话长度上限错误（context_length_exceeded）');
          onLimitExceeded();
        }

        if (d.p) lastPath = d.p;
        if (d.o) lastOp = d.o;

        // 追加新 fragment
        if (lastPath === 'response/fragments' && lastOp === 'APPEND' && Array.isArray(d.v)) {
          for (const f of d.v) {
            if (f && f.type === 'RESPONSE') {
              if (currentFragmentType !== 'RESPONSE') console.log('[SSE] 检测到 RESPONSE fragment');
              currentFragmentType = 'RESPONSE';
              if (typeof f.content === 'string') {
                responseContent += f.content;
                onResponseDelta(f.content);
              }
            } else if (f && f.type === 'THINK') {
              currentFragmentType = 'THINK';
              if (typeof f.content === 'string') thinkContent += f.content;
            }
          }
          continue;
        }

        // 流式累积 content（-1 指向当前 fragment）
        if (lastPath === 'response/fragments/-1/content') {
          if (typeof d.v === 'string') {
            if (currentFragmentType === 'THINK') {
              thinkContent += d.v;
            } else {
              // RESPONSE 或未知类型：默认按正文处理，避免误判为思考
              responseContent += d.v;
              onResponseDelta(d.v);
            }
          }
          continue;
        }

        // 完成信号
        if (d.p === 'response/status' && d.v === 'FINISHED') {
          console.log('[SSE] 检测到 FINISHED 信号');
          if (!responseContent && thinkContent) {
            console.log('[SSE] 模型只输出了思考（THINK），正文（RESPONSE）为空，THINK长度:', thinkContent.length);
          }
          onFinished();
        }
      }
    };
  }

  async function sendAndWait(text, cancelState = null, onDelta = null, retryCount = 0) {
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

      // ★ 如果"智能搜索"处于开启状态，关掉它
      try {
        // 用 Playwright 的 hasText 过滤器（不是 CSS 伪类），能正确匹配 <div class="ds-toggle-button">智能搜索</div>
        let searchBtn = page.locator('.ds-toggle-button', { hasText: '智能搜索' }).first();
        if (await searchBtn.count() === 0) {
          // 兜底：类名或文案可能不同
          searchBtn = page.locator('.ds-toggle-button', { hasText: '联网搜索' }).first();
        }
        if (await searchBtn.count() === 0) {
          searchBtn = page.locator('[aria-pressed]', { hasText: '智能搜索' }).first();
        }

        if (await searchBtn.count() > 0 && await searchBtn.isVisible()) {
          const pressed = (await searchBtn.getAttribute('aria-pressed') || '').toLowerCase();
          const cls = (await searchBtn.getAttribute('class') || '');
          const isOn = pressed === 'true' || /ds-toggle-button--selected/i.test(cls);

          console.log('[HTTP][诊断] 智能搜索按钮: aria-pressed=' + pressed + ', isOn=' + isOn);

          if (isOn) {
            await searchBtn.click();
            await page.waitForTimeout(500);
            // 二次确认
            const afterPressed = (await searchBtn.getAttribute('aria-pressed') || '').toLowerCase();
            console.log('[HTTP] 已点击智能搜索，点击后 aria-pressed=' + afterPressed);
          } else {
            console.log('[HTTP] 智能搜索未开启，无需处理');
          }
        } else {
          console.log('[HTTP] 未找到智能搜索按钮');
        }
      } catch (e) {
        console.log('[HTTP] 智能搜索切换异常:', e.message);
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
    const sendBtnSelector = platform.sendButton.split(',').map(s => s.trim())[0]; // 取第一个选择器
    try {
      await page.waitForFunction(
        (sel) => {
          const btn = document.querySelector(sel);
          return btn && !btn.disabled && btn.offsetParent !== null;
        },
        sendBtnSelector,
        { timeout: 5000 }
      );
    } catch (_) {
      console.log('[HTTP] 等待发送按钮可用超时，仍尝试发送');
    }

    // 设置流式 SSE 解析器（在点击发送前，通过页面内 fetch 拦截实时接收增量）
    let finishedResolve;
    const finishedPromise = new Promise(resolve => { finishedResolve = resolve; });
    let fullContent = '';
    let sseChunkCount = 0;
    let sseRawBytes = 0;
    let inToolBlock = false;   // 是否在工具调用块内（<｜｜DSML｜｜ calls> 包裹块 或 裸 <｜｜DSML｜｜ invoke>）
    let toolBlockEnd = '';     // 当前工具块的结束标记
    let outputLen = 0;         // 已通过 onDelta 输出的长度（fullContent 的索引）
    let limitExceeded = false; // 是否检测到"对话长度上限"错误
    // ★ 防死循环：DSML 标签泛滥 & 缓冲停滞检测
    let dsmlFloodCount = 0;         // 本次等待中收到的 DSML 标签总数
    let bufferingSince = 0;         // 缓冲开始时间（用于检测停滞）
    const DSML_FLOOD_LIMIT = 200;   // 超过 200 个标签视为死循环
    const BUFFER_STALL_MS = 8000;   // 缓冲停滞超过 8 秒视为死循环

    // ★ 工具标签的宽容正则：放在 delta 回调之外，避免每次 delta 都重建
    // 兼容任意噪声前缀（DSML、全角/半角竖线、空格等），无论噪声与 "<" 是否跨 chunk
    const TAG_NOISE_STR = '(?:DSML|[^a-zA-Z0-9_/>])*';
    const RE_CALLS_OPEN    = new RegExp('^<'  + TAG_NOISE_STR + 'calls(?=[\\s>])',        'i');
    const RE_CALLS_CLOSE   = new RegExp('^</' + TAG_NOISE_STR + 'calls(?=[\\s>])',        'i');
    const RE_INVOKE_OPEN   = new RegExp('^<'  + TAG_NOISE_STR + 'invoke(?=[\\s>])',       'i');
    const RE_INVOKE_CLOSE  = new RegExp('^</' + TAG_NOISE_STR + 'invoke[^>]*>',           'i');
    const RE_PARAM_OPEN    = new RegExp('^<'  + TAG_NOISE_STR + 'parameter\\b[^>]*>',     'i');
    const RE_PARAM_CLOSE   = new RegExp('^</' + TAG_NOISE_STR + 'parameter(?=[\\s>])[^>]*>', 'i');

    // 判断 rest 是否是某个工具标签的前缀（跨增量缓冲用）
     const isToolTagPrefix = (s) => {
      if (!s || s[0] !== '<') return false;
      let idx = 1;
      if (s[idx] === '/') idx++;
      while (idx < s.length) {
        if (s.startsWith('DSML', idx)) { idx += 4; continue; }
        if (!/[a-zA-Z0-9_/>]/.test(s[idx])) { idx++; continue; }
        // ★ 若 s.slice(idx) 恰好是 "DSML" 的某个前缀（D / DS / DSM / S / SM / SML / M / ML / L），说明 DSML 字面量还没收完，缓冲等待
        const remain = s.slice(idx);
        if (remain.length <= 4 && 'DSML'.startsWith(remain)) return true;
        break;
      }
      if (idx >= s.length) return true; // 全是噪声，等待标签名
      const tail = s.slice(idx);
      for (const tag of ['calls', 'invoke', 'parameter']) {
        if (tail.length <= tag.length) {
          if (tag.slice(0, tail.length) === tail) return true;
        } else if (tail.startsWith(tag)) {
          const next = tail[tag.length];
          if (!/[a-zA-Z0-9_]/.test(next)) return true;
        }
      }
      return false;
    };

    const parser = createSSEParser(
            (delta) => {
        fullContent += delta;

        // 逐段扫描新增部分，输出工具调用块之外的文本，跳过块内内容
        let out = '';
        let i = outputLen;
        while (i < fullContent.length) {
          const rest = fullContent.slice(i);

          // ★ 先吃掉任何残留的闭合标签（无论是否在块内）
          const strayParamClose = rest.match(RE_PARAM_CLOSE);
          if (strayParamClose) {
            i += strayParamClose[0].length;
            // 孤儿 parameter 块：遇到 </parameter> 即退出
            if (inToolBlock && toolBlockEnd === 'parameter') { inToolBlock = false; toolBlockEnd = ''; }
            continue;
          }
          const strayCallsClose = rest.match(RE_CALLS_CLOSE);
          if (strayCallsClose) {
            i += strayCallsClose[0].length;
            if (inToolBlock && toolBlockEnd === 'calls') { inToolBlock = false; toolBlockEnd = ''; }
            continue;
          }
          const strayInvokeClose = rest.match(RE_INVOKE_CLOSE);
          if (strayInvokeClose) {
            i += strayInvokeClose[0].length;
            if (inToolBlock && toolBlockEnd === 'invoke') { inToolBlock = false; toolBlockEnd = ''; }
            continue;
          }

          if (!inToolBlock) {
            // 进入 <... calls>（含 DSML 或纯竖线噪声）
            const callsOpen = rest.match(RE_CALLS_OPEN);
            if (callsOpen) {
              inToolBlock = true;
              toolBlockEnd = 'calls';
              i += callsOpen[0].length;
              continue;
            }
            // 进入 <... invoke>（无 calls 包裹的异常输出）
            const invokeOpen = rest.match(RE_INVOKE_OPEN);
            if (invokeOpen) {
              inToolBlock = true;
              toolBlockEnd = 'invoke';
              i += invokeOpen[0].length;
              continue;
            }
            // 孤儿 <... parameter>（模型漏了 invoke 包裹）——进入吞掉模式
            const paramOpen = rest.match(RE_PARAM_OPEN);
            if (paramOpen) {
              inToolBlock = true;
              toolBlockEnd = 'parameter';
              i += paramOpen[0].length;
              continue;
            }

            // 跨增量缓冲（含停滞检测）
            if (isToolTagPrefix(rest)) {
              if (bufferingSince === 0) {
                bufferingSince = Date.now();
              } else if (Date.now() - bufferingSince > BUFFER_STALL_MS) {
                console.log('[SSE] 标签缓冲停滞超过 ' + BUFFER_STALL_MS + 'ms，放弃缓冲');
                out += fullContent[i];
                i++;
                bufferingSince = 0;
                continue;
              }
              break;
            } else {
              bufferingSince = 0;
            }

            out += fullContent[i];
            i++;
          } else {
            // 块内：跟踪嵌套开标签（parameter 计数）
            const paramOpen = rest.match(RE_PARAM_OPEN);
            if (paramOpen) {
              i += paramOpen[0].length;
              continue;
            }
            // 闭合标签（calls/invoke/parameter）已在循环开头由 stray*Close 分支统一处理，
            if (isToolTagPrefix(rest)) {
              if (bufferingSince === 0) {
                bufferingSince = Date.now();
              } else if (Date.now() - bufferingSince > BUFFER_STALL_MS) {
                console.log('[SSE] 块内标签缓冲停滞超过 ' + BUFFER_STALL_MS + 'ms，放弃缓冲');
                i++;
                bufferingSince = 0;
                continue;
              }
              break;
            } else {
              bufferingSince = 0;
            }
            // 块内内容一律跳过
            i++;
          }
        }
        outputLen = i;

        if (out && onDelta) { try { onDelta(out); } catch (e) {} }
      },
      () => { finishedResolve(); },
      () => {
        limitExceeded = true;
        finishedResolve(); // 已满时无 FINISHED 信号，主动触发让等待提前结束
      }
    );
    sseDeltaHandler = (chunk) => {
      sseChunkCount++;
      sseRawBytes += chunk.length;

      // ★ 统计本 chunk 里的 DSML 标签数量，泛滥时强制结束等待
      const tagMatches = chunk.match(/<\/?[｜|\s]*DSML[｜|\s]*/gi);
      if (tagMatches) {
        dsmlFloodCount += tagMatches.length;
        if (dsmlFloodCount > DSML_FLOOD_LIMIT) {
          console.log(`[SSE] 检测到 DSML 标签泛滥（${dsmlFloodCount} 个），强制结束本次等待`);
          try { finishedResolve(); } catch (_) {}
          return;
        }
      }

      try { parser(chunk); } catch (e) {}
    };

    // 点击发送按钮
    const sendBtn = await findSendButton();
    if (sendBtn) {
      console.log('\x1b[36m[DEBUG] 点击发送按钮\x1b[0m');
      await sendBtn.click();
    } else {
      console.log('\x1b[36m[DEBUG] Enter 发送\x1b[0m');
      await editor.press('Enter');
    }

    // 检测超限提示（限制在通知/错误区域）
    const isOverLimit = await page.evaluate(() => {
      const regex = /(over limit|超出限制|超过限制|超出).?\d+%/i;
      // 优先搜索通知容器
      const containers = document.querySelectorAll('.ds-notification-container, .ds-toast, .ds-message, .ds-alert, [class*="notification"]');
      const searchRoots = containers.length > 0 ? containers : [document.body];
      for (const root of searchRoots) {
        const text = root.textContent.trim();
        if (regex.test(text)) return text;
      }
      return null;
    });

    if (isOverLimit) {
      console.log(`\x1b[31m[ERROR] 检测到上下文超限: ${isOverLimit}\x1b[0m`);
      return null;
    }

    console.log('\x1b[35m[DEBUG] 等待 SSE 回复...\x1b[0m');
    let timedOut = false;

    // 定期检测页面上的「重试」按钮（DeepSeek 提交后服务端超时会显示「超时重试」），检测到就点击并重置累积
    const retryCheckTimer = setInterval(async () => {
      try {
        const retryBtn = await detectRetryButton();
        if (retryBtn) {
          console.log('[DEBUG] 等待中检测到重试按钮，自动点击并重置累积...');
          await retryBtn.click();
          fullContent = '';
          outputLen = 0;
          inToolBlock = false;
          toolBlockEnd = '';
          sseChunkCount = 0;
          sseRawBytes = 0;
          // ★ 补齐：重试时也要清零泛滥计数与缓冲时间戳，
          //   否则上一次尝试累积的标签数会误触发中止/污染新回复
          dsmlFloodCount = 0;
          bufferingSince = 0;
        }
      } catch (e) {}
    }, 3000);

    await Promise.race([
      finishedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), 5 * 60 * 1000))
    ]).catch(e => {
      console.log('[DEBUG] SSE 等待异常:', e.message);
      timedOut = true;
    });

    clearInterval(retryCheckTimer);

    // ★ DSML 泛滥触发中止：开新对话，避免污染历史
    if (dsmlFloodCount > DSML_FLOOD_LIMIT) {
      sseDeltaHandler = null;
      console.log(`[DEBUG][SSE诊断] DSML 泛滥触发中止：chunk数=${sseChunkCount}, 标签数=${dsmlFloodCount}`);
      await startNewChatIfPossible();
      return null;
    }

    // 检测到"对话长度上限"错误（SSE 信号 context_length_exceeded），点击"开启新对话"并重新发送
    if (limitExceeded) {
      sseDeltaHandler = null;
      console.log('[新对话] SSE 检测到对话长度上限，点击"开启新对话"...');
      await detectAndHandleLimit();
      if (retryCount < 1) {
        console.log('[新对话] 已开新对话，重新发送消息...');
        return sendAndWait(text, cancelState, onDelta, retryCount + 1);
      }
      return null;
    }

    if (fullContent && !timedOut) {
      sseDeltaHandler = null;
      console.log('\x1b[32m[DEBUG] === 收到回复 ===\x1b[0m');
      console.log('\x1b[32m[DEBUG] 长度:\x1b[0m', fullContent.length);
      console.log('\x1b[32m[DEBUG] 前 200 字符:\x1b[0m', fullContent.slice(0, 200));
      return fullContent;
    } else {
      // 超时 或 正文为空
      if (!timedOut) {
        // FINISHED 但正文为空：先保持监听等待几秒，看是否有后续 completion 请求带正文到来（深度思考可能分多请求输出）
        console.log('[DEBUG] FINISHED 但正文为空，等待后续请求 5 秒...');
        await page.waitForTimeout(5000);
        if (fullContent) {
          sseDeltaHandler = null;
          console.log('\x1b[32m[DEBUG] 后续请求带来了正文，长度:\x1b[0m', fullContent.length);
          return fullContent;
        }
      }
      sseDeltaHandler = null;

      console.log(timedOut ? '\x1b[31m[DEBUG] SSE 超时，正文不完整\x1b[0m' : '\x1b[31m[DEBUG] 未收到回复\x1b[0m');
      console.log(`[DEBUG][SSE诊断] chunk数=${sseChunkCount}, 原始字节=${sseRawBytes}, content长度=${fullContent.length}`);

      // 超时或正文为空，尝试点击「重新生成」按钮重试
      if (retryCount < 1) {
        const retryBtn = await detectRetryButton();
        if (retryBtn) {
          console.log('[DEBUG] 检测到重试按钮，点击重新生成...');
          let finishedResolve2;
          const finishedPromise2 = new Promise(resolve => { finishedResolve2 = resolve; });
          let fullContent2 = '';
          const parser2 = createSSEParser(
            (delta) => { fullContent2 += delta; if (onDelta) { try { onDelta(delta); } catch (e) {} } },
            () => { finishedResolve2(); }
          );
          sseDeltaHandler = (chunk) => { try { parser2(chunk); } catch (e) {} };
          await retryBtn.click();
          await Promise.race([
            finishedPromise2,
            new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), 5 * 60 * 1000))
          ]).catch(e => { console.log('[DEBUG] 重试 SSE 等待异常:', e.message); });
          sseDeltaHandler = null;
          if (fullContent2) {
            console.log('\x1b[32m[DEBUG] 重试后收到回复，长度:\x1b[0m', fullContent2.length);
            return fullContent2;
          }
          console.log('[DEBUG] 重试后仍未收到回复');
        } else {
          console.log('[DEBUG] 未检测到重试按钮，重新发送消息重试...');
          await page.waitForTimeout(1000);
          return sendAndWait(text, cancelState, onDelta, retryCount + 1);
        }
      }
      return null;
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

    // 解析模型输出中的工具调用（格式：<invoke name="函数名"><parameter name="参数名">参数值</parameter></invoke>）
    function parseToolCall(text, allowedNames = []) {
      if (!text) return { found: false, success: false, toolCalls: [], toolCall: null };

      // 清理零宽字符、HTML 实体、<zwnj 字面量
      text = text
        .replace(/[​‌‍⁠﻿]/g, '')
        .replace(/&(?:zwnj|zwj|lrm|rlm);/gi, '')
        .replace(/<z(?:wnj|wj)/gi, '<');

      // ★ 清洗工具标签前的异常前缀，兼容模型输出的各种噪声形态：
      //   DSML 字面量、全角/半角竖线、空格、以及这些的任意组合和变体
      //   （例：<｜｜DSML｜｜ parameter>、</｜DSML｜ invoke>、<｜｜｜｜ calls>、
      //        <∣DSML∣ invoke> 等 —— 不再枚举竖线变体，用排除法统一处理）
      //   - TAG_NOISE 用 (?:DSML|[^a-zA-Z0-9_/>])* 覆盖：DSML 整体识别，
      //     其他任何非字母数字下划线斜杠尖括号的字符都被当作噪声
      //   - (?=[\s>]) 保证标签名后紧邻空格或 >，避免误伤 <parameters>、<callstate> 之类
      const TAG_NOISE = '(?:DSML|[^a-zA-Z0-9_/>])*';
      text = text.replace(
        new RegExp('(<\\/?)' + TAG_NOISE + '(calls|invoke|parameter)(?=[\\s>])', 'gi'),
        '$1$2'
      );

      // 兜底：清掉标签外可能残留的 DSML 字面量
      text = text.replace(/DSML/gi, '');

      const results = [];

      // 正则匹配完整的 <invoke name="函数名"> ... </invoke>（支持换行、多个参数）
      const invokeRegex = /<invoke\s+name\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/invoke>/gi;
      let match;
      while ((match = invokeRegex.exec(text)) !== null) {
        const rawName = match[1].trim();
        const rawBody = match[2];

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

        // 无参数的工具调用
        if (rawBody.trim() === '') {
          results.push({ success: true, toolCall: { name: rawName, arguments: {} } });
          continue;
        }

        // 解析 <parameter name="参数名">参数值</parameter>（手动解析，CDATA 感知：CDATA 包裹的内容一律当作值，不当标签）
        const args = {};
        const paramOpenRegex = /<parameter\s+name\s*=\s*"([^"]*)"[^>]*>/gi;
        let pm;
        while ((pm = paramOpenRegex.exec(rawBody)) !== null) {
          const pName = pm[1].trim();
          const openTag = pm[0];
          // 从开标签里提取 string="true" / string="false"（可选属性）
          const stringAttrMatch = openTag.match(/\bstring\s*=\s*"([^"]*)"/i);
          const stringAttr = stringAttrMatch ? stringAttrMatch[1].toLowerCase() : null;
          let pos = pm.index + pm[0].length;
          let pValue = '';

          // 值被 CDATA 包裹时，CDATA 里的内容（含 <invoke>/<parameter>/</parameter> 等）都当作值的一部分
          if (rawBody.startsWith('<![CDATA[', pos)) {
            const cdataStart = pos + '<![CDATA['.length;
            const cdataEnd = rawBody.indexOf(']]>', cdataStart);
            if (cdataEnd === -1) { break; }
            pValue = rawBody.slice(cdataStart, cdataEnd);
            pos = cdataEnd + ']]>'.length;
          } else {
            // 用正则匹配闭合标签：
            //  - 若以 "/" 或 "\" 开头（真正的闭合标签），允许 parameter 后跟随任意属性后再接 ">"；
            //    这是为了兼容模型把闭标签和下一个开标签合并写出的畸形（如 <\｜｜DSML｜｜ parameter name="offset" ...>）
            //  - 若无斜杠，则 parameter 后必须直接 ">"（避免把合法开标签 <parameter name="xxx"> 误当闭合标签）
            const closeRe = /(?:<[\\/]parameter\b[^>]*>|<parameter>|<[\\/]parameter>)/i;
            const afterOpen = rawBody.slice(pos);
            const mc = afterOpen.match(closeRe);
            if (!mc) { break; }
            pValue = afterOpen.slice(0, mc.index);
            pos = pos + mc.index + mc[0].length;
          }

          // 剥离可能的嵌套 CDATA 标记，取真实值
          pValue = pValue.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();

          // 类型转换：优先依据标签上的 string 属性；没有该属性时才回退到"纯数字自动转 Number"的启发式
          if (stringAttr === 'true') {
            // 明确声明是字符串，保持原样
            args[pName] = pValue;
          } else if (stringAttr === 'false') {
            // 明确声明是非字符串，尝试转数字/布尔；都不是则保留原文本
            const cleaned = pValue.replace(/\s+/g, '');
            const numVal = Number(cleaned);
            if (cleaned !== '' && !isNaN(numVal) && String(numVal) === cleaned) {
              args[pName] = numVal;
            } else if (cleaned === 'true' || cleaned === 'false') {
              args[pName] = cleaned === 'true';
            } else {
              args[pName] = pValue;
            }
          } else {
            // 未声明类型：保留原有启发式
            const cleanedValue = pValue.replace(/\s+/g, '');
            const numVal = Number(cleanedValue);
            if (cleanedValue !== '' && !isNaN(numVal) && String(numVal) === cleanedValue) {
              args[pName] = numVal;
            } else {
              args[pName] = pValue;
            }
          }

          // pos 已在上面推进到闭合标签之后，直接用它作为下一次搜索起点
          paramOpenRegex.lastIndex = pos;
        }

        // 只保留合法的参数名，丢弃无效键
        const validArgs = {};
        let hasInvalidKey = false;
        for (const [k, v] of Object.entries(args)) {
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
            validArgs[k] = v;
          } else {
            console.log('[ToolCall] 忽略非法参数名:', k);
            hasInvalidKey = true;
          }
        }

        if (Object.keys(validArgs).length === 0) {
          results.push({ success: false, error: `参数格式错误，未提取到有效参数，失败的参数文本：${rawBody.slice(0, 100)}` });
        } else {
          if (hasInvalidKey) {
            console.log('[ToolCall] 部分参数被忽略，已提取的有效参数:', JSON.stringify(validArgs));
          }
          results.push({ success: true, toolCall: { name: rawName, arguments: validArgs } });
        }
      }

      if (results.length === 0) {
        // 捕获无 ｜｜DSML｜｜ 前缀的旧格式标签，也兼容模型误加 ｜｜DSML｜｜ 前缀的变体
        if (/<(｜｜DSML｜｜\s+)?(tool_call|tool_calls|function_call|tool_use)/i.test(text)) {
          const oldTags = ['tool_call', 'tool_calls', 'function_call', 'tool_use'];
          const foundTags = oldTags.filter(tag =>
            text.includes(`<${tag}`) ||
            text.includes(`&lt;${tag}`) ||
            text.includes(`<｜｜DSML｜｜ ${tag}`) ||
            text.includes(`&lt;｜｜DSML｜｜ ${tag}`)
          );
          const tagList = foundTags.length > 0
            ? foundTags.map(t => `<${t}>`).join(', ')
            : '旧格式标签';
          return {
            found: true,
            success: false,
            toolCalls: [],
            toolCall: null,
            error: `检测到旧格式标签：${tagList}，必须使用 <｜｜DSML｜｜ calls> + <｜｜DSML｜｜ invoke name="函数名"> + <｜｜DSML｜｜ parameter name="参数名">参数值</｜｜DSML｜｜ parameter> 格式`
          };
        }
        if (/<(?:｜｜DSML｜｜[ \t\u00A0\u3000]+)?invoke/i.test(text) || text.includes('&lt;｜｜DSML｜｜ invoke') || text.includes('&lt;invoke')) {
          return { found: true, success: false, toolCalls: [], toolCall: null, error: '存在 <｜｜DSML｜｜ invoke> 标签但无法解析，请使用 <｜｜DSML｜｜ parameter name="参数名">参数值</｜｜DSML｜｜ parameter> 包裹参数' };
        }
        // 检测"缺少 <invoke name="函数名"> 开头，但有余下的 invoke 闭合标签 或 parameter 开标签"
        // 兼容带/不带 ｜｜DSML｜｜ 前缀，兼容 "/" "\" 或不带斜杠的闭合标签
        const danglingInvokeClose = /<[\\/]?\s*(?:｜｜DSML｜｜[ \t\u00A0\u3000]*)?invoke\s*>/i.test(text);
        const danglingParam = /<(?:｜｜DSML｜｜[ \t\u00A0\u3000]*)?parameter\b/i.test(text);
        if (danglingInvokeClose || danglingParam) {
          return {
            found: true,
            success: false,
            toolCalls: [],
            toolCall: null,
            error: '工具调用格式不完整：缺少 <｜｜DSML｜｜ invoke name="函数名"> 开头标签，请重新输出完整的工具调用'
          };
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
     * @param {string} text
     * @returns {string|null} 清洗后的有效文本，若为空则返回 null
     */
    function cleanTaskCompletedMark(text) {
      if (!text) return null;
      // 只清理工具调用相关的标签（含噪声前缀变体），保留正文里可能出现的 HTML
      const N = '(?:DSML|[^a-zA-Z0-9_/>])*';
      text = text
        .replace(new RegExp('</?' + N + '(?:invoke|parameter|calls)(?=[\\s>])[^>]*>', 'gi'), '')
        .replace(/DSML/gi, '');
      const cleaned = text.trim();
      return cleaned.length > 0 ? cleaned : null;
    }

    /**
     * 剥离所有 ｜｜DSML｜｜ 标签（开/闭、配对/孤立、正反斜杠），
     * 避免任何残缺的工具调用标签被当作正文返回给客户端
     */
    function stripDsmlTags(text) {
      if (!text) return text;
      // 统一噪声类：DSML 整体识别 + 任意非字母数字下划线斜杠尖括号的字符
      const N = '(?:DSML|[^a-zA-Z0-9_/>])*';
      return text
        // 1. 配对块（开/闭标签名前都允许任意噪声）
        .replace(new RegExp('<' + N + '(?:invoke|parameter|calls)\\b[^>]*>[\\s\\S]*?<\\/' + N + '(?:invoke|parameter|calls)(?=[\\s>])[^>]*>', 'gi'), '')
        // 2. 残余的孤立标签（含反斜杠变体）
        .replace(new RegExp('</?' + N + '(?:invoke|parameter|calls)(?=[\\s>])[^>]*>', 'gi'), '')
        // 3. 纯 parameter 开标签（模型漏写 invoke 包裹时）
        .replace(new RegExp('<' + N + 'parameter\\b[^>]*>', 'gi'), '')
        // 4. 清理可能残留的 DSML 字面量
        .replace(/DSML/gi, '')
        .trim();
    }

    async function getFinalReplyWithTools(promptText, toolsText, instruction, toolNames, cancelState, onDelta = null) {
      let prompt = `【可用工具】\n${toolsText}${instruction}\n\n${promptText}`;
      let reply = await sendAndWait(prompt, cancelState, onDelta);
      let rawOutput = (reply && reply.trim()) || '【系统提示】DeepSeek 未返回有效回复。';
      console.log('[HTTP] 首次输出:', rawOutput.slice(0, 150));

      let parseResult = parseToolCall(rawOutput, toolNames);

      // 无论是否声明了工具，只要回复中包含了工具调用标签，就尝试解析或纠正
      if (parseResult.found) {
        // ★ 有上限的纠正循环（最多 2 次），并带 DSML 泛滥 / 重复输出检测
        let correctionAttempts = 0;
        const MAX_CORRECTIONS = 2;
        let prevOutput = '';
        let repeatedCount = 0;

        while (correctionAttempts < MAX_CORRECTIONS) {
          correctionAttempts++;

          if (cancelState && cancelState.cancelled) {
            console.log('[ToolCall] 任务已取消，停止工具纠错');
            return { toolCall: null, toolCalls: [], rawOutput: rawOutput || '', assistantContent: null };
          }

          if (parseResult.success) {
            const textContent = stripDsmlTags(rawOutput)
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            return {
              toolCall: parseResult.toolCall,
              toolCalls: parseResult.toolCalls,
              rawOutput,
              assistantContent: cleanTaskCompletedMark(textContent) || null
            };
          }

          // ★ 检测 DSML 标签泛滥
          const dsmlCount = (rawOutput.match(/<\/?[｜|\s]*DSML/gi) || []).length;
          if (dsmlCount > 30) {
            console.log(`[ToolCall] DSML 标签泛滥（${dsmlCount} 个），停止纠正`);
            break;
          }

          // ★ 检测连续相同输出
          if (rawOutput === prevOutput) {
            repeatedCount++;
            if (repeatedCount >= 2) {
              console.log('[ToolCall] 输出连续未变化，停止纠正');
              break;
            }
          } else {
            repeatedCount = 0;
          }
          prevOutput = rawOutput;

          console.log(`[ToolCall] 格式错误，纠正中... (${correctionAttempts}/${MAX_CORRECTIONS})`);
          let fixExample = '';
          const failedMatch = parseResult.error.match(/失败的参数文本：\s*(.*)/);
          if (failedMatch) {
            const failedText = failedMatch[1].trim();
            fixExample = `\n  【你的错误输出】：${failedText.slice(0, 200)}`;
          } else if (parseResult.error.includes('禁止的标签格式')) {
            fixExample = `\n  【你的错误输出片段】：${rawOutput.slice(0, 200)}`;
          }

          const retryPrompt = `上一轮你的工具调用格式错误：${parseResult.error}${fixExample}\n` +
            `\n\n【!!!最高优先级指令：工具调用格式!!!】\n` +
            `你现在必须使用以下 XML 格式调用工具，绝对禁止使用任何其他格式。\n\n` +
            `✅ 正确格式（唯一允许）：\n` +
            `<｜｜DSML｜｜ calls>\n` +
            `<｜｜DSML｜｜ invoke name="工具名">\n` +
            `<｜｜DSML｜｜ parameter name="参数名1">参数值1</｜｜DSML｜｜ parameter>\n` +
            `<｜｜DSML｜｜ parameter name="参数名2">参数值2</｜｜DSML｜｜ parameter>\n` +
            `</｜｜DSML｜｜ invoke>\n` +
            `</｜｜DSML｜｜ calls>\n`;

          reply = await sendAndWait(retryPrompt, cancelState);
          if (reply && reply.trim()) {
            rawOutput = reply.trim();
          } else {
            console.log('[ToolCall] 纠正请求未获得有效回复，放弃纠正');
            break;
          }
          console.log('[HTTP] 纠正后输出:', rawOutput.slice(0, 200));

          parseResult = parseToolCall(rawOutput, toolNames);
          if (!parseResult.found) {
            console.log('[ToolCall] 模型仍未输出工具调用，将其视为最终回复');
            const langKeywords = /^(java|text|python|javascript|js|typescript|go|ruby|rust|c|cpp|csharp|bash|shell|powershell|sql|html|css|xml|json|yaml|swift|kotlin|scala|perl|php|r|dart|elixir|erlang|haskell|clojure|lua|matlab|objective-c|rust)$/i;
            const uiNoise = /^(复制|下载|运行|调试|代码)$/;
            let finalText = rawOutput
              .replace(/专家模式暂不支持搜索，请使用快速模式/g, '')
              .split('\n')
              .filter(line => {
                const t = line.trim();
                return t !== '' && !langKeywords.test(t) && !uiNoise.test(t);
              })
              .join('\n')
              .trim();
            const cleaned = cleanTaskCompletedMark(stripDsmlTags(finalText));
            return { toolCall: null, toolCalls: [], rawOutput: cleaned || stripDsmlTags(rawOutput), assistantContent: null };
          }
        }

        // ★ 达到最大纠正次数 / 检测到泛滥：降级为普通文本返回，避免死循环
        console.log('[ToolCall] 纠正失败，降级为普通文本返回');
        const fallbackText = cleanTaskCompletedMark(stripDsmlTags(rawOutput))
          || '【系统提示】工具调用格式持续错误，请重试或换一种表达方式。';
        return { toolCall: null, toolCalls: [], rawOutput: fallbackText, assistantContent: null };
      } else {
        // 没有任何工具调用标签，直接返回纯文本（finish_reason: stop）
        // 清洗 UI 杂讯，仅在纯文本模式下进行
        const langKeywords = /^(java|text|python|javascript|js|typescript|go|ruby|rust|c|cpp|csharp|bash|shell|powershell|sql|html|css|xml|json|yaml|swift|kotlin|scala|perl|php|r|dart|elixir|erlang|haskell|clojure|lua|matlab|objective-c|rust)$/i;
        const uiNoise = /^(复制|下载|运行|调试|代码)$/;
        let cleanText = rawOutput
          .replace(/专家模式暂不支持搜索，请使用快速模式/g, '')
          .split('\n')
          .filter(line => {
            const t = line.trim();
            return t !== '' && !langKeywords.test(t) && !uiNoise.test(t);
          })
          .join('\n');
        const cleaned = cleanTaskCompletedMark(stripDsmlTags(cleanText));
        return { toolCall: null, rawOutput: cleaned || stripDsmlTags(rawOutput), assistantContent: null };
      }
    }

    // 原有的请求处理部分（仅展示核心修改）
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => body += chunk);
      const cancelState = { cancelled: false, retryCount: 0 };
      req.on('close', () => {
        // cancelState.cancelled = true;
        // console.log('[HTTP] 客户端已断开连接');
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
            const historyNoise = /^(复制|下载|运行|调试|代码)$/;
            let promptText = "";
            for (const msg of recentMessages) {
              let rawContent = extractTextContent(msg.content);
              // 只清洗 assistant 消息中的 UI 杂讯（行级过滤，避免误删正文中的"代码""运行"等词）
              if (msg.role === 'assistant') {
                rawContent = rawContent
                  .split('\n')
                  .filter(line => !historyNoise.test(line.trim()))
                  .join('\n');
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
  ? `\n\n【工具调用格式（必须严格遵守）】\n` +
    `格式：<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="工具名"> <｜｜DSML｜｜ parameter name="参数名">值</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>\n` +
    `示例（只给一个，请勿照抄参数值）：\n` +
    `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read"><｜｜DSML｜｜ parameter name="filePath">/tmp/a.txt</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>\n\n` +
    `【工具使用规则（最高优先级）】：\n` +
    `- 修改文件时，优先使用 edit 工具，绝对不要用 write 整体覆盖。\n` +
    `- 如果 edit 失败，说明文件内容/结构已经变化，必须先重新 read 读取最新内容，再基于最新内容 edit。\n\n` +
    `【禁止事项（最高优先级）】：\n` +
    `- 禁止单独输出 </｜｜DSML｜｜> 或任何孤立闭合标签。\n` +
    `- 禁止重复输出同一标签。\n` +
    `- 一次回复只输出一组完整的 <｜｜DSML｜｜ calls> 块。\n` +
    `- 闭合标签必须使用正斜杠：</｜｜DSML｜｜ parameter>，禁止写成 <\｜｜DSML｜｜ parameter>。\n`
  : '';
            // ===== 流式基础设施：data.stream === true 时，提前设置响应头 + onDelta =====
            let streamCtx = null;
            if (data.stream === true) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
              });
              let responseEnded = false;
              const markEnded = (reason) => {
                if (!responseEnded) { responseEnded = true; console.log(`[HTTP] 响应流中断: ${reason}`); }
              };
              res.on('error', (err) => markEnded(`error: ${err.message}`));
              res.on('close', () => markEnded('close'));
              const chunkId = 'chatcmpl-' + Date.now();
              const model = 'deepseek-chat';
              const created = Math.floor(Date.now() / 1000);

              // 发送第一个 chunk（role）
              res.write(`data: ${JSON.stringify({
                id: chunkId, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }]
              })}\n\n`);

              // 流式剥离 <...>：用一个缓冲区处理跨 chunk 的"半个标签"
              let streamBuf = '';
              const flushStream = (force = false) => {
                if (responseEnded || !res.writable || !streamBuf) return;
                // 尾部若存在未闭合的 '<'，从"最靠前的那个未闭合 '<'"开始暂存，
                // 避免多个未闭合标签时前面的半截被误 emit
                //   - 非 force：暂存到下次，等下一帧补全
                //   - force：直接丢弃半截
                const gtIdx = streamBuf.lastIndexOf('>');
                const tail = streamBuf.slice(gtIdx + 1);
                const firstLtInTail = tail.indexOf('<');
                let toEmit;
                if (firstLtInTail !== -1) {
                  const cutIdx = gtIdx + 1 + firstLtInTail;
                  toEmit = streamBuf.slice(0, cutIdx);
                  streamBuf = force ? '' : streamBuf.slice(cutIdx);
                } else {
                  toEmit = streamBuf;
                  streamBuf = '';
                }
                // 只剥离工具调用相关标签（含噪声前缀变体），避免误伤正文里的 HTML
                const N = '(?:DSML|[^a-zA-Z0-9_/>])*';
                const cleaned = toEmit
                  .replace(new RegExp('</?' + N + '(?:invoke|parameter|calls)(?=[\\s>])[^>]*>', 'gi'), '')
                  .replace(/DSML/gi, '');
                if (!cleaned) return;
                res.write(`data: ${JSON.stringify({
                  id: chunkId, object: 'chat.completion.chunk', created, model,
                  choices: [{ index: 0, delta: { content: cleaned }, finish_reason: null }]
                })}\n\n`);
              };
              const onDelta = (delta) => {
                if (responseEnded || !res.writable) return;
                streamBuf += delta;
                flushStream(false);
              };

              streamCtx = { isEnded: () => responseEnded, chunkId, model, created, onDelta, flushStream };
            }

            // 真正流式：无工具 + 流式请求时，正文边接收边返回
            if (data.stream === true && tools.length === 0) {
              const streamPrompt = `【可用工具】\n无\n\n${promptText}`;
              await sendAndWait(streamPrompt, cancelState, streamCtx.onDelta);
              // ★ 把流式缓冲区里最后的内容吐出来（尾部半截 '<...' 会被强制丢弃）
              try { streamCtx.flushStream(true); } catch (_) {}
              if (!streamCtx.isEnded() && res.writable) {
                res.write(`data: ${JSON.stringify({
                  id: streamCtx.chunkId, object: 'chat.completion.chunk', created: streamCtx.created, model: streamCtx.model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                })}\n\n`);
                res.write('data: [DONE]\n\n');
              }
              res.end();
              return;
            }

            const { toolCall, toolCalls, rawOutput, assistantContent } = await getFinalReplyWithTools(
              promptText, toolsText, toolCallInstructions, toolNames, cancelState,
              streamCtx ? streamCtx.onDelta : null
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

            // ---- 流式响应（响应头 + role chunk 已在 streamCtx 设置，正文说明已通过 onDelta 流式输出）----
            if (data.stream === true) {
              const { chunkId, model, created, isEnded } = streamCtx;
              const alive = () => !isEnded() && res.writable;

              try { streamCtx.flushStream(true); } catch (_) {}
              if (hasTool) {
                // 正文说明已通过 onDelta 流式输出，这里只发送工具调用块
                for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
                  const tc = toolCalls[tcIdx];
                  const toolCallId = 'call_' + Math.random().toString(36).substr(2, 9);
                  const argsStr = JSON.stringify(tc.arguments);

                  // 发送 tool_call 开始块
                  if (alive()) {
                    res.write(`data: ${JSON.stringify({
                      id: chunkId, object: 'chat.completion.chunk', created, model,
                      choices: [{ index: 0, delta: { tool_calls: [{ index: tcIdx, id: toolCallId, type: 'function', function: { name: tc.name, arguments: '' } }] }, finish_reason: null }]
                    })}\n\n`);
                  }

                  // 逐步发送 arguments
                  for (let i = 0; i < argsStr.length; i++) {
                    if (!alive()) break;
                    res.write(`data: ${JSON.stringify({
                      id: chunkId, object: 'chat.completion.chunk', created, model,
                      choices: [{ index: 0, delta: { tool_calls: [{ index: tcIdx, function: { arguments: argsStr[i] } }] }, finish_reason: null }]
                    })}\n\n`);
                    await new Promise(r => setTimeout(r, 5));
                  }

                  if (!alive()) break;
                }

                if (alive()) {
                  res.write(`data: ${JSON.stringify({
                    id: chunkId, object: 'chat.completion.chunk', created, model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                  })}\n\n`);
                  res.write('data: [DONE]\n\n');
                  res.end();
                }
              } else {
                // 无工具调用（纯文本），正文已通过 onDelta 流式输出，只发 finish + DONE
                if (alive()) {
                  res.write(`data: ${JSON.stringify({
                    id: chunkId, object: 'chat.completion.chunk', created, model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                  })}\n\n`);
                  res.write('data: [DONE]\n\n');
                  res.end();
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
                content: assistantContent || null,
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
            cancelState.cancelled = true;  // 通知内部循环退出

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
      } catch (_) { }
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
    } catch (_) { }
    server.close();
    await browser.close();
    process.exit(0);
  });
}

main().catch(async (err) => {
  console.error('发生错误:', err.message);
  process.exit(1);
});