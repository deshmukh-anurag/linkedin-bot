import test from 'node:test';
import assert from 'node:assert/strict';
import { Sheets, HEADERS } from '../src/sheets.js';
import { SEND_FORMULA } from '../src/links.js';

const record = { id: 'sample:dm', profile_url: 'https://www.linkedin.com/in/sample/', action: 'dm', status: 'ready',
  payload: JSON.stringify({ person: { name: '=UNTRUSTED()', bio: 'Profile bio', headline: 'Founder', about: '=About()', recentPost: 'Product launch', recentPostUrl: 'https://www.linkedin.com/posts/sample_launch', companies: [{ name: 'Example', url: 'https://www.linkedin.com/company/example/' }], messagingUrl: 'https://www.linkedin.com/messaging/compose/?recipient=known-id' },
    keywords: ['founder'] }) };
function fixture(initial = []) {
  const grid = [HEADERS, ...initial]; const calls = [];
  const api = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: 'Outreach', gridProperties: { rowCount: grid.length } } }] } }),
    values: {
      batchGet: async () => ({ data: { valueRanges: [{ values: grid }] } }),
      append: async a => { calls.push(a); grid.push(...a.requestBody.values); },
      batchUpdate: async a => { calls.push(a); },
      update: async a => { calls.push(a); },
    },
  } };
  return { sheets: new Sheets({ sheetId: 'fixture', sheetTab: 'Outreach' }, api), grid, calls };
}
test('new Sheet row gets automatic completion and an independently written dynamic Send hyperlink', async () => {
  const { sheets, calls } = fixture(); await sheets.upsert(record);
  const append = calls.find(c => c.insertDataOption);
  assert.equal(append.valueInputOption, 'RAW');
  assert.equal(append.requestBody.values[0][1], '=UNTRUSTED()');
  assert.equal(append.requestBody.values[0][13], 'Done');
  assert.equal(append.requestBody.values[0][6], 'Profile bio');
  assert.equal(append.requestBody.values[0][4], 'Founder');
  assert.deepEqual(append.requestBody.values[0].slice(17, 20), ['=About()', 'Product launch', 'https://www.linkedin.com/posts/sample_launch']);
  assert.deepEqual(append.requestBody.values[0].slice(9, 12), ['', '', '']);
  const formula = calls.find(c => c.valueInputOption === 'USER_ENTERED');
  assert.equal(formula.range, "'Outreach'!M2");
  assert.equal(formula.requestBody.values[0][0], SEND_FORMULA);
});
test('sync preserves user-edited Final Message while updating completion fields', async () => {
  const row = HEADERS.map(() => ''); row[0] = record.id; row[11] = 'My edit'; row[13] = 'Done'; row[14] = '2026-10-03T12:00:00Z';
  const { sheets, calls } = fixture([row]); await sheets.upsert(record);
  const raw = calls.find(c => c.requestBody.data);
  assert.deepEqual(raw.requestBody.data.map(r => r.range), ["'Outreach'!N2", "'Outreach'!O2", "'Outreach'!P2", "'Outreach'!Q2", "'Outreach'!R2", "'Outreach'!S2", "'Outreach'!T2"]);
  assert.equal(row[11], 'My edit'); assert.equal(row[13], 'Done');
});
test('link writes locate record after rows are reordered', async () => {
  const a = HEADERS.map(() => ''); a[0] = record.id;
  const b = HEADERS.map(() => ''); b[0] = 'other:dm';
  const { sheets, grid, calls } = fixture([a, b]);
  grid.splice(1, 2, b, a);
  await sheets.refreshLink(record.id);
  assert.equal(calls[0].range, "'Outreach'!M3");
});
test('duplicate IDs fail closed', async () => {
  const r = [record.id]; const { sheets } = fixture([r, r]);
  await assert.rejects(sheets.rows(), /duplicate/);
});
test('initialization respects a 17-column sheet grid and removes manual status validation', async () => {
  let headers = []; const reads = [], requests = [];
  const api = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 1, title: 'Outreach', gridProperties: { rowCount: 2, columnCount: 17 } } }] } }),
    batchUpdate: async a => { requests.push(...a.requestBody.requests); return { data: {} }; },
    values: {
      get: async a => { reads.push(a.range); return { data: {} }; },
      update: async a => { headers = a.requestBody.values[0]; },
      batchGet: async () => ({ data: { valueRanges: [{ values: [headers] }] } }),
    },
  } };
  await new Sheets({ sheetId: 'fixture', sheetTab: 'Outreach' }, api).init();
  assert.deepEqual(reads, ["'Outreach'!A1:Q2"]);
  const dropdown = requests.find(r => r.setDataValidation).setDataValidation;
  assert.equal(dropdown.range.startColumnIndex, 13);
  assert.equal(dropdown.rule, undefined);
});

test('legacy Sheet migrates automatically without overwriting existing message cells', async () => {
  const oldRow = Array(17).fill(''); oldRow[0] = 'saved:dm'; oldRow[11] = 'Keep my message';
  const grid = [HEADERS.slice(0, 17), oldRow]; let columns = 17;
  const api = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 1, title: 'Outreach', gridProperties: { rowCount: 2, columnCount: columns } } }] } }),
    batchUpdate: async a => {
      for (const r of a.requestBody.requests) columns = r.updateSheetProperties?.properties.gridProperties.columnCount || columns;
      return { data: {} };
    },
    values: {
      get: async () => ({ data: { values: grid } }),
      update: async a => { assert.equal(columns, 21); assert.equal(a.range, "'Outreach'!A1:U1"); grid[0] = a.requestBody.values[0]; },
      batchGet: async a => { assert.ok(a.ranges.every(r => r.includes(columns === 17 ? ':Q' : ':U'))); return { data: { valueRanges: [{ values: grid }] } }; },
    },
  } };
  const rows = await new Sheets({ sheetId: 'fixture', sheetTab: 'Outreach' }, api).rows();
  assert.equal(columns, 21); assert.deepEqual(grid[0], HEADERS);
  assert.equal(rows[0]['Final Message'], 'Keep my message'); assert.equal(rows[0].About, '');
});

test('migration refuses to overwrite occupied enrichment columns', async () => {
  let writes = 0;
  const api = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 1, title: 'Outreach', gridProperties: { rowCount: 10, columnCount: 26 } } }] } }),
    values: {
      get: async a => ({ data: { values: a.range.includes('!R') ? [[], ['User data']] : [HEADERS.slice(0, 17)] } }),
      update: async () => { writes++; },
    },
  } };
  await assert.rejects(new Sheets({ sheetId: 'fixture', sheetTab: 'Outreach' }, api).init(), /existing data/);
  assert.equal(writes, 0);
});
