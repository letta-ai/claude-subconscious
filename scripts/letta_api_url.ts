/**
 * Shared Letta API URL helpers.
 *
 * Centralizes base URL normalization and endpoint URL construction.
 */

export type LettaApiQueryValue = string | number | boolean | null | undefined;

export type LettaApiQuery = Record<string, LettaApiQueryValue>;

export function normalizeLettaBaseUrl(baseUrl = process.env.LETTA_BASE_URL): string {
  const rawBase = baseUrl?.trim() || 'https://api.letta.com';
  return rawBase.replace(/\/+$/, '');
}

export function getLettaApiBase(baseUrl = process.env.LETTA_BASE_URL): string {
  const normalizedBase = normalizeLettaBaseUrl(baseUrl);
  return normalizedBase.endsWith('/v1')
    ? normalizedBase
    : `${normalizedBase}/v1`;
}

export const LETTA_BASE_URL = normalizeLettaBaseUrl();
export const LETTA_API_BASE = getLettaApiBase();

export function buildLettaApiUrl(
  path: string,
  query: LettaApiQuery = {},
  apiBase: string = LETTA_API_BASE,
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const normalizedApiBase = apiBase.replace(/\/+$/, '');
  const url = new URL(`${normalizedApiBase}${normalizedPath}`);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}