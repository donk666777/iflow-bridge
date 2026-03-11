/**
 * iFlow SDK Bridge - OpenAI 兼容 API 服务
 * 完全模拟 iflow-cli，真正的流式输出，支持自定义工具
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { getBridge, IFlowBridge, ChatMessage, ToolDefinition, performOAuthLogin, performOAuthLoginForAccount, IFlowOAuth, getConfig, IFlowConfig, getAccountPool, getAccountPoolStats } from './client.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const app = express();
const PORT = process.env.PORT || 28002;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/v1/models', (_req: Request, res: Response) => {
  const models = IFlowBridge.getModels();
  res.json({
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'iflow',
    })),
  });
});

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const startTime = Date.now();

  const messages = body.messages as ChatMessage[] | undefined;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({
      error: { message: 'messages is required', type: 'invalid_request_error' },
    });
    return;
  }

  const isStream = body.stream === true;
  const model = String(body.model || 'glm-5');
  const tools = body.tools as ToolDefinition[] | undefined;
  const temperature = body.temperature as number | undefined;
  const maxTokens = body.max_tokens as number | undefined;
  const topP = body.top_p as number | undefined;

  console.log(`[Request] model=${model}, stream=${isStream}, messages=${messages.length}, tools=${tools?.length || 0}`);

  try {
    const bridge = await getBridge({ model });
    const extraParams: Record<string, unknown> = {};
    if (temperature !== undefined) extraParams.temperature = temperature;
    if (maxTokens !== undefined) extraParams.max_new_tokens = maxTokens;
    if (topP !== undefined) extraParams.top_p = topP;

    if (isStream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      try {
        for await (const chunk of bridge.chatStreamRaw(messages, model, tools, extraParams)) {
          res.write(chunk);
        }
        res.end();
      } catch (streamError) {
        console.error('[Stream Error]', streamError);
        if (!res.writableEnded) {
          const errorChunk = {
            id: `error-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { content: `[错误] ${streamError instanceof Error ? streamError.message : '流式传输错误'}` },
                finish_reason: 'stop',
              },
            ],
          };
          res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
    } else {
      const result = await bridge.chat(messages, model, tools, extraParams);

      res.json({
        id: `chatcmpl-${Date.now().toString(16)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.content,
              ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
            },
            finish_reason: 'stop',
          },
        ],
        usage: result.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });

      console.log(`[Response] 完成: ${Date.now() - startTime}ms, ${result.content.length} chars, tokens: ${result.usage?.total_tokens || 'N/A'}`);
    }
  } catch (error) {
    console.error('[Error]', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: error instanceof Error ? error.message : 'Internal server error',
          type: 'api_error',
        },
      });
    }
  }
});

app.post('/v1/messages', async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  if (!body.messages || !Array.isArray(body.messages)) {
    res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'messages is required' },
    });
    return;
  }

  const isStream = body.stream === true;
  const model = String(body.model || 'glm-5');
  const maxTokens = body.max_tokens as number | undefined;

  const messages: ChatMessage[] = [];

  if (body.system) {
    const systemText =
      typeof body.system === 'string'
        ? body.system
        : (body.system as Array<{ type: string; text: string }>)
            ?.filter(b => b.type === 'text')
            ?.map(b => b.text)
            ?.join(' ') || '';
    if (systemText) messages.push({ role: 'system', content: systemText });
  }

  for (const msg of body.messages as Array<Record<string, unknown>>) {
    const role = String(msg.role || 'user');
    const content = msg.content;

    if (typeof content === 'string') {
      messages.push({ role, content });
    } else if (Array.isArray(content)) {
      const textParts = content
        .filter((c: Record<string, unknown>) => c.type === 'text')
        .map((c: Record<string, unknown>) => String(c.text || ''))
        .join('\n');

      const toolResults = content.filter((c: Record<string, unknown>) => c.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const trContent = (tr as Record<string, unknown>).content;
          const trText =
            typeof trContent === 'string'
              ? trContent
              : Array.isArray(trContent)
              ? trContent
                  .filter((tc: Record<string, unknown>) => tc.type === 'text')
                  .map((tc: Record<string, unknown>) => tc.text)
                  .join('\n')
              : '';
          messages.push({
            role: 'tool',
            content: trText,
          } as ChatMessage);
        }
      }

      const toolUses = content.filter((c: Record<string, unknown>) => c.type === 'tool_use');
      if (role === 'assistant' && toolUses.length > 0) {
        if (textParts) messages.push({ role, content: textParts });
      } else if (textParts) {
        messages.push({ role, content: textParts });
      }
    }
  }

  console.log(`[Anthropic] model=${model}, stream=${isStream}, messages=${messages.length}`);

  try {
    const bridge = await getBridge({ model });
    const extraParams: Record<string, unknown> = {};
    if (maxTokens !== undefined) extraParams.max_new_tokens = maxTokens;

    let tools: ToolDefinition[] | undefined;
    if (body.tools) {
      tools = (body.tools as Array<Record<string, unknown>>).map(t => ({
        type: 'function' as const,
        function: {
          name: String(t.name || ''),
          description: String(t.description || ''),
          parameters: t.input_schema as Record<string, unknown>,
        },
      }));
    }

    if (isStream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const chatId = `msg_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 14)}`;

      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: chatId,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
          },
        })}\n\n`
      );

      res.write(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })}\n\n`
      );

      let outputTokens = 0;
      let thinkingIndex = -1;

      for await (const chunk of bridge.chatStream(messages, model, tools, extraParams)) {
        if (chunk.done) break;

        if (chunk.reasoning) {
          if (thinkingIndex < 0) {
            thinkingIndex = 1;
            res.write(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: 0,
              })}\n\n`
            );
            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'thinking', thinking: '' },
              })}\n\n`
            );
          }
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'thinking_delta', thinking: chunk.reasoning },
            })}\n\n`
          );
        }

        if (chunk.content) {
          outputTokens++;
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: thinkingIndex >= 0 ? 0 : 0,
              delta: { type: 'text_delta', text: chunk.content },
            })}\n\n`
          );
        }
      }

      res.write(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: thinkingIndex >= 0 ? thinkingIndex : 0,
        })}\n\n`
      );
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: outputTokens },
        })}\n\n`
      );
      res.write(
        `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
      );
      res.end();
    } else {
      const result = await bridge.chat(messages, model, tools, extraParams);

      const contentBlocks: Array<{ type: string; text?: string; thinking?: string }> = [];
      if (result.reasoning) contentBlocks.push({ type: 'thinking', thinking: result.reasoning });
      if (result.content) contentBlocks.push({ type: 'text', text: result.content });

      res.json({
        id: `msg_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 14)}`,
        type: 'message',
        role: 'assistant',
        content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }],
        model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { 
          input_tokens: result.usage?.prompt_tokens || 0, 
          output_tokens: result.usage?.completion_tokens || 0 
        },
      });
    }
  } catch (error) {
    console.error('[Anthropic Error]', error);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: error instanceof Error ? error.message : 'Internal error' },
      });
    }
  }
});

app.post('/v1/config/think', (_req: Request, res: Response) => {
  res.json({ success: true, note: '思考模式由模型自动配置' });
});

app.post('/v1/config/model', (req: Request, res: Response) => {
  const body = req.body as { model?: string };
  if (!body.model) {
    res.status(400).json({ error: 'model is required' });
    return;
  }
  res.json({ success: true, model: body.model });
});

app.get('/v1/config/status', (_req: Request, res: Response) => {
  const configPath = path.join(os.homedir(), '.iflow', 'settings.json');
  const hasConfig = fs.existsSync(configPath);
  let configInfo: Partial<IFlowConfig> | null = null;
  
  if (hasConfig) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);
      const apiKey = config.apiKey || config.searchApiKey;
      configInfo = {
        apiKey: apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : undefined,
        baseUrl: config.baseUrl,
        modelName: config.modelName,
        authType: config.selectedAuthType,
      };
    } catch {
    }
  }
  
  res.json({
    hasConfig,
    configPath,
    config: configInfo,
  });
});

app.get('/v1/accounts/status', (_req: Request, res: Response) => {
  const pool = getAccountPool();
  const stats = getAccountPoolStats();
  
  res.json({
    totalAccounts: pool.getAccountCount(),
    healthyAccounts: pool.getHealthyCount(),
    accounts: stats,
  });
});

app.get('/v1/oauth/login/:accountName', async (req: Request, res: Response) => {
  const accountName = req.params.accountName;
  
  try {
    const accountsPath = path.join(os.homedir(), '.iflow', 'accounts.json');
    
    if (!fs.existsSync(accountsPath)) {
      res.status(400).send('accounts.json 不存在，请先创建配置文件');
      return;
    }
    
    const accountsContent = fs.readFileSync(accountsPath, 'utf-8');
    const accountsConfig = JSON.parse(accountsContent) as { accounts: Array<{ name: string; apiKey: string; baseUrl: string; modelName: string }> };
    
    const account = accountsConfig.accounts.find((a: { name: string }) => a.name === accountName);
    if (!account) {
      res.status(404).send(`账号 ${accountName} 不存在`);
      return;
    }
    
    console.log(`[OAuth] 为账号 ${accountName} 启动登录...`);
    console.log(`[OAuth] 请使用对应手机号登录`);
    
    const config = await performOAuthLoginForAccount(accountName);
    
    if (config) {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>登录成功</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
            .card { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); text-align: center; max-width: 400px; }
            .success { color: #10b981; font-size: 48px; margin-bottom: 16px; }
            h1 { color: #1f2937; margin: 0 0 8px 0; }
            p { color: #6b7280; margin: 0 0 20px 0; }
            .key { background: #f3f4f6; padding: 12px 16px; border-radius: 8px; font-family: monospace; font-size: 14px; color: #374151; margin-bottom: 10px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="success">✓</div>
            <h1>登录成功！</h1>
            <p>账号 ${accountName} 已更新</p>
            <div class="key">API Key: ${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)}</div>
            <p style="font-size: 12px; color: #9ca3af;">refresh_token 已保存，可用于自动刷新</p>
          </div>
        </body>
        </html>
      `);
    } else {
      res.status(400).send('登录失败');
    }
  } catch (error) {
    res.status(500).send(`登录失败: ${error instanceof Error ? error.message : '未知错误'}`);
  }
});

app.get('/v1/oauth/url', (req: Request, res: Response) => {
  const port = parseInt(req.query.port as string) || 11451;
  const redirectUri = `http://localhost:${port}/oauth2callback`;
  const authUrl = IFlowOAuth.getAuthUrl(redirectUri);
  
  res.json({
    auth_url: authUrl,
    redirect_uri: redirectUri,
  });
});

app.get('/v1/oauth/login', async (_req: Request, res: Response) => {
  try {
    const configPath = path.join(os.homedir(), '.iflow', 'settings.json');
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        const apiKey = config.apiKey || config.searchApiKey;
        if (apiKey) {
          res.send(`
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="utf-8">
              <title>iFlow SDK Bridge - 登录状态</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
                .card { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); text-align: center; max-width: 400px; }
                .success { color: #10b981; font-size: 48px; margin-bottom: 16px; }
                h1 { color: #1f2937; margin: 0 0 8px 0; }
                p { color: #6b7280; margin: 0 0 20px 0; }
                .key { background: #f3f4f6; padding: 12px 16px; border-radius: 8px; font-family: monospace; font-size: 14px; color: #374151; }
              </style>
            </head>
            <body>
              <div class="card">
                <div class="success">✓</div>
                <h1>已登录</h1>
                <p>您已经配置了 API Key</p>
                <div class="key">${apiKey.slice(0, 8)}...${apiKey.slice(-4)}</div>
              </div>
            </body>
            </html>
          `);
          return;
        }
      } catch {
      }
    }
    
    const port = 11451;
    const redirectUri = `http://localhost:${port}/oauth2callback`;
    const authUrl = IFlowOAuth.getAuthUrl(redirectUri);
    
    console.log('[OAuth] 重定向到登录页面:', authUrl);
    res.redirect(authUrl);
  } catch (error) {
    res.status(500).send(`登录失败: ${error instanceof Error ? error.message : '未知错误'}`);
  }
});

app.post('/v1/oauth/login', async (_req: Request, res: Response) => {
  try {
    const config = await performOAuthLogin();
    if (config) {
      await getBridge({});
      res.json({
        success: true,
        apiKey: `${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)}`,
        modelName: config.modelName,
        ready: true,
      });
    } else {
      res.status(400).json({ success: false, error: 'OAuth 登录失败' });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'OAuth 登录失败',
    });
  }
});

app.post('/v1/oauth/callback', async (req: Request, res: Response) => {
  const { code, redirect_uri } = req.body as { code?: string; redirect_uri?: string };
  
  if (!code) {
    res.status(400).json({ success: false, error: 'code is required' });
    return;
  }
  
  try {
    const tokenData = await IFlowOAuth.getToken(code, redirect_uri || 'http://localhost:11451/oauth2callback');
    const accessToken = tokenData.access_token as string;
    const userInfo = await IFlowOAuth.getUserInfo(accessToken);
    const apiKey = userInfo.apiKey as string;
    
    if (!apiKey) {
      throw new Error('未获取到 API Key');
    }
    
    const config: IFlowConfig = {
      apiKey,
      baseUrl: 'https://apis.iflow.cn/v1',
      modelName: 'glm-5',
      authType: 'oauth-iflow',
      oauthAccessToken: accessToken,
      oauthRefreshToken: tokenData.refresh_token as string,
      oauthExpiresAt: tokenData.expires_at as string,
    };
    
    const configDir = path.join(os.homedir(), '.iflow');
    const configPath = path.join(configDir, 'settings.json');
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    let existingData: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      existingData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    
    const newData = {
      ...existingData,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      modelName: config.modelName,
      selectedAuthType: config.authType,
      oauth_access_token: config.oauthAccessToken,
      oauth_refresh_token: config.oauthRefreshToken,
      oauth_expires_at: config.oauthExpiresAt,
    };
    
    fs.writeFileSync(configPath, JSON.stringify(newData, null, 2));
    
    res.json({
      success: true,
      apiKey: `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'OAuth 回调处理失败',
    });
  }
});

async function checkConfigAndAutoLogin() {
  const accountsPath = path.join(os.homedir(), '.iflow', 'accounts.json');
  
  if (fs.existsSync(accountsPath)) {
    try {
      const content = fs.readFileSync(accountsPath, 'utf-8');
      const accountsConfig = JSON.parse(content);
      if (accountsConfig.accounts && accountsConfig.accounts.length > 0) {
        const validAccounts = accountsConfig.accounts.filter((a: { apiKey: string }) => a.apiKey);
        if (validAccounts.length > 0) {
          console.log(`[Config] 已找到 ${validAccounts.length} 个账号配置`);
          await getBridge({});
          console.log('[Config] 服务已就绪，可以开始使用！');
          return true;
        }
      }
    } catch {
      console.log('[Config] 多账号配置解析失败');
    }
  }
  
  const configPath = path.join(os.homedir(), '.iflow', 'settings.json');
  
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);
      const apiKey = config.apiKey || config.searchApiKey;
      if (apiKey) {
        console.log(`[Config] 已找到配置: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
        await getBridge({});
        return true;
      }
    } catch {
      console.log('[Config] 配置文件解析失败，需要重新登录');
    }
  }
  
  console.log('[Config] 未找到有效配置');
  console.log(`[Config] 请访问 http://localhost:${PORT}/v1/oauth/login/account1 进行登录`);
  console.log(`[Config] 或访问 http://localhost:${PORT}/v1/oauth/login/account2 进行登录`);
  console.log(`[Config] 或访问 http://localhost:${PORT}/v1/oauth/login/account3 进行登录`);
  
  return false;
}

app.listen(PORT, async () => {
  console.log(`[iflow-sdk-bridge] Server running on http://localhost:${PORT}`);
  console.log(`[iflow-sdk-bridge] Models: http://localhost:${PORT}/v1/models`);
  console.log(`[iflow-sdk-bridge] Chat: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`[iflow-sdk-bridge] Anthropic: http://localhost:${PORT}/v1/messages`);
  console.log(`[iflow-sdk-bridge] OAuth Login: http://localhost:${PORT}/v1/oauth/login`);
  console.log(`[iflow-sdk-bridge] 模拟 iflow-cli HTTP 请求`);
  
  await checkConfigAndAutoLogin();
});

process.on('SIGINT', () => {
  console.log('\n[iflow-sdk-bridge] Shutting down...');
  process.exit(0);
});
