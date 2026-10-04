import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { normalizeProfile, matchesKeyword } from '../src/core.js';
import { collect, sync } from '../src/workflow.js';
import { composeLink, SEND_FORMULA } from '../src/links.js';

const person = { url: 'https://www.linkedin.com/in/sample/', name: 'Sample', degree: 1,
  messagingUrl: 'https://www.linkedin.com/messaging/compose/?recipient=known-id&interop=msgOverlay' };
const c = { degree: 1, action: 'dm', keywords: ['founder'], pages: 1, maxProfiles: 50, profilesPerRun: 15 };
const payload = { person, keywords: ['founder'], draft: { direct_message: 'A draft', connection_note: 'A note', company_name: 'Example', role: 'Founder' }, research: { text: 'Research', sources: [] } };
function saved() { const store = new Store(':memory:'); store.discover(person, 'founder'); return { store, record: store.saveProfile(person, 'dm', payload) }; }

test('profile identity rejects unrelated domains and strips query tracking', () => {
  assert.equal(normalizeProfile('https://uk.linkedin.com/in/sample?trk=x'), person.url);
  assert.throws(() => normalizeProfile('https://linkedin.com.evil.test/in/sample'));
});
test('compose links retain only observed recipient; edited text can be encoded safely', () => {
  const link = composeLink(person, 'dm');
  assert.equal(link, 'https://www.linkedin.com/messaging/compose/?recipient=known-id');
  const withUrn = composeLink({ ...person, messagingUrl: person.messagingUrl + '&profileUrn=urn%3Ali%3Afsd_profile%3Aknown-id' }, 'dm');
  assert.equal(new URL(withUrn).searchParams.get('profileUrn'), 'urn:li:fsd_profile:known-id');
  const message = 'Hello & thanks!\nNamaskar 👋 #engineering';
  assert.equal(new URL(`${link}&body=${encodeURIComponent(message)}`).searchParams.get('body'), message);
  assert.ok(SEND_FORMULA.includes('ENCODEURL(INDEX(J:J,ROW()))'));
});
test('missing or unsafe messaging links fall back to profile without guessing recipient', () => {
  assert.equal(composeLink({ ...person, messagingUrl: '' }, 'dm'), person.url);
  assert.equal(composeLink({ ...person, messagingUrl: 'https://evil.test/messaging/compose/?recipient=x' }, 'dm'), person.url);
  assert.equal(composeLink({ ...person, invitationUrl: 'https://www.linkedin.com/preload/custom-invite/?vanityName=someone-else' }, 'connection_request'), person.url);
});
test('successful Sheet sync marks done automatically and preserves edited message', async () => {
  const { store, record } = saved();
  const row = { 'Record ID': record.id, 'Profile URL': person.url, 'Action Type': 'dm', 'Final Message': 'User-edited text' };
  const sheets = { rows: async () => [row], upsert: async () => ({ addedAt: '2026-10-04T12:00:00Z' }) };
  await sync(store, sheets); await sync(store, sheets);
  assert.equal(store.get(record.id).status, 'done');
  assert.equal(store.get(record.id).done_at, '2026-10-04T12:00:00.000Z');
  assert.equal(JSON.parse(store.get(record.id).payload).editedMessage, row['Final Message']);
  assert.equal(store.hasProfile(person.url), true);
  store.close();
});
test('Sheet failure remains pending; retry publishes saved draft without browser or Gemini', async () => {
  const { store, record } = saved(); let fail = true;
  const sheets = { rows: async () => [], upsert: async () => { if (fail) throw new Error('Sheet timeout'); return { addedAt: '2026-10-04T12:00:00Z' }; } };
  await assert.rejects(sync(store, sheets), /timeout/);
  assert.equal(store.get(record.id).status, 'pending_sheet'); assert.equal(store.get(record.id).done_at, null);
  fail = false; await sync(store, sheets);
  assert.equal(store.get(record.id).status, 'done'); store.close();
});
test('done profiles are never reopened even when keyword and connection degree change', async () => {
  const { store } = saved();
  const sheets = { rows: async () => [], upsert: async () => ({ addedAt: '2026-10-04T12:00:00Z' }) };
  await sync(store, sheets);
  const linkedin = { verifySession: async () => {}, discover: async () => [{ ...person, degree: 2 }], profile: async () => assert.fail('Revisited completed profile') };
  const result = await collect({ c: { ...c, degree: 2, action: 'connection_request', keywords: ['CTO'] }, store, sheets, linkedin, log: () => {} });
  assert.equal(result.scanned, 0); assert.equal(result.collected, 0); assert.equal(store.all().length, 1); store.close();
});
test('changed recipient in Sheet is rejected before importing edits', async () => {
  const { store, record } = saved();
  const sheets = { rows: async () => [{ 'Record ID': record.id, 'Profile URL': 'https://www.linkedin.com/in/other/', 'Action Type': 'dm' }] };
  await assert.rejects(sync(store, sheets), /identity/);
  assert.equal(store.get(record.id).status, 'pending_sheet'); store.close();
});
test('collection continues after three extraction errors and skips saved profiles on rerun', async () => {
  const store = new Store(':memory:');
  const people = Array.from({ length: 4 }, (_, i) => ({ ...person, url: `https://www.linkedin.com/in/person-${i}/` }));
  const records = new Map(); let extracted = 0;
  const sheets = { rows: async () => [], upsert: async r => { records.set(r.id, r); return {}; } };
  const linkedin = { verifySession: async () => {}, discover: async () => people, profile: async p => {
    if (p !== people[3]) throw new Error('Profile extraction timeout');
    extracted++; return { ...p, bio: 'Founder profile text', headline: 'Founder', companies: [] };
  } };
  const args = { c, store, sheets, linkedin, log: () => {} };
  assert.deepEqual(await collect(args), { scanned: 4, collected: 1, failed: 3 });
  await collect(args);
  assert.equal(extracted, 1); assert.equal(records.size, 1);
  const data = JSON.parse(store.all()[0].payload);
  assert.equal(data.person.bio, 'Founder profile text'); assert.equal(data.draft, undefined); assert.equal(data.research, undefined);
  store.close();
});

test('deleting a completed Sheet row never republishes or reopens the profile', async () => {
  const {store,record}=saved(); store.markDone(record.id);
  const sheets={rows:async()=>[],upsert:async()=>assert.fail('Deleted row recreated')};
  const linkedin={verifySession:async()=>{},discover:async()=>[person],profile:async()=>assert.fail('Deleted profile revisited')};
  await sync(store,sheets);
  await collect({c,store,sheets,linkedin,log:()=>{}});
  assert.equal(store.get(record.id).status,'done');store.close();
});

test('collection rejects nonmatching headlines and does not drain stale discovered contacts', async () => {
  const store=new Store(':memory:');
  store.discover({...person,url:'https://www.linkedin.com/in/stale/'},'founder');
  const written=[];
  const sheets={rows:async()=>[],upsert:async r=>{written.push(r);return {};}};
  const linkedin={verifySession:async()=>{},discover:async()=>[person],profile:async p=>{
    assert.equal(p.url,person.url);return {...p,headline:'Software Engineer',about:'Previously worked for a founder'};
  }};
  await collect({c,store,sheets,linkedin,log:()=>{}});
  assert.equal(written.length,0);assert.equal(store.all().length,0);store.close();
});


test('headline qualification respects word boundaries and configured keywords', () => {
  assert.equal(matchesKeyword('Co-Founder at Example', 'founder'), true);
  assert.equal(matchesKeyword('Cofounder at Example', 'co-founder'), true);
  assert.equal(matchesKeyword('CTO at Example', 'CTO'), true);
  assert.equal(matchesKeyword('Director at Example', 'CTO'), false);
  assert.equal(matchesKeyword('Engineering at Example', 'founder'), false);
  assert.equal(matchesKeyword('', 'founder'), false);
});
