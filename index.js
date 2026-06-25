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
  async function waitForReply(timeout = 1200000) {
    const startTime = Date.now();
    console.log('\x1b[35m[DEBUG] 等待最新 AI 回复完成...\x1b[0m');

    try {
      // 等待最后一个消息项同时具备 AI 回复内容 和 操作栏(完成标志)
      await page.waitForFunction(
        () => {
          const items = document.querySelectorAll('[data-virtual-list-item-key]');
          if (!items.length) return false;
          const last = items[items.length - 1];
          return last.querySelector('.ds-assistant-message-main-content') && last.querySelector('.ds-flex');
        },
        { timeout }
      );
      console.log('\x1b[35m[DEBUG] 最新 AI 回复已完成\x1b[0m');

      // 提取纯文本（只取 ds-assistant-message-main-content，过滤思考过程）
      const reply = await page.evaluate(() => {
        const items = document.querySelectorAll('[data-virtual-list-item-key]');
        const last = items[items.length - 1];
        const main = last.querySelector('.ds-assistant-message-main-content');
        if (!main) return null;
        let text = main.textContent.trim();
        text = text.replace(/专家模式暂不支持搜索，请使用快速模式/g, '').trim();
        if (text.includes('User:') || text.includes('Assistant:')) return '';
        return text.length > 10 ? text : null;
      });

      if (reply) {
        console.log('\x1b[32m[DEBUG] 成功提取回复，长度:\x1b[0m', reply.length);
        return reply;
      }
    } catch (e) {
      console.log('\x1b[31m[DEBUG] 等待或提取失败:\x1b[0m', e.message);
    }

    console.log('\x1b[31m[DEBUG] waitForReply 超时\x1b[0m');
    return null;
  }

  async function sendAndWait(text) {
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
          // console.log('[HTTP] 专家模式已选中:', isSelected);
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

    // 将文本写入剪贴板
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, text);

    await editor.click();
    await page.waitForTimeout(200);

    // 清空输入框（根据类型清空）
    const tagName = await editor.evaluate(el => el.tagName.toLowerCase());
    const isContentEditable = await editor.evaluate(el => el.getAttribute('contenteditable') === 'true');

    if (isContentEditable || tagName === 'div') {
      await editor.evaluate(el => { el.textContent = ''; });
    } else {
      await editor.fill('');
    }

    // 模拟 Ctrl+V 粘贴
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyV');
    await page.keyboard.up('Control');

    await page.waitForTimeout(300);

    const sendBtn = await findSendButton();
    if (sendBtn) {
      console.log('\x1b[36m[DEBUG] 点击发送按钮\x1b[0m');
      await sendBtn.click();
    } else {
      console.log('\x1b[36m[DEBUG] Enter 发送\x1b[0m');
      await editor.press('Enter');
    }

    console.log('\x1b[35m[DEBUG] 进入 waitForReply\x1b[0m');
    const reply = await waitForReply();
    if (reply) {
      console.log('\x1b[32m[DEBUG] === 收到回复 ===\x1b[0m');
      console.log('\x1b[32m[DEBUG] 长度:\x1b[0m', reply.length);
      console.log('\x1b[32m[DEBUG] 前 200 字符:\x1b[0m', reply.slice(0, 200));
    } else {
      console.log('\x1b[31m[DEBUG] 未收到回复\x1b[0m');
      return sendAndWait(text);
    }
    return reply;
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

    // 解析模型输出中的工具调用
    function parseToolCall(text) {
      const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/;
      const match = text.match(regex);

      // 完全没有 <tool_call> 标签 → 正常，不调用工具
      if (!match) {
        if (text.includes('tool_call')){
          return {
            found: true,
            success: false,
            error: '模型输出中存在 <tool_call> 标签，但 JSON 解析失败'
          };
        }

        return { found: false, error: null };
      } 
        

      try {
        const parsed = JSON.parse(match[1].trim());
        if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
          return {
            found: true,
            success: false,
            error: 'JSON 中缺少有效的 "name" 字段，请确保 "name" 存在且不为空'
          };
        }
        if (typeof parsed.arguments !== 'object' || parsed.arguments === null) {
          return {
            found: true,
            success: false,
            error: '"arguments" 必须是一个 JSON 对象'
          };
        }
        return {
          found: true,
          success: true,
          toolCall: { name: parsed.name, arguments: parsed.arguments }
        };
      } catch (e) {
        return {
          found: true,
          success: false,
          error: `JSON ${text} \n解析失败: ${e.message}`
        };
      }
    }

    async function getFinalReplyWithTools(promptText, toolsText, instruction) {
      // 首次调用
      let prompt = `【可用工具】\n${toolsText}${instruction}\n\n${promptText}`;
      let reply = await sendAndWait(prompt);
      let rawOutput = (reply && reply.trim()) || '【系统提示】DeepSeek 未返回有效回复。';
      console.log('[HTTP] 首次输出:', rawOutput.slice(0, 150));

      let parseResult = parseToolCall(rawOutput);

      // 1. 未找到工具调用 → 直接返回文本
      if (!parseResult.found) {
        return { toolCall: null, rawOutput };
      }

      // 2. 格式正确 → 返回工具调用
      if (parseResult.success) {
        return { toolCall: parseResult.toolCall, rawOutput };
      }

      // 3. 格式错误 → 进入重试循环（最多5次，包含首次共6次尝试）
      const maxRetries = 50;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[ToolCall] 格式错误，第 ${attempt}/${maxRetries} 次纠正重试`);
        // 构造纠错消息，把具体错误告诉模型
        prompt = `【可用工具】\n${toolsText}${instruction}\n\n【注意】JSON解析是程序解析，解析失败必定是输出的格式有误：${parseResult.error}\n请严格按格式重新输出工具调用\n调用工具一次只能一个，也就是只能一个<tool_call>，一个</tool_call>\n注意引号嵌套问题,引号里面有引号必须转义\n tool_call标签之间不能有真正的换行，可以使用斜杆n代替\n：\n<tool_call>\n{"name": "函数名", "arguments": {}}\n</tool_call>`;

        reply = await sendAndWait(prompt);
        rawOutput = (reply && reply.trim()) || '【系统提示】DeepSeek 未返回有效回复。';
        console.log('[HTTP] 纠正后输出:', rawOutput.slice(0, 150));

        parseResult = parseToolCall(rawOutput);

        // 纠正后未找到工具调用 → 可能模型放弃使用工具，退回文本
        if (!parseResult.found) {
          return { toolCall: null, rawOutput };
        }
        // 纠正成功
        if (parseResult.success) {
          return { toolCall: parseResult.toolCall, rawOutput };
        }
        // 否则继续下一个纠正轮次
      }

      // 重试用完仍失败，回退为普通文本（防止卡死）
      console.log('[ToolCall] 重试次数用尽，降级为纯文本回复');
      return { toolCall: null, rawOutput };
    }

    // 原有的请求处理部分（仅展示核心修改）
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          console.log('\x1b[36m[DEBUG] === 收到请求 ===\x1b[0m');
          // console.log('\x1b[36m[DEBUG] 内容:\x1b[0m', body);
          const data = JSON.parse(body);
          const messages = data.messages || [];
          const userMsgs = messages.filter(m => m.role === 'user');
          let userMsg = userMsgs.length ? userMsgs[userMsgs.length - 1].content : '';
          const tools = data.tools || [];

          if (!userMsg) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No message content', type: 'invalid_request_error' } }));
            return;
          }
          
          // 防重放过滤器（保留）
          if (userMsg.includes('User:') || userMsg.includes('Assistant:')) {
            console.log('\x1b[31m[网关拦截] 检测到回流的对话历史，已拒绝:\x1b[0m', userMsg.slice(0, 80));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{
                message: { role: 'assistant', content: '请求已被拦截，请勿发送包含对话历史的脏数据。' },
                finish_reason: 'stop'
              }]
            }));
            return;
          }

          let promptText = "";
          if(messages.length > 0){
            for(let i = 0; i < messages.length; i++){
              if(messages[i].role === 'system'){
                promptText += `【系统提示】\n${messages[i].content}`;
              }else if(messages[i].role === 'user'){
                promptText += `【用户消息】\n${messages[i].content}`;
              }else if(messages[i].role === 'assistant'){
                promptText += `【模型回复】\n${messages[i].content}`;
              }else if(messages[i].role === 'tool'){
                promptText += `【工具信息】\n${messages[i].content}`;
              }
            }
          }


          console.log('[HTTP] 收到消息:', userMsg.slice(0, 50), '...');

          const toolsText = tools.length > 0
            ? tools.map(t => `- ${t.function.name}: ${t.function.description}`).join('\n')
            : '无';
          const toolCallInstructions = tools.length > 0
            ? `\n\n当你需要使用工具时，请严格按以下格式输出，不要附带任何其他文字,注意tool_call之间必须是有效的json,而且必须是<tool_call>与</tool_call>同时出现,调用工具一次只能一个，也就是只能一个<tool_call>，一个</tool_call>\n tool_call标签之间不能有真正的换行，可以使用斜杆n代替\n：\n<tool_call>\n{"name": "<函数名>", "arguments": <参数JSON>}\n</tool_call>，当不需要使用工具时，直接输出你的文本回复`
            : '';

          const { toolCall, rawOutput } = await getFinalReplyWithTools(
            promptText, toolsText, toolCallInstructions
          );

          const hasTool = !!toolCall;
          const finishReason = hasTool ? 'tool_calls' : 'stop';

          // ---- 流式响应（简单处理：工具调用时不流式，直接一次性返回；纯文本保持原逻辑）----
          if (data.stream === true) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });

            const chunkId = 'chatcmpl-' + Date.now();
            const model = 'deepseek-chat';

            // 1. 发送第一个 delta，包含 role
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

            if (hasTool) {
              // 2. 工具调用流式发送
              const toolCallId = 'call_' + Math.random().toString(36).substr(2, 9);
              const argsStr = JSON.stringify(toolCall.arguments);

              // 发送 tool_call 开始块（name + 空的 arguments）
              const toolStartChunk = {
                id: chunkId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: toolCallId,
                      type: 'function',
                      function: {
                        name: toolCall.name,
                        arguments: ''
                      }
                    }]
                  },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(toolStartChunk)}\n\n`);

              // 逐步发送 arguments（可以按字符或分块发送）
              for (let i = 0; i < argsStr.length; i++) {
                const argChunk = {
                  id: chunkId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: 0,
                        function: {
                          arguments: argsStr[i]
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                };
                res.write(`data: ${JSON.stringify(argChunk)}\n\n`);
                await new Promise(r => setTimeout(r, 5)); // 模拟流式延迟
              }

              // 最后发送 finish_reason
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
            } else {
              // 3. 普通文本流式输出（保留你原来的逐字发送逻辑）
              const words = rawOutput.split('');
              for (let i = 0; i < words.length; i++) {
                const chunk = {
                  id: chunkId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{
                    index: 0,
                    delta: { content: words[i] },
                    finish_reason: null
                  }]
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                await new Promise(r => setTimeout(r, 20));
              }
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
            }

            res.write('data: [DONE]\n\n');
            res.end();
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
            const toolCallId = 'call_' + Math.random().toString(36).substr(2, 9);
            response.choices[0].message = {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: toolCallId,
                type: 'function',
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.arguments)
                }
              }]
            };
          } else {
            response.choices[0].message = {
              role: 'assistant',
              content: rawOutput
            };
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));

        } catch (e) {
          console.log('[HTTP] 处理请求异常:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
        }
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