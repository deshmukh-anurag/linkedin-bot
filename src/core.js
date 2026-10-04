import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const now = () => new Date().toISOString();
export function normalizeProfile(raw) {
  const u = new URL(raw, 'https://www.linkedin.com');
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname) || !/^\/in\/[^/]+\/?$/.test(u.pathname)) throw new Error('Invalid LinkedIn profile URL');
  return `https://www.linkedin.com${u.pathname.replace(/\/$/, '')}/`;
}
export const contactId = url => hash(normalizeProfile(url)).slice(0, 24);
export const recordId = (url, action) => `${contactId(url)}:${action}`;

export class HaltError extends Error {}
export class SkipError extends Error {}
export function safeError(e) {
  return String(e?.message || e).replace(/https?:\/\/[^\s]+/g, '[URL redacted]').replace(/(key|token|password|authorization)\s*[:=]\s*[^\s,]+/gi, '$1=[redacted]').slice(0, 700);
}
export async function retry(fn, attempts = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const status = e.status || e.response?.status || e.code;
      if (i >= attempts - 1 || ![429, 500, 502, 503, 504, 'ETIMEDOUT', 'ECONNRESET'].includes(status)) throw e;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** i, 8000)));
    }
  }
}
