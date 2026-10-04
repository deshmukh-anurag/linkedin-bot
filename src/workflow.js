import { now, safeError, HaltError, matchesKeyword } from './core.js';

export async function sync(store, sheets) {
  const rows = await sheets.rows();
  for (const row of rows) {
    const record = store.get(row['Record ID']);
    if (!record) continue;
    if (row['Profile URL'] !== record.profile_url || row['Action Type'] !== record.action) throw new Error('Sheet recipient/action changed; restore original identity fields');
    store.recordEditedMessage(record.id, row['Final Message']);
  }
  for (const record of store.all()) {
    // Completion is permanent: removing a published row is the user's decision.
    if (record.status !== 'pending_sheet') continue;
    const result = await sheets.upsert(record);
    store.markDone(record.id, result?.addedAt);
  }
}

export async function collect({ c, store, sheets, linkedin, log = console.log }) {
  await sync(store, sheets); // Retry saved profiles without revisiting LinkedIn.
  await linkedin.verifySession();
  let scanned = 0, collected = 0, failed = 0;
  const seen = new Set();
  const processPerson = async (person, keyword) => {
    store.discover(person, keyword);
    if (seen.has(person.url) || store.hasProfile(person.url)) return;
    if (scanned >= c.maxProfiles || collected >= c.profilesPerRun) return;
    seen.add(person.url); scanned++;
    try {
      const profile = await linkedin.profile(person);
      if (!matchesKeyword(profile.headline, keyword)) {
        log(`Profile skipped: headline does not match ${keyword}`);
        return;
      }
      const contact = store.contacts().find(p => p.profile_url === person.url);
      const record = store.saveProfile(profile, c.action, { person: profile,
        keywords: JSON.parse(contact.keywords), createdAt: now() });
      collected++;
      const result = await sheets.upsert(record);
      store.markDone(record.id, result?.addedAt);
      log(`Profile saved: ${record.id}`);
    } catch (e) {
      failed++;
      store.error(person.url, 'collect', safeError(e));
      log(`Profile deferred: ${safeError(e)}`);
      if (e instanceof HaltError) throw e;
    }
  };
  // Rediscover from page 1 each run. Database identity, never result position, is the checkpoint.
  for (const keyword of c.keywords) {
    for (let n = 1; n <= c.pages; n++) {
      if (scanned >= c.maxProfiles || collected >= c.profilesPerRun) break;
      const people = await linkedin.discover(keyword, n);
      if (!people.length) break;
      // Save all discovered identities even when this run's collection target is reached.
      for (const person of people) store.discover(person, keyword);
      for (const person of people) await processPerson(person, keyword);
    }
  }
  await sync(store, sheets);
  return { scanned, collected, failed };
}
