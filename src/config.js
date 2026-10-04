import 'dotenv/config';
import path from 'node:path';

export function config(env = process.env) {
  const integer = (key, fallback, min = 1, max = 10000) => {
    const n = Number(env[key] || fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const bool = (key, fallback) => {
    const v = env[key] ?? String(fallback);
    if (!['true', 'false'].includes(v)) throw new Error(`${key} must be true or false`);
    return v === 'true';
  };
  const stateDir = path.resolve(env.STATE_DIR || '.runtime');
  const degree = integer('LINKEDIN_CONNECTION_DEGREE', 1, 1, 2);
  return {
    stateDir, dbPath: path.join(stateDir, 'state.sqlite'),
    storagePath: path.join(stateDir, 'browser-state.json'),
    keywords: [...new Set((env.LINKEDIN_SEARCH_KEYWORDS || 'founder').split(',').map(s => s.trim()).filter(Boolean))],
    degree, action: degree === 1 ? 'dm' : 'connection_request',
    profilesPerRun: integer('PROFILES_PER_RUN', env.DRAFTS_PER_RUN || 15), pages: integer('MAX_SEARCH_PAGES', 5, 1, 100),
    maxProfiles: integer('MAX_PROFILES_PER_RUN', 50),
    sheetId: env.GOOGLE_SHEET_ID, sheetTab: env.GOOGLE_SHEET_TAB || 'Outreach',
    credentials: env.GOOGLE_APPLICATION_CREDENTIALS,
    headless: bool('HEADLESS', false), executablePath: env.BROWSER_EXECUTABLE_PATH || undefined,
    cdp: env.BROWSER_CDP_URL, proxy: env.BROWSER_PROXY_URL,
  };
}

export function requireValues(c, keys) {
  const missing = keys.filter(k => !c[k]);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
}
