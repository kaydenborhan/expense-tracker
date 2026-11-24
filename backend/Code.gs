/**
 * Expense Tracker backend (Google Apps Script)
 *
 * - Stores expenses in a Google Sheet and receipt photos in a Drive folder
 * - Reads receipts / spoken expenses with Claude
 * - Protected by a secret token (APP_TOKEN) that the phone app sends with every call
 *
 * Setup: see README.md. Run setup() once, set ANTHROPIC_API_KEY in Script Properties,
 * then Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 */

const MODEL_RECEIPT = 'claude-sonnet-5-5'; // reads photos: accuracy matters
const MODEL_TEXT = 'claude-haiku-5-5';     // reads short spoken text: speed matters
const BASE_CURRENCY = 'MYR';

const EXPENSE_HEADERS = [
  'ID', 'Date', 'Entity', 'Category', 'Vendor', 'Details',
  'Amount', 'Currency', 'Rate to MYR', 'Amount MYR',
  'Source', 'Receipt link', 'Receipt file ID', 'Created', 'Updated'
];

const DEFAULT_CATEGORIES = [
  'Fuel', 'Food & Drink', 'Groceries', 'Parking & Tolls', 'Transport',
  'Vehicle Maintenance', 'Parts & Supplies', 'Tools & Equipment',
  'Advertising & Marketing', 'Software & Subscriptions', 'Phone & Internet',
  'Utilities', 'Rent', 'Shopping', 'Health', 'Entertainment', 'Other'
];
const DEFAULT_ENTITIES = ['Personal', 'Business'];

/* ------------------------------------------------------------------ */
/* One-time setup                                                      */
/* ------------------------------------------------------------------ */

function setup() {
  const props = PropertiesService.getScriptProperties();

  if (!props.getProperty('APP_TOKEN')) {
    props.setProperty('APP_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }

  if (!props.getProperty('SHEET_ID')) {
    const folder = DriveApp.createFolder('Expense Tracker');
    const receipts = folder.createFolder('Receipts');

    const ss = SpreadsheetApp.create('Expenses');
    DriveApp.getFileById(ss.getId()).moveTo(folder);
    ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());

    const exp = ss.getSheets()[0];
    exp.setName('Expenses');
    exp.getRange(1, 1, 1, EXPENSE_HEADERS.length).setValues([EXPENSE_HEADERS])
      .setFontWeight('bold').setBackground('#e8f0fe');
    exp.setFrozenRows(1);
    exp.getRange('B:B').setNumberFormat('yyyy-mm-dd');
    exp.getRange('G:G').setNumberFormat('#,##0.00');
    exp.getRange('I:I').setNumberFormat('0.000000');
    exp.getRange('J:J').setNumberFormat('#,##0.00');

    const cats = ss.insertSheet('Categories');
    cats.getRange(1, 1).setValue('Category').setFontWeight('bold');
    cats.getRange(2, 1, DEFAULT_CATEGORIES.length, 1).setValues(DEFAULT_CATEGORIES.map(c => [c]));

    const ents = ss.insertSheet('Entities');
    ents.getRange(1, 1).setValue('Entity').setFontWeight('bold');
    ents.getRange(2, 1, DEFAULT_ENTITIES.length, 1).setValues(DEFAULT_ENTITIES.map(c => [c]));

    props.setProperty('SHEET_ID', ss.getId());
    props.setProperty('RECEIPTS_ID', receipts.getId());
    props.setProperty('FOLDER_ID', folder.getId());
  }

  const hasKey = !!props.getProperty('ANTHROPIC_API_KEY');
  Logger.log('Setup complete.');
  Logger.log('Your APP TOKEN (paste into the phone app): ' + props.getProperty('APP_TOKEN'));
  Logger.log('Drive folder: https://drive.google.com/drive/folders/' + props.getProperty('FOLDER_ID'));
  Logger.log(hasKey
    ? 'Anthropic API key: found.'
    : 'NEXT: add ANTHROPIC_API_KEY under Project Settings > Script Properties.');
}

/** Run this any time to re-print your token. */
function showToken() {
  Logger.log(PropertiesService.getScriptProperties().getProperty('APP_TOKEN'));
}

/* ------------------------------------------------------------------ */
/* Web app entry points                                                */
/* ------------------------------------------------------------------ */

function doGet() {
  return ContentService.createTextOutput('Expense Tracker backend is running.');
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req.token || req.token !== prop_('APP_TOKEN')) throw new Error('Unauthorized: wrong token');
    out = route_(req);
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function route_(req) {
  switch (req.action) {
    case 'sync':         return sync_();
    case 'upsert':       return withLock_(() => upsert_(req));
    case 'delete':       return withLock_(() => delete_(req.id));
    case 'addCategory':  return withLock_(() => addListItem_('Categories', req.name));
    case 'addEntity':    return withLock_(() => addListItem_('Entities', req.name));
    case 'parseReceipt': return parseReceipt_(req);
    case 'parseText':    return parseText_(req);
    case 'getReceipt':   return getReceipt_(req.fileId);
    default: throw new Error('Unknown action: ' + req.action);
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function ss_() { return SpreadsheetApp.openById(prop_('SHEET_ID')); }

/* ------------------------------------------------------------------ */
/* Sheet read / write                                                  */
/* ------------------------------------------------------------------ */

function sync_() {
  const ss = ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const sh = ss.getSheetByName('Expenses');
  const last = sh.getLastRow();
  const expenses = [];
  if (last > 1) {
    const rows = sh.getRange(2, 1, last - 1, EXPENSE_HEADERS.length).getValues();
    rows.forEach(r => {
      if (!r[0]) return;
      expenses.push({
        id: String(r[0]),
        date: toDateStr_(r[1], tz),
        entity: String(r[2]),
        category: String(r[3]),
        vendor: String(r[4]),
        details: String(r[5]),
        amount: Number(r[6]) || 0,
        currency: String(r[7] || BASE_CURRENCY),
        rate: Number(r[8]) || 1,
        amountMYR: Number(r[9]) || 0,
        source: String(r[10]),
        receiptUrl: String(r[11]),
        receiptFileId: String(r[12]),
        createdAt: Number(r[13]) || 0,
        updatedAt: Number(r[14]) || 0
      });
    });
  }
  return {
    ok: true,
    expenses: expenses,
    categories: readList_(ss, 'Categories'),
    entities: readList_(ss, 'Entities')
  };
}

function readList_(ss, name) {
  const sh = ss.getSheetByName(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0]).trim()).filter(Boolean);
}

function toDateStr_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

function findRow_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

function upsert_(req) {
  const e = req.expense;
  if (!e || !e.id) throw new Error('Missing expense');
  const ss = ss_();
  const sh = ss.getSheetByName('Expenses');
  let rowIdx = findRow_(sh, e.id);
  const existing = rowIdx > 0 ? sh.getRange(rowIdx, 1, 1, EXPENSE_HEADERS.length).getValues()[0] : null;

  // Keep any receipt already stored; only save an image once.
  let fileId = existing ? String(existing[12]) : '';
  let fileUrl = existing ? String(existing[11]) : '';
  if (!fileId && e.receiptFileId) { fileId = e.receiptFileId; fileUrl = e.receiptUrl || ''; }
  if (!fileId && req.image) {
    const bytes = Utilities.base64Decode(req.image);
    const safe = s => String(s || '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
    const name = [e.date, safe(e.vendor || e.category), Number(e.amountMYR || 0).toFixed(2), String(e.id).slice(0, 6)]
      .filter(Boolean).join('_') + '.jpg';
    const blob = Utilities.newBlob(bytes, req.mime || 'image/jpeg', name);
    const file = DriveApp.getFolderById(prop_('RECEIPTS_ID')).createFile(blob);
    fileId = file.getId();
    fileUrl = file.getUrl();
  }

  const row = [
    e.id, e.date, e.entity, e.category, e.vendor || '', e.details || '',
    Number(e.amount) || 0, e.currency || BASE_CURRENCY, Number(e.rate) || 1, Number(e.amountMYR) || 0,
    e.source || 'manual', fileUrl, fileId,
    existing ? existing[13] : (e.createdAt || Date.now()), Date.now()
  ];
  if (rowIdx < 1) rowIdx = sh.getLastRow() + 1;
  sh.getRange(rowIdx, 1, 1, row.length).setValues([row]);

  // make sure a brand-new category / entity is also in the lists
  ensureListItem_(ss, 'Categories', e.category);
  ensureListItem_(ss, 'Entities', e.entity);

  return { ok: true, expense: { id: e.id, receiptFileId: fileId, receiptUrl: fileUrl } };
}

function delete_(id) {
  const sh = ss_().getSheetByName('Expenses');
  const rowIdx = findRow_(sh, id);
  if (rowIdx > 0) {
    const fileId = String(sh.getRange(rowIdx, 13).getValue() || '');
    sh.deleteRow(rowIdx);
    if (fileId) { try { DriveApp.getFileById(fileId).setTrashed(true); } catch (err) {} }
  }
  return { ok: true };
}

function addListItem_(sheetName, name) {
  ensureListItem_(ss_(), sheetName, name);
  return { ok: true };
}

function ensureListItem_(ss, sheetName, name) {
  name = String(name || '').trim();
  if (!name) return;
  const sh = ss.getSheetByName(sheetName);
  const have = readList_(ss, sheetName).map(s => s.toLowerCase());
  if (have.indexOf(name.toLowerCase()) < 0) sh.appendRow([name]);
}

function getReceipt_(fileId) {
  if (!fileId) throw new Error('No file');
  const blob = DriveApp.getFileById(fileId).getBlob();
  return { ok: true, mime: blob.getContentType(), image: Utilities.base64Encode(blob.getBytes()) };
}

/* ------------------------------------------------------------------ */
/* Claude: receipt + voice parsing                                     */
/* ------------------------------------------------------------------ */

function expenseTool_(categories, entities) {
  return {
    name: 'record_expense',
    description: 'Record the expense details extracted from the input.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null if not stated or unreadable.' },
        vendor: { type: 'string', description: 'Shop / merchant / payee name. Empty string if unknown.' },
        details: { type: 'string', description: 'Short description of what was bought, max ~80 chars.' },
        amount: { type: ['number', 'null'], description: 'Total amount paid including tax, as a plain number. null if unknown.' },
        currency: { type: 'string', description: 'ISO 4217 code, e.g. MYR, USD, SGD. "RM" means MYR.' },
        category: { type: 'string', description: 'Best match from the existing category list. Only invent a new short name if none fit.' },
        entity: { type: ['string', 'null'], description: 'One of the existing entities ONLY if the input clearly says which; otherwise null.' }
      },
      required: ['date', 'vendor', 'details', 'amount', 'currency', 'category', 'entity']
    }
  };
}

function systemPrompt_(categories, entities, today) {
  return [
    'You extract expense records for a personal bookkeeping app used in Malaysia.',
    'Today is ' + today + '. The default currency is ' + BASE_CURRENCY + ' (RM).',
    'Malaysian dates are written day/month/year: 03/04/2026 is 3 April 2026.',
    'Resolve relative dates ("yesterday", "last Friday") against today.',
    'amount is the final total paid (after tax / service charge / rounding), not a subtotal.',
    'Use the receipt\'s own currency; do not convert.',
    'Existing categories: ' + JSON.stringify(categories) + '.',
    'Existing entities (personal or business): ' + JSON.stringify(entities) + '.',
    'Choose the closest existing category. Be sensible: petrol station = Fuel, restaurant/cafe = Food & Drink, etc.',
    'Never invent details. Leave unknown fields empty or null.'
  ].join('\n');
}

function parseReceipt_(req) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: req.mime || 'image/jpeg', data: req.image } },
    { type: 'text', text: 'Read this receipt and record the expense.' }
  ];
  const parsed = callClaude_(MODEL_RECEIPT, systemPrompt_(req.categories, req.entities, req.today), content,
    expenseTool_(req.categories, req.entities));
  return { ok: true, parsed: parsed };
}

function parseText_(req) {
  const parsed = callClaude_(MODEL_TEXT, systemPrompt_(req.categories, req.entities, req.today),
    'The user said (speech-to-text, may contain small mistakes): "' + req.text + '"',
    expenseTool_(req.categories, req.entities));
  return { ok: true, parsed: parsed };
}

function callClaude_(model, system, content, tool) {
  const key = prop_('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set in Script Properties');
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: model,
      max_tokens: 1024,
      system: system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: content }]
    })
  });
  const code = res.getResponseCode();
  const body = JSON.parse(res.getContentText());
  if (code !== 200) {
    throw new Error('Claude API error ' + code + ': ' + ((body.error && body.error.message) || res.getContentText()));
  }
  const block = (body.content || []).filter(b => b.type === 'tool_use')[0];
  if (!block) throw new Error('Claude returned no result');
  return block.input;
}
