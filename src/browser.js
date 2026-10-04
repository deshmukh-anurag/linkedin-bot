import { chromium } from 'playwright';
import fs from 'node:fs';
import { HaltError, SkipError, normalizeProfile, safeError } from './core.js';

export async function openBrowser(c) {
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  let browser, context;
  if (c.cdp) {
    browser = await chromium.connectOverCDP(c.cdp);
    context = browser.contexts()[0];
    if (!context) throw new Error('CDP endpoint has no browser context');
  } else {
    let proxy;
    const rawProxy = c.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (rawProxy) {
      const u = new URL(rawProxy);
      proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), bypass: 'localhost,127.0.0.1' };
    }
    const installed = '/opt/ms-playwright/chromium-1228/chrome-linux64/chrome';
    browser = await chromium.launch({ headless: c.headless,
      executablePath: c.executablePath || (fs.existsSync(installed) ? installed : undefined), proxy,
      args: ['--start-maximized'],
    });
    context = await browser.newContext({ viewport: null, storageState: fs.existsSync(c.storagePath) ? c.storagePath : undefined });
  }
  context.setDefaultTimeout(12000);
  const page = await context.newPage();
  const save = async () => {
    await context.storageState({ path: c.storagePath });
    fs.chmodSync(c.storagePath, 0o600);
  };
  return {
    page, save,
    async close() {
      try { await save(); }
      finally {
        if (c.cdp) await page.close(); // Leave the user's existing browser running.
        else await browser.close();
      }
    },
  };
}

export class LinkedIn {
  constructor(page, c) { this.page = page; this.c = c; }
  async primary() {
    const main = this.page.locator('main').first();
    const ownerColumn = main.locator('[data-testid="lazy-column"]').filter({ has: this.page.locator('[id$="Topcard"]') }).first();
    if (await ownerColumn.count()) return ownerColumn;
    const region = main.getByRole('region', { name: 'Primary content', exact: true }).first();
    return await region.count() ? region : main;
  }
  async guard() {
    if (/\/checkpoint|\/login|\/uas\/|\/authwall|\/challenge/.test(this.page.url())) {
      throw new HaltError('LinkedIn login or verification required; run npm run login');
    }
    const title = await this.page.title();
    if (/Attention Required|Access Denied|Security Verification/i.test(title)) throw new HaltError('LinkedIn access or verification blocked');
  }
  async visit(url) {
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if ([401, 403, 429].includes(response?.status())) throw new HaltError(`LinkedIn HTTP ${response.status()}; stopping this run`);
    await this.guard();
  }
  async verifySession() {
    await this.visit('https://www.linkedin.com/feed/');
    await this.page.locator('main').first().waitFor();
  }
  async discover(keyword, pageNumber) {
    const u = new URL('https://www.linkedin.com/search/results/people/');
    u.searchParams.set('keywords', keyword);
    u.searchParams.set('network', JSON.stringify([this.c.degree === 1 ? 'F' : 'S']));
    u.searchParams.set('page', String(pageNumber));
    await this.visit(u.href);
    const main = this.page.locator('main').first();
    await main.waitFor();
    // DOM-driven waits rather than sleep-based clicking.
    await main.locator('a[href*="/in/"]').first().waitFor({ timeout: 12000 }).catch(async e => {
      if (!/no results|no people found|try a different search/i.test(await main.innerText())) throw e;
    });
    const cards = main.locator('.reusable-search__result-container, [data-view-name="people-search-result"], [data-testid="search-result"], [componentkey*="SearchResult"], [componentkey*="search-result"]');
    // Only the owner link of a result card, never mutual-connection/sidebar links.
    const links = await cards.evaluateAll(nodes => nodes.filter(n => !n.closest('aside,[role="complementary"]')).flatMap(card => {
      const link = [...card.querySelectorAll('a[href*="/in/"]')].find(n => n.innerText.trim() || n.getAttribute('aria-label'));
      return link ? [{ url: link.href, name: link.innerText || link.getAttribute('aria-label') || '' }] : [];
    }));
    if (!links.length && !/no results|no people found|try a different search/i.test(await main.innerText())) {
      throw new HaltError('People search result cards not recognized; inspect the search layout before collecting');
    }
    const uSearch = u.href;
    const unique = new Map();
    for (const link of links) {
      try {
        const u = new URL(link.url); u.search = ''; u.hash = '';
        const url = normalizeProfile(u.href);
        const name = link.name.split('\n')[0].trim();
        if (!unique.has(url) || (!unique.get(url).name && name)) unique.set(url, { url, name, degree: this.c.degree, searchUrl: uSearch });
      } catch { /* Non-profile link. */ }
    }
    return [...unique.values()];
  }
  async profile(person) {
    if (!person.searchUrl) return this.extractProfile(person);
    const source = new URL(person.searchUrl);
    if (source.origin !== 'https://www.linkedin.com' || source.pathname !== '/search/results/people/') {
      throw new SkipError('Invalid search provenance');
    }
    let halted = false;
    try {
      return await this.extractProfile(person);
    } catch (e) {
      halted = e instanceof HaltError;
      throw e;
    } finally {
      // Stay on the same keyword/page between profiles, including extraction failures.
      // Do not navigate away from a login or verification screen.
      if (!halted) {
        await this.guard();
        await this.visit(source.href);
        await this.page.locator('main').first().waitFor();
      }
    }
  }
  async extractProfile(person) {
    await this.visit(person.url);
    let main = await this.primary();
    // LinkedIn serves both classic h1 profiles and a newer h2-based layout.
    const heading = main.getByRole('heading').first();
    await heading.waitFor();
    // The SDUI profile initially renders only its top card; wait for deferred sections.
    const pageMain = this.page.locator('main').first();
    if (await pageMain.locator('[componentkey]').count()) {
      await pageMain.getByRole('heading', { name: /^(About|Activity|Experience|Education)$/ }).first().waitFor({ timeout: 10000 }).catch(() => {});
      main = await this.primary();
    }
    const actual = normalizeProfile(this.page.url());
    if (actual !== person.url) throw new SkipError('Profile URL changed; review identity before continuing');
    const name = (await main.getByRole('heading').first().innerText()).trim();
    const bio = (await main.innerText()).slice(0, 22000);
    const extractionNotes = [];
    const optional = async (label, fn, fallback = '') => {
      try { return await fn(); }
      catch (e) {
        if (e instanceof HaltError) throw e;
        extractionNotes.push(`${label}: ${safeError(e)}`);
        return fallback;
      }
    };
    const headline = await optional('Headline', async () => {
      const headlineNode = main.locator('.text-body-medium').first();
      if (await headlineNode.count()) return (await headlineNode.innerText({ timeout: 3000 })).trim();
      return main.evaluate(el => {
        const top = el.querySelector('[id$="Topcard"]') || el;
        return [...top.querySelectorAll('p')].filter(n => n.checkVisibility())
          .map(n => n.innerText.trim()).find(t => t && !/^(?:[·•]\s*)?(?:1st|2nd|3rd\+?)$|^(?:he|she|they|him|her|them)(?:\s*[/|]\s*(?:he|she|they|him|her|them))+$/i.test(t)) || '';
      });
    });
    const about = await optional('About', () => this.about(main));
    const companies = await main.locator('a[href*="/company/"]').evaluateAll(nodes => nodes.map(n => ({ name: n.innerText, url: n.href })).filter(n => n.name));
    const message = main.getByRole('link', { name: /^Message(?: .*)?$/ }).first();
    const invite = main.getByRole('link', { name: /^(Connect|Invite .+ to connect)$/ }).first();
    const result = { ...person, name, headline, about, bio, companies,
      messagingUrl: await message.count() ? new URL(await message.getAttribute('href'), 'https://www.linkedin.com').href : '',
      invitationUrl: await invite.count() ? new URL(await invite.getAttribute('href'), 'https://www.linkedin.com').href : '',
    };
    const post = await optional('Recent Post', () => this.recentPost(main, person), { text: '', url: '' });
    return { ...result, recentPost: post.text, recentPostUrl: post.url, extractionNotes };
  }
  async about(root) {
    return root.evaluate(el => {
      const heading = [...el.querySelectorAll('h2,h3,[role="heading"]')].find(n => n.innerText.trim() === 'About');
      const marker = el.querySelector('#about');
      let section = marker?.closest('section') || heading?.closest('section');
      if (!section && heading) {
        section = heading.parentElement;
        while (section && section !== el && section.innerText.trim() === 'About') section = section.parentElement;
      }
      if (!section || section === el) return '';
      const content = section.querySelector('.inline-show-more-text, .pv-shared-text-with-see-more');
      if (content) return content.innerText.trim().slice(0, 22000);
      const copy = section.cloneNode(true);
      copy.querySelectorAll('h2,h3,[role="heading"],button,[aria-hidden="true"]').forEach(n => n.remove());
      return (copy.textContent || '').trim().slice(0, 22000);
    });
  }
  async postFrom(root) {
    return root.evaluate(el => {
      const cards = [...el.querySelectorAll('[data-urn*="activity"], .feed-shared-update-v2, .occludable-update, article, [componentkey^="update-card-focus"]')]
        .filter(n => !n.closest('aside,[role="complementary"]'));
      for (const card of cards) {
        const body = card.querySelector('.update-components-text, .feed-shared-update-v2__description, [data-test-id="main-feed-activity-card__commentary"]');
        const link = [...card.querySelectorAll('a[href]')].find(n => /\/posts\/|\/feed\/update\//.test(n.href));
        // Do not mistake a recommendation or an unrelated article for a post.
        if (!body && !link) continue;
        let url = '';
        if (link) {
          const u = new URL(link.href);
          if (u.protocol === 'https:' && /(^|\.)linkedin\.com$/i.test(u.hostname)) { u.search = ''; u.hash = ''; url = u.href; }
        }
        const modernBody = [...card.querySelectorAll('a[tabindex="0"][href]')].find(n => /\/posts\/|\/feed\/update\//.test(n.href) && n.innerText.trim());
        const text = (body?.innerText || modernBody?.innerText || '').trim().slice(0, 22000);
        if (text || url) return { text, url };
      }
      return { text: '', url: '' };
    });
  }
  async recentPost(main, person) {
    const visible = await this.postFrom(main);
    const links = await main.locator('a[href*="/recent-activity/"]').evaluateAll(nodes => nodes.map(n => n.href));
    const activity = links.find(raw => {
      try {
        const u = new URL(raw), profile = new URL(person.url);
        return u.origin === profile.origin && u.pathname === `${profile.pathname}recent-activity/posts/`;
      } catch { return false; }
    });
    if (!activity || visible.text || visible.url) return visible;
    await this.visit(activity);
    const root = await this.primary();
    await root.waitFor({ timeout: 8000 });
    await root.locator('.update-components-text, .feed-shared-update-v2__description, [data-test-id="main-feed-activity-card__commentary"]').first().waitFor({ timeout: 5000 }).catch(() => {});
    const post = await this.postFrom(root);
    return post.text ? post : visible;
  }
}
