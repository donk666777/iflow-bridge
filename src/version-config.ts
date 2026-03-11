import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

export interface IFlowVersionConfig {
  version: string;
  nodeVersion: string;
  userAgent: string;
  lastUpdated: string;
  source: 'bundle' | 'package' | 'fallback';
}

export interface ModelThinkingConfig {
  supportsThinking: boolean;
  supportedReasoningLevels: ('low' | 'medium' | 'high')[];
  maxThinkingTokens: number;
  requestConfig: {
    thinking_mode?: boolean;
    reasoning?: boolean;
    chat_template_kwargs?: { enable_thinking: boolean };
    enable_thinking?: boolean;
    thinking?: { type: 'enabled' | 'disabled' };
  };
}

const OFFICIAL_CLI_PATHS = [
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@iflow-ai', 'iflow-cli'),
  path.join(os.homedir(), 'AppData', 'Local', 'npm', 'node_modules', '@iflow-ai', 'iflow-cli'),
  path.join(os.homedir(), '@iflow-ai', 'iflow-cli'),
  path.join(os.homedir(), '.npm-global', 'node_modules', '@iflow-ai', 'iflow-cli'),
  path.join(os.homedir(), '.local', 'share', 'pnpm', 'global', 'node_modules', '@iflow-ai', 'iflow-cli'),
  path.join(os.homedir(), '.yarn', 'global', 'node_modules', '@iflow-ai', 'iflow-cli'),
  path.join(process.cwd(), 'node_modules', '@iflow-ai', 'iflow-cli'),
];

const CONFIG_CACHE_PATH = path.join(os.homedir(), '.iflow-sdk-bridge', 'version-config.json');

const DEFAULT_CONFIG: IFlowVersionConfig = {
  version: '0.5.16',
  nodeVersion: 'v22.22.0',
  userAgent: 'iFlow-Cli',
  lastUpdated: new Date().toISOString(),
  source: 'fallback',
};

function extractVersionFromPackage(packagePath: string): string | null {
  try {
    const packageJsonPath = path.join(packagePath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return null;
    
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content);
    return pkg.version || null;
  } catch {
    return null;
  }
}

function extractVersionFromBundle(bundlePath: string): string | null {
  try {
    if (!fs.existsSync(bundlePath)) return null;
    
    const content = fs.readFileSync(bundlePath, 'utf-8');
    
    const patterns = [
      /IFLOW_CLI_VERSION\s*[=:]\s*["'](\d+\.\d+\.\d+)["']/,
      /"name"\s*:\s*"@iflow-ai\/iflow-cli"[^}]*"version"\s*:\s*"(\d+\.\d+\.\d+)"/,
      /"version"\s*:\s*"(\d+\.\d+\.\d+)"[^}]*"name"\s*:\s*"@iflow-ai\/iflow-cli"/,
    ];
    
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

function extractModelConfigsFromBundle(bundlePath: string): Map<string, ModelThinkingConfig> {
  const configs = new Map<string, ModelThinkingConfig>();
  
  try {
    if (!fs.existsSync(bundlePath)) return configs;
    
    const content = fs.readFileSync(bundlePath, 'utf-8');
    
    if (content.includes('deepseek') && content.includes('thinking_mode')) {
      configs.set('deepseek', {
        supportsThinking: true,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        maxThinkingTokens: 32000,
        requestConfig: {
          thinking_mode: true,
          reasoning: true,
        },
      });
    }
    
    if (content.includes('glm-5') && content.includes('enable_thinking')) {
      configs.set('glm-5', {
        supportsThinking: true,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        maxThinkingTokens: 20000,
        requestConfig: {
          chat_template_kwargs: { enable_thinking: true },
          enable_thinking: true,
          thinking: { type: 'enabled' },
        },
      });
    }
    
    if (content.includes('glm-4.7')) {
      configs.set('glm-4.7', {
        supportsThinking: true,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        maxThinkingTokens: 20000,
        requestConfig: {
          chat_template_kwargs: { enable_thinking: true },
        },
      });
    }
    
    if (content.includes('kimi-k2.5') && content.includes('thinking')) {
      configs.set('kimi-k2.5', {
        supportsThinking: true,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        maxThinkingTokens: 32768,
        requestConfig: {
          thinking: { type: 'enabled' },
        },
      });
    }
    
    if (content.includes('mimo-')) {
      configs.set('mimo', {
        supportsThinking: true,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        maxThinkingTokens: 20000,
        requestConfig: {
          thinking: { type: 'enabled' },
        },
      });
    }
    
    if (content.includes('reasoning')) {
      configs.set('reasoning', {
        supportsThinking: true,
        supportedReasoningLevels: ['low', 'medium'],
        maxThinkingTokens: 10000,
        requestConfig: {
          reasoning: true,
        },
      });
    }
    
    if (content.includes('thinking_mode')) {
      configs.set('thinking', {
        supportsThinking: true,
        supportedReasoningLevels: ['low', 'medium', 'high'],
        maxThinkingTokens: 15000,
        requestConfig: {
          thinking_mode: true,
        },
      });
    }
    
  } catch (error) {
    console.error('[VersionConfig] 提取模型配置失败:', error);
  }
  
  return configs;
}

function findOfficialCliPath(): string | null {
  for (const searchPath of OFFICIAL_CLI_PATHS) {
    if (fs.existsSync(searchPath)) {
      return searchPath;
    }
  }
  return null;
}

function getVersionFromNpm(): string | null {
  try {
    const result = execSync('npm list @iflow-ai/iflow-cli --json --depth=0 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const parsed = JSON.parse(result);
    return parsed.dependencies?.['@iflow-ai/iflow-cli']?.version || null;
  } catch {
    return null;
  }
}

export function getVersionConfig(): IFlowVersionConfig {
  const cliPath = findOfficialCliPath();
  
  if (cliPath) {
    const packageVersion = extractVersionFromPackage(cliPath);
    if (packageVersion) {
      return {
        version: packageVersion,
        nodeVersion: 'v22.22.0',
        userAgent: 'iFlow-Cli',
        lastUpdated: new Date().toISOString(),
        source: 'package',
      };
    }
    
    const bundlePath = path.join(cliPath, 'bundle', 'iflow.js');
    const bundleVersion = extractVersionFromBundle(bundlePath);
    
    if (bundleVersion) {
      return {
        version: bundleVersion,
        nodeVersion: 'v22.22.0',
        userAgent: 'iFlow-Cli',
        lastUpdated: new Date().toISOString(),
        source: 'bundle',
      };
    }
  }
  
  const npmVersion = getVersionFromNpm();
  if (npmVersion) {
    return {
      version: npmVersion,
      nodeVersion: 'v22.22.0',
      userAgent: 'iFlow-Cli',
      lastUpdated: new Date().toISOString(),
      source: 'package',
    };
  }
  
  if (fs.existsSync(CONFIG_CACHE_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CONFIG_CACHE_PATH, 'utf-8'));
      const cacheAge = Date.now() - new Date(cached.lastUpdated).getTime();
      if (cacheAge < 24 * 60 * 60 * 1000) {
        return cached;
      }
    } catch {
    }
  }
  
  return DEFAULT_CONFIG;
}

export function getModelThinkingConfig(modelId: string): ModelThinkingConfig | null {
  const cliPath = findOfficialCliPath();
  
  if (cliPath) {
    const bundlePath = path.join(cliPath, 'bundle', 'iflow.js');
    const configs = extractModelConfigsFromBundle(bundlePath);
    
    if (configs.has(modelId)) {
      return configs.get(modelId) || null;
    }
    
    const modelLower = modelId.toLowerCase();
    
    for (const [key, config] of configs) {
      if (modelLower.includes(key) || key.includes(modelLower)) {
        return config;
      }
    }
  }
  
  return getBuiltinModelConfig(modelId);
}

function getBuiltinModelConfig(modelId: string): ModelThinkingConfig | null {
  const modelLower = modelId.toLowerCase();
  
  if (modelLower.startsWith('deepseek')) {
    return {
      supportsThinking: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      maxThinkingTokens: 32000,
      requestConfig: {
        thinking_mode: true,
        reasoning: true,
      },
    };
  }
  
  if (modelLower === 'glm-5' || modelLower.includes('glm-5')) {
    return {
      supportsThinking: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      maxThinkingTokens: 20000,
      requestConfig: {
        chat_template_kwargs: { enable_thinking: true },
        enable_thinking: true,
        thinking: { type: 'enabled' },
      },
    };
  }
  
  if (modelLower === 'glm-4.7' || modelLower.includes('glm-4.7')) {
    return {
      supportsThinking: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      maxThinkingTokens: 20000,
      requestConfig: {
        chat_template_kwargs: { enable_thinking: true },
      },
    };
  }
  
  if (modelLower.startsWith('glm-')) {
    return {
      supportsThinking: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      maxThinkingTokens: 20000,
      requestConfig: {
        chat_template_kwargs: { enable_thinking: true },
      },
    };
  }
  
  if (modelLower.startsWith('kimi-k2.5')) {
    return {
      supportsThinking: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      maxThinkingTokens: 32768,
      requestConfig: {
        thinking: { type: 'enabled' },
      },
    };
  }
  
  if (modelLower.startsWith('mimo-')) {
    return {
      supportsThinking: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      maxThinkingTokens: 20000,
      requestConfig: {
        thinking: { type: 'enabled' },
      },
    };
  }
  
  if (modelLower.includes('thinking')) {
    return {
      supportsThinking: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      maxThinkingTokens: 15000,
      requestConfig: {
        thinking_mode: true,
      },
    };
  }
  
  if (modelLower.includes('reasoning')) {
    return {
      supportsThinking: true,
      supportedReasoningLevels: ['low', 'medium'],
      maxThinkingTokens: 10000,
      requestConfig: {
        reasoning: true,
      },
    };
  }
  
  if (modelLower.includes('claude') || modelLower.includes('sonnet')) {
    return {
      supportsThinking: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      maxThinkingTokens: 25000,
      requestConfig: {
        chat_template_kwargs: { enable_thinking: true },
      },
    };
  }
  
  return null;
}

export function getRequestConfig(): {
  version: string;
  userAgent: string;
  nodeVersion: string;
} {
  const config = getVersionConfig();
  return {
    version: config.version,
    userAgent: config.userAgent,
    nodeVersion: config.nodeVersion,
  };
}

export const IFLOW_CLI_VERSION = getVersionConfig().version;
export const IFLOW_CLI_USER_AGENT = 'iFlow-Cli';
export const NODE_VERSION_EMULATED = 'v22.22.0';
