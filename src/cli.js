import fs from 'node:fs';
import { config, requireValues } from './config.js';
import { Store } from './store.js';
import { Sheets } from './sheets.js';
import { openBrowser, LinkedIn } from './browser.js';
import { collect, sync } from './workflow.js';
import { safeError } from './core.js';

const command = process.argv[2] || 'help';
let store, session;
try {
  const c = config();
  if (command === 'help') {
    console.log('Commands: doctor, login, sheets-init, collect, sync, status. Sending is manual from the Sheet.');
  } else if (command === 'doctor') {
    console.table({
      'Node >=24': Number(process.versions.node.split('.')[0]) >= 24,
      'Google Sheet ID configured': Boolean(c.sheetId),
      'Google credentials file exists': Boolean(c.credentials && fs.existsSync(c.credentials)),
      'Browser session saved': fs.existsSync(c.storagePath),
    });
    console.log(`Search: ${c.keywords.join(', ')} | ${c.degree}-degree | target ${c.profilesPerRun} profiles`);
  } else if (command === 'login') {
    if (c.headless) throw new Error('Login needs HEADLESS=false');
    session = await openBrowser(c);
    await session.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
    console.log('Log in in the shared browser. Keep this process open while using it. Press Ctrl+C here to save the session and close this window.');
    const timer = setInterval(() => session.save().catch(() => {}), 10000);
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); session.page.once('close', resolve); });
    clearInterval(timer);
  } else if (['sheets-init', 'collect', 'sync', 'status'].includes(command)) {
    store = new Store(c.dbPath);
    store.lock();
    if (command === 'status') {
      console.table(store.all().map(r => ({ id: r.id, action: r.action, status: r.status, added: r.done_at || '', error: r.last_error || '' })));
    } else {
      requireValues(c, ['sheetId']);
      const sheets = new Sheets(c);
      if (command === 'sheets-init') { await sheets.init(); console.log(`Review Sheet: https://docs.google.com/spreadsheets/d/${c.sheetId}/edit`); }
      if (command === 'sync') { await sync(store, sheets); console.log('Sheet synchronized'); }
      if (command === 'collect') {
        await sheets.rows();
        session = await openBrowser(c);
        console.log(await collect({ c, store, sheets, linkedin: new LinkedIn(session.page, c) }));
      }
    }
  } else throw new Error(`Unknown command: ${command}`);
} catch (e) {
  console.error(safeError(e));
  process.exitCode = 1;
} finally {
  try { if (session) await session.close(); } catch (e) { console.error(`Browser cleanup: ${safeError(e)}`); }
  if (store) { store.unlock(); store.close(); }
}
