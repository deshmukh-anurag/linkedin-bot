import { google } from 'googleapis';
import { retry, now } from './core.js';
import { composeLink, SEND_FORMULA } from './links.js';

export const HEADERS = ['Record ID', 'Name', 'Profile URL', 'Companies (profile)', 'Headline', 'Matched Keywords',
  'Profile Text', 'Company Links', 'Action Type', 'DM Draft', 'Connection Note', 'Final Message',
  'Send', 'State', 'Added At', 'Last Error', 'Messaging URL', 'About', 'Recent Post', 'Recent Post URL', 'Extraction Notes'];
const LEGACY_HEADERS = HEADERS.slice(0, 17);
const quote = s => `'${s.replaceAll("'", "''")}'`;
const column = i => String.fromCharCode(65 + i);

export class Sheets {
  constructor(c, api) {
    this.c = c;
    this.api = api || google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({
      keyFile: c.credentials || undefined, scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    }) });
    this.root = quote(c.sheetTab);
  }
  async metadata() {
    if (this.cachedMetadata && Date.now() - this.cachedAt < 30000) return this.cachedMetadata;
    const { data } = await retry(() => this.api.spreadsheets.get({ spreadsheetId: this.c.sheetId, fields: 'sheets.properties' }));
    const sheet = data.sheets.find(s => s.properties.title === this.c.sheetTab);
    if (!sheet) throw new Error(`Tab ${this.c.sheetTab} missing; run npm run sheets:init`);
    this.cachedMetadata = sheet.properties;
    this.cachedAt = Date.now();
    return sheet.properties;
  }
  async init() {
    const { data } = await this.api.spreadsheets.get({ spreadsheetId: this.c.sheetId, fields: 'sheets.properties' });
    let props = data.sheets.find(s => s.properties.title === this.c.sheetTab)?.properties;
    if (!props) {
      const added = await this.api.spreadsheets.batchUpdate({ spreadsheetId: this.c.sheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: this.c.sheetTab, gridProperties: { rowCount: 2000, columnCount: HEADERS.length, frozenRowCount: 1 } } } }] } });
      props = added.data.replies[0].addSheet.properties;
    }
    const inspectEnd = column(Math.min(props.gridProperties.columnCount, HEADERS.length + 1) - 1);
    const existing = await this.api.spreadsheets.values.get({ spreadsheetId: this.c.sheetId, range: `${this.root}!A1:${inspectEnd}2` });
    const header = existing.data.values?.[0] || [];
    const legacy = JSON.stringify(header) === JSON.stringify(LEGACY_HEADERS);
    if (header.length && !legacy && JSON.stringify(header) !== JSON.stringify(HEADERS)) {
      throw new Error('Existing tab has different headers; choose a new dedicated tab. Nothing overwritten.');
    }
    // Never overwrite user data occupying the newly added columns.
    if (legacy && props.gridProperties.columnCount > 17) {
      const extra = await this.api.spreadsheets.values.get({ spreadsheetId: this.c.sheetId,
        range: `${this.root}!R1:${column(Math.min(props.gridProperties.columnCount, HEADERS.length) - 1)}${props.gridProperties.rowCount}` });
      if (extra.data.values?.some(row => row.some(v => v !== ''))) throw new Error('New profile columns contain existing data; choose a new dedicated tab');
    }
    if (props.gridProperties.columnCount < HEADERS.length) {
      await this.api.spreadsheets.batchUpdate({ spreadsheetId: this.c.sheetId, requestBody: { requests: [
        { updateSheetProperties: { properties: { sheetId: props.sheetId, gridProperties: { columnCount: HEADERS.length } }, fields: 'gridProperties.columnCount' } },
      ] } });
    }
    await this.api.spreadsheets.values.update({ spreadsheetId: this.c.sheetId, range: `${this.root}!A1:U1`, valueInputOption: 'RAW', requestBody: { values: [HEADERS] } });
    this.cachedMetadata = null;
    const range = { sheetId: props.sheetId, startRowIndex: 1, endRowIndex: props.gridProperties.rowCount };
    await this.api.spreadsheets.batchUpdate({ spreadsheetId: this.c.sheetId, requestBody: { requests: [
      { updateSheetProperties: { properties: { sheetId: props.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId: props.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.12, green: 0.2, blue: 0.33 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } }, fields: 'userEnteredFormat' } },
      { setDataValidation: { range: { ...range, startColumnIndex: 13, endColumnIndex: 14 } } },
      { repeatCell: { range: { ...range, startColumnIndex: 12, endColumnIndex: 13 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.85, green: 0.93, blue: 1 }, textFormat: { bold: true } } }, fields: 'userEnteredFormat' } },
    ] } });
    await this.rows();
  }
  async rows() {
    const props = await this.metadata();
    const values = [], ranges = [], starts = [];
    // Bounded reads; retain actual row numbers, including blank rows.
    for (let start = 1; start <= props.gridProperties.rowCount; start += 500) {
      const end = Math.min(start + 499, props.gridProperties.rowCount);
      const endColumn = column(Math.min(props.gridProperties.columnCount || HEADERS.length, HEADERS.length) - 1);
      ranges.push(`${this.root}!A${start}:${endColumn}${end}`); starts.push(start);
    }
    const res = await retry(() => this.api.spreadsheets.values.batchGet({ spreadsheetId: this.c.sheetId, ranges }));
    for (const [index, range] of (res.data.valueRanges || []).entries()) {
      for (const [offset, cells] of (range.values || []).entries()) values.push({ cells, number: starts[index] + offset });
    }
    const header = values.find(r => r.number === 1)?.cells;
    if (JSON.stringify(header) === JSON.stringify(LEGACY_HEADERS)) {
      await this.init();
      return this.rows();
    }
    if (JSON.stringify(header) !== JSON.stringify(HEADERS)) throw new Error('Sheet headers changed');
    const seen = new Set();
    return values.filter(r => r.number > 1 && r.cells.some(Boolean)).map(({ cells, number }) => {
      const row = Object.fromEntries(HEADERS.map((h, i) => [h, String(cells[i] ?? '')]));
      if (!row['Record ID'] || seen.has(row['Record ID'])) throw new Error('Sheet has missing or duplicate Record IDs');
      seen.add(row['Record ID']);
      return { ...row, _row: number };
    });
  }
  async row(id) { return (await this.rows()).find(r => r['Record ID'] === id); }
  async patch(id, fields) {
    const row = await this.row(id);
    if (!row) throw new Error(`Sheet row missing for ${id}`);
    const data = Object.entries(fields).map(([key, value]) => {
      const i = HEADERS.indexOf(key);
      if (i < 0) throw new Error(`Unknown column ${key}`);
      return { range: `${this.root}!${column(i)}${row._row}`, values: [[value ?? '']] };
    });
    await retry(() => this.api.spreadsheets.values.batchUpdate({ spreadsheetId: this.c.sheetId, requestBody: { valueInputOption: 'RAW', data } }));
  }
  async upsert(record) {
    const existing = await this.row(record.id);
    const p = JSON.parse(record.payload);
    const url = composeLink({ ...p.person, url: record.profile_url }, record.action);
    const addedAt = record.done_at || existing?.['Added At'] || now();
    if (existing) {
      // Preserve user-edited message; completion describes publishing to the Sheet only.
      const fields = { State: 'Done', 'Added At': addedAt, 'Last Error': '', 'Messaging URL': url };
      // Backfill only empty enrichment cells from saved data, without revisiting profiles.
      for (const [key, value] of Object.entries({ About: p.person.about, 'Recent Post': p.person.recentPost,
        'Recent Post URL': p.person.recentPostUrl, 'Extraction Notes': p.person.extractionNotes?.join('\n') })) {
        if (!existing[key] && value) fields[key] = value;
      }
      await this.patch(record.id, fields);
      await this.refreshLink(record.id);
      return { addedAt };
    }
    const row = { 'Record ID': record.id, Name: p.person.name, 'Profile URL': record.profile_url,
      'Companies (profile)': [...new Set((p.person.companies || []).map(c => c.name).filter(Boolean))].join('\n'),
      Headline: p.person.headline || '', 'Matched Keywords': p.keywords.join(', '),
      'Profile Text': p.person.bio || '', 'Company Links': [...new Set((p.person.companies || []).map(c => c.url).filter(Boolean))].join('\n'),
      'Action Type': record.action, 'DM Draft': p.draft?.direct_message || '', 'Connection Note': p.draft?.connection_note || '',
      'Final Message': p.editedMessage ?? p.manualReview?.message ?? (record.action === 'dm' ? p.draft?.direct_message : p.draft?.connection_note) ?? '',
      Send: '', State: 'Done', 'Added At': addedAt, 'Last Error': '', 'Messaging URL': url,
      About: p.person.about || '', 'Recent Post': p.person.recentPost || '', 'Recent Post URL': p.person.recentPostUrl || '',
      'Extraction Notes': (p.person.extractionNotes || []).join('\n') };
    // Append isn't idempotent. Do not blindly retry on timeout; next sync re-reads IDs first.
    await this.api.spreadsheets.values.append({ spreadsheetId: this.c.sheetId, range: `${this.root}!A:U`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [HEADERS.map(h => row[h] || '')] } });
    this.cachedMetadata = null; // Appends may expand the grid.
    await this.refreshLink(record.id);
    return { addedAt };
  }
  async refreshLink(id) {
    const row = await this.row(id);
    if (!row) throw new Error(`Missing Sheet row ${id}`);
    await retry(() => this.api.spreadsheets.values.update({ spreadsheetId: this.c.sheetId,
      range: `${this.root}!M${row._row}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[SEND_FORMULA]] } }));
  }
}
