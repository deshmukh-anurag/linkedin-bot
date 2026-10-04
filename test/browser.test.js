import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { LinkedIn } from '../src/browser.js';

async function fixture(t, html) {
  const installed = '/opt/ms-playwright/chromium-1228/chrome-linux64/chrome';
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH || (fs.existsSync(installed) ? installed : undefined) });
  t.after(() => browser.close()); const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  return { page, linkedin: new LinkedIn(page, { degree: 1 }) };
}
test('profile scraper extracts recipient link without clicking or opening messaging', async t => {
  const { page, linkedin } = await fixture(t, `<main><section role="region" aria-label="Primary content"><h2>Sample Person</h2><p>Founder at Example</p>
    <a href="/messaging/compose/?recipient=sample-id&interop=msgOverlay">Message Sample Person</a></section>
    <aside><a href="/messaging/compose/?recipient=wrong-id">Message Someone Else</a></aside></main>
    <script>window.clicks=0;document.addEventListener('click',()=>window.clicks++);</script>`);
  const profile = await linkedin.profile({ url: 'https://www.linkedin.com/in/sample/' });
  assert.equal(new URL(profile.messagingUrl).searchParams.get('recipient'), 'sample-id');
  assert.equal(await page.evaluate(() => window.clicks), 0);
  assert.equal(typeof linkedin.prepareAction, 'undefined');
  assert.equal(new URL(page.url()).pathname, '/in/sample/');
});
test('discovery deduplicates results and excludes sidebar recommendations', async t => {
  const { linkedin } = await fixture(t, `<main><div data-view-name="people-search-result"><a href="/in/sample/?trk=1">Sample</a><a href="/in/mutual/">Mutual connection</a></div><div data-view-name="people-search-result"><a href="/in/sample/">Sample</a></div>
    <aside><a href="/in/irrelevant/">Other</a></aside></main>`);
  const people = await linkedin.discover('founder', 1);
  assert.equal(people.length, 1); assert.equal(people[0].url, 'https://www.linkedin.com/in/sample/');
});

test('extracts About and a visible recent post while excluding sidebar content', async t => {
  const { linkedin } = await fixture(t, `<main><h1>Sample</h1><p class="text-body-medium">Founder at Example</p>
    <section><div id="about"></div><h2>About</h2><div class="inline-show-more-text">I build useful tools.</div></section>
    <section><h2>Activity</h2><article><div class="update-components-text">We launched a new product.</div><a href="/posts/sample_launch?trk=x">Post</a></article></section>
    <aside><article><div class="update-components-text">Unrelated</div></article></aside></main>`);
  const p = await linkedin.profile({ url: 'https://www.linkedin.com/in/sample/' });
  assert.equal(p.headline, 'Founder at Example');
  assert.equal(p.about, 'I build useful tools.');
  assert.equal(p.recentPost, 'We launched a new product.');
  assert.equal(p.recentPostUrl, 'https://www.linkedin.com/posts/sample_launch');
});

test('optional extraction errors preserve the profile and record notes', async t => {
  const { linkedin } = await fixture(t, '<main><h1>Sample</h1><p>Founder</p></main>');
  linkedin.about = async () => { throw new Error('Detached About section'); };
  linkedin.recentPost = async () => { throw new Error('Activity timeout'); };
  const p = await linkedin.profile({ url: 'https://www.linkedin.com/in/sample/' });
  assert.equal(p.name, 'Sample'); assert.equal(p.about, ''); assert.equal(p.recentPost, '');
  assert.equal(p.extractionNotes.length, 2);
});

test('reads an observed owner-specific Posts activity link', async t => {
  const { page, linkedin } = await fixture(t, '<main></main>');
  await page.route('**/in/sample/', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main><h1>Sample</h1><a href="/in/sample/recent-activity/posts/">Show all posts</a></main>' }));
  await page.route('**/recent-activity/posts/', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main><article><div class="update-components-text">Latest visible post</div><a href="/feed/update/urn:li:activity:123/">Permalink</a></article></main>' }));
  const p = await linkedin.profile({ url: 'https://www.linkedin.com/in/sample/' });
  assert.equal(p.recentPost, 'Latest visible post');
  assert.equal(p.name, 'Sample');
});

test('waits for deferred SDUI profile sections and excludes recommendation columns', async t => {
  const { linkedin } = await fixture(t, `<main><div data-testid="lazy-column" id="owner">
    <div id="sampleTopcard" componentkey="top"><section><h2>Sample</h2><p>He/Him</p><p>· 1st</p><p>Founder at Example</p></section></div>
    </div><div data-testid="lazy-column"><h2>More profiles for you</h2><p>Wrong headline</p></div></main>
    <script>setTimeout(() => document.querySelector('#owner').insertAdjacentHTML('beforeend', '<section><h2>About</h2><p>Building useful tools.</p></section><section><h2>Activity</h2><div componentkey="update-card-focus123"><a tabindex="0" href="/feed/update/urn:li:activity:123/">Launch announcement</a></div></section>'), 300);</script>`);
  const p = await linkedin.profile({ url: 'https://www.linkedin.com/in/sample/' });
  assert.equal(p.headline, 'Founder at Example');
  assert.equal(p.about, 'Building useful tools.');
  assert.equal(p.recentPost, 'Launch announcement');
  assert.ok(!p.bio.includes('Wrong headline'));
});

test('keeps newest media post URL without substituting an older text post', async t => {
  const { linkedin } = await fixture(t, `<main><h1>Sample</h1><section><h2>Activity</h2>
    <div componentkey="update-card-focus1"><a tabindex="0" href="/feed/update/urn:li:activity:123/"><img alt="Photo"></a></div>
    <div componentkey="update-card-focus2"><a tabindex="0" href="/feed/update/urn:li:activity:122/">Older text</a></div></section></main>`);
  const p = await linkedin.profile({ url: 'https://www.linkedin.com/in/sample/' });
  assert.equal(p.recentPost, '');
  assert.equal(p.recentPostUrl, 'https://www.linkedin.com/feed/update/urn:li:activity:123/');
});

test('returns to exact keyword search page after each profile and after extraction errors', async t => {
  const {page, linkedin} = await fixture(t, '<main><h1>Sample</h1><p>Founder</p></main>');
  const searchUrl='https://www.linkedin.com/search/results/people/?keywords=founder&network=%5B%22F%22%5D&page=2';
  await linkedin.profile({url:'https://www.linkedin.com/in/sample/',searchUrl});
  assert.equal(page.url(),searchUrl);
  linkedin.extractProfile = async () => { await page.goto('https://www.linkedin.com/in/other/'); throw new Error('Extraction failed'); };
  await assert.rejects(linkedin.profile({url:'https://www.linkedin.com/in/other/',searchUrl}), /Extraction failed/);
  assert.equal(page.url(),searchUrl);
});

test('unknown result layout does not collect arbitrary profile links', async t => {
  const {linkedin} = await fixture(t, '<main><a href="/in/recommendation/">Recommended person</a></main>');
  await assert.rejects(linkedin.discover('founder',1), /not recognized/);
});

test('access blocks do not navigate back to search', async t => {
  const {page,linkedin}=await fixture(t,'<main>Blocked</main>');
  await page.route('**/in/blocked/',route=>route.fulfill({status:429,contentType:'text/html',body:'<main>Rate limited</main>'}));
  await assert.rejects(linkedin.profile({url:'https://www.linkedin.com/in/blocked/',searchUrl:'https://www.linkedin.com/search/results/people/?keywords=founder'}),/HTTP 429/);
  assert.equal(page.url(),'https://www.linkedin.com/in/blocked/');
});
