import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import fetch from 'node-fetch';
import http from 'http';
import url from 'url';
import { execSync } from 'child_process';

import {
  getVersionConfig,
  getModelThinkingConfig,
  IFLOW_CLI_USER_AGENT,
} from './version-config.js';

export interface IFlowConfig {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  authType?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: string;
  name?: string;
}

export interface IFlowAccountConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  oauth_access_token?: string;
  oauth_refresh_token?: string;
  oauth_expires_at?: string;
}

export interface IFlowMultiAccountConfig {
  accounts: IFlowAccountConfig[];
  defaultAccount: string;
  strategy?: 'round-robin' | 'parallel' | 'failover';
}

export interface BridgeOptions {
  model?: string;
  preserveReasoning?: boolean;
  accountName?: string;
}

export interface ChatMessage {
  role: string;
  content: string | unknown[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

const TOKEN_COUNTER_MODEL = 'qwen3-4b';

class IFlowOAuth {
  static CLIENT_ID = '10009311001';
  static CLIENT_SECRET = '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW';
  static TOKEN_URL = 'https://iflow.cn/oauth/token';
  static USER_INFO_URL = 'https://iflow.cn/api/oauth/getUserInfo';
  static AUTH_URL = 'https://iflow.cn/oauth';

  static getAuthUrl(redirectUri: string, state?: string): string {
    if (!state) {
      state = crypto.randomBytes(16).toString('base64url');
    }
    return `${this.AUTH_URL}?client_id=${this.CLIENT_ID}&loginMethod=phone&type=phone&redirect=${encodeURIComponent(redirectUri)}&state=${state}`;
  }

  static async getToken(code: string, redirectUri: string): Promise<Record<string, unknown>> {
    const credentials = Buffer.from(`${this.CLIENT_ID}:${this.CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch(this.TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Basic ${credentials}`,
        'User-Agent': 'iFlow-Cli',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.CLIENT_ID,
        client_secret: this.CLIENT_SECRET,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`OAuth token 请求失败: ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>;
    
    if (!data.access_token) {
      throw new Error('OAuth 响应缺少 access_token');
    }

    if (data.expires_in) {
      const expiresAt = new Date(Date.now() + (data.expires_in as number) * 1000);
      data.expires_at = expiresAt.toISOString();
    }

    return data;
  }

  static async getUserInfo(accessToken: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.USER_INFO_URL}?accessToken=${accessToken}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'iFlow-Cli',
      },
    });

    if (!response.ok) {
      throw new Error(`获取用户信息失败: ${response.status}`);
    }

    const result = await response.json() as Record<string, unknown>;
    
    if (result.success && result.data) {
      return result.data as Record<string, unknown>;
    }
    
    throw new Error('获取用户信息失败');
  }

  static async refreshToken(refreshToken: string): Promise<Record<string, unknown>> {
    const credentials = Buffer.from(`${this.CLIENT_ID}:${this.CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch(this.TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Basic ${credentials}`,
        'User-Agent': 'iFlow-Cli',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.CLIENT_ID,
        client_secret: this.CLIENT_SECRET,
        refresh_token: refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Token 刷新失败: ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>;
    
    if (!data.access_token) {
      throw new Error('OAuth 响应缺少 access_token');
    }

    if (data.expires_in) {
      const expiresAt = new Date(Date.now() + (data.expires_in as number) * 1000);
      data.expires_at = expiresAt.toISOString();
    }

    return data;
  }
}

async function waitForOAuthCallback(port: number, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('OAuth 登录超时'));
    }, 120000);

    const server = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url || '', true);
      
      if (parsedUrl.pathname === '/oauth2callback') {
        const code = parsedUrl.query.code as string;
        const returnedState = parsedUrl.query.state as string;
        const error = parsedUrl.query.error as string;

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>登录失败</h1><p>您拒绝了授权</p><script>window.close();</script>');
          clearTimeout(timeout);
          server.close();
          reject(new Error(`OAuth 错误: ${error}`));
          return;
        }

        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>登录失败</h1><p>状态不匹配</p><script>window.close();</script>');
          clearTimeout(timeout);
          server.close();
          reject(new Error('OAuth state 不匹配'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>登录成功！</h1><p>您可以关闭此窗口</p><script>window.close();</script>');
        clearTimeout(timeout);
        server.close();
        resolve(code);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(port, () => {
      console.log(`[OAuth] 回调服务器启动在端口 ${port}`);
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function openBrowser(url: string): void {
  const platform = process.platform;
  
  try {
    if (platform === 'win32') {
      execSync(`start "" "${url}"`, { timeout: 5000 });
    } else if (platform === 'darwin') {
      execSync(`open "${url}"`, { timeout: 5000 });
    } else {
      execSync(`xdg-open "${url}"`, { timeout: 5000 });
    }
  } catch {
    console.log(`[OAuth] 请手动打开浏览器访问: ${url}`);
  }
}

async function performOAuthLogin(): Promise<IFlowConfig | null> {
  console.log('[OAuth] 开始 OAuth 登录流程...');
  
  const port = 11451;
  const state = crypto.randomBytes(16).toString('base64url');
  const redirectUri = `http://localhost:${port}/oauth2callback`;
  
  const authUrl = IFlowOAuth.getAuthUrl(redirectUri, state);
  
  console.log(`[OAuth] 正在打开浏览器进行登录...`);
  openBrowser(authUrl);
  
  try {
    const code = await waitForOAuthCallback(port, state);
    console.log('[OAuth] 获取到授权码，正在换取 token...');
    
    const tokenData = await IFlowOAuth.getToken(code, redirectUri);
    const accessToken = tokenData.access_token as string;
    
    console.log('[OAuth] 正在获取用户信息...');
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
    
    saveOAuthConfig(config);
    
    console.log('[OAuth] 登录成功！');
    return config;
  } catch (error) {
    console.error('[OAuth] 登录失败:', error);
    return null;
  }
}

function saveOAuthConfig(config: IFlowConfig): void {
  const configDir = path.join(os.homedir(), '.iflow');
  const configPath = path.join(configDir, 'settings.json');
  
  try {
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
    console.log(`[Config] 配置已保存到: ${configPath}`);
  } catch (error) {
    console.error('[Config] 保存配置失败:', error);
  }
}

function updateAccountOAuth(accountName: string, config: IFlowConfig): void {
  const configDir = path.join(os.homedir(), '.iflow');
  const accountsPath = path.join(configDir, 'accounts.json');
  
  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    let accountsData: IFlowMultiAccountConfig;
    
    if (fs.existsSync(accountsPath)) {
      accountsData = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
    } else {
      accountsData = { accounts: [], defaultAccount: accountName };
    }
    
    const accountIndex = accountsData.accounts.findIndex(a => a.name === accountName);
    
    if (accountIndex >= 0) {
      accountsData.accounts[accountIndex] = {
        ...accountsData.accounts[accountIndex],
        apiKey: config.apiKey,
        oauth_access_token: config.oauthAccessToken,
        oauth_refresh_token: config.oauthRefreshToken,
        oauth_expires_at: config.oauthExpiresAt,
      };
      console.log(`[Config] 已更新账号 ${accountName} 的 OAuth 配置`);
    } else {
      accountsData.accounts.push({
        name: accountName,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        modelName: config.modelName,
        oauth_access_token: config.oauthAccessToken,
        oauth_refresh_token: config.oauthRefreshToken,
        oauth_expires_at: config.oauthExpiresAt,
      });
      console.log(`[Config] 已添加账号 ${accountName}`);
    }
    
    fs.writeFileSync(accountsPath, JSON.stringify(accountsData, null, 2));
    console.log(`[Config] 配置已保存到: ${accountsPath}`);
  } catch (error) {
    console.error('[Config] 更新账号配置失败:', error);
  }
}

async function performOAuthLoginForAccount(accountName: string): Promise<IFlowConfig | null> {
  console.log(`[OAuth] 开始为账号 ${accountName} 进行 OAuth 登录...`);
  
  const port = 11451;
  const state = crypto.randomBytes(16).toString('base64url');
  const redirectUri = `http://localhost:${port}/oauth2callback`;
  
  const authUrl = IFlowOAuth.getAuthUrl(redirectUri, state);
  
  console.log(`[OAuth] 正在打开浏览器进行登录...`);
  console.log(`[OAuth] 请使用 ${accountName} 对应的手机号登录！`);
  openBrowser(authUrl);
  
  try {
    const code = await waitForOAuthCallback(port, state);
    console.log('[OAuth] 获取到授权码，正在换取 token...');
    
    const tokenData = await IFlowOAuth.getToken(code, redirectUri);
    const accessToken = tokenData.access_token as string;
    
    console.log('[OAuth] 正在获取用户信息...');
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
      name: accountName,
    };
    
    updateAccountOAuth(accountName, config);
    
    console.log(`[OAuth] 账号 ${accountName} 登录成功！`);
    return config;
  } catch (error) {
    console.error(`[OAuth] 账号 ${accountName} 登录失败:`, error);
    return null;
  }
}

export class TokenCounter {
  private config: IFlowConfig;
  private sessionId: string;

  constructor(config: IFlowConfig) {
    this.config = config;
    this.sessionId = `session-${crypto.randomUUID()}`;
  }

  private getHeaders(): Record<string, string> {
    const timestamp = Date.now();
    const signature = generateSignature(
      IFLOW_CLI_USER_AGENT,
      this.sessionId,
      timestamp,
      this.config.apiKey
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
      'user-agent': IFLOW_CLI_USER_AGENT,
      'session-id': this.sessionId,
      'accept': '*/*',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
      'accept-encoding': 'gzip, deflate, br',
      'traceparent': generateTraceparent(),
    };

    if (signature) {
      headers['x-iflow-signature'] = signature;
      headers['x-iflow-timestamp'] = String(timestamp);
    }

    return headers;
  }

  async countTokens(
    messages: ChatMessage[],
    completionContent?: string
  ): Promise<TokenUsage> {
    const url = `${this.config.baseUrl}/chat/completions`;
    
    const body = {
      model: TOKEN_COUNTER_MODEL,
      messages,
      stream: false,
      max_new_tokens: 1,
      temperature: 0.1,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        timeout: 30000,
      });

      if (!response.ok) {
        return this.estimateTokens(messages, completionContent);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const usage = data.usage as Record<string, number> | undefined;

      if (usage) {
        const promptTokens = usage.prompt_tokens || 0;
        const completionTokens = completionContent 
          ? this.estimateTextTokens(completionContent)
          : (usage.completion_tokens || 0);
        
        return {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        };
      }

      return this.estimateTokens(messages, completionContent);
    } catch (error) {
      return this.estimateTokens(messages, completionContent);
    }
  }

  private estimateTextTokens(text: string): number {
    if (!text) return 0;
    const charCount = text.length;
    const estimated = Math.ceil(charCount / 2.5);
    return Math.max(1, estimated);
  }

  private estimateTokens(
    messages: ChatMessage[],
    completionContent?: string
  ): TokenUsage {
    let promptTokens = 0;

    for (const msg of messages) {
      promptTokens += 4;
      
      const content = msg.content;
      if (typeof content === 'string') {
        promptTokens += this.estimateTextTokens(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'string') {
            promptTokens += this.estimateTextTokens(part);
          } else if (typeof part === 'object' && part !== null) {
            const text = (part as Record<string, unknown>).text;
            if (typeof text === 'string') {
              promptTokens += this.estimateTextTokens(text);
            }
          }
        }
      }
    }

    const completionTokens = completionContent 
      ? this.estimateTextTokens(completionContent) 
      : 0;

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  }
}

const _versionConfig = getVersionConfig();
const IFLOW_CLI_VERSION = _versionConfig.version;

function generateTraceparent(): string {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

function generateSignature(
  userAgent: string,
  sessionId: string,
  timestamp: number,
  apiKey: string
): string | null {
  if (!apiKey) return null;
  const message = `${userAgent}:${sessionId}:${timestamp}`;
  try {
    return crypto.createHmac('sha256', apiKey).update(message).digest('hex');
  } catch {
    return null;
  }
}

interface AccountInfo {
  config: IFlowConfig;
  healthy: boolean;
  lastUsed: number;
  requestCount: number;
  errorCount: number;
  lastError?: string;
}

class AccountPool {
  private accounts: Map<string, AccountInfo> = new Map();
  private accountOrder: string[] = [];
  private currentIndex: number = 0;
  private strategy: 'round-robin' | 'parallel' | 'failover' = 'round-robin';
  private maxRetries: number = 3;
  private healthCheckInterval: number = 60000;
  private unhealthyThreshold: number = 3;

  constructor() {}

  addAccount(name: string, config: IFlowConfig): void {
    this.accounts.set(name, {
      config,
      healthy: true,
      lastUsed: 0,
      requestCount: 0,
      errorCount: 0,
    });
    this.accountOrder.push(name);
    console.log(`[AccountPool] 添加账号: ${name} (${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)})`);
  }

  setStrategy(strategy: 'round-robin' | 'parallel' | 'failover'): void {
    this.strategy = strategy;
    console.log(`[AccountPool] 策略设置为: ${strategy}`);
  }

  getAccountCount(): number {
    return this.accounts.size;
  }

  getHealthyCount(): number {
    let count = 0;
    this.accounts.forEach((info) => {
      if (info.healthy) count++;
    });
    return count;
  }

  getNextAccount(): IFlowConfig | null {
    if (this.accounts.size === 0) return null;

    const healthyAccounts = this.accountOrder.filter(name => {
      const info = this.accounts.get(name);
      return info && info.healthy;
    });

    if (healthyAccounts.length === 0) {
      console.log('[AccountPool] 没有健康的账号，尝试重置所有账号状态');
      this.accounts.forEach((info) => {
        info.healthy = true;
        info.errorCount = 0;
      });
      return this.accounts.get(this.accountOrder[0])?.config || null;
    }

    if (this.strategy === 'round-robin') {
      this.currentIndex = this.currentIndex % healthyAccounts.length;
      const accountName = healthyAccounts[this.currentIndex];
      this.currentIndex++;
      
      const info = this.accounts.get(accountName);
      if (info) {
        info.lastUsed = Date.now();
        info.requestCount++;
        console.log(`[AccountPool] 轮询选择账号: ${accountName} (请求次数: ${info.requestCount})`);
        return info.config;
      }
    } else if (this.strategy === 'failover') {
      const accountName = healthyAccounts[0];
      const info = this.accounts.get(accountName);
      if (info) {
        info.lastUsed = Date.now();
        info.requestCount++;
        return info.config;
      }
    }

    return null;
  }

  getAllHealthyAccounts(): IFlowConfig[] {
    const healthyAccounts: IFlowConfig[] = [];
    this.accounts.forEach((info, name) => {
      if (info.healthy) {
        healthyAccounts.push(info.config);
      }
    });
    return healthyAccounts;
  }

  markError(accountName: string, error: string): void {
    const info = this.accounts.get(accountName);
    if (info) {
      info.errorCount++;
      info.lastError = error;
      
      if (info.errorCount >= this.unhealthyThreshold) {
        info.healthy = false;
        console.log(`[AccountPool] 账号 ${accountName} 标记为不健康: ${error}`);
      }
    }
  }

  markSuccess(accountName: string): void {
    const info = this.accounts.get(accountName);
    if (info) {
      info.errorCount = 0;
      info.healthy = true;
    }
  }

  getStats(): Record<string, { healthy: boolean; requestCount: number; errorCount: number; lastError?: string }> {
    const stats: Record<string, { healthy: boolean; requestCount: number; errorCount: number; lastError?: string }> = {};
    this.accounts.forEach((info, name) => {
      stats[name] = {
        healthy: info.healthy,
        requestCount: info.requestCount,
        errorCount: info.errorCount,
        lastError: info.lastError,
      };
    });
    return stats;
  }
}

let globalAccountPool: AccountPool | null = null;

function loadEnvMultiAccountConfig(): IFlowMultiAccountConfig | null {
  const accountsJson = process.env.IFLOW_ACCOUNTS;
  
  if (!accountsJson) {
    return null;
  }
  
  try {
    const config = JSON.parse(accountsJson) as IFlowMultiAccountConfig;
    
    if (!config.accounts || config.accounts.length === 0) {
      console.log('[Config] 环境变量中没有账号');
      return null;
    }
    
    console.log(`[Config] 从环境变量加载了 ${config.accounts.length} 个账号`);
    return config;
  } catch (error) {
    console.error('[Config] 解析环境变量 IFLOW_ACCOUNTS 失败:', error);
    return null;
  }
}

function loadEnvConfig(): IFlowConfig | null {
  const apiKey = process.env.IFLOW_API_KEY;
  
  if (!apiKey) {
    return null;
  }
  
  const baseUrl = (process.env.IFLOW_BASE_URL || 'https://apis.iflow.cn/v1').replace(/\/+$/, '');
  const modelName = process.env.IFLOW_MODEL_NAME || 'glm-5';
  
  console.log(`[Config] 从环境变量加载单账号配置`);
  console.log(`[Config] API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  console.log(`[Config] Base URL: ${baseUrl}`);
  console.log(`[Config] Model: ${modelName}`);
  
  return {
    apiKey,
    baseUrl,
    modelName,
    authType: 'env',
    name: 'env-account',
    oauthAccessToken: process.env.IFLOW_OAUTH_ACCESS_TOKEN,
    oauthRefreshToken: process.env.IFLOW_OAUTH_REFRESH_TOKEN,
    oauthExpiresAt: process.env.IFLOW_OAUTH_EXPIRES_AT,
  };
}

function loadIflowSettings(): IFlowConfig | null {
  const configPath = path.join(os.homedir(), '.iflow', 'settings.json');

  try {
    if (!fs.existsSync(configPath)) {
      console.log('[Config] 配置文件不存在:', configPath);
      return null;
    }

    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    const apiKey = config.apiKey || config.searchApiKey;
    const baseUrl = (config.baseUrl || 'https://apis.iflow.cn/v1').replace(/\/+$/, '');
    const modelName = config.modelName || 'glm-5';

    if (!apiKey) {
      console.log('[Config] 未找到 API Key');
      return null;
    }

    console.log(`[Config] API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
    console.log(`[Config] Base URL: ${baseUrl}`);
    
    return {
      apiKey,
      baseUrl,
      modelName,
      authType: config.selectedAuthType,
      oauthAccessToken: config.oauth_access_token,
      oauthRefreshToken: config.oauth_refresh_token,
      oauthExpiresAt: config.oauth_expires_at,
    };
  } catch (error) {
    console.error('[Config] 读取配置失败:', error);
    return null;
  }
}

function loadMultiAccountConfig(): IFlowMultiAccountConfig | null {
  const configPath = path.join(os.homedir(), '.iflow', 'accounts.json');
  
  try {
    if (!fs.existsSync(configPath)) {
      console.log('[Config] 多账号配置文件不存在:', configPath);
      return null;
    }
    
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as IFlowMultiAccountConfig;
    
    if (!config.accounts || config.accounts.length === 0) {
      console.log('[Config] 多账号配置中没有账号');
      return null;
    }
    
    console.log(`[Config] 加载了 ${config.accounts.length} 个账号`);
    return config;
  } catch (error) {
    console.error('[Config] 读取多账号配置失败:', error);
    return null;
  }
}

function initAccountPool(): AccountPool {
  if (globalAccountPool) {
    return globalAccountPool;
  }

  const pool = new AccountPool();
  
  const envMultiConfig = loadEnvMultiAccountConfig();
  if (envMultiConfig && envMultiConfig.accounts.length > 0) {
    const strategy = envMultiConfig.strategy || 'round-robin';
    pool.setStrategy(strategy);
    
    for (const account of envMultiConfig.accounts) {
      const config: IFlowConfig = {
        apiKey: account.apiKey,
        baseUrl: account.baseUrl.replace(/\/+$/, ''),
        modelName: account.modelName,
        name: account.name,
        oauthAccessToken: account.oauth_access_token,
        oauthRefreshToken: account.oauth_refresh_token,
        oauthExpiresAt: account.oauth_expires_at,
      };
      pool.addAccount(account.name, config);
    }
    
    globalAccountPool = pool;
    return pool;
  }
  
  const multiConfig = loadMultiAccountConfig();
  if (multiConfig && multiConfig.accounts.length > 0) {
    const strategy = multiConfig.strategy || 'round-robin';
    pool.setStrategy(strategy);
    
    for (const account of multiConfig.accounts) {
      const config: IFlowConfig = {
        apiKey: account.apiKey,
        baseUrl: account.baseUrl.replace(/\/+$/, ''),
        modelName: account.modelName,
        name: account.name,
        oauthAccessToken: account.oauth_access_token,
        oauthRefreshToken: account.oauth_refresh_token,
        oauthExpiresAt: account.oauth_expires_at,
      };
      pool.addAccount(account.name, config);
    }
    
    globalAccountPool = pool;
    return pool;
  }
  
  const envConfig = loadEnvConfig();
  if (envConfig) {
    pool.addAccount('env-account', envConfig);
    globalAccountPool = pool;
    return pool;
  }
  
  const settings = loadIflowSettings();
  if (settings) {
    pool.addAccount('default', settings);
    globalAccountPool = pool;
    return pool;
  }

  globalAccountPool = pool;
  return pool;
}

function getAccountByName(accountName?: string): IFlowConfig | null {
  const multiConfig = loadMultiAccountConfig();
  
  if (!multiConfig) {
    return null;
  }
  
  const targetName = accountName || multiConfig.defaultAccount;
  const account = multiConfig.accounts.find(a => a.name === targetName);
  
  if (!account) {
    console.log(`[Config] 未找到账号: ${targetName}`);
    return null;
  }
  
  console.log(`[Config] 使用账号: ${account.name}`);
  console.log(`[Config] API Key: ${account.apiKey.slice(0, 8)}...${account.apiKey.slice(-4)}`);
  
  return {
    apiKey: account.apiKey,
    baseUrl: account.baseUrl.replace(/\/+$/, ''),
    modelName: account.modelName,
    name: account.name,
    oauthAccessToken: account.oauth_access_token,
    oauthRefreshToken: account.oauth_refresh_token,
    oauthExpiresAt: account.oauth_expires_at,
  };
}

function listAvailableAccounts(): string[] {
  const multiConfig = loadMultiAccountConfig();
  if (!multiConfig) {
    return [];
  }
  return multiConfig.accounts.map(a => a.name);
}

function configureModelRequest(
  body: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const result = { ...body };
  
  const thinkingConfig = getModelThinkingConfig(model);
  
  if (thinkingConfig) {
    const config = thinkingConfig.requestConfig;
    
    if (config.thinking_mode !== undefined) {
      result.thinking_mode = config.thinking_mode;
    }
    if (config.reasoning !== undefined) {
      result.reasoning = config.reasoning;
    }
    if (config.chat_template_kwargs) {
      result.chat_template_kwargs = config.chat_template_kwargs;
    }
    if (config.enable_thinking !== undefined) {
      result.enable_thinking = config.enable_thinking;
    }
    if (config.thinking) {
      result.thinking = config.thinking;
    }
    
    return result;
  }
  
  const modelLower = model.toLowerCase();

  if (modelLower.startsWith('deepseek')) {
    result.thinking_mode = true;
    result.reasoning = true;
  } else if (model === 'glm-5') {
    result.chat_template_kwargs = { enable_thinking: true };
    result.enable_thinking = true;
    result.thinking = { type: 'enabled' };
  } else if (model === 'glm-4.7') {
    result.chat_template_kwargs = { enable_thinking: true };
  } else if (modelLower.startsWith('glm-')) {
    result.chat_template_kwargs = { enable_thinking: true };
  } else if (modelLower.startsWith('kimi-k2.5')) {
    result.thinking = { type: 'enabled' };
  } else if (modelLower.includes('thinking')) {
    result.thinking_mode = true;
  } else if (modelLower.startsWith('mimo-')) {
    result.thinking = { type: 'enabled' };
  } else if (modelLower.includes('claude') || modelLower.includes('sonnet')) {
    result.chat_template_kwargs = { enable_thinking: true };
  } else if (modelLower.includes('reasoning')) {
    result.reasoning = true;
  }

  if (/qwen.*4b/i.test(model)) {
    delete result.thinking_mode;
    delete result.reasoning;
    delete result.chat_template_kwargs;
    delete result.enable_thinking;
    delete result.thinking;
  }

  return result;
}

export class IFlowBridge {
  private config: IFlowConfig;
  private sessionId: string;
  private conversationId: string;
  private telemetryUserId: string;
  private preserveReasoning: boolean;
  private tokenCounter: TokenCounter;

  constructor(config: IFlowConfig, options?: BridgeOptions) {
    this.config = config;
    this.sessionId = `session-${crypto.randomUUID()}`;
    this.conversationId = crypto.randomUUID();
    this.telemetryUserId = crypto
      .createHash('sha1')
      .update(config.apiKey || this.sessionId)
      .digest('hex')
      .slice(0, 32);
    this.preserveReasoning = options?.preserveReasoning ?? true;
    this.tokenCounter = new TokenCounter(config);
  }

  private getHeaders(traceparent?: string): Record<string, string> {
    const timestamp = Date.now();
    const signature = generateSignature(
      IFLOW_CLI_USER_AGENT,
      this.sessionId,
      timestamp,
      this.config.apiKey
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
      'user-agent': IFLOW_CLI_USER_AGENT,
      'session-id': this.sessionId,
      'conversation-id': this.conversationId,
      'accept': '*/*',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
      'accept-encoding': 'gzip, deflate, br',
      'traceparent': traceparent || generateTraceparent(),
    };

    if (signature) {
      headers['x-iflow-signature'] = signature;
      headers['x-iflow-timestamp'] = String(timestamp);
    }

    return headers;
  }

  private buildRequestBody(
    messages: ChatMessage[],
    stream: boolean,
    model?: string,
    tools?: ToolDefinition[],
    extraParams?: Record<string, unknown>
  ): Record<string, unknown> {
    const modelId = model || this.config.modelName;

    let body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream,
      temperature: 0.7,
      top_p: 0.95,
      max_new_tokens: 8192,
      tools: tools || [],
    };

    if (extraParams) {
      body = { ...body, ...extraParams };
    }

    body = configureModelRequest(body, modelId);

    return body;
  }

  async chat(
    messages: ChatMessage[],
    model?: string,
    tools?: ToolDefinition[],
    extraParams?: Record<string, unknown>
  ): Promise<{ content: string; reasoning?: string; usage?: TokenUsage }> {
    const body = this.buildRequestBody(messages, false, model, tools, extraParams);
    const url = `${this.config.baseUrl}/chat/completions`;
    const headers = this.getHeaders();

    const tokenCountPromise = this.tokenCounter.countTokens(messages);

    const startTime = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 错误 (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const latency = Date.now() - startTime;
    
    const parsed = this.parseResponse(data);
    
    let usage: TokenUsage | undefined;
    try {
      usage = await Promise.race([
        tokenCountPromise,
        new Promise<TokenUsage>((_, reject) => 
          setTimeout(() => reject(new Error('timeout')), 5000)
        ),
      ]);
      
      if (parsed.content) {
        usage = await this.tokenCounter.countTokens(messages, parsed.content);
      }
    } catch {
      const apiUsage = data.usage as Record<string, number> | undefined;
      if (apiUsage) {
        usage = {
          prompt_tokens: apiUsage.prompt_tokens || 0,
          completion_tokens: apiUsage.completion_tokens || 0,
          total_tokens: apiUsage.total_tokens || 0,
        };
      }
    }

    console.log(`[Response] 非流式完成: ${latency}ms, tokens: ${usage?.total_tokens || 'N/A'}`);

    return { ...parsed, usage };
  }

  async *chatStreamRaw(
    messages: ChatMessage[],
    model?: string,
    tools?: ToolDefinition[],
    extraParams?: Record<string, unknown>
  ): AsyncGenerator<Buffer> {
    const body = this.buildRequestBody(messages, true, model, tools, extraParams);
    const url = `${this.config.baseUrl}/chat/completions`;
    const traceparent = generateTraceparent();
    const headers = this.getHeaders(traceparent);

    const inputTokenPromise = this.tokenCounter.countTokens(messages);

    const startTime = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errorChunk = this.createErrorChunk(model || 'unknown', errorText);
      yield Buffer.from(errorChunk);
      return;
    }

    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('text/event-stream') && !contentType.includes('application/octet-stream')) {
      const data = (await response.json()) as Record<string, unknown>;
      const normalized = this.normalizeResponse(data);
      yield Buffer.from(`data: ${JSON.stringify(normalized)}\n\n`);
      yield Buffer.from('data: [DONE]\n\n');
      return;
    }

    let buffer = '';
    let chunkCount = 0;
    let collectedContent = '';

    try {
      for await (const chunk of response.body as AsyncIterable<Buffer>) {
        buffer += chunk.toString('utf-8');

        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          if (!event.trim()) continue;

          for (const line of event.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') {
              try {
                const inputTokens = await inputTokenPromise;
                const outputTokens = this.tokenCounter['estimateTextTokens'](collectedContent);
                const usageEvent = {
                  type: 'token_usage',
                  usage: {
                    prompt_tokens: inputTokens.prompt_tokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens.prompt_tokens + outputTokens,
                  },
                };
                yield Buffer.from(`data: ${JSON.stringify(usageEvent)}\n\n`);
              } catch {
              }
              yield Buffer.from('data: [DONE]\n\n');
              continue;
            }

            try {
              const data = JSON.parse(dataStr);
              const normalized = this.normalizeStreamChunk(data);
              
              const delta = (data.choices?.[0]?.delta as Record<string, unknown>) || {};
              if (delta.content) {
                collectedContent += delta.content;
              }
              
              yield Buffer.from(`data: ${JSON.stringify(normalized)}\n\n`);
              chunkCount++;
            } catch {
              yield Buffer.from(`${trimmed}\n\n`);
            }
          }
        }
      }

      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            yield Buffer.from('data: [DONE]\n\n');
          } else {
            try {
              const data = JSON.parse(dataStr);
              const normalized = this.normalizeStreamChunk(data);
              yield Buffer.from(`data: ${JSON.stringify(normalized)}\n\n`);
              chunkCount++;
            } catch {
              yield Buffer.from(`${trimmed}\n\n`);
            }
          }
        }
      }
    } finally {
      const latency = Date.now() - startTime;
      console.log(`[Response] 流式完成: ${latency}ms, ${chunkCount} chunks, 输出约 ${Math.ceil(collectedContent.length / 2.5)} tokens`);
    }
  }

  async *chatStream(
    messages: ChatMessage[],
    model?: string,
    tools?: ToolDefinition[],
    extraParams?: Record<string, unknown>
  ): AsyncGenerator<{ content?: string; reasoning?: string; done?: boolean }> {
    for await (const chunk of this.chatStreamRaw(messages, model, tools, extraParams)) {
      const text = chunk.toString('utf-8');

      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          yield { done: true };
          return;
        }

        try {
          const data = JSON.parse(dataStr);
          const choice = data.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta || {};
          if (delta.content) yield { content: delta.content };
          if (delta.reasoning_content) yield { reasoning: delta.reasoning_content };

          if (choice.finish_reason) {
            yield { done: true };
            return;
          }
        } catch {
        }
      }
    }
  }

  private parseResponse(data: Record<string, unknown>): { content: string; reasoning?: string } {
    const choices = (data.choices as Array<Record<string, unknown>>) || [];
    const message = (choices[0]?.message as Record<string, unknown>) || {};

    let content = (message.content as string) || '';
    const reasoning = message.reasoning_content as string | undefined;

    if (!content && reasoning) {
      content = reasoning;
    }

    return { content, reasoning };
  }

  private normalizeResponse(data: Record<string, unknown>): Record<string, unknown> {
    const choices = (data.choices as Array<Record<string, unknown>>) || [];
    for (const choice of choices) {
      const message = (choice.message as Record<string, unknown>) || {};
      const content = message.content;
      const reasoning = message.reasoning_content;

      if (!content && reasoning) {
        message.content = reasoning;
        if (!this.preserveReasoning) {
          delete message.reasoning_content;
        }
      }
    }
    return data;
  }

  private normalizeStreamChunk(data: Record<string, unknown>): Record<string, unknown> {
    const choices = (data.choices as Array<Record<string, unknown>>) || [];
    for (const choice of choices) {
      const delta = (choice.delta as Record<string, unknown>) || {};
      const content = delta.content;
      const reasoning = delta.reasoning_content;

      if (!content && reasoning) {
        if (!this.preserveReasoning) {
          delta.content = reasoning;
          delete delta.reasoning_content;
        }
      }
    }
    return data;
  }

  private createErrorChunk(model: string, errorText: string): string {
    const errorChunk = {
      id: `error-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: { content: `[API Error] ${errorText.slice(0, 200)}` },
          finish_reason: 'stop',
        },
      ],
    };
    return `data: ${JSON.stringify(errorChunk)}\n\ndata: [DONE]\n\n`;
  }

  static getModels(): Array<{ id: string; name: string }> {
    return [
      { id: 'glm-4.6', name: 'GLM-4.6' },
      { id: 'glm-4.7', name: 'GLM-4.7' },
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'iFlow-ROME-30BA3B', name: 'iFlow-ROME-30BA3B' },
      { id: 'deepseek-v3.2-chat', name: 'DeepSeek-V3.2' },
      { id: 'qwen3-4b', name: 'Qwen3-4B (Token Counter)' },
      { id: 'qwen3-coder-plus', name: 'Qwen3-Coder-Plus' },
      { id: 'kimi-k2', name: 'Kimi-K2' },
      { id: 'kimi-k2-thinking', name: 'Kimi-K2-Thinking' },
      { id: 'kimi-k2.5', name: 'Kimi-K2.5' },
      { id: 'minimax-m2.5', name: 'MiniMax-M2.5' },
      { id: 'qwen-vl-max', name: 'Qwen-VL-Max' },
    ];
  }
}

let globalBridge: IFlowBridge | null = null;
let globalConfig: IFlowConfig | null = null;

export async function getBridge(options?: BridgeOptions): Promise<IFlowBridge> {
  const pool = initAccountPool();
  
  if (pool.getAccountCount() > 1) {
    const config = pool.getNextAccount();
    if (config) {
      if (options?.model) {
        config.modelName = options.model;
      }
      return new IFlowBridge(config, options);
    }
  }
  
  if (globalBridge && options?.model && globalConfig && options.model !== globalConfig.modelName) {
    globalConfig.modelName = options.model;
    globalBridge = new IFlowBridge(globalConfig, options);
    console.log(`[Bridge] 模型切换: ${options.model}`);
    return globalBridge;
  }

  if (!globalBridge) {
    let settings: IFlowConfig | null = null;
    
    if (pool.getAccountCount() === 1) {
      settings = pool.getNextAccount();
    }
    
    if (!settings) {
      settings = loadEnvConfig();
    }
    
    if (!settings && options?.accountName) {
      console.log(`[Bridge] 尝试加载指定账号: ${options.accountName}`);
      settings = getAccountByName(options.accountName);
    }
    
    if (!settings) {
      settings = getAccountByName();
    }
    
    if (!settings) {
      console.log('[Bridge] 未找到多账号配置，尝试加载默认配置...');
      settings = loadIflowSettings();
    }
    
    if (!settings) {
      console.log('[Bridge] 未找到配置文件，尝试 OAuth 登录...');
      settings = await performOAuthLogin();
      
      if (!settings) {
        throw new Error('未找到 API Key，OAuth 登录失败');
      }
    }
    
    globalConfig = settings;
    if (options?.model) {
      globalConfig.modelName = options.model;
    }
    globalBridge = new IFlowBridge(globalConfig, options);
    console.log(`[Bridge] 已连接, 模型: ${globalConfig.modelName}`);
  }
  return globalBridge;
}

export function getConfig(): IFlowConfig | null {
  return globalConfig;
}

export async function resetBridge(): Promise<void> {
  globalBridge = null;
  globalConfig = null;
}

export function getAccountPool(): AccountPool {
  return initAccountPool();
}

export function getAccountPoolStats(): Record<string, { healthy: boolean; requestCount: number; errorCount: number; lastError?: string }> {
  const pool = initAccountPool();
  return pool.getStats();
}

export { IFlowOAuth, performOAuthLogin, performOAuthLoginForAccount, listAvailableAccounts, getAccountByName };
