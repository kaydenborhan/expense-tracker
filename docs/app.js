'use strict';
/* Expense Tracker — offline-first PWA. Local copy (IndexedDB) is instant; Google Sheet sync runs in the background. */

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const fmt = n => 'RM ' + (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const store = {
  get(k, d) { try { const v = localStorage.getItem('et.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('et.' + k, JSON.stringify(v)); } catch { /* ignore */ } }
};
const IC = {
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 9"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'
};
const icon = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${IC[n] || ''}</svg>`;
$$('[data-icon]').forEach(el => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));

const DEFAULT_CATS = ['Fuel', 'Food & Drink', 'Groceries', 'Parking & Tolls', 'Transport', 'Vehicle Maintenance', 'Parts & Supplies',
  'Tools & Equipment', 'Advertising & Marketing', 'Software & Subscriptions', 'Phone & Internet', 'Utilities', 'Rent', 'Shopping', 'Health', 'Entertainment', 'Other'];
const DEFAULT_ENTS = ['Personal', 'Business'];
const CURRENCIES = ['MYR', 'SGD', 'USD', 'EUR', 'GBP', 'THB', 'IDR', 'JPY', 'CNY', 'AUD', 'HKD', 'INR', 'KRW', 'AED', 'VND', 'PHP', 'NZD', 'CAD', 'CHF', 'TWD'];
const PALETTE = ['#0f766e', '#f59e0b', '#6366f1', '#ef4444', '#06b6d4', '#84cc16', '#d946ef', '#f97316', '#3b82f6', '#10b981', '#e11d48', '#8b5cf6', '#64748b', '#ca8a04'];
const colorFor = (name, list) => {
  const i = list ? list.indexOf(name) : -1;
  if (i >= 0) return PALETTE[i % PALETTE.length];
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

/* ---------- state ---------- */
const S = {
  expenses: [],
  cats: store.get('cats', DEFAULT_CATS),
  ents: store.get('ents', DEFAULT_ENTS),
  cfg: store.get('cfg', { url: '', token: '' }),
  defEnt: store.get('defEnt', 'Personal'),
  filters: Object.assign({ period: 'month', from: '', to: '', ents: [], cats: [], sort: 'newest', group: 'category', chart: 'pie', q: '' }, store.get('filters', {})),
  tab: 'add', syncing: false, pending: 0, syncError: '', listLimit: 100
};
if (!S.ents.includes(S.defEnt)) S.defEnt = S.ents[0];

/* ---------- IndexedDB ---------- */
const DB = (() => {
  let db;
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('expense-tracker', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('expenses', { keyPath: 'id' });
      d.createObjectStore('images');
      d.createObjectStore('queue', { keyPath: 'qid', autoIncrement: true });
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
  const tx = (name, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(name, mode);
    const out = fn(t.objectStore(name));
    t.oncomplete = () => res(out && out.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
  return {
    open,
    all: n => tx(n, 'readonly', s => s.getAll()),
    get: (n, k) => tx(n, 'readonly', s => s.get(k)),
    put: (n, v, k) => tx(n, 'readwrite', s => (k === undefined ? s.put(v) : s.put(v, k))),
    del: (n, k) => tx(n, 'readwrite', s => s.delete(k)),
    clear: n => tx(n, 'readwrite', s => s.clear()),
    keys: n => tx(n, 'readonly', s => s.getAllKeys())
  };
})();

/* ---------- UI utils ---------- */
let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const anySheetOpen = () => ['#formSheet', '#voiceSheet', '#pickSheet'].some(s => !$(s).hidden);

/* ---------- backend API ---------- */
async function api(payload, timeoutMs = 90000) {
  if (!S.cfg.url) throw new Error('Not linked to a Google Sheet yet');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(S.cfg.url, { method: 'POST', body: JSON.stringify({ ...payload, token: S.cfg.token }), signal: ctl.signal });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'Backend error');
    return j;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Timed out');
    throw err;
  } finally { clearTimeout(timer); }
}
const canReach = () => !!S.cfg.url && navigator.onLine;

const blobToB64 = blob => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1]);
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});

/* ---------- image compression ---------- */
async function compress(blob, max = 1800, q = 0.82) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch {
    bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); });
  }
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', q));
}

/* ---------- exchange rates ---------- */
const rateCache = store.get('rates', {});
async function getRate(cur, date) {
  if (cur === 'MYR') return 1;
  const d = date > todayStr() ? 'latest' : date;
  const key = `${cur}|${d}`;
  if (rateCache[key]) return rateCache[key];
  const urls = [`https://api.frankfurter.dev/v1/${d}?base=${cur}&symbols=MYR`, `https://api.frankfurter.app/${d}?from=${cur}&to=MYR`];
  for (const u of urls) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(u, { signal: ctl.signal }); clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      const rate = j && j.rates && j.rates.MYR;
      if (rate) { rateCache[key] = rate; store.set('rates', rateCache); return rate; }
    } catch { /* try next */ }
  }
  return null;
}

/* ---------- data layer ---------- */
async function reloadExpenses() { S.expenses = await DB.all('expenses'); }
async function enqueue(op) {
  if (op.op === 'upsert') {
    const q = await DB.all('queue');
    if (q.some(x => x.op === 'upsert' && x.id === op.id)) return;
  }
  await DB.put('queue', op);
  await countPending();
}
async function countPending() { S.pending = (await DB.all('queue')).length; updateSyncUI(); }

async function saveExpense(e, imageBlob) {
  e.updatedAt = Date.now();
  await DB.put('expenses', e);
  if (imageBlob) await DB.put('images', imageBlob, e.id);
  const i = S.expenses.findIndex(x => x.id === e.id);
  if (i >= 0) S.expenses[i] = e; else S.expenses.push(e);
  await enqueue({ op: 'upsert', id: e.id });
  flush();
}

async function removeExpense(id) {
  await DB.del('expenses', id); await DB.del('images', id);
  S.expenses = S.expenses.filter(x => x.id !== id);
  await enqueue({ op: 'delete', id });
  flush();
}

function addToList(kind, name) {
  const list = kind === 'cat' ? S.cats : S.ents;
  if (list.some(x => x.toLowerCase() === name.toLowerCase())) return list.find(x => x.toLowerCase() === name.toLowerCase());
  list.push(name);
  store.set(kind === 'cat' ? 'cats' : 'ents', list);
  enqueue({ op: kind === 'cat' ? 'addCategory' : 'addEntity', name });
  flush();
  return name;
}

/* ---------- sync ---------- */
async function flush() {
  if (S.syncing) return;
  if (!S.cfg.url || !navigator.onLine) { await countPending(); return; }
  S.syncing = true; S.syncError = ''; updateSyncUI();
  try {
    const q = (await DB.all('queue')).sort((a, b) => a.qid - b.qid);
    for (const item of q) {
      if (item.op === 'upsert') {
        const e = await DB.get('expenses', item.id);
        if (e) {
          const payload = { action: 'upsert', expense: e };
          const img = await DB.get('images', item.id);
          if (img && !e.receiptFileId) { payload.image = await blobToB64(img); payload.mime = img.type || 'image/jpeg'; }
          const r = await api(payload);
          const cur = await DB.get('expenses', item.id);
          if (cur) {
            cur.receiptFileId = r.expense.receiptFileId; cur.receiptUrl = r.expense.receiptUrl;
            await DB.put('expenses', cur);
          }
        }
      } else if (item.op === 'delete') await api({ action: 'delete', id: item.id });
      else if (item.op === 'addCategory') await api({ action: 'addCategory', name: item.name });
      else if (item.op === 'addEntity') await api({ action: 'addEntity', name: item.name });
      await DB.del('queue', item.qid);
    }
    await pull();
  } catch (err) {
    S.syncError = err.message || 'Sync failed';
  } finally {
    S.syncing = false;
    await countPending();
    await reloadExpenses();
    refreshAll();
  }
  // anything saved while this sync was running is still queued: go again (unless we just failed)
  if (!S.syncError && S.pending > 0) return flush();
}

async function pull() {
  const r = await api({ action: 'sync' });
  const queue = await DB.all('queue');
  const pendingIds = new Set(queue.filter(x => x.op === 'upsert' || x.op === 'delete').map(x => x.id));
  const local = await DB.all('expenses');
  const keep = local.filter(e => pendingIds.has(e.id));
  const merged = new Map();
  r.expenses.forEach(e => { if (!pendingIds.has(e.id)) merged.set(e.id, e); });
  keep.forEach(e => merged.set(e.id, e));
  await DB.clear('expenses');
  for (const e of merged.values()) await DB.put('expenses', e);
  const mergeList = (remote, localList, pendingNames) => {
    const out = [...remote];
    [...localList.filter(n => pendingNames.has(n.toLowerCase()))].forEach(n => { if (!out.some(x => x.toLowerCase() === n.toLowerCase())) out.push(n); });
    return out;
  };
  const pc = new Set(queue.filter(x => x.op === 'addCategory').map(x => x.name.toLowerCase()));
  const pe = new Set(queue.filter(x => x.op === 'addEntity').map(x => x.name.toLowerCase()));
  if (r.categories.length) { S.cats = mergeList(r.categories, S.cats, pc); store.set('cats', S.cats); }
  if (r.entities.length) { S.ents = mergeList(r.entities, S.ents, pe); store.set('ents', S.ents); }
  if (!S.ents.includes(S.defEnt)) S.defEnt = S.ents[0];
}

function updateSyncUI() {
  const dot = $('#syncDot'), txt = $('#syncText');
  let cls = '', t = '';
  if (!S.cfg.url) { cls = ''; t = 'Not linked'; }
  else if (S.syncing) { cls = 'busy'; t = 'Syncing'; }
  else if (S.syncError) { cls = 'err'; t = 'Sync error'; }
  else if (!navigator.onLine) { cls = 'pending'; t = S.pending ? `Offline · ${S.pending}` : 'Offline'; }
  else if (S.pending) { cls = 'pending'; t = `${S.pending} waiting`; }
  else { cls = 'ok'; t = 'Synced'; }
  dot.className = 'dot ' + cls; txt.textContent = t;
  const st = $('#syncStatusText');
  if (st) st.textContent = !S.cfg.url ? 'Not linked yet. Paste your backend URL and token below. Until then, expenses are saved on this phone only.'
    : S.syncError ? 'Last sync failed: ' + S.syncError : S.syncing ? 'Syncing…' : `${t}. ${S.expenses.length} expenses on this phone.`;
}

/* ---------- camera ---------- */
const cam = { stream: null, track: null, torch: false };
async function startCam() {
  if (cam.stream) return;
  const v = $('#cam');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return camFail('This browser has no live camera.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false
    });
    if (!camWanted()) { stream.getTracks().forEach(t => t.stop()); return; }
    cam.stream = stream; cam.track = stream.getVideoTracks()[0];
    v.srcObject = stream; v.hidden = false; $('#camFallback').hidden = true;
    const caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
    $('#torchBtn').hidden = !caps.torch; cam.torch = false;
  } catch (err) {
    camFail(err && err.name === 'NotAllowedError' ? 'Camera permission is blocked. Allow it in your browser settings, or use the button below.' : "Couldn't start the camera.");
  }
}
function camFail(msg) {
  $('#camFallbackMsg').textContent = msg; $('#camFallback').hidden = false; $('#cam').hidden = true; $('#torchBtn').hidden = true;
}
function stopCam() {
  if (cam.stream) cam.stream.getTracks().forEach(t => t.stop());
  cam.stream = null; cam.track = null; $('#cam').srcObject = null;
}
const camWanted = () => S.tab === 'add' && !anySheetOpen() && !document.hidden;
function syncCam() { camWanted() ? startCam() : stopCam(); }

async function shutter() {
  const v = $('#cam');
  if (!cam.stream || !v.videoWidth) return $('#fileCamera').click();
  if (navigator.vibrate) navigator.vibrate(15);
  const k = Math.min(1, 1800 / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  handleImage(blob);
}

/* ---------- Claude parsing flows ---------- */
async function handleImage(blob) {
  const img = await compress(blob);
  const ctl = openForm({ image: img, source: 'scan', banner: ['Reading receipt…', 'busy'] });
  if (!canReach()) return ctl.setBanner(S.cfg.url ? 'Offline: fill in the details — the photo is saved with the expense.' : 'Not linked to Claude yet: fill in the details (photo is still saved).', 'warn');
  try {
    const r = await api({ action: 'parseReceipt', image: await blobToB64(img), mime: 'image/jpeg', categories: S.cats, entities: S.ents, today: todayStr() });
    ctl.apply(r.parsed); ctl.setBanner('Receipt read. Check the details, then save.', 'ok');
  } catch (err) { ctl.setBanner("Couldn't read the receipt (" + err.message + '). Fill in the details.', 'warn'); }
}

async function handleVoiceText(text) {
  const ctl = openForm({ source: 'voice', banner: ['Understanding what you said…', 'busy'], prefill: { details: text } });
  if (!canReach()) return ctl.setBanner('Offline: fill in the details.', 'warn');
  try {
    const r = await api({ action: 'parseText', text, categories: S.cats, entities: S.ents, today: todayStr() });
    ctl.apply(r.parsed); ctl.setBanner(`Heard: “${text}”`, 'ok');
  } catch (err) { ctl.setBanner("Couldn't process that (" + err.message + '). Fill in the details.', 'warn'); }
}

/* ---------- expense form ---------- */
let F = null; // active form state

function fillSelect(sel, list, value, { blank, newLabel }) {
  const opts = [];
  if (blank) opts.push(`<option value="">${esc(blank)}</option>`);
  list.forEach(x => opts.push(`<option value="${esc(x)}">${esc(x)}</option>`));
  if (newLabel) opts.push(`<option value="__new__">${esc(newLabel)}</option>`);
  sel.innerHTML = opts.join('');
  sel.value = value || '';
  if (sel.value !== (value || '')) sel.value = blank ? '' : list[0];
}

function openForm({ expense, image, source, banner, prefill }) {
  const isNew = !expense;
  const token = uuid();
  F = {
    token, isNew, dirty: {}, fxSeq: 0, image: image || null, source: source || (expense && expense.source) || 'manual',
    base: expense ? { ...expense } : { id: uuid(), createdAt: Date.now(), source: source || 'manual', receiptFileId: '', receiptUrl: '' }
  };
  const e = Object.assign({ date: todayStr(), entity: S.defEnt, category: '', vendor: '', details: '', amount: '', currency: 'MYR' }, expense || {}, prefill || {});

  $('#formTitle').textContent = isNew ? 'New expense' : 'Edit expense';
  $('#fDelete').hidden = isNew;
  $('#fDate').value = e.date;
  $('#fAmount').value = e.amount === '' ? '' : e.amount;
  fillSelect($('#fCur'), CURRENCIES, e.currency, {});
  fillSelect($('#fEntity'), S.ents, e.entity, { newLabel: '＋ New business…' });
  fillSelect($('#fCat'), S.cats, e.category, { blank: 'Choose category…', newLabel: '＋ New category…' });
  $('#fNewEntity').hidden = true; $('#fNewEntity').value = '';
  $('#fNewCat').hidden = true; $('#fNewCat').value = '';
  $('#fVendor').value = e.vendor; $('#fDetails').value = e.details;
  $('#fMyr').value = expense && e.currency !== 'MYR' ? e.amountMYR : '';
  if (expense && e.currency !== 'MYR') F.dirty.myr = true;
  $('#fMyrRow').hidden = e.currency === 'MYR';
  $('#fRateNote').textContent = expense && e.currency !== 'MYR' ? `1 ${e.currency} = ${(e.rate || 0).toFixed(4)} MYR` : '';
  if (banner) setBanner(banner[0], banner[1]); else $('#fBanner').hidden = true;

  // receipt image
  const wrap = $('#fImgWrap'), img = $('#fImg');
  img.removeAttribute('src'); $('#fLoadImg').hidden = true; $('#fOpenImg').hidden = true; wrap.hidden = true;
  if (image) { img.src = URL.createObjectURL(image); wrap.hidden = false; }
  else if (expense) {
    DB.get('images', expense.id).then(b => {
      if (!F || F.token !== token) return;
      if (b) { img.src = URL.createObjectURL(b); wrap.hidden = false; }
      else if (expense.receiptFileId) { wrap.hidden = false; $('#fLoadImg').hidden = !canReach(); }
      if (expense.receiptUrl) { $('#fOpenImg').href = expense.receiptUrl; $('#fOpenImg').hidden = false; wrap.hidden = false; }
    });
  }

  $('#formSheet').hidden = false; $('#formSheet').querySelector('.sheet-body').scrollTop = 0;
  syncCam();
  if (!isNew || prefill) Object.keys(prefill || {}).forEach(k => { F.dirty[k] = true; });
  if (e.currency !== 'MYR' && isNew) updateFx();

  return {
    setBanner,
    apply: parsed => { if (F && F.token === token) applyParsed(parsed); }
  };
}

function setBanner(msg, kind) {
  const b = $('#fBanner');
  b.className = 'banner' + (kind === 'warn' ? ' warn' : kind === 'ok' ? ' ok' : '');
  b.innerHTML = (kind === 'busy' ? '<div class="spinner"></div>' : '') + `<span>${esc(msg)}</span>`;
  b.hidden = false;
}

function applyParsed(p) {
  if (!p) return;
  const set = (key, id, val) => { if (!F.dirty[key] && val != null && val !== '') $(id).value = val; };
  if (p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date)) set('date', '#fDate', p.date);
  set('vendor', '#fVendor', p.vendor);
  set('details', '#fDetails', p.details);
  if (p.amount != null && !F.dirty.amount) $('#fAmount').value = p.amount;
  if (p.currency && !F.dirty.cur) {
    const c = String(p.currency).toUpperCase();
    if (!CURRENCIES.includes(c)) { const o = document.createElement('option'); o.value = o.textContent = c; $('#fCur').insertBefore(o, $('#fCur').firstChild.nextSibling); }
    $('#fCur').value = c;
  }
  if (p.category && !F.dirty.cat) {
    const hit = S.cats.find(c => c.toLowerCase() === String(p.category).toLowerCase());
    if (hit) $('#fCat').value = hit;
    else { $('#fCat').value = '__new__'; $('#fNewCat').hidden = false; $('#fNewCat').value = p.category; }
  }
  if (p.entity && !F.dirty.entity) {
    const hit = S.ents.find(c => c.toLowerCase() === String(p.entity).toLowerCase());
    if (hit) $('#fEntity').value = hit;
  }
  updateFx();
}

async function updateFx() {
  if (!F) return;
  const cur = $('#fCur').value;
  $('#fMyrRow').hidden = cur === 'MYR';
  if (cur === 'MYR') return;
  const amt = num($('#fAmount').value);
  if (F.dirty.myr && $('#fMyr').value) { rateNote(); return; }
  const seq = ++F.fxSeq, date = $('#fDate').value || todayStr();
  $('#fRateNote').textContent = 'Looking up rate…';
  const rate = await getRate(cur, date);
  if (!F || seq !== F.fxSeq) return;
  if (rate) {
    $('#fMyr').value = amt ? (amt * rate).toFixed(2) : '';
    $('#fRateNote').textContent = `1 ${cur} = ${rate.toFixed(4)} MYR (rate for ${date}). Edit the MYR box to match your card statement.`;
  } else $('#fRateNote').textContent = "Couldn't look up the rate. Type the MYR amount.";
}
function rateNote() {
  const amt = num($('#fAmount').value), myr = num($('#fMyr').value), cur = $('#fCur').value;
  $('#fRateNote').textContent = amt && myr ? `1 ${cur} = ${(myr / amt).toFixed(4)} MYR (from your amounts)` : '';
}

function closeForm() { $('#formSheet').hidden = true; F = null; $('#fImg').removeAttribute('src'); syncCam(); }

async function submitForm() {
  if (!F) return;
  const date = $('#fDate').value, amount = num($('#fAmount').value), cur = $('#fCur').value;
  let entity = $('#fEntity').value, cat = $('#fCat').value;
  if (entity === '__new__') entity = $('#fNewEntity').value.trim();
  if (cat === '__new__') cat = $('#fNewCat').value.trim();
  const myrBox = num($('#fMyr').value);
  if (!date) return toast('Pick a date');
  if (!(amount > 0)) return toast('Enter the amount');
  if (!entity) return toast('Choose who this is for');
  if (!cat) return toast('Choose a category');
  if (cur !== 'MYR' && !(myrBox > 0)) return toast('Enter the amount in MYR (rate not found yet)');

  const amountMYR = cur === 'MYR' ? amount : Math.round(myrBox * 100) / 100;
  const vendor = $('#fVendor').value.trim();
  if (F.isNew) {
    const dup = S.expenses.find(x => x.date === date && Math.abs(x.amountMYR - amountMYR) < 0.005 && (x.vendor || '').toLowerCase() === vendor.toLowerCase());
    if (dup && !confirm('You already have an expense with the same date, vendor and amount. Save anyway?')) return;
  }
  entity = addToList('ent', entity); cat = addToList('cat', cat);
  const e = Object.assign({}, F.base, {
    date, entity, category: cat, vendor, details: $('#fDetails').value.trim(),
    amount, currency: cur, amountMYR, rate: amountMYR / amount, source: F.base.source || F.source
  });
  S.defEnt = entity; store.set('defEnt', entity);
  const img = F.image;
  closeForm();
  await saveExpense(e, img);
  toast(`Saved · ${fmt(e.amountMYR)} · ${e.category}`);
  refreshAll();
}

async function loadRemoteReceipt() {
  if (!F) return;
  const e = F.base, token = F.token;
  $('#fLoadImg').textContent = 'Loading…';
  try {
    const r = await api({ action: 'getReceipt', fileId: e.receiptFileId });
    if (!F || F.token !== token) return;
    $('#fImg').src = `data:${r.mime};base64,${r.image}`; $('#fLoadImg').hidden = true;
  } catch (err) { $('#fLoadImg').textContent = 'Load receipt image'; toast("Couldn't load: " + err.message); }
}

/* ---------- voice ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const voice = { rec: null, live: false, cancelled: false };
function openVoice() {
  $('#vText').value = ''; $('#voiceSheet').hidden = false; syncCam();
  $('#vMic').hidden = !SR;
  $('#vStatus').textContent = SR ? 'Listening… say it naturally.' : "This browser can't listen. Type below (your keyboard's mic works too).";
  if (SR) startListen();
}
function startListen() {
  voice.cancelled = false;
  try {
    const rec = new SR();
    rec.lang = 'en-MY'; rec.interimResults = true; rec.continuous = false;
    let finalText = '';
    rec.onresult = ev => {
      let t = '';
      for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
      finalText = t; $('#vText').value = t;
    };
    rec.onerror = ev => {
      const m = { 'not-allowed': 'Microphone permission is blocked.', 'no-speech': "Didn't catch anything. Tap the mic to try again.", 'network': 'Speech service needs internet.' };
      $('#vStatus').textContent = m[ev.error] || 'Mic error: ' + ev.error;
    };
    rec.onend = () => {
      voice.live = false; $('#vMic').classList.remove('live');
      if (!voice.cancelled && finalText.trim()) submitVoice();
      else if (!voice.cancelled && $('#vStatus').textContent.startsWith('Listening')) $('#vStatus').textContent = 'Tap the mic and try again.';
    };
    rec.start(); voice.rec = rec; voice.live = true; $('#vMic').classList.add('live');
  } catch { $('#vStatus').textContent = 'Could not start the microphone.'; }
}
function submitVoice() {
  const text = $('#vText').value.trim();
  if (!text) return toast('Say or type something first');
  voice.cancelled = true; try { voice.rec && voice.rec.abort(); } catch { /* ignore */ }
  $('#voiceSheet').hidden = true;
  handleVoiceText(text);
}
function closeVoice() { voice.cancelled = true; try { voice.rec && voice.rec.abort(); } catch { /* ignore */ } $('#voiceSheet').hidden = true; syncCam(); }

/* ---------- picker ---------- */
function openPicker({ title, options, selected, multi, onDone, colors }) {
  $('#pTitle').textContent = title;
  const body = $('#pBody');
  body.innerHTML = options.map((o, i) =>
    `<label><input type="${multi ? 'checkbox' : 'radio'}" name="pick" value="${esc(o)}" ${selected.includes(o) ? 'checked' : ''}>${colors ? `<i style="width:12px;height:12px;border-radius:4px;background:${colorFor(o, colors)}"></i>` : ''}<span>${esc(o)}</span></label>`).join('');
  $('#pDone').hidden = !multi;
  $('#pickSheet').hidden = false; syncCam();
  const done = () => { const vals = $$('input:checked', body).map(i => i.value); closePicker(); onDone(vals); };
  $('#pDone').onclick = done;
  if (!multi) body.onchange = done; else body.onchange = null;
}
function closePicker() { $('#pickSheet').hidden = true; syncCam(); }

/* ---------- summary ---------- */
const PERIODS = [['month', 'This month'], ['last', 'Last month'], ['3m', '3 months'], ['year', 'This year'], ['all', 'All time'], ['custom', 'Custom']];
function periodRange(f) {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth();
  switch (f.period) {
    case 'month': return [ymd(new Date(y, m, 1)), ymd(new Date(y, m + 1, 0))];
    case 'last': return [ymd(new Date(y, m - 1, 1)), ymd(new Date(y, m, 0))];
    case '3m': return [ymd(new Date(y, m - 2, 1)), ymd(new Date(y, m + 1, 0))];
    case 'year': return [`${y}-01-01`, `${y}-12-31`];
    case 'custom': return [f.from || '0000-01-01', f.to || '9999-12-31'];
    default: return ['0000-01-01', '9999-12-31'];
  }
}
function applyFilters() {
  const f = S.filters, [a, b] = periodRange(f), q = f.q.trim().toLowerCase();
  let out = S.expenses.filter(e => e.date >= a && e.date <= b
    && (!f.ents.length || f.ents.includes(e.entity))
    && (!f.cats.length || f.cats.includes(e.category))
    && (!q || `${e.vendor} ${e.details} ${e.category} ${e.entity}`.toLowerCase().includes(q)));
  const by = {
    newest: (x, y) => y.date.localeCompare(x.date) || y.createdAt - x.createdAt,
    oldest: (x, y) => x.date.localeCompare(y.date) || x.createdAt - y.createdAt,
    largest: (x, y) => y.amountMYR - x.amountMYR,
    smallest: (x, y) => x.amountMYR - y.amountMYR
  }[f.sort];
  return out.sort(by);
}
const sumBy = (items, keyFn) => {
  const m = new Map();
  items.forEach(e => { const k = keyFn(e); const o = m.get(k) || { key: k, total: 0, count: 0 }; o.total += e.amountMYR; o.count++; m.set(k, o); });
  return [...m.values()].sort((a, b) => b.total - a.total);
};
const mondayOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
function bucketize(items) {
  const dates = items.map(e => e.date).sort();
  const min = parseYmd(dates[0]), max = parseYmd(dates[dates.length - 1]);
  const span = Math.round((max - min) / 864e5) + 1;
  const gran = span <= 35 ? 'day' : span <= 150 ? 'week' : 'month';
  const keyOf = d => gran === 'day' ? ymd(d) : gran === 'week' ? ymd(mondayOf(d)) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const keys = [];
  let cur = gran === 'day' ? new Date(min) : gran === 'week' ? mondayOf(min) : new Date(min.getFullYear(), min.getMonth(), 1);
  while (cur <= max) {
    keys.push(keyOf(cur));
    if (gran === 'day') cur.setDate(cur.getDate() + 1); else if (gran === 'week') cur.setDate(cur.getDate() + 7); else cur.setMonth(cur.getMonth() + 1);
  }
  const label = k => gran === 'month' ? parseYmd(k + '-01').toLocaleDateString('en-MY', { month: 'short', year: '2-digit' })
    : parseYmd(k).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' });
  return { gran, keys, keyOf: e => keyOf(parseYmd(e.date)), label };
}

let chart = null;
function renderSummary() {
  if (S.tab !== 'summary') return;
  const f = S.filters;
  // period chips
  $('#periodChips').innerHTML = PERIODS.map(([k, l]) => `<button class="chip ${f.period === k ? 'on' : ''}" data-p="${k}">${l}</button>`).join('');
  $('#customRange').hidden = f.period !== 'custom'; $('#fFrom').value = f.from; $('#fTo').value = f.to;
  // entity chips
  $('#entityChips').innerHTML = `<button class="chip ${!f.ents.length ? 'on' : ''}" data-e="">All</button>` + S.ents.map(x => `<button class="chip ${f.ents.includes(x) ? 'on' : ''}" data-e="${esc(x)}">${esc(x)}</button>`).join('');
  $('#catFilterBtn').textContent = f.cats.length ? (f.cats.length === 1 ? f.cats[0] : `${f.cats.length} categories`) : 'All categories';
  $('#fSort').value = f.sort; $('#fGroup').value = f.group; $('#fSearch').value = f.q;
  $$('#chartType button').forEach(b => b.classList.toggle('on', b.dataset.type === f.chart));
  const active = (f.ents.length ? 1 : 0) + (f.cats.length ? 1 : 0) + (f.q.trim() ? 1 : 0);
  $('#filterCount').hidden = !active; $('#filterCount').textContent = active;

  const items = applyFilters();
  const total = items.reduce((s, e) => s + e.amountMYR, 0);
  const top = items.length ? sumBy(items, e => e.category)[0] : null;
  const big = items.length ? items.reduce((m, e) => e.amountMYR > m.amountMYR ? e : m) : null;
  $('#stats').innerHTML = `
    <div class="stat hero"><small>Total spent</small><b>${fmt(total)}</b></div>
    <div class="stat"><small>Expenses</small><b>${items.length}</b></div>
    <div class="stat"><small>Average</small><b>${fmt(items.length ? total / items.length : 0)}</b></div>
    <div class="stat"><small>Biggest</small><b>${big ? fmt(big.amountMYR) : '–'}</b></div>
    <div class="stat"><small>Top category</small><b style="font-size:1rem">${top ? esc(top.key) : '–'}</b></div>`;

  drawChartAndBreakdown(items, total);
  renderList(items);
}

function drawChartAndBreakdown(items, total) {
  const f = S.filters;
  if (chart) { chart.destroy(); chart = null; }
  $('#chartEmpty').hidden = items.length > 0;
  $('#chart').style.visibility = items.length ? 'visible' : 'hidden';
  $('#chartNote').hidden = true;
  if (!items.length) { $('#breakdown').innerHTML = ''; $('#breakdownTitle').textContent = 'Breakdown'; return; }
  if (typeof Chart === 'undefined') { $('#chartEmpty').hidden = false; $('#chartEmpty').textContent = 'Chart library not loaded.'; return; }

  const cs = getComputedStyle(document.documentElement);
  const muted = cs.getPropertyValue('--muted').trim(), line = cs.getPropertyValue('--line').trim(), surface = cs.getPropertyValue('--surface').trim(), accent = cs.getPropertyValue('--accent').trim();
  Chart.defaults.color = muted; Chart.defaults.font.family = 'system-ui, sans-serif';

  let type = f.chart, group = f.group;
  if (group === 'time' && type === 'pie') {
    group = 'category';
    $('#chartNote').textContent = 'A pie shows shares, so it uses categories. Pick Column or Line to see spending over time.'; $('#chartNote').hidden = false;
  }
  const val = c => typeof c.parsed === 'number' ? c.parsed : (c.chart.options.indexAxis === 'y' ? c.parsed.x : c.parsed.y);
  const tip = { callbacks: { label: c => ' ' + fmt(val(c)) } };
  const axisMoney = { ticks: { callback: v => v >= 1000 ? (v / 1000) + 'k' : v }, grid: { color: line } };
  let cfg, rows;

  if (group === 'time') {
    const b = bucketize(items);
    const totals = new Map(b.keys.map(k => [k, 0]));
    items.forEach(e => totals.set(b.keyOf(e), (totals.get(b.keyOf(e)) || 0) + e.amountMYR));
    const labels = b.keys.map(b.label);
    rows = b.keys.map(k => ({ key: b.label(k), total: totals.get(k), color: accent })).filter(r => r.total > 0).reverse();
    $('#breakdownTitle').textContent = 'By ' + b.gran;
    if (type === 'column') {
      const cats = [...new Set(items.map(e => e.category))];
      const datasets = cats.map(c => ({
        label: c, backgroundColor: colorFor(c, S.cats),
        data: b.keys.map(k => items.filter(e => e.category === c && b.keyOf(e) === k).reduce((s, e) => s + e.amountMYR, 0))
      }));
      cfg = { type: 'bar', data: { labels, datasets }, options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ...axisMoney } }, plugins: { legend: { display: cats.length > 1, position: 'bottom', labels: { boxWidth: 10 } }, tooltip: tip } } };
    } else if (type === 'bar') {
      cfg = { type: 'bar', data: { labels, datasets: [{ data: b.keys.map(k => totals.get(k)), backgroundColor: accent, borderRadius: 4 }] }, options: { indexAxis: 'y', scales: { x: axisMoney, y: { grid: { display: false } } }, plugins: { legend: { display: false }, tooltip: tip } } };
    } else {
      cfg = { type: 'line', data: { labels, datasets: [{ data: b.keys.map(k => totals.get(k)), borderColor: accent, backgroundColor: accent + '33', fill: true, tension: .3, pointRadius: b.keys.length > 40 ? 0 : 3 }] }, options: { scales: { x: { grid: { display: false } }, y: axisMoney }, plugins: { legend: { display: false }, tooltip: tip } } };
    }
  } else {
    const isCat = group === 'category', list = isCat ? S.cats : S.ents;
    const g = sumBy(items, e => isCat ? e.category : e.entity);
    rows = g.map(x => ({ key: x.key, total: x.total, color: colorFor(x.key, list), pick: true }));
    $('#breakdownTitle').textContent = isCat ? 'By category' : 'By business / personal';
    const labels = g.map(x => x.key), data = g.map(x => x.total), colors = g.map(x => colorFor(x.key, list));
    if (type === 'pie') cfg = { type: 'pie', data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: surface, borderWidth: 2 }] }, options: { plugins: { legend: { display: false }, tooltip: tip } } };
    else if (type === 'column') cfg = { type: 'bar', data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 6 }] }, options: { scales: { x: { grid: { display: false }, ticks: { maxRotation: 60, minRotation: 0 } }, y: axisMoney }, plugins: { legend: { display: false }, tooltip: tip } } };
    else if (type === 'bar') cfg = { type: 'bar', data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 6 }] }, options: { indexAxis: 'y', scales: { x: axisMoney, y: { grid: { display: false } } }, plugins: { legend: { display: false }, tooltip: tip } } };
    else cfg = { type: 'line', data: { labels, datasets: [{ data, borderColor: accent, backgroundColor: accent + '33', fill: true, tension: .3, pointBackgroundColor: colors, pointRadius: 5 }] }, options: { scales: { x: { grid: { display: false } }, y: axisMoney }, plugins: { legend: { display: false }, tooltip: tip } } };
  }
  cfg.options.maintainAspectRatio = false; cfg.options.responsive = true;
  chart = new Chart($('#chart'), cfg);

  const max = Math.max(...rows.map(r => r.total), 1);
  $('#breakdown').innerHTML = rows.map(r => `
    <button class="brow" ${r.pick ? `data-pick="${esc(r.key)}" data-group="${group}"` : ''}>
      <i style="background:${r.color}"></i><span>${esc(r.key)}</span><b>${fmt(r.total)}<em>${total ? Math.round(r.total / total * 100) : 0}%</em></b>
      <div class="bar"><span style="width:${Math.round(r.total / max * 100)}%;background:${r.color}"></span></div>
    </button>`).join('');
}

function renderList(items) {
  const f = S.filters, shown = items.slice(0, S.listLimit);
  $('#listCount').textContent = items.length ? `(${items.length})` : '';
  const byDate = f.sort === 'newest' || f.sort === 'oldest';
  let html = '', lastDate = '';
  shown.forEach(e => {
    if (byDate && e.date !== lastDate) {
      lastDate = e.date;
      html += `<div class="dayhead">${parseYmd(e.date).toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div>`;
    }
    const foreign = e.currency !== 'MYR' ? `<small>${esc(e.currency)} ${e.amount.toLocaleString('en-MY', { minimumFractionDigits: 2 })}</small>` : '';
    const sub = [e.category, e.entity, e.vendor && e.details ? e.details : ''].filter(Boolean).join(' · ');
    const dateTxt = !byDate ? parseYmd(e.date).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' }) + ' · ' : '';
    html += `<button class="item" data-id="${esc(e.id)}"><div class="tag" style="background:${colorFor(e.category, S.cats)}"></div>
      <div style="min-width:0"><div class="t">${esc(e.vendor || e.details || e.category)}${e.receiptFileId || e.receiptUrl ? ' 🧾' : ''}</div><div class="s">${esc(dateTxt + sub)}</div></div>
      <div class="a">${fmt(e.amountMYR)}${foreign}</div></button>`;
  });
  if (!items.length) html = '<p class="muted center" style="padding:20px 0">Nothing here yet. Scan a receipt on the Add tab.</p>';
  $('#list').innerHTML = html;
  $('#moreBtn').hidden = items.length <= S.listLimit;
}

/* ---------- settings ---------- */
function renderSettings() {
  $('#cfgUrl').value = S.cfg.url; $('#cfgToken').value = S.cfg.token;
  $('#entList').innerHTML = S.ents.map(x => `<span class="tag-pill">${esc(x)}</span>`).join('');
  $('#catList').innerHTML = S.cats.map(x => `<span class="tag-pill" style="border-left:6px solid ${colorFor(x, S.cats)}">${esc(x)}</span>`).join('');
  updateSyncUI();
}
function exportCsv() {
  const head = ['Date', 'Entity', 'Category', 'Vendor', 'Details', 'Amount', 'Currency', 'Rate to MYR', 'Amount MYR', 'Receipt'];
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [...S.expenses].sort((a, b) => a.date.localeCompare(b.date)).map(e => [e.date, e.entity, e.category, e.vendor, e.details, e.amount, e.currency, e.rate, e.amountMYR, e.receiptUrl].map(q).join(','));
  const blob = new Blob([[head.map(q).join(','), ...rows].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `expenses-${todayStr()}.csv`; a.click();
}

/* ---------- navigation + refresh ---------- */
function showTab(name) {
  S.tab = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'summary') renderSummary();
  if (name === 'settings') renderSettings();
  syncCam();
}
function refreshAll() {
  $('#entityChip').innerHTML = `${esc(S.defEnt)} ▾`;
  updateSyncUI();
  if (S.tab === 'summary') renderSummary();
  if (S.tab === 'settings') renderSettings();
}
function saveFilters() { store.set('filters', S.filters); S.listLimit = 100; renderSummary(); }

/* ---------- wire up ---------- */
function bind() {
  $$('#tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#shutter').onclick = shutter;
  $('#manualBtn').onclick = () => openForm({ source: 'manual' });
  $('#micBtn').onclick = openVoice;
  $('#galleryBtn').onclick = () => $('#fileGallery').click();
  $('#openCamBtn').onclick = () => $('#fileCamera').click();
  $('#retryCamBtn').onclick = () => { stopCam(); startCam(); };
  [$('#fileGallery'), $('#fileCamera')].forEach(inp => inp.onchange = () => { const f = inp.files[0]; inp.value = ''; if (f) handleImage(f); });
  $('#torchBtn').onclick = async () => { cam.torch = !cam.torch; try { await cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] }); } catch { /* ignore */ } };
  $('#entityChip').onclick = () => openPicker({ title: 'Add expenses to…', options: [...S.ents, '＋ Add a business…'], selected: [S.defEnt], multi: false,
    onDone: v => { let n = v[0]; if (n && n.startsWith('＋')) { n = (prompt('Business name') || '').trim(); if (n) n = addToList('ent', n); } if (n && !n.startsWith('＋')) { S.defEnt = n; store.set('defEnt', n); refreshAll(); } } });
  $('#syncBadge').onclick = async () => { if (!S.cfg.url) return showTab('settings'); await flush(); toast(S.syncError ? 'Sync error: ' + S.syncError : 'Synced'); };

  // form
  $('#fCancel').onclick = closeForm;
  $('#fSave').onclick = $('#fSaveTop').onclick = submitForm;
  $('#fDelete').onclick = async () => { if (F && confirm('Delete this expense?')) { const id = F.base.id; closeForm(); await removeExpense(id); toast('Deleted'); refreshAll(); } };
  $('#fLoadImg').onclick = loadRemoteReceipt;
  const mark = (id, key) => $(id).addEventListener('input', () => { if (F) F.dirty[key] = true; });
  mark('#fDate', 'date'); mark('#fVendor', 'vendor'); mark('#fDetails', 'details'); mark('#fAmount', 'amount');
  $('#fDate').addEventListener('change', () => { if (F && !F.dirty.myr) updateFx(); });
  $('#fAmount').addEventListener('input', () => { if (F) { F.dirty.amount = true; updateFx(); } });
  $('#fCur').addEventListener('change', () => { if (F) { F.dirty.cur = true; F.dirty.myr = false; $('#fMyr').value = ''; updateFx(); } });
  $('#fMyr').addEventListener('input', () => { if (!F) return; F.dirty.myr = !!$('#fMyr').value; rateNote(); if (!F.dirty.myr) updateFx(); });
  $('#fEntity').addEventListener('change', () => { if (F) F.dirty.entity = true; $('#fNewEntity').hidden = $('#fEntity').value !== '__new__'; if (!$('#fNewEntity').hidden) $('#fNewEntity').focus(); });
  $('#fCat').addEventListener('change', () => { if (F) F.dirty.cat = true; $('#fNewCat').hidden = $('#fCat').value !== '__new__'; if (!$('#fNewCat').hidden) $('#fNewCat').focus(); });

  // voice + picker
  $('#vCancel').onclick = closeVoice; $('#vGo').onclick = submitVoice;
  $('#vMic').onclick = () => { if (voice.live) { try { voice.rec.stop(); } catch { /* ignore */ } } else { $('#vStatus').textContent = 'Listening…'; startListen(); } };
  $('#pCancel').onclick = closePicker;

  // summary
  $('#filtersToggle').onclick = () => { $('#filtersPanel').hidden = !$('#filtersPanel').hidden; };
  $('#periodChips').onclick = e => { const b = e.target.closest('[data-p]'); if (!b) return; S.filters.period = b.dataset.p; saveFilters(); };
  $('#fFrom').onchange = () => { S.filters.from = $('#fFrom').value; saveFilters(); };
  $('#fTo').onchange = () => { S.filters.to = $('#fTo').value; saveFilters(); };
  $('#entityChips').onclick = e => {
    const b = e.target.closest('[data-e]'); if (!b) return; const k = b.dataset.e, f = S.filters;
    if (!k) f.ents = []; else f.ents = f.ents.includes(k) ? f.ents.filter(x => x !== k) : [...f.ents, k];
    saveFilters();
  };
  $('#catFilterBtn').onclick = () => openPicker({ title: 'Categories', options: S.cats, selected: S.filters.cats, multi: true, colors: S.cats, onDone: v => { S.filters.cats = v.length === S.cats.length ? [] : v; saveFilters(); } });
  $('#fSort').onchange = () => { S.filters.sort = $('#fSort').value; saveFilters(); };
  $('#fGroup').onchange = () => { S.filters.group = $('#fGroup').value; saveFilters(); };
  $('#fSearch').oninput = () => { S.filters.q = $('#fSearch').value; saveFilters(); };
  $('#resetFilters').onclick = () => { Object.assign(S.filters, { ents: [], cats: [], q: '', sort: 'newest', group: 'category' }); saveFilters(); };
  $('#chartType').onclick = e => { const b = e.target.closest('[data-type]'); if (!b) return; S.filters.chart = b.dataset.type; saveFilters(); };
  $('#breakdown').onclick = e => {
    const b = e.target.closest('[data-pick]'); if (!b) return;
    if (b.dataset.group === 'category') S.filters.cats = [b.dataset.pick]; else S.filters.ents = [b.dataset.pick];
    saveFilters(); toast('Filtered · clear it in Filters');
  };
  $('#list').onclick = e => { const b = e.target.closest('[data-id]'); if (!b) return; const x = S.expenses.find(y => y.id === b.dataset.id); if (x) openForm({ expense: x }); };
  $('#moreBtn').onclick = () => { S.listLimit += 100; renderSummary(); };

  // settings
  $('#cfgSave').onclick = async () => {
    S.cfg = { url: $('#cfgUrl').value.trim(), token: $('#cfgToken').value.trim() }; store.set('cfg', S.cfg);
    if (!S.cfg.url) { updateSyncUI(); return toast('Saved (no backend)'); }
    toast('Connecting…'); await flush(); toast(S.syncError ? 'Failed: ' + S.syncError : 'Connected · ' + S.expenses.length + ' expenses');
  };
  $('#syncNow').onclick = async () => { if (!S.cfg.url) return toast('Add the backend URL first'); await flush(); toast(S.syncError ? 'Failed: ' + S.syncError : 'Synced'); };
  $('#addEntityBtn').onclick = () => { const n = $('#newEntity').value.trim(); if (!n) return; addToList('ent', n); $('#newEntity').value = ''; renderSettings(); toast('Added ' + n); };
  $('#addCatBtn').onclick = () => { const n = $('#newCategory').value.trim(); if (!n) return; addToList('cat', n); $('#newCategory').value = ''; renderSettings(); toast('Added ' + n); };
  $('#exportCsv').onclick = exportCsv;
  $('#wipeLocal').onclick = async () => {
    const warn = S.pending ? `${S.pending} changes haven't synced yet and will be lost. ` : '';
    if (!confirm(warn + "Clear this phone's copy? Your Google Sheet is not affected.")) return;
    await DB.clear('expenses'); await DB.clear('images'); await DB.clear('queue'); S.expenses = []; S.pending = 0;
    toast('Cleared'); await flush(); refreshAll();
  };

  document.addEventListener('visibilitychange', () => { syncCam(); if (!document.hidden) flush(); });
  window.addEventListener('online', flush); window.addEventListener('offline', updateSyncUI);
}

async function init() {
  // setup link: ?u=<backend url>&t=<token>
  const p = new URLSearchParams(location.search);
  if (p.get('u') && p.get('t')) {
    S.cfg = { url: p.get('u'), token: p.get('t') }; store.set('cfg', S.cfg);
    history.replaceState(null, '', location.pathname);
  }
  try { await DB.open(); await reloadExpenses(); } catch (err) { toast('Storage unavailable: ' + err.message, 6000); }
  bind(); refreshAll(); countPending();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell optional */ });
  syncCam();
  flush();
  if (p.get('manual')) openForm({ source: 'manual' });
  if (p.get('voice')) openVoice();
}
init();
