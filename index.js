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
  // ★ XHR SSE 拦截器脚本（可被 addInitScript 与 evaluate 复用）
  //   - addInitScript：在页面脚本之前执行，每次真实导航自动重新执行，SPA 无法覆盖
  //   - evaluate：作为 SPA 内部路由跳转后 XHR 被覆盖的罕见场景的补充
  //   - window.__sseInjected 守卫：保证同一页面内只包装一次，避免拦截器嵌套/重复推送
  function getSSEInterceptorScript() {
    return () => {
      // ★ 守卫改为"检查当前 send 是否仍是我们的包装"：
      //   - 初次注入：XMLHttpRequest.prototype.send 没有 __sseWrapped 标记 → 注入
      //   - SPA 重写了 XHR（框架常见）：send 被替换，__sseWrapped 丢失 → 重新注入
      //   - 已注入且未被覆盖：send.__sseWrapped 为 true → 跳过，避免嵌套包装
      //   注意：仅靠 window.__sseInjected 会漏掉"SPA 覆盖后无法恢复"的场景 → chunk=0。
      if (XMLHttpRequest.prototype.send && XMLHttpRequest.prototype.send.__sseWrapped) return;
      window.__sseInjected = true;

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__url = url;
        return origOpen.call(this, method, url, ...rest);
      };

      const wrappedSend = function(...args) {
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
          this.addEventListener('progress', flush);
          this.addEventListener('load', flush);
          this.addEventListener('loadend', () => {
            flush();
            if (window.__onSSEDelta) window.__onSSEDelta('\n');
          });
        }
        return origSend.call(this, ...args);
      };
      wrappedSend.__sseWrapped = true;   // ★ 标记，供重复注入时判断
      XMLHttpRequest.prototype.send = wrappedSend;
    };
  }

  // ★ 确保 XHR SSE 拦截已注入当前页面（幂等）
  //   - exposeFunction：Playwright 在导航后会自动重新暴露，重复调用抛错被忽略
  //   - evaluate：用 __sseInjected 守卫，与 addInitScript 互斥，避免重复包装
  async function ensureSSEInjected(targetPage) {
    if (!targetPage) return;
    // ★ __onSSEDelta / __onSSERequest 已由 context 级 exposeFunction 绑定（initBrowserAndPage 中），
    //   这里保留兜底调用，兼容 context 级绑定失败或被覆盖的边缘场景。
    //   重复调用会抛错，被 catch 忽略，无副作用。
    try {
      await targetPage.exposeFunction('__onSSEDelta', (chunk) => {
        if (sseDeltaHandler) sseDeltaHandler(chunk);
      });
    } catch (_) { /* 已注册或页面正在导航，忽略 */ }
    try {
      await targetPage.exposeFunction('__onSSERequest', () => {
        sseRequestSeq++;
        console.log('[SSE] 新的 completion 请求 #' + sseRequestSeq + '（判断是否分多请求输出）');
      });
    } catch (_) { /* 已注册或页面正在导航，忽略 */ }
    // 补注入 XHR 拦截器：覆盖 SPA 内部路由后 XHR 被第三方脚本重写的场景
    try {
      await targetPage.evaluate(getSSEInterceptorScript());
    } catch (e) {
      console.log('[SSE] 注入失败（页面可能正在导航）:', e.message);
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

    // ★ 关键修复 A：context 级 exposeFunction 绑定 __onSSEDelta / __onSSERequest
    //   根因：page.exposeFunction 只对单个页面生效；browser.on('page') 里等 waitForSelector 成功
    //         才调用 ensureSSEInjected，导致新标签页加载期间 window.__onSSEDelta 缺失，
    //         addInitScript 注入的 XHR 拦截器拿到数据后无处推送 → 静默丢弃 → chunk=0。
    //   修复：context 级一次性绑定，所有页面（含未来打开的标签页）自动获得这两个函数，
    //         无需等待页面就绪即可接收 completion 增量。
    try {
      await newBrowser.exposeFunction('__onSSEDelta', (chunk) => {
        if (sseDeltaHandler) sseDeltaHandler(chunk);
      });
    } catch (_) { /* 已注册，忽略 */ }
    try {
      await newBrowser.exposeFunction('__onSSERequest', () => {
        sseRequestSeq++;
        console.log('[SSE] 新的 completion 请求 #' + sseRequestSeq + '（判断是否分多请求输出）');
      });
    } catch (_) { /* 已注册，忽略 */ }

    // ★ 关键修复 B：用 addInitScript 注册 XHR 拦截器
    //   - 它在页面脚本之前执行，SPA 初始化时无法覆盖
    //   - 每次真实导航（goto / reload）都会自动重新执行，新 window 的 __sseInjected 为 undefined，会重新包装
    //   - 注册在 context 级别：所有页面（含新标签页、window.open 弹窗）都会自动注入
    //   - 修复 "新标签/新对话后 chunk=0、模型已输出但程序未收到" 的问题
    await newBrowser.addInitScript(getSSEInterceptorScript());

    // ★ 若页面内 window.open / target="_blank" 打开新标签，全局 page 需要跟随切换，
    //   否则 findEditor / findSendButton / ensureSSEInjected 都在旧页面上操作。
    //   策略：新页面出现时，若它是主站域名 + 有可见输入框，则切换到新页面
    //   （用户主动打开新标签通常是想要在新标签操作，不能因旧页还有输入框而拒绝）
    newBrowser.on('page', async (newP) => {
      try {
        // ★ 无条件先注入 SSE 回调 + XHR 拦截器：
        //   1. newP.url() 在 page 事件触发时通常是 about:blank，若用 URL 判断会跳过注入，
        //      若 BrowserContext.exposeFunction 不可用（老版本 Playwright），新页永远没有
        //      window.__onSSEDelta → XHR 拦截器拿到数据后无处推送 → chunk=0。
        //   2. 页面正在导航时注入失败会被 catch；URL 判断通过后会再注入一次（evaluate 幂等）。
        try { await ensureSSEInjected(newP); } catch (_) {}

        await newP.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        const newUrl = newP.url() || '';
        const platformHost = new URL(platform.url).host;
        // ★ 只切换主站域名的页：window.open('https://chat.deepseek.com/...') 在 page 事件
        //   触发时 URL 已是主站；不需要接受 about:blank 过渡态。
        //   撤销上一轮的 isUserOpenedTab：用户手动打开空白标签时会被误切换，
        //   导致每次请求前 sendAndWait 兜底等 30 秒。
        if (!newUrl.includes(platformHost)) return;

        // ★ 关键修复：域名匹配后立即切换 page（用户打开新标签页就是要在这边操作），
        //   不再等 waitForSelector 30 秒；否则用户在新页操作期间 page 仍指旧页，
        //   消息会被 sendAndWait 发到旧页，模型在新页的输出无人接收 → chunk=0 / 长时间等待。
        console.log('[浏览器] 检测到新标签页，立即切换 page 到:', newUrl);
        page = newP;
        try { await ensureSSEInjected(page); } catch (_) {}

        // waitForSelector 仅用于日志（观察新页输入框就绪时间），不阻塞 page 切换
        const editorSelector = platform.editor.split(',')[0].trim();
        try {
          await newP.waitForSelector(editorSelector, { state: 'visible', timeout: 30000 });
          console.log('[浏览器] 新标签页输入框已就绪');
        } catch (_) {
          console.log('[浏览器] 新标签页输入框 30 秒内未就绪，sendAndWait 会在发送时等待');
        }
      } catch (e) {
        console.log('[浏览器] 新标签页切换失败:', e.message);
      }
    });

    await newPage.goto(platform.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`页面已打开，等待登录到 ${platform.name}...`);

    await waitForLogin(newPage);
    console.log('登录成功！可以开始对话了。\n');

    // 注入 SSE 流式拦截：把 completion 响应的增量实时推给 Node（用于流式返回）
    await ensureSSEInjected(newPage);

    return { browser: newBrowser, page: newPage };
  }

  // 初始化（替代原来的 const browser = ... 和 const page = ...）
  const initResult = await initBrowserAndPage();
  browser = initResult.browser;
  page = initResult.page;

  // ★ 程序启动后第一次请求标志：
  //   - 程序刚启动时 DeepSeek 停在新对话界面，服务端上下文为空
  //   - 此时如果客户端发完整历史，必须用 fullPromptText（完整历史）建立上下文
  //   - 之后依赖服务端上下文，用 promptText（system + 最新 user）
  //   - 超限切换新对话后，由 limitExceeded 分支用 fullText 重发（已有逻辑）
  let isFirstRequestAfterStart = true;

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
  // ★ 只接受"视口下半部分"的按钮，避免误触历史消息的"重新生成"按钮
  //   - 新消息出现在页面底部，其重试按钮也在底部
  //   - 历史消息的重试按钮在视口上方或上半部分，不在检查范围内
  async function detectRetryButton() {
    const retryPatterns = ['重试', '重新生成', '重新发送', 'Retry', 'Refresh', 'refresh', 'retry', '超时', 'timeout', 'Timeout', '重新加载', '生成失败', '重新回答'];

    // ★ 不依赖 page.viewportSize()（launchPersistentContext 默认 viewport 为 null），
    //   改用 getBoundingClientRect + window.innerHeight 判断按钮是否在视口下半部分
    const isInBottomHalf = async (btn) => {
      try {
        const result = await btn.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return { centerY: rect.top + rect.height / 2, vh: window.innerHeight };
        });
        if (!result || !result.vh) return true; // 无法获取时退化为原行为
        return result.centerY > result.vh * 0.45;
      } catch (_) {
        return false;
      }
    };

    try {
      const buttons = page.locator('button, [role="button"]');
      const count = await buttons.count();
      // 从后往前扫描，优先最新的按钮（新消息的按钮在 DOM 中靠后）
      for (let i = count - 1; i >= 0; i--) {
        const btn = buttons.nth(i);
        try {
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
              if (visible && await isInBottomHalf(btn)) {
                console.log('[重试检测] 发现重试按钮（视口下半部分）: "' + combined.trim() + '"');
                return btn;
              }
            }
          }
        } catch (e) { }
      }
    } catch (e) { }
    try {
      const warningBtns = page.locator('[role="button"].ds-button--warning, button.ds-button--warning');
      const wCount = await warningBtns.count();
      for (let i = wCount - 1; i >= 0; i--) {
        const btn = warningBtns.nth(i);
        if (await btn.isVisible({ timeout: 1500 }) && await isInBottomHalf(btn)) {
          console.log('[重试检测] 发现 warning 按钮（视口下半部分）');
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
          // ★ 增强等待：等页面加载 + 输入框真正可见
          try {
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
          } catch (_) {}
          await page.waitForTimeout(2000);
          // ★ 确认输入框就绪（最多再等 10 秒）
          const editorSelector = platform.editor.split(',').map(s => s.trim())[0];
          try {
            await page.waitForSelector(editorSelector, { state: 'visible', timeout: 10000 });
            console.log('[新对话] 输入框已就绪');
          } catch (_) {
            console.log('[新对话] 等待输入框可见超时，仍尝试继续');
          }
          await page.waitForTimeout(1000);
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
      // ★ 导航后 exposeFunction 与 evaluate 注入都会失效，必须重新注入
      await ensureSSEInjected(page);
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
    let fragments = [];          // ★ 维护完整 fragments 数组
    let thinkContent = '';
    let responseContent = '';
    let pendingContent = '';     // ★ fragments 尚未就绪时到达的增量，等类型确定后再归属
    let lastPath = '';           // ★ 记录上一次的 p，用于处理省略 p 的连续增量
    let lastOp = '';             // ★ 记录上一次的 o

    // ★ 类型名兼容：DeepSeek 可能用 THINK / THINKING / REASONING 等变体，
    //   固定大写后比对，避免平台改名导致静默丢弃或误判为正文
    const isThinkType = (t) => {
      if (typeof t !== 'string') return false;
      const u = t.toUpperCase();
      return u === 'THINK' || u === 'THINKING' || u === 'REASONING' || u === 'REASON';
    };
    const isResponseType = (t) => {
      if (typeof t !== 'string') return false;
      const u = t.toUpperCase();
      return u === 'RESPONSE' || u === 'CONTENT' || u === 'ANSWER';
    };

    const getLastType = () => {
      if (fragments.length === 0) return null;
      const last = fragments[fragments.length - 1];
      return (last && typeof last.type === 'string') ? last.type : null;
    };

    const emitResponse = (s) => {
      if (!s) return;
      responseContent += s;
      try { onResponseDelta(s); } catch (_) {}
    };

    // ★ 把 pendingContent 按当前最后一个 fragment 的类型归属。
    //   类型未知（fragments 空 / type 字段缺失 / 平台新增类型）时：默认按 THINK 处理（不输出正文），
    //   避免协议变更时把 THINK 内容误当正文泄漏；可用 SSE_THINK_FALLBACK=1 强制当正文输出。
    const flushPending = () => {
      if (!pendingContent) return;
      const type = getLastType();
      if (isResponseType(type)) {
        emitResponse(pendingContent);
      } else if (isThinkType(type)) {
        thinkContent += pendingContent;
      } else if (process.env.SSE_THINK_FALLBACK === '1') {
        if (process.env.DEBUG_SSE) {
          console.log('[SSE诊断] flushPending 类型未知，SSE_THINK_FALLBACK=1 开启，按正文输出，type=' +
            JSON.stringify(type) + ', 长度=' + pendingContent.length);
        }
        emitResponse(pendingContent);
      } else {
        if (process.env.DEBUG_SSE) {
          console.log('[SSE诊断] flushPending 类型未知，按 THINK 处理（不输出正文），type=' +
            JSON.stringify(type) + ', 长度=' + pendingContent.length +
            '（若确为正文，请把类型名补进 isResponseType）');
        }
        thinkContent += pendingContent;
      }
      pendingContent = '';
    };

    const processFragment = (f) => {
      if (!f || typeof f !== 'object') return;
      const content = typeof f.content === 'string' ? f.content : '';
      if (!content) return;
      if (isResponseType(f.type)) {
        emitResponse(content);
      } else if (isThinkType(f.type)) {
        thinkContent += content;
      } else if (process.env.SSE_THINK_FALLBACK === '1') {
        if (process.env.DEBUG_SSE) {
          console.log('[SSE诊断] processFragment 未知类型，SSE_THINK_FALLBACK=1 开启，按正文输出，type=' +
            JSON.stringify(f.type));
        }
        emitResponse(content);
      } else {
        if (process.env.DEBUG_SSE) {
          console.log('[SSE诊断] processFragment 未知类型，按 THINK 处理（不输出正文），type=' +
            JSON.stringify(f.type) + '（若确为正文，请把类型名补进 isResponseType）');
        }
        thinkContent += content;
      }
    };

    // ★ 提取处理全量快照的公共逻辑
    // 统一遍历所有 fragment，只要内容变长了就提取增量，避免既有元素增长被漏掉
    const processFragmentsSnapshot = (newFrags) => {
      for (let i = 0; i < newFrags.length; i++) {
        const nf = newFrags[i];
        if (!nf || typeof nf.content !== 'string') continue;
        
        const of = fragments[i];
        const oldLen = (of && typeof of.content === 'string') ? of.content.length : 0;
        if (nf.content.length <= oldLen) continue;
        
        const delta = nf.content.slice(oldLen);
        if (!delta) continue;

        if (isResponseType(nf.type)) {
          emitResponse(delta);
        } else if (isThinkType(nf.type)) {
          thinkContent += delta;
        } else if (process.env.SSE_THINK_FALLBACK === '1') {
          if (process.env.DEBUG_SSE) {
            console.log('[SSE诊断] 快照 fragment 增长但类型未知，SSE_THINK_FALLBACK=1 开启，按正文输出，type=' +
              JSON.stringify(nf.type) + ', delta长度=' + delta.length);
          }
          emitResponse(delta);
        } else {
          if (process.env.DEBUG_SSE) {
            console.log('[SSE诊断] 快照 fragment 增长但类型未知，按 THINK 处理（不输出正文），type=' +
              JSON.stringify(nf.type) + ', delta长度=' + delta.length +
              '（若确为正文，请把类型名补进 isResponseType）');
          }
          thinkContent += delta;
        }
      }
      // ★ 使用 JSON 比较并直接覆盖，确保属性（如 content）被正确更新
      fragments = newFrags.slice();
    };

    return (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr.startsWith('{')) continue;
        if (process.env.DEBUG_SSE_RAW) {
          console.log('[SSE RAW]', dataStr.length > 800 ? dataStr.slice(0, 800) + '...' : dataStr);
        }
        let d; try { d = JSON.parse(dataStr); } catch (e) { continue; }

        // ① 初始化 response（快照可能重复发送，只处理新增 fragment，避免重复输出）
        if (d.v && d.v.response && Array.isArray(d.v.response.fragments)) {
          processFragmentsSnapshot(d.v.response.fragments);
          flushPending();
          continue;
        }

        // ② 长度上限信号
        if (d.type === 'error' && d.finish_reason === 'context_length_exceeded') {
          console.log('[SSE] 检测到对话长度上限错误（context_length_exceeded）');
          onLimitExceeded();
        }

        // ③ ★ 处理当前消息的 p/o（兼容省略 p/o 的连续增量）
        const curPath = d.p || '';
        const curOp   = d.o || '';

        if (d.p) lastPath = d.p;
        if (d.o) lastOp = d.o;

        // DeepSeek 省流优化：连续同一个 p 的增量，后续只发 {"v":"xxx"}，无 p 无 o
        let actualPath = curPath;
        let actualOp = curOp;
        if (!d.p && !d.o && typeof d.v === 'string') {
          actualPath = lastPath;
          // ★ 省略 p/o 的增量一定是对路径的追加。无论上一条 lastOp 是什么（比如 elapsed_secs 的 SET），
          //   只要继承了路径，其操作必定是 APPEND 更新内容。
          if (actualPath === 'response/fragments/-1/content' || actualPath === 'response/fragments/-1/thinking') {
            actualOp = 'APPEND';
          } else if (lastOp) {
            actualOp = lastOp;
          }
        }

        // ④ 处理 fragment 变化（兼容 APPEND 和全量快照）
        if (actualPath === 'response/fragments') {
          let arr = Array.isArray(d.v) ? d.v : (d.v && typeof d.v === 'object' ? [d.v] : []);
          if (actualOp === 'APPEND') {
            // 追加增量
            for (const f of arr) { fragments.push(f); processFragment(f); }
          } else {
            // 全量快照（如 REPLACE 或未带 o 的 SET，日志中已证实存在无 o 的情况）
            processFragmentsSnapshot(arr);
          }
          flushPending();
          continue;
        }

        // ⑤ 最后一个 fragment 的 content 增量
        if (actualPath === 'response/fragments/-1/content' && typeof d.v === 'string') {
          if (actualOp && actualOp !== 'APPEND' && process.env.DEBUG_SSE) {
            console.log('[SSE诊断] -1/content 的 o=' + actualOp + '（非 APPEND）');
          }
          const type = getLastType();
          if (type === null) {
            // ★ fragments 尚未就绪：缓存，绝不直接当正文输出（避免 THINK 被当正文）
            pendingContent += d.v;
            if (process.env.DEBUG_SSE) {
              console.log('[SSE诊断] 增量到达但 fragments 为空，缓存 ' + d.v.length + ' 字符');
            }
          } else if (isResponseType(type)) {
            emitResponse(d.v);
          } else if (isThinkType(type)) {
            thinkContent += d.v;
          } else if (process.env.SSE_THINK_FALLBACK === '1') {
            if (process.env.DEBUG_SSE) {
              console.log('[SSE诊断] 未知 fragment 类型，SSE_THINK_FALLBACK=1 开启，按正文输出，type=' +
                JSON.stringify(type) + ', delta长度=' + d.v.length);
            }
            emitResponse(d.v);
          } else {
            if (process.env.DEBUG_SSE) {
              console.log('[SSE诊断] 未知 fragment 类型，按 THINK 处理（不输出正文），type=' +
                JSON.stringify(type) + ', delta长度=' + d.v.length +
                '（若确为正文，请把类型名补进 isResponseType）');
            }
            thinkContent += d.v;
          }
          continue;
        }

        // ⑥ FINISHED
        if (actualPath === 'response/status' && d.v === 'FINISHED') {
          console.log('[SSE] 检测到 FINISHED 信号');
          // ★ FINISHED 前若仍有 pendingContent，按当前类型归属一次
          if (pendingContent) {
            if (process.env.DEBUG_SSE) {
              console.log('[SSE诊断] FINISHED 前仍有 pendingContent ' +
                pendingContent.length + ' 字符，类型=' + JSON.stringify(getLastType()));
            }
            flushPending();
          }
          // ★ 默认不把 THINK 当正文输出：模型只思考不回答时返回空正文，
          //   由上层 sendAndWait 走"正文为空"分支重试 / 系统提示兜底，避免 THINK 污染正文。
          //   如确需保留旧行为（THINK 兜底进正文），设环境变量 SSE_THINK_FALLBACK=1 开启。
          if (!responseContent && thinkContent) {
            if (process.env.SSE_THINK_FALLBACK === '1') {
              console.log('[SSE] 只收到 THINK，正文为空，THINK 长度:', thinkContent.length,
                '，SSE_THINK_FALLBACK=1 已开启，用 THINK 兜底输出');
              try { onResponseDelta(thinkContent); } catch (_) {}
              responseContent += thinkContent;
            } else {
              console.log('[SSE] 只收到 THINK，正文为空，THINK 长度:', thinkContent.length,
                '，默认不输出 THINK（如需兜底请设 SSE_THINK_FALLBACK=1）');
            }
          }
          onFinished();
          continue;
        }
      }
    };
  }

  async function syncActivePage() {
    if (!browser || !browser.pages) return;
    const platformHost = new URL(platform.url).host;
    const pages = browser.pages();
    for (const p of pages) {
      if (p === page || p.isClosed()) continue;
      try {
        // ★ 只切换主站域名的前台页：
        //   - 不看 editorSelector（页面加载中可能未就绪）
        //   - 但必须过滤 URL：否则用户打开无关页（广告/扩展/chrome://）并聚焦时，
        //     会被误切 → sendAndWait 每次都要走兜底遍历 + 15 秒 waitForSelector
        const url = p.url() || '';
        if (!url.includes(platformHost)) continue;
        const focused = await p.evaluate(() => document.hasFocus() && document.visibilityState === 'visible').catch(() => false);
        if (!focused) continue;
        console.log('[浏览器] 检测到前台活跃页，切换 page:', url);
        page = p;
        await ensureSSEInjected(page);
        return;
      } catch (_) {}
    }
  }

  async function sendAndWait(text, cancelState = null, onDelta = null, retryCount = 0, fullText = null) {
    console.log('\x1b[36m[DEBUG] === 发送消息 ===\x1b[0m');
    console.log('\x1b[36m[DEBUG] 内容:\x1b[0m', text.slice(0, 100));

    await syncActivePage();
    // ★ 发送前保底注入：任何页面导航（新对话、超限重置、崩溃恢复等）都会导致注入失效，
    //   这里是最后一道防线，确保本次发送一定能收到 SSE 增量。
    await ensureSSEInjected(page);

    // ★ 兜底：若当前 page 无可见输入框
    //   1) 如果当前 page 是主站域名，或正处于 about:blank / 空 URL（新标签页刚打开、页面加载中）：
    //      等当前页 editor 就绪，不切走（否则会切回旧页，导致消息发到旧页、新页模型输出无人接收）
    //      ★ 关键：about:blank 时若只判断 includes(platformHost) 会返回 false，
    //         进入情况 2 把 page 切回旧页 → 新页模型输出无人接收 → chunk=0 / 长时间等待
    //   2) 如果当前 page 是无关页面（chrome:// / devtools / 第三方域名）：遍历其他主站页兜底切换
    let editor = await findEditor();
    if (!editor) {
      const platformHost = new URL(platform.url).host;
      const editorSelector = platform.editor.split(',')[0].trim();
      const currentUrl = (page && !page.isClosed()) ? (page.url() || '') : '';

      // 判断当前 page 是否"应该等它就绪"：
      //   - 主站域名：用户在该页操作
      //   - '' / about:blank / about:xxx：新标签页加载中的过渡状态
      const shouldWaitCurrent =
        currentUrl.includes(platformHost) ||
        currentUrl === '' ||
        currentUrl.startsWith('about:');

      if (shouldWaitCurrent && page && !page.isClosed()) {
        try {
          await page.waitForSelector(editorSelector, { state: 'visible', timeout: 30000 });
          console.log('[浏览器] 当前页输入框已就绪，使用当前 page');
          editor = await findEditor();
        } catch (_) {
          console.log('[浏览器] 当前页输入框 30 秒内未就绪，尝试兜底切换');
        }
      }

      // 情况 2：当前 page 无 editor 且非主站/加载中，或等待超时 → 遍历其他主站页兜底
      if (!editor && browser && browser.pages) {
        for (const p of browser.pages()) {
          if (p === page || p.isClosed()) continue;
          try {
            const url = p.url() || '';
            if (!url.includes(platformHost)) continue;
            try {
              await p.waitForSelector(editorSelector, { state: 'visible', timeout: 15000 });
            } catch (_) {
              continue;
            }
            console.log('[浏览器] 兜底切换：切换到就绪的主站页:', url);
            page = p;
            await ensureSSEInjected(page);
            editor = await findEditor();
            if (editor) break;
          } catch (_) {}
        }
      }
    }

    if (!editor) {
      console.log('[HTTP] 错误: 未找到输入框');
      throw new Error('未找到输入框');
    }

    // ★ 在兜底逻辑确定最终 page 之后才取快照：
    //   - 若在兜底之前取，兜底切换 page 后 requestPage 会指向旧页
    //   - 导致 retryCheckTimer 的 `page !== requestPage` 永远 true → 永久失效，
    //     等待期间无法自动处理"超时重试"按钮
    //   - 且 isOverLimit 在错误的页面上检测，可能漏检超限提示
    const requestPage = page;

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
    let isFinished = false; // ★ 标记等待是否已结束（FINISHED / 超限 / DSML 泛滥都会触发）
    const finishedPromise = new Promise(resolve => {
      finishedResolve = () => { isFinished = true; resolve(); };
    });
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

    // ★ 把 delta 处理逻辑提为具名函数，方便重试时用相同逻辑重建 parser
    const onResponseDeltaImpl = (delta) => {
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
    };

    // ★ buildParser 供主流程与 retryCheckTimer 共用；重试时必须重建，
    //   否则 fragments / thinkContent / responseContent / buffer 残留会导致
    //   重试后新回复的 THINK 被当正文（或正文被当 THINK）输出
    const buildParser = () => createSSEParser(
      onResponseDeltaImpl,
      () => { finishedResolve(); },
      () => {
        limitExceeded = true;
        finishedResolve(); // 已满时无 FINISHED 信号，主动触发让等待提前结束
      }
    );

    let parser = buildParser();
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
    const seqBefore = sseRequestSeq;  // ★ 记录点击前的 completion 请求序号
    const sendBtn = await findSendButton();
    if (sendBtn) {
      console.log('\x1b[36m[DEBUG] 点击发送按钮\x1b[0m');
      await sendBtn.click();
    } else {
      console.log('\x1b[36m[DEBUG] Enter 发送\x1b[0m');
      await editor.press('Enter');
    }

    // ★ 仅在重发时（retryCount > 0）验证发送是否真正触发了 SSE，避免正常请求增加延迟
    if (retryCount > 0) {
      // 新会话后页面加载慢，3 秒可能不够；延长到 5 秒避免误判导致重复发送
      await page.waitForTimeout(5000);
      if (sseRequestSeq === seqBefore) {
        console.log('[DEBUG] 重发后 3 秒内未触发 completion 请求，消息可能未发送成功，尝试再次发送');
        try {
          const editorAfter = await findEditor();
          if (editorAfter) {
            const hasContent = await editorAfter.evaluate(el => {
              const text = el.textContent || el.value || '';
              return text.trim().length > 0;
            });
            if (hasContent) {
              // 输入框还有内容 → 发送按钮没点对，再试一次
              const btn2 = await findSendButton();
              if (btn2) {
                await btn2.click();
                console.log('[DEBUG] 已再次点击发送按钮');
              } else {
                await editorAfter.press('Enter');
                console.log('[DEBUG] 已再次按 Enter 发送');
              }
            } else {
              // 输入框已空 → 消息发出去了但没触发 SSE，可能是页面跳转导致拦截失效
              console.log('[DEBUG] 输入框已空但未触发 SSE，可能页面跳转导致拦截失效');
            }
          }
        } catch (e) {
          console.log('[DEBUG] 发送检测异常:', e.message);
        }
      }
    }

    // 检测超限提示（限制在通知/错误区域）
    // ★ try-catch：紧跟 sendBtn.click 之后，若页面正在跳转，evaluate 会抛
    //   "Execution context was destroyed"，会污染整个 sendAndWait → 500。
    //   这里视为"未检测到超限"，继续正常等待 SSE。
    const checkPage = (requestPage && !requestPage.isClosed()) ? requestPage : page;
    let isOverLimit = null;
    try {
      isOverLimit = await checkPage.evaluate(() => {
        const regex = /(over limit|超出限制|超过限制|超出).?\d+%/i;
        const containers = document.querySelectorAll('.ds-notification-container, .ds-toast, .ds-message, .ds-alert, [class*="notification"]');
        const searchRoots = containers.length > 0 ? containers : [document.body];
        for (const root of searchRoots) {
          const text = root.textContent.trim();
          if (regex.test(text)) return text;
        }
        return null;
      });
    } catch (e) {
      console.log('[HTTP] 超限检测 evaluate 失败（页面可能跳转中）:', e.message);
    }

    if (isOverLimit) {
      console.log(`\x1b[31m[ERROR] 检测到上下文超限: ${isOverLimit}\x1b[0m`);
      sseDeltaHandler = null;
      // ★ 设置超限标志并主动结束等待，让代码走到后面统一的 limitExceeded 分支，
      //   自动开新对话并用完整历史重发，避免程序卡在"每次返回系统提示"的死循环
      limitExceeded = true;
      finishedResolve();
    }

    console.log('\x1b[35m[DEBUG] 等待 SSE 回复...\x1b[0m');
    let timedOut = false;

    // 定期检测页面上的「重试」按钮（DeepSeek 提交后服务端超时会显示「超时重试」），检测到就点击并重置累积
    // ★ 检测到重试按钮后先等待 5 秒再点击：
    //   - 给服务端/模型一个自愈窗口，避免按钮刚出现就误触
    //   - 5 秒期间若收到 FINISHED / 超限 / DSML 泛滥（isFinished=true），或 page 被切换，或按钮已消失，则放弃点击
    //   - isRetryPending 锁：防止 setInterval 每 3 秒重复触发导致并发 5 秒等待 + 重复点击
    let isRetryPending = false;
    const retryCheckTimer = setInterval(async () => {
      if (isRetryPending) return;
      try {
        if (page !== requestPage) return;
        const retryBtn = await detectRetryButton();
        if (!retryBtn) return;

        isRetryPending = true;
        console.log('[DEBUG] 等待中检测到重试按钮，5 秒后自动点击并重置累积...');
        await new Promise(r => setTimeout(r, 5000));

        // 5 秒后二次确认：等待已结束 / page 被切换 / 按钮已消失 → 放弃点击
        if (isFinished) {
          console.log('[DEBUG] 5 秒等待期间请求已完成，取消点击重试');
          return;
        }
        if (page !== requestPage) {
          console.log('[DEBUG] 5 秒等待期间 page 已切换，取消点击重试');
          return;
        }
        const retryBtnAgain = await detectRetryButton();
        if (!retryBtnAgain) {
          console.log('[DEBUG] 5 秒等待后重试按钮已消失，取消点击');
          return;
        }

        await retryBtnAgain.click();
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
        // ★ 必须重建 parser：清空 fragments / thinkContent / responseContent / buffer，
        //   否则上一轮残留的 fragment 类型会让新一轮的 THINK 被当正文输出
        parser = buildParser();
      } catch (e) {
        // 忽略
      } finally {
        isRetryPending = false;
      }
    }, 3000);

    await Promise.race([
      finishedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), 5 * 60 * 1000))
    ]).catch(e => {
      console.log('[DEBUG] SSE 等待异常:', e.message);
      timedOut = true;
    });

    // ★ 超时也视为"等待结束"：阻止 retryCheckTimer 的 5 秒等待中的回调在超时后继续点击，
    //   否则会出现"主流程已超时返回/进入重试，retryCheckTimer 的 5 秒等待结束时又点一次"的重复触发。
    if (timedOut) isFinished = true;

    clearInterval(retryCheckTimer);

    // ★ 流结束（正常 FINISHED 或超时）后，flush 剩余缓冲内容
    //   修复：模型正文以 "<" 等工具标签前缀结尾时，这部分被 isToolTagPrefix 缓冲，
    //   onDelta 从未输出，导致流式/非流式返回的文本尾部被截断。
    //
    //   ★ 仅在未触发 limitExceeded / DSML 泛滥时执行：
    //     这两个分支会开新对话重发，若此时 flush 输出，客户端会收到重复内容。
    //   ★ 尾部若包含完整工具块 + 后续正文（扫描逻辑因停滞 break），
    //     提取最后一个工具块结束标记之后的正文输出，避免整段丢弃。
    if (!limitExceeded && dsmlFloodCount <= DSML_FLOOD_LIMIT) {
      sseDeltaHandler = null;
      if (outputLen < fullContent.length && onDelta) {
        const remaining = fullContent.slice(outputLen);
        const N2 = '(?:DSML|[^a-zA-Z0-9_/>])*';
        const cleanTail = (s) => s
          .replace(new RegExp('</?' + N2 + '(?:invoke|parameter|calls)(?=[\\s>])[^>]*>', 'gi'), '')
          // ★ 畸形空标签（覆盖所有 Unicode 竖线变体，保留中文/日文/韩文字母）
          .replace(/<\/?[^\p{L}\p{N}\s!\/][^>]*>/gu, '')
          .replace(/DSML/gi, '');

        let textToEmit = '';
        if (inToolBlock || isToolTagPrefix(remaining)) {
          // 尾部以工具块/工具标签开头：找到最后一个工具标签闭合标记，提取之后的正文
          const endRe = new RegExp('</' + N2 + '(?:calls|invoke|parameter)(?=[\\s>])[^>]*>', 'gi');
          let lastEnd = -1;
          let m;
          while ((m = endRe.exec(remaining)) !== null) lastEnd = m.index + m[0].length;
          if (lastEnd > 0) {
            textToEmit = cleanTail(remaining.slice(lastEnd));
          }
          if (!textToEmit) {
            console.log('[SSE] 尾部缓冲为未完成的工具标签，丢弃:', JSON.stringify(remaining.slice(0, 60)));
          }
        } else {
          // 普通文本：清洗工具标签后输出
          textToEmit = cleanTail(remaining);
        }
        if (textToEmit) {
          try { onDelta(textToEmit); } catch (e) {}
          console.log('[SSE] flush 尾部缓冲内容，长度:', textToEmit.length);
        }
        outputLen = fullContent.length;
      }
    } else {
      // limitExceeded 或 DSML 泛滥：不 flush，避免与重发内容重复
      sseDeltaHandler = null;
    }

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
      const handled = await detectAndHandleLimit();
      if (!handled) {
        console.log('[新对话] detectAndHandleLimit 未成功，回退到 startNewChatIfPossible');
        await startNewChatIfPossible();
      }
      if (retryCount < 1) {
        // ★ 新会话重发：用完整历史（fullText），客户端已压缩过历史，不会超限。
        //   旧会话里 prompt 本身就很短（只发 system + 当前 user），新会话里用完整历史
        //   让模型看到之前的对话上下文，能正常复现任务。
        const retryText = fullText || text;
        console.log(`[新对话] 已开新对话，重新发送消息...（prompt ${retryText.length} 字符，${fullText ? '完整历史' : '原 prompt'}）`);
        await new Promise(r => setTimeout(r, 10000));
        return sendAndWait(retryText, cancelState, onDelta, retryCount + 1, fullText);
      }
      console.log('[新对话] 重试次数已用尽，返回 null');
      return null;
    }

    // ★ 超时也返回已收到的内容：超长文本超时不该"全丢"
    //   - 正常完成：返回完整内容
    //   - 超时但有部分内容：返回已收到的部分（标记日志，客户端能拿到大部分）
    //   - 完全空：才走重试
    if (fullContent) {
      sseDeltaHandler = null;
      if (timedOut) {
        console.log(`\x1b[33m[DEBUG] SSE 超时但已收到 ${fullContent.length} 字符，返回已收到的部分\x1b[0m`);
      } else {
        console.log('\x1b[32m[DEBUG] === 收到回复 ===\x1b[0m');
        console.log('\x1b[32m[DEBUG] 长度:\x1b[0m', fullContent.length);
        console.log('\x1b[32m[DEBUG] 前 200 字符:\x1b[0m', fullContent.slice(0, 200));
      }
      return fullContent;
    } else {
      // 超时 或 正文为空
      if (!timedOut) {
        // FINISHED 但正文为空：先保持监听等待几秒，看是否有后续 completion 请求带正文到来（深度思考可能分多请求输出）
        console.log('[DEBUG] FINISHED 但正文为空，等待后续请求 5 秒...');
        // ★ 用 setTimeout 而非 page.waitForTimeout：page 已关闭时后者会抛 Target closed
        await new Promise(r => setTimeout(r, 5000));
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
          console.log('[DEBUG] 检测到重试按钮，5 秒后点击重新生成...');
          // ★ 检测到重试按钮后先等待 5 秒，给服务端一个自愈窗口
          await new Promise(r => setTimeout(r, 5000));
          // 5 秒后二次确认：page 未被切换 + 按钮仍然存在（可能服务端已自愈、按钮消失）
          if (page !== requestPage) {
            console.log('[DEBUG] 5 秒等待期间 page 已切换，取消点击');
            return null;
          }
          const retryBtnAgain = await detectRetryButton();
          if (!retryBtnAgain) {
            console.log('[DEBUG] 5 秒等待后重试按钮已消失，取消点击');
            return null;
          }
          let finishedResolve2;
          const finishedPromise2 = new Promise(resolve => { finishedResolve2 = resolve; });
          let fullContent2 = '';
          const parser2 = createSSEParser(
            (delta) => { fullContent2 += delta; if (onDelta) { try { onDelta(delta); } catch (e) {} } },
            () => { finishedResolve2(); },
            // ★ 重试也需监听超限信号：否则 onLimitExceeded 为 undefined 时抛错被吞，
            //   finishedPromise2 永远 pending，直到 5 分钟超时。
            () => { 
              limitExceeded = true; // ★ 补齐：重试时也要把超限信号传回主流程
              finishedResolve2(); 
            }
          );
          sseDeltaHandler = (chunk) => { try { parser2(chunk); } catch (e) {} };
          await retryBtnAgain.click();
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
          await new Promise(r => setTimeout(r, 10000));
          return sendAndWait(text, cancelState, onDelta, retryCount + 1, fullText);
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

        /**
     * ★ 标签配对性严格校验：在容错解析之前先做。
     * 检测"非成双成对/畸形"的工具调用标签，直接报告错误要求模型重写，
     * 避免容错解析产生"看似成功但参数缺失"的半成品。
     * @returns {{valid: boolean, errors?: string[]}}
     */
    function validateTagPairing(text) {
      if (!text) return { valid: true };

      // 与 parseToolCall 同样的噪声清洗
      let cleaned = text
        .replace(/[​‌‍⁠﻿]/g, '')
        .replace(/&(?:zwnj|zwj|lrm|rlm);/gi, '')
        .replace(/<z(?:wnj|wj)/gi, '<');
      const TAG_NOISE = '(?:DSML|[^a-zA-Z0-9_/>])*';
      cleaned = cleaned.replace(
        new RegExp('(<\\/?)' + TAG_NOISE + '(calls|invoke|parameter)(?=[\\s>])', 'gi'),
        '$1$2'
      );
      cleaned = cleaned.replace(/DSML/gi, '');

      // 快速判断：不含工具调用标签则跳过检查
      if (!/<\/?(?:calls|invoke|parameter)(?=[\s>])/i.test(cleaned)) {
        return { valid: true };
      }
      
      const errors = [];

      // ★ 抠掉 CDATA 内容，避免其中的 </parameter foo>、<parameter ...> 等字面量被误判为畸形标签。
      //   用等长空格替换（保持字符串长度与索引对齐，便于日志排查）。
      //   仅 ① ② 使用这个"干净版"字符串；③ 栈式嵌套检查仍用 cleaned（它自身会跳过 CDATA）。
      const cleanedNoCDATA = cleaned.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => ' '.repeat(m.length));

      // ① 闭合标签携带多余内容（粘连畸形：</parameter name="path">、</parameter foo> 等）
      //    正规闭合标签必须严格是 </parameter> / </invoke> / </calls>
      const malformedCloseRe = /<\/(calls|invoke|parameter)(\s+[^>]*)?>/gi;
      let mc;
      while ((mc = malformedCloseRe.exec(cleanedNoCDATA)) !== null) {
        const full = mc[0];
        const inner = mc[2] || '';
        // 严格判断：标签名后不应有任何字符（包括空白），除紧跟 > 外
        if (inner.length > 0) {
          errors.push(`闭合标签携带了多余内容（畸形写法）：${full} —— 闭合标签必须严格写成 </${mc[1]}>，标签名后不得有任何字符`);
        }
      }

      // ② 全局开闭数量核对（用 cleanedNoCDATA，排除 CDATA 内的字面量干扰）
      const countTag = (tag, isClose) =>
        (cleanedNoCDATA.match(new RegExp('<' + (isClose ? '\\/' : '') + tag + '(?=[\\s>])', 'gi')) || []).length;

      const pairs = [
        ['calls', countTag('calls', false), countTag('calls', true)],
        ['invoke', countTag('invoke', false), countTag('invoke', true)],
        ['parameter', countTag('parameter', false), countTag('parameter', true)],
      ];
      for (const [name, open, close] of pairs) {
        if (open !== close) {
          errors.push(`<${name}> 开闭标签数量不匹配：开 ${open} 个，闭 ${close} 个`);
        }
      }

      // ③ 栈式嵌套顺序检查（跳过 CDATA 内容）
      //    规则：calls 只能含 invoke；invoke 只能含 parameter；parameter 不嵌套工具标签
      const allowedChild = {
        calls: ['invoke'],
        invoke: ['parameter'],
        parameter: [],
      };
      const stack = [];
      let i = 0;
      while (i < cleaned.length) {
        // 跳过 CDATA
        if (cleaned.startsWith('<![CDATA[', i)) {
          const end = cleaned.indexOf(']]>', i);
          if (end === -1) {
            // ★ CDATA 未闭合：直接报告具体原因，让模型补上 ]]> 重写。
            //   不 break：继续扫描后面的闭合标签（</parameter>/</invoke>/</calls>），
            //   避免因提前退出导致 stack 残留，误报"存在未闭合的标签"（掩盖真实原因）。
            errors.push(
              `参数值中的 <![CDATA[ 未闭合：缺少对应的 ]]> 结束标记。` +
              `CDATA 必须以 <![CDATA[ 开头、以 ]]> 结尾，请检查参数值并在末尾补上 ]]>。`
            );
            i += 9; // '<![CDATA['.length === 9
            continue;
          }
          i = end + 3;
          continue;
        }
        const tagMatch = cleaned.slice(i).match(/^<(\/?)(calls|invoke|parameter)(?=[\s>])[^>]*>/i);
        if (tagMatch) {
          const isClose = tagMatch[1] === '/';
          const name = tagMatch[2].toLowerCase();
          if (!isClose) {
            if (stack.length > 0) {
              const parent = stack[stack.length - 1];
              if (!allowedChild[parent].includes(name)) {
                errors.push(`标签嵌套顺序错误：<${name}> 不能直接出现在 <${parent}> 内`);
              }
            }
            stack.push(name);
          } else {
            if (stack.length === 0) {
              errors.push(`多余的闭合标签：</${name}>，缺少对应的开标签`);
            } else {
              const top = stack.pop();
              if (top !== name) {
                errors.push(`闭合标签不匹配：期望 </${top}>，实际是 </${name}>`);
              }
            }
          }
          i += tagMatch[0].length;
          continue;
        }
        i++;
      }
      if (stack.length > 0) {
        errors.push(`存在未闭合的标签：${stack.map(t => '<' + t + '>').join(', ')}`);
      }

      // ④ 严格格式校验：所有"含工具标签关键字"的 <...> 片段必须严格符合以下形式之一：
      //      <calls>            <calls 任意属性>
      //      <invoke ...>       <parameter ...>
      //      </calls>           </invoke>           </parameter>
      //    任何其他形式（含属性乱序、闭标签带属性、跨标签粘连、多出字符等）
      //    一律报错，不做猜测性修复，让模型重新生成。
      //    只检查"含 calls/invoke/parameter 关键字"的片段，避免误伤正文里的 <div> / <T> / <https://...>。
      const strictTagRe = /^(?:<(?:calls|invoke|parameter)(?:\s[^>]*)?>|<\/(?:calls|invoke|parameter)>)$/;
      let ltPos = -1;
      const bogusTags = [];
      while ((ltPos = cleanedNoCDATA.indexOf('<', ltPos + 1)) !== -1) {
        const rest = cleanedNoCDATA.slice(ltPos);
        // 跳过注释/CDATA（双保险）
        if (rest.startsWith('<!--') || rest.startsWith('<![CDATA[')) continue;

        const gt = rest.indexOf('>');
        // ★ 提取完整"标签样"片段：从 < 到第一个 >，不管中间有多少个 <
        //   这样才能捕获 </... </parameter> 这种"多余的 < 后紧跟关键字"的畸形。
        //   如果直接截到下一个 <，前半段 </... 会因不含关键字被跳过，漏检。
        let frag;
        if (gt === -1) {
          // 到结尾都没有 > → 也算异常片段（截前 200 字符用于展示）
          frag = rest.slice(0, Math.min(rest.length, 200)).trim();
        } else {
          frag = rest.slice(0, gt + 1);
        }
        // 不含工具关键字 → 视为正文里的普通 <，跳过
        // ★ 跳噪声的方式必须与清洗正则一致（`(?:DSML|[^a-zA-Z0-9_>])*`）：
        //    否则 `</｜｜DSML｜｜ </parameter>` 会被 `[^a-zA-Z]*` 卡在 DSML 的 D 上，
        //    导致 afterNoise 变成 `DSML｜｜ </parameter>` 而不以 parameter 开头 → 漏检。
        const afterNoise = frag.replace(/^<\/?(?:DSML|[^a-zA-Z0-9_>])*/i, '');
        if (!/^(?:calls|invoke|parameter)\b/i.test(afterNoise)) continue;
        // 含工具关键字 → 必须严格合法，否则收集报错
        if (!strictTagRe.test(frag)) {
          bogusTags.push(frag.slice(0, 120));
        }
      }
      if (bogusTags.length > 0) {
        const sample = bogusTags.slice(0, 3).join(' / ');
        errors.push(
          `发现不符合规范的标签片段：${sample}\n` +
          `  工具标签只允许以下严格形式：\n` +
          `    <calls>  <invoke name="函数名">  <parameter name="参数名">值</parameter>  </invoke>  </calls>\n` +
          `  禁止以下写法：\n` +
          `    - 闭合标签携带属性（如 </parameter name="x">）\n` +
          `    - 属性写在标签名前（如 <... filePath="x" ... parameter>）\n` +
          `    - 标签名前插入任何非 < 或 </ 开头的字符\n` +
          `    - 闭合标签和下一个开标签粘连\n` +
          `    - 标签名后跟除空格或 > 之外的字符\n` +
          `  请重新输出完整的工具调用，每个标签必须独立、严格、干净。`
        );
      }

      if (errors.length > 0) return { valid: false, errors };
      return { valid: true };
    }

    /**
     * ★ 参数语义校验：根据工具声明的 JSON Schema，检查参数是否齐全、类型正确、值合法。
     * 只覆盖最常见的几类错误：required / type / enum / additionalProperties。
     * @returns {{valid: boolean, error?: string}}
     */
    function validateArgsAgainstSchema(fnName, args, schema) {
      if (!schema || typeof schema !== 'object') return { valid: true };

      const errors = [];

      // ① required 检查
      const required = Array.isArray(schema.required) ? schema.required : [];
      const missing = required.filter(k => !(k in args));
      if (missing.length > 0) {
        errors.push(`缺少必需参数：${missing.join(', ')}`);
      }

      // ② type / enum / 额外属性检查
      const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
      const propKeys = Object.keys(props);

      for (const [k, v] of Object.entries(args)) {
        const prop = props[k];
        if (!prop) {
          // additionalProperties !== false 时允许未知参数，这里静默放行
          if (schema.additionalProperties === false) {
            errors.push(`不允许多余参数 "${k}"（允许的参数：${propKeys.join(', ')}）`);
          }
          continue;
        }

        // 类型检查
        const expected = prop.type;
        if (expected) {
          const actual = Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);
          const ok =
            expected === actual ||
            (expected === 'integer' && actual === 'number' && Number.isInteger(v)) ||
            (expected === 'number' && actual === 'number');
          if (!ok) {
            errors.push(`参数 "${k}" 类型错误：期望 ${expected}，实际 ${actual}（值：${JSON.stringify(v).slice(0, 60)}）`);
          }
        }

        // enum 检查
        if (Array.isArray(prop.enum) && !prop.enum.includes(v)) {
          errors.push(`参数 "${k}" 值不在允许列表：期望 ${JSON.stringify(prop.enum)}，实际 ${JSON.stringify(v)}`);
        }
      }

      if (errors.length > 0) {
        return { valid: false, error: errors.join('；') };
      }
      return { valid: true };
    }

    // 解析模型输出中的工具调用（格式：<invoke name="函数名"><parameter name="参数名">参数值</parameter></invoke>）
    function parseToolCall(text, allowedNames = [], toolSchemas = null) {
      if (!text) return { found: false, success: false, toolCalls: [], toolCall: null };

      // ★ 严格配对检查：一旦发现非成双成对/畸形，直接报错要求模型重写，
      //   绝不做容错解析，避免产出"看似成功但参数残缺"的半成品
      //   （例如 </parameter name="path"> 会吃掉 path 的开标签，导致后续参数全部丢失）
      const pairing = validateTagPairing(text);
      if (!pairing.valid) {
        return {
          found: true,
          success: false,
          toolCalls: [],
          toolCall: null,
          error:
            '工具调用标签不是严格成双成对的，具体错误如下：\n' +
            pairing.errors.map(e => '  - ' + e).join('\n') +
            '\n请重新输出完整的工具调用：每个开标签必须有对应的闭合标签，闭合标签不得携带属性，且必须严格成对出现、不得与其他标签粘连。'
        };
      }

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
        // ★ 客户端未声明任何工具时，模型不应输出工具调用
        if (allowedNames.length === 0) {
          results.push({ success: false, error: '客户端未声明任何可用工具，禁止输出工具调用，请直接以纯文本回复' });
          continue;
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawName)) {
          results.push({ success: false, error: `无效的函数名格式 "${rawName}"，函数名只能包含字母、数字和下划线` });
          continue;
        }
        if (!allowedNames.includes(rawName)) {
          results.push({ success: false, error: `无效的函数名 "${rawName}"，允许的函数名：${allowedNames.join(', ')}` });
          continue;
        }

        // 无参数的工具调用
        if (rawBody.trim() === '') {
          // ★ 即使无参数，也要过 schema 校验（可能 required 不为空）
          const schema = toolSchemas && toolSchemas[rawName];
          const schemaCheck = validateArgsAgainstSchema(rawName, {}, schema);
          if (!schemaCheck.valid) {
            results.push({
              success: false,
              error: `函数 "${rawName}" 参数不符合 schema：${schemaCheck.error}`
            });
          } else {
            results.push({ success: true, toolCall: { name: rawName, arguments: {} } });
          }
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

          // ★ 不无差别 trim：代码类参数的首尾空白是语义的一部分
          //   - CDATA 包裹：完全保留原样（CDATA 明确表达"内容边界"）
          //   - 非 CDATA：只去掉"纯换行包裹"（首尾各一个 \n 是标签排版噪声），
          //     保留空格和缩进
          pValue = pValue.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');
          // 去掉首尾各一个换行（仅当首/尾字符就是换行时）
          if (pValue.startsWith('\n')) pValue = pValue.slice(1);
          if (pValue.endsWith('\n')) pValue = pValue.slice(0, -1);

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
          // ★ 参数语义校验（schema）
          const schema = toolSchemas && toolSchemas[rawName];
          const schemaCheck = validateArgsAgainstSchema(rawName, validArgs, schema);
          if (!schemaCheck.valid) {
            results.push({
              success: false,
              error: `函数 "${rawName}" 参数不符合 schema：${schemaCheck.error}`
            });
          } else {
            results.push({ success: true, toolCall: { name: rawName, arguments: validArgs } });
          }
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
      const N = '(?:DSML|[^a-zA-Z0-9_/>])*';
      return text
        // 1. 配对块（开/闭标签名前都允许任意噪声）
        .replace(new RegExp('<' + N + '(?:invoke|parameter|calls)\\b[^>]*>[\\s\\S]*?<\\/' + N + '(?:invoke|parameter|calls)(?=[\\s>])[^>]*>', 'gi'), '')
        // 2. 残余的孤立标签（含反斜杠变体）
        .replace(new RegExp('</?' + N + '(?:invoke|parameter|calls)(?=[\\s>])[^>]*>', 'gi'), '')
        // 3. 纯 parameter 开标签（模型漏写 invoke 包裹时）
        .replace(new RegExp('<' + N + 'parameter\\b[^>]*>', 'gi'), '')
        // ★ 4. 畸形空标签：标签名首字符不是 Unicode 字母/数字/空白/!/斜杠 的尖括号标签一律删除
        //    覆盖所有 Unicode 竖线变体（｜ U+FF5C、| U+007C、│ U+2502、︱ U+FE31、❘ U+2758 等）
        //    保留：<div>、<T>、<https://...>、<3>、<!-- -->、<![CDATA[]]>、a < b > c
        //         以及中文/日文/韩文标签：<按钮>、<输入框>、<結果>
        .replace(/<\/?[^\p{L}\p{N}\s!\/][^>]*>/gu, '')
        // 5. 清理可能残留的 DSML 字面量
        .replace(/DSML/gi, '')
        .trim();
    }

    async function getFinalReplyWithTools(promptText, fullPromptText, toolsText, instruction, toolNames, toolSchemas, cancelState, onDelta = null) {
      // ★ 追踪 onDelta 是否已经发出过任何内容
      //   如果从未发出过，最终由调用方（task()）把 rawOutput 一次性补发出去，
      //   避免客户端收到"只有 finish 没有 content"的空响应。
      let emittedContent = false;
      const trackOnDelta = onDelta ? (chunk) => {
        if (chunk && chunk.length > 0) emittedContent = true;
        try { onDelta(chunk); } catch (e) {}
      } : null;

      // ★ 判断是否为「纯工具增量」请求：
      //   特征：以【工具执行结果开头，且以 buildPromptText 在纯工具回调场景追加的结尾引导语结尾。
      //   - 用 endsWith 而非 includes 判断，避免工具返回的内容里恰好包含
      //     【系统提示】/【用户消息】字面量导致误判（例如 read 工具返回了含这些字样的文件）。
      //   - 结尾引导语只由 buildPromptText 场景 B（hasTool && !hasUser）追加，不会出现在工具内容里。
      //   - 纯工具增量 → 直接发增量，不带工具列表（省 Token）
      //   - 其他情况（首轮 / 重建 / 有新的 user 追问 / 混合 [tool, user]）→ 带上完整工具列表，
      //     防止模型忘记有哪些工具、防止新指令无法调用工具。
      const isPureToolIncrement =
        promptText.startsWith('【工具执行结果') &&
        promptText.endsWith('请基于上述工具执行结果继续回答。\n');

      let prompt = isPureToolIncrement
        ? promptText
        : `【可用工具】\n${toolsText}${instruction}\n\n${promptText}`;

      // ★ 新会话完整版本（limitExceeded 重发时用），必须始终携带完整的工具说明
      let fullPrompt = `【可用工具】\n${toolsText}${instruction}\n\n${fullPromptText}`;
      await new Promise(r => setTimeout(r, 10000));
      let reply = await sendAndWait(prompt, cancelState, trackOnDelta, 0, fullPrompt);
      let rawOutput = (reply && reply.trim()) || '【系统提示】DeepSeek 未返回有效回复。';
      console.log('[HTTP] 首次输出:', rawOutput.slice(0, 150));

      let parseResult = parseToolCall(rawOutput, toolNames, toolSchemas);

      // 无论是否声明了工具，只要回复中包含了工具调用标签，就尝试解析或纠正
      if (parseResult.found) {
        // ★ 有上限的纠正循环（最多 2 次），并带 DSML 泛滥 / 重复输出检测
        let correctionAttempts = 0;
        const MAX_CORRECTIONS = 30;
        let prevOutput = '';
        let repeatedCount = 0;

        while (correctionAttempts < MAX_CORRECTIONS) {
          correctionAttempts++;

          if (cancelState && cancelState.cancelled) {
            console.log('[ToolCall] 任务已取消，停止工具纠错');
            return { toolCall: null, toolCalls: [], rawOutput: rawOutput || '', assistantContent: null,emittedContent };
          }

          if (parseResult.success) {
            const textContent = stripDsmlTags(rawOutput)
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            return {
              toolCall: parseResult.toolCall,
              toolCalls: parseResult.toolCalls,
              rawOutput,
              assistantContent: cleanTaskCompletedMark(textContent) || null,
              emittedContent   // ★ 加这一行
            };
          }

          // ★ 检测 DSML 标签泛滥
          const dsmlCount = (rawOutput.match(/<\/?[｜|\s]*DSML/gi) || []).length;
          if (dsmlCount > 100) {
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

          // ★ 极简版：只发错误位置，不发任何示例/规则
          const retryPrompt =
            `【工具调用格式错误】\n` +
            `错误详情：\n${parseResult.error}\n\n` +
            `请重新输出完整的工具调用。`;

          // ★ 发送纠正提示前先等 10 秒：
          //   - 给页面一个渲染/输入框恢复的缓冲窗口，避免上一轮刚结束就立刻输入
          //   - 用 setTimeout 而非 page.waitForTimeout：page 已关闭时后者会抛 Target closed
          console.log(`[ToolCall] 等待 10 秒后发送纠正提示... (${correctionAttempts}/${MAX_CORRECTIONS})`);
          await new Promise(r => setTimeout(r, 10000));

          reply = await sendAndWait(retryPrompt, cancelState, trackOnDelta);
          if (reply && reply.trim()) {
            rawOutput = reply.trim();
          } else {
            console.log('[ToolCall] 纠正请求未获得有效回复，放弃纠正');
            break;
          }
          console.log('[HTTP] 纠正后输出:', rawOutput.slice(0, 200));

          parseResult = parseToolCall(rawOutput, toolNames, toolSchemas);
          if (!parseResult.found) {
            console.log('[ToolCall] 模型仍未输出工具调用，将其视为最终回复');
            let finalText = rawOutput
              .replace(/专家模式暂不支持搜索，请使用快速模式/g, '')
              .trim();
            const cleaned = cleanTaskCompletedMark(stripDsmlTags(finalText));
            return { toolCall: null, toolCalls: [], rawOutput: cleaned || stripDsmlTags(rawOutput), assistantContent: null,emittedContent };
          }
        }

        // ★ 达到最大纠正次数 / 检测到泛滥：降级为普通文本返回，避免死循环
        console.log('[ToolCall] 纠正失败，降级为普通文本返回');
        const fallbackText = cleanTaskCompletedMark(stripDsmlTags(rawOutput))
          || '【系统提示】工具调用格式持续错误，请重试或换一种表达方式。';
        return { toolCall: null, toolCalls: [], rawOutput: fallbackText, assistantContent: null,emittedContent };
      } else {
        let cleanText = rawOutput
          .replace(/专家模式暂不支持搜索，请使用快速模式/g, '')
          .trim();
        const cleaned = cleanTaskCompletedMark(stripDsmlTags(cleanText));
        return { toolCall: null, toolCalls: [], rawOutput: cleaned || stripDsmlTags(rawOutput), assistantContent: null,emittedContent };
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
            // ★ 构建 name → schema 的映射，用于参数语义校验
            const toolSchemas = {};
            for (const t of tools) {
              if (t && t.function && t.function.name) {
                toolSchemas[t.function.name] = t.function.parameters || null;
              }
            }

            console.log('[HTTP] 可用工具:', toolNames.join(', '));
            if (!userMsg) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: 'No message content', type: 'invalid_request_error' } }));
              return;
            }

            const historyNoise = /^(复制|下载|运行|调试|代码)$/;

            // ★ 构建两个版本的 prompt：
            //   - promptText（默认，旧会话用）：只发 system + 当前 user，不发任何历史。
            //     依赖 DeepSeek 会话自身的服务端上下文，避免"prompt 历史 + 服务端上下文"双重累积导致超限。
            //   - fullPromptText（新会话用）：完整历史，切换新对话后重发时使用。
            //     客户端会自己压缩历史，新会话本身没超限过，所以直接用客户端给的完整 messages。
            function buildPromptText(includeFullHistory) {
              let text = "";

              if (!includeFullHistory) {
                // 1. 找到最后一条 assistant 的索引（代表上一次模型的输出/工具调用指令）
                let lastAssistantIdx = -1;
                for (let i = messages.length - 1; i >= 0; i--) {
                  if (messages[i].role === 'assistant') {
                    lastAssistantIdx = i;
                    break;
                  }
                }

                // 2. 从最后一条 assistant 之后提取所有的增量内容（可能有 tool 结果，也可能有新的 user 消息）
                const incrementalMsgs = [];
                for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
                  incrementalMsgs.push(messages[i]);
                }

                // 3. 判断是否有实际的增量输入
                const hasTool = incrementalMsgs.some(m => m.role === 'tool');
                const hasUser = incrementalMsgs.some(m => m.role === 'user');

                if (lastAssistantIdx === -1) {
                  // 场景 A：服务端无历史（第一轮对话）。直接发 system + user，保持纯净
                  for (const msg of messages) {
                    if (msg.role === 'system') {
                      const rawContent = extractTextContent(msg.content);
                      text += `【系统提示】\n${rawContent}`;
                    }
                  }
                  if (userMsg) {
                    text += `【用户消息】\n${userMsg}`;
                  }
                } else if (hasTool || hasUser) {
                  // 场景 B：多轮对话包含工具回调或新提示。只发增量部分
                  for (const msg of incrementalMsgs) {
                    if (msg.role === 'tool') {
                      const content = extractTextContent(msg.content);
                      const toolName = msg.name ? `[${msg.name}]` : '';
                      text += `【工具执行结果 ${toolName}】\n${content}\n\n`;
                    } else if (msg.role === 'user') {
                      const content = extractTextContent(msg.content);
                      text += `【用户消息】\n${content}\n\n`;
                    }
                  }
                  // ★ 只有"纯工具回调"（有 tool 但没有新 user）才标记为增量，节省 Token。
                  //   如果同时有新的用户消息，用户很可能想基于结果继续使用工具（比如换个参数再试），
                  //   此时不加提示语，让 getFinalReplyWithTools 带上完整的工具列表，避免模型"忘记"工具有哪些。
                  if (hasTool && !hasUser) {
                    text += `请基于上述工具执行结果继续回答。\n`;
                  }
                } else {
                  // 场景 C：兜底
                  for (const msg of messages) {
                    if (msg.role === 'system') {
                      const rawContent = extractTextContent(msg.content);
                      text += `【系统提示】\n${rawContent}`;
                    }
                  }
                  if (userMsg) {
                    text += `【用户消息】\n${userMsg}`;
                  }
                }

                return text;
              }

              // ★ 新会话逻辑（切换新聊天窗口 / 超限）：全部发送所有历史
              for (const msg of messages) {
                let rawContent = extractTextContent(msg.content);
                if (msg.role === 'assistant') {
                  rawContent = rawContent
                    .split('\n')
                    .filter(line => !historyNoise.test(line.trim()))
                    .join('\n');
                }
                if (msg.role === 'system') {
                  text += `【系统提示】\n${rawContent}`;
                } else if (msg.role === 'user') {
                  text += `【用户消息】\n${rawContent}`;
                } else if (msg.role === 'assistant') {
                  text += `【模型回复】\n${rawContent}`;
                } else if (msg.role === 'tool') {
                  const toolName = msg.name ? `[${msg.name}]` : '';
                  text += `【工具信息 ${toolName}】\n${rawContent}`;
                }
              }
              return text;
            }

            const promptText = buildPromptText(false);   // 旧会话用：极简
            const fullPromptText = buildPromptText(true); // 新会话用：完整历史

            // ★ 程序启动后第一次请求：服务端上下文为空，必须用完整历史建立上下文
            //   之后依赖服务端上下文，用 promptText（system + 最新 user）
            let actualPromptText = promptText;
            if (isFirstRequestAfterStart) {
              isFirstRequestAfterStart = false;
              // 只有 messages 里有实质历史（> system + 1 user）时才需要切换
              // 新任务场景（只有 system + 1 user）两者等价，无需特别处理
              if (messages.length > 2) {
                console.log('[启动] 首次请求检测到历史消息，使用完整历史 prompt 建立上下文');
                actualPromptText = fullPromptText;
              }
            }
            console.log(`[HTTP] prompt 模式：${actualPromptText === fullPromptText ? '完整历史' : '旧会话极简'} ${actualPromptText.length} 字符 / 完整版 ${fullPromptText.length} 字符`);

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
    `- 闭合标签必须使用正斜杠：</｜｜DSML｜｜ parameter>，禁止写成 <\｜｜DSML｜｜ parameter>。\n` +
    `- ❌ 禁止把闭合标签和下一个开标签合并输出，例如禁止写成：\n` +
    `    </｜｜DSML｜｜ parameter name="path">E:\\...\n` +
    `  ✅ 必须严格写成两个独立标签：\n` +
    `    </｜｜DSML｜｜ parameter>\n` +
    `    <｜｜DSML｜｜ parameter name="path">E:\\...\n` +
    `  （每个参数的开标签、值、闭合标签必须各自成对，不得跨参数合并）\n`
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
              // ★ 判断字符串是否是（不完整的）工具标签前缀，与 sendAndWait 中的逻辑一致
              const isToolTagPrefixStr = (s) => {
                if (!s || s[0] !== '<') return false;
                let idx = 1;
                if (s[idx] === '/') idx++;
                while (idx < s.length) {
                  if (s.startsWith('DSML', idx)) { idx += 4; continue; }
                  if (!/[a-zA-Z0-9_/>]/.test(s[idx])) { idx++; continue; }
                  const remain = s.slice(idx);
                  if (remain.length <= 4 && 'DSML'.startsWith(remain)) return true;
                  break;
                }
                if (idx >= s.length) return true;
                const tailStr = s.slice(idx);
                for (const tag of ['calls', 'invoke', 'parameter']) {
                  if (tailStr.length <= tag.length) {
                    if (tag.slice(0, tailStr.length) === tailStr) return true;
                  } else if (tailStr.startsWith(tag)) {
                    const next = tailStr[tag.length];
                    if (!/[a-zA-Z0-9_]/.test(next)) return true;
                  }
                }
                return false;
              };
              const flushStream = (force = false) => {
                if (responseEnded || !res.writable || !streamBuf) return;
                // 尾部若存在未闭合的 '<'，从"最靠前的那个未闭合 '<'"开始暂存，
                // 避免多个未闭合标签时前面的半截被误 emit
                const gtIdx = streamBuf.lastIndexOf('>');
                const tail = streamBuf.slice(gtIdx + 1);
                const firstLtInTail = tail.indexOf('<');
                let toEmit;
                if (firstLtInTail !== -1) {
                  const cutIdx = gtIdx + 1 + firstLtInTail;
                  toEmit = streamBuf.slice(0, cutIdx);
                  const rest = streamBuf.slice(cutIdx);
                  if (force) {
                    // ★ 修复：force 时按 rest 的形态分类处理，避免误删正文：
                    //   - rest 以完整工具标签开头（如 </calls>后续正文）：提取最后一个闭合标签之后的正文保留
                    //   - rest 是未完成的工具标签前缀（如 <c、<inv、</par 等）：丢弃
                    //   - rest 是普通文本（如 "a < b" 中的 "< b"）：保留
                    if (rest) {
                      const N2 = '(?:DSML|[^a-zA-Z0-9_/>])*';
                      const tagAtStart = rest.match(new RegExp('^</?' + N2 + '(?:invoke|parameter|calls)(?=[\\s>])[^>]*>', 'i'));
                      if (tagAtStart) {
                        // rest 以完整工具标签开头：找最后一个闭合标签，提取之后的正文
                        const closeRe = new RegExp('</' + N2 + '(?:calls|invoke|parameter)(?=[\\s>])[^>]*>', 'gi');
                        let lastClose = -1;
                        let cm;
                        while ((cm = closeRe.exec(rest)) !== null) lastClose = cm.index + cm[0].length;
                        let cleanedRest = '';
                        if (lastClose >= 0) {
                          cleanedRest = rest.slice(lastClose)
                            .replace(new RegExp('</?' + N2 + '(?:invoke|parameter|calls)(?=[\\s>])[^>]*>', 'gi'), '')
                            .replace(/DSML/gi, '');
                        }
                        if (cleanedRest && isToolTagPrefixStr(cleanedRest)) {
                          console.log('[HTTP] 流结束时丢弃未完成的工具标签前缀:', JSON.stringify(cleanedRest.slice(0, 60)));
                          cleanedRest = '';
                        }
                        if (cleanedRest) toEmit += cleanedRest;
                        else console.log('[HTTP] 流结束时丢弃未完成的工具标签块:', JSON.stringify(rest.slice(0, 60)));
                      } else if (isToolTagPrefixStr(rest)) {
                        console.log('[HTTP] 流结束时丢弃未完成的工具标签前缀:', JSON.stringify(rest.slice(0, 60)));
                      } else {
                        // 普通文本，保留
                        toEmit += rest;
                      }
                    }
                    streamBuf = '';
                  } else {
                    streamBuf = rest;
                  }
                } else {
                  toEmit = streamBuf;
                  streamBuf = '';
                }
                // 只剥离工具调用相关标签（含噪声前缀变体），避免误伤正文里的 HTML
                const N = '(?:DSML|[^a-zA-Z0-9_/>])*';
                const cleaned = toEmit
                  .replace(new RegExp('</?' + N + '(?:invoke|parameter|calls)(?=[\\s>])[^>]*>', 'gi'), '')
                  // ★ 畸形空标签（覆盖所有 Unicode 竖线变体，保留中文/日文/韩文字母）
                  .replace(/<\/?[^\p{L}\p{N}\s!\/][^>]*>/gu, '')
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
              // ★ 与 getFinalReplyWithTools 中保持一致的「纯工具增量」判断：
              //   用 endsWith 替代 includes，避免工具返回内容里恰好包含
              //   【系统提示】/【用户消息】字面量导致误判。
              const isPureToolIncrementStream =
                actualPromptText.startsWith('【工具执行结果') &&
                actualPromptText.endsWith('请基于上述工具执行结果继续回答。\n');

              const streamPrompt = isPureToolIncrementStream
                ? actualPromptText
                : `【可用工具】\n无\n\n${actualPromptText}`;
              const streamFullPrompt = `【可用工具】\n无\n\n${fullPromptText}`;
              await new Promise(r => setTimeout(r, 10000));
              await sendAndWait(streamPrompt, cancelState, streamCtx.onDelta, 0, streamFullPrompt);
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

            const { toolCall, toolCalls, rawOutput, assistantContent, emittedContent } = await getFinalReplyWithTools(
              actualPromptText, fullPromptText, toolsText, toolCallInstructions, toolNames, toolSchemas, cancelState,
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

                  // ★ 分块发送 arguments（每块 200 字符，每块间隔 5ms）
                  //   逐字符 × 5ms 对 50KB 参数要 250 秒，客户端会超时
                  //   分块后：50KB / 200 × 5ms = 1.25 秒
                  const ARGS_CHUNK = 200;
                  for (let i = 0; i < argsStr.length; i += ARGS_CHUNK) {
                    if (!alive()) break;
                    const chunk = argsStr.slice(i, i + ARGS_CHUNK);
                    res.write(`data: ${JSON.stringify({
                      id: chunkId, object: 'chat.completion.chunk', created, model,
                      choices: [{ index: 0, delta: { tool_calls: [{ index: tcIdx, function: { arguments: chunk } }] }, finish_reason: null }]
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
                // ★ 无工具调用（纯文本）：
                //   如果 onDelta 从未发出过内容（比如走了纠正循环、降级返回），
                //   这里把 rawOutput 一次性补发，避免客户端收到空响应。
                if (alive() && !emittedContent && rawOutput) {
                  res.write(`data: ${JSON.stringify({
                    id: chunkId, object: 'chat.completion.chunk', created, model,
                    choices: [{ index: 0, delta: { content: rawOutput }, finish_reason: null }]
                  })}\n\n`);
                }
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
      await new Promise(r => setTimeout(r, 10000));
      const reply = await sendAndWait(text);
      process.stdout.write('\x1b[1A\x1b[K');
      if (reply) {
        // ★ 控制台也清理畸形工具标签（stripDsmlTags 定义在 createServer 内部，此处内联等价逻辑）
        const N = '(?:DSML|[^a-zA-Z0-9_/>])*';
        const displayReply = reply
          .replace(new RegExp('</?' + N + '(?:invoke|parameter|calls)(?=[\\s>])[^>]*>', 'gi'), '')
          .replace(/<\/?[^\p{L}\p{N}\s!\/][^>]*>/gu, '')
          .replace(/DSML/gi, '')
          .trim();
        console.log(`[${platform.name}]:`, displayReply || reply, '\n');
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