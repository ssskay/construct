/**
 * lib/doctor/watchers/credential-parity.mjs — advisory credential alignment checks.
 *
 * Surfaces when a pinned OpenRouter model or OpenCode default expects
 * OPENROUTER_API_KEY but the canonical store and op-run catalog both lack it,
 * or when OpenCode's openrouter provider has no auth wiring.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseEnvFile, getUserEnvPath } from '../../env-config.mjs';
import { hasSecret } from '../../providers/secret-resolver.mjs';
import { ensureOpenRouterProviderAuth } from '../../opencode-config.mjs';
import { findOpenCodeConfigPath } from '../../opencode-config.mjs';

export const name = 'credential-parity';
export const intervalMs = 30 * 60 * 1000;

function openRouterModelId(modelId) {
  return typeof modelId === 'string' && /^openrouter\//.test(modelId);
}

function openCodeNeedsOpenRouter(homeDir) {
  const configPath = findOpenCodeConfigPath();
  if (!fs.existsSync(configPath)) return { needs: false, configPath };
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const defaultModel = config.model || config.defaultModel || '';
    return { needs: openRouterModelId(defaultModel), configPath, config };
  } catch {
    return { needs: false, configPath };
  }
}

function openRouterAuthWired(config) {
  const probe = { provider: { openrouter: config?.provider?.openrouter || {} } };
  ensureOpenRouterProviderAuth(probe);
  const provider = probe.provider.openrouter;
  return Boolean(
    provider.apiKey
    || provider.options?.headers?.Authorization,
  );
}

export async function runCredentialParityChecks({ rootDir = process.cwd(), homeDir = os.homedir(), env = process.env } = {}) {
  const violations = [];
  const configPath = getUserEnvPath(homeDir);
  const openRouterConfigured = hasSecret('OPENROUTER_API_KEY', { env, cwd: rootDir });

  const openCode = openCodeNeedsOpenRouter(homeDir);
  if (openCode.needs && !openRouterConfigured) {
    violations.push({
      category: 'credential-parity',
      severity: 'advisory',
      summary: `OpenCode default model uses OpenRouter but OPENROUTER_API_KEY is not configured (${openCode.configPath})`,
    });
  }

  if (openCode.config && openCode.needs && !openRouterAuthWired(openCode.config)) {
    violations.push({
      category: 'credential-parity',
      severity: 'advisory',
      summary: 'OpenCode provider.openrouter has no apiKey env ref — run `construct sync --global`',
    });
  }

  const xdgEnv = parseEnvFile(configPath);
  const legacyEnv = parseEnvFile(path.join(homeDir, '.construct', 'config.env'));
  if (legacyEnv.CONSTRUCT_OP_ENV_FILE && !xdgEnv.CONSTRUCT_OP_ENV_FILE) {
    violations.push({
      category: 'credential-parity',
      severity: 'advisory',
      summary: 'CONSTRUCT_OP_ENV_FILE is still in ~/.construct/config.env — run `construct install --footprint=user` to migrate to XDG config',
    });
  }

  return {
    summary: violations.length
      ? `credential-parity: ${violations.length} advisory finding(s)`
      : 'credential-parity: ok',
    violations,
  };
}

export async function tick({ rootDir = process.cwd(), homeDir = os.homedir(), env = process.env } = {}) {
  const result = await runCredentialParityChecks({ rootDir, homeDir, env });
  return {
    actions: [],
    escalations: [],
    findings: result.violations,
    passed: result.violations.length === 0
      ? [{ category: 'credential-parity', summary: result.summary }]
      : [],
  };
}
