import type { ApiType, ResolvedAuth } from './types.js';
import { logger } from '../utils/logger.js';

export interface ApiContextInfo {
  type: ApiType;
  baseUrl?: string;
  /** Raw auth description text from the context file */
  authDescription?: string;
  bearerToken?: string;
}

/**
 * Resolve authentication headers for a given API type.
 *
 * - front-proxy / experience: no headers added (Playwright context.request carries cookies)
 * - private: x-api-key header from environment variable
 * - serverless: Authorization: Bearer header
 * - public: no auth
 */
export function resolveAuth(apiContext: ApiContextInfo): ResolvedAuth {
  const headers: Record<string, string> = {};

  switch (apiContext.type) {
    case 'front-proxy':
    case 'experience': {
      // Cookie session is automatically carried by Playwright context.request —
      // no headers to add here.
      break;
    }

    case 'private': {
      const apiKey = resolveApiKeyFromContext(apiContext);
      if (apiKey) {
        headers['x-api-key'] = apiKey;
      } else {
        logger.warn('Private API: no API key found in environment. Requests may fail.');
      }
      break;
    }

    case 'serverless': {
      const token = resolveTokenFromContext(apiContext);
      if (token) {
        headers['authorization'] = `Bearer ${token}`;
      }
      break;
    }

    case 'public': {
      break;
    }

    default: {
      logger.warn(`Unknown API type, no auth applied`);
    }
  }

  return { headers };
}

/**
 * Return true if the API type requires Playwright browser context for requests
 * (to inherit session cookies automatically).
 */
export function shouldUseBrowserContext(apiType: ApiType): boolean {
  return apiType === 'front-proxy' || apiType === 'experience';
}

/**
 * Parse an API type string from a context file into the ApiType union.
 * Handles common variations in casing and spacing.
 */
export function parseApiType(raw: string): ApiType {
  const normalized = raw.toLowerCase().replace(/[\s_]/g, '-');
  switch (normalized) {
    case 'front-proxy':
    case 'frontproxy':
      return 'front-proxy';
    case 'experience':
    case 'experience-api':
      return 'experience';
    case 'private':
    case 'private-api':
      return 'private';
    case 'serverless':
    case 'serverless-api':
      return 'serverless';
    case 'public':
    case 'public-api':
    default:
      return 'public';
  }
}

/**
 * Extract an API type declaration from a context file string.
 * Looks for "Type: <value>" in the text.
 */
export function extractApiTypeFromContext(contextText: string): ApiType | undefined {
  const match = contextText.match(/type\s*:\s*(.+)/i);
  if (!match?.[1]) return undefined;
  return parseApiType(match[1].trim());
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Find the API key value by scanning the auth description for $ENV_VAR references
 * and looking them up in process.env.
 */
function resolveApiKeyFromContext(apiContext: ApiContextInfo): string | undefined {
  const searchText = [apiContext.authDescription ?? '', apiContext.baseUrl ?? ''].join('\n');

  // Look for environment variable references containing API_KEY, KEY, SECRET
  const matches = searchText.match(/\$([A-Z_][A-Z0-9_]*)/g);
  if (matches) {
    for (const match of matches) {
      const varName = match.replace(/^\$/, '');
      if (
        varName.includes('API_KEY') ||
        varName.includes('_KEY') ||
        varName.includes('SECRET')
      ) {
        const value = process.env[varName];
        if (value) return value;
      }
    }
  }

  return undefined;
}

/**
 * Find a bearer token value from the auth description env var references.
 */
function resolveTokenFromContext(apiContext: ApiContextInfo): string | undefined {
  // Prefer explicitly provided token (e.g. from prior auth step response)
  if (apiContext.bearerToken) return apiContext.bearerToken;

  const searchText = apiContext.authDescription ?? '';
  const matches = searchText.match(/\$([A-Z_][A-Z0-9_]*)/g);

  if (matches) {
    for (const match of matches) {
      const varName = match.replace(/^\$/, '');
      if (varName.includes('TOKEN') || varName.includes('BEARER')) {
        const value = process.env[varName];
        if (value) return value;
      }
    }
  }

  return undefined;
}
