import test from 'node:test';
import assert from 'node:assert/strict';
import { Sheets, HEADERS, PREVIOUS_HEADERS } from '../src/sheets.js';
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
  assert.equal(append.requestBody.values[0][11], 'Done');
  assert.equal(append.requestBody.values[0][6], 'Profile bio');
  assert.equal(append.requestBody.values[0][4], 'Founder');
  assert.deepEqual(append.requestBody.values[0].slice(15, 18), ['=About()', 'Product launch', 'https://www.linkedin.com/posts/sample_launch']);
  assert.equal(append.requestBody.values[0][9], '');
  assert.equal(append.requestBody.values[0].length, 18);
  const formula = calls.find(c => c.valueInputOption === 'USER_ENTERED');
  assert.equal(formula.range, "'Outreach'!K2");
  assert.equal(formula.requestBody.values[0][0], SEND_FORMULA);
});
test('sync preserves user-edited Final Message while updating completion fields', async () => {
  const row = HEADERS.map(() => ''); row[0] = record.id; row[9] = 'My edit'; row[11] = 'Done'; row[12] = '2026-10-03T12:00:00Z';
  const { sheets, calls } = fixture([row]); await sheets.upsert(record);
  const raw = calls.find(c => c.requestBody.data);
  assert.deepEqual(raw.requestBody.data.map(r => r.range), ["'Outreach'!L2", "'Outreach'!M2", "'Outreach'!N2", "'Outreach'!O2", "'Outreach'!P2", "'Outreach'!Q2", "'Outreach'!R2"]);
  assert.equal(row[9], 'My edit'); assert.equal(row[11], 'Done');
});
test('link writes locate record after rows are reordered', async () => {
  const a = HEADERS.map(() => ''); a[0] = record.id;
  const b = HEADERS.map(() => ''); b[0] = 'other:dm';
  const { sheets, grid, calls } = fixture([a, b]);
  grid.splice(1, 2, b, a);
  await sheets.refreshLink(record.id);
  assert.equal(calls[0].range, "'Outreach'!K3");
});
test('duplicate IDs fail closed', async () => {
  const r = [record.id]; const { sheets } = fixture([r, r]);
  await assert.rejects(sheets.rows(), /duplicate/);
});

function migrationFixture(headers, columns = headers.length, extras = []) {
  const oldRow = Array(columns).fill(''); oldRow[0] = 'saved:dm';
  if (headers.includes('Final Message')) oldRow[headers.indexOf('Final Message')] = 'Keep my message';
  if (headers.includes('About')) oldRow[headers.indexOf('About')] = 'Keep About';
  const grid = [headers.slice(), oldRow]; const requests = [];
  const api = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 1, title: 'Outreach', gridProperties: { rowCount: 2, columnCount: columns } } }] } }),
    batchUpdate: async a => {
      requests.push(...a.requestBody.requests);
      for (const r of a.requestBody.requests) {
        if (r.deleteDimension) {
          const {startIndex, endIndex} = r.deleteDimension.range;
          for (const row of grid) row.splice(startIndex, endIndex - startIndex);
          columns -= endIndex - startIndex;
        }
        if (r.updateSheetProperties?.properties.gridProperties.columnCount) columns = r.updateSheetProperties.properties.gridProperties.columnCount;
        if (r.updateCells) grid[0] = r.updateCells.rows[0].values.map(v => v.userEnteredValue.stringValue);
      }
      return { data: {} };
    },
    values: {
      get: async a => ({ data: { values: a.range.includes('!R') ? extras : grid } }),
      batchGet: async () => ({ data: { valueRanges: [{ values: grid }] } }),
    },
  } };
  return { sheets: new Sheets({ sheetId: 'fixture', sheetTab: 'Outreach' }, api), grid, requests };
}

test('empty small sheet initializes eighteen columns', async () => {
  const {sheets, grid, requests} = migrationFixture([], 17);
  await sheets.init();
  assert.deepEqual(grid[0], HEADERS);
  assert.equal(requests.find(r => r.setDataValidation).setDataValidation.range.startColumnIndex, 11);
});

for (const previous of [PREVIOUS_HEADERS.slice(0, 17), PREVIOUS_HEADERS]) {
  test(`migrates ${previous.length} columns without losing messages or retained fields`, async () => {
    const {sheets, grid, requests} = migrationFixture(previous);
    const rows = await sheets.rows();
    assert.deepEqual(grid[0], HEADERS);
    assert.equal(rows[0]['Final Message'], 'Keep my message');
    assert.equal(rows[0].About, previous.length === 21 ? 'Keep About' : '');
    const deletes = requests.filter(r => r.deleteDimension).map(r => r.deleteDimension.range.startIndex);
    assert.deepEqual(deletes, previous.length === 21 ? [20, 9] : [9]);
    const count = requests.length;
    await sheets.rows();
    assert.equal(requests.length, count, 'rerun must not delete more columns');
  });
}

test('migration refuses to overwrite occupied enrichment columns', async () => {
  const {sheets, requests} = migrationFixture(PREVIOUS_HEADERS.slice(0, 17), 26, [[], ['User data']]);
  await assert.rejects(sheets.init(), /existing data/);
  assert.equal(requests.length, 0);
});
