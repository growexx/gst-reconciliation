/**
 * SAP `/zapi_tables` client — on-demand, load-optimized fetch of one reconcile
 * window. Contacted ONCE per reconcile run; all app reads are served from Mongo.
 *
 * Strategy — MANY SMALL REQUESTS IN PARALLEL. The link (and some SAP configs) stall
 * on large responses, so every call is kept small and the bounded pool runs them
 * concurrently:
 *   - BKPF/RBKP: the date window is split into short slices (SAP_API_WINDOW_DAYS)
 *     fetched in parallel, then merged — no single giant month response.
 *   - BSEG/BSET: fetched BY DOCUMENT in small chunks (SAP_API_CHUNK).
 *   - BKPF is always doc_type-filtered (RE/KR/KG/SA); SA is filtered to IMPORT docs
 *     at the header level (Reference~CUSTOM) so its huge payroll BSEG is never pulled.
 *   - BSEG only for KR/KG by default (RE vendors come from RBKP) — biggest download cut.
 *   - LFA1 only for the distinct vendor codes discovered, small chunks.
 *   - Each response is PROJECTED to the ~10 fields we use as it arrives.
 *
 * TLS: internal cert not publicly trusted → SCOPED https agent (rejectUnauthorized:
 * false) for these calls only. Set SAP_API_INSECURE_TLS=false once the CA is installed.
 * Connection is flaky (200 then ECONNRESET / stalls) → small calls + retry with backoff.
 */
const https = require('https');

const BASE_URL = (process.env.SAP_API_BASE_URL || 'https://vhntxps4ap01.sap.nandanterry.com/zapi_tables').replace(/\/+$/, '');
const CLIENT = process.env.SAP_API_CLIENT || '500';
const CHUNK = Number(process.env.SAP_API_CHUNK) || 150;           // docs per BSEG/BSET call (URL cap ~200; 500 → HTTP 414)
const VENDOR_CHUNK = Number(process.env.SAP_API_VENDOR_CHUNK) || 50;
const WINDOW_DAYS = Number(process.env.SAP_API_WINDOW_DAYS) || 3;  // date-slice size for BKPF/RBKP
const CONCURRENCY = Number(process.env.SAP_API_CONCURRENCY) || 12;
const TIMEOUT_MS = Number(process.env.SAP_API_TIMEOUT_MS) || 20000;   // fail fast on a stall, then retry
const RETRIES = Number(process.env.SAP_API_RETRIES) || 5;
// Fail-CLOSED: TLS verification is ON unless SAP_API_INSECURE_TLS=true is set explicitly.
// A missing/typo'd value keeps verification on rather than silently trusting any cert.
const INSECURE_TLS = process.env.SAP_API_INSECURE_TLS === 'true';
// BSEG is the heaviest table; RE (MM) vendors come from RBKP, so BSEG is fetched only
// for KR/KG by default. SAP_API_BSEG_ALL=true fetches BSEG for every AP doc (ETL parity).
const BSEG_ALL = process.env.SAP_API_BSEG_ALL === 'true';
// Auth: single shared SERVICE account (maintained in an SAP custom table). We log in
// once, cache the Bearer token server-side, and refresh before SAP's ~2h expiry. This is
// backend-only — it is NOT the app's user login and never reaches the browser.
// No hardcoded fallback — creds MUST come from the environment. login() fails loudly
// (and the caller degrades to stored data) if they are missing.
const SAP_USER = process.env.SAP_API_USER || '';
const SAP_PASSWORD = process.env.SAP_API_PASSWORD || '';
const TOKEN_TTL_MS = Number(process.env.SAP_API_TOKEN_TTL_MS) || 110 * 60 * 1000;   // refresh ~10 min before the 2h expiry

const agent = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY + 4, rejectUnauthorized: !INSECURE_TLS });

const CUSTOMS_RE = /custom|bill of entry|\bBE\b|IGST ON CUSTOM/i;

const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

// Indian fiscal year (GJAHR) for a YYYYMMDD date: Apr–Mar, so Jan–Mar belong to the
// previous year. Lets the ±1-month window span a fiscal boundary correctly.
const fyOf = (yyyymmdd) => { const y = +yyyymmdd.slice(0, 4); const m = +yyyymmdd.slice(4, 6); return String(m >= 4 ? y : y - 1); };

// Split [from,to] (YYYYMMDD) into contiguous ranges each within ONE Indian GJAHR (FY
// boundary = 1 April). One BKPF/RBKP call per segment — a month loads fast as a single
// call (measured), so we avoid over-splitting into tiny date-slices.
function fiscalSegments(from, to) {
    const parse = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
    const fmt = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const end = parse(to); const out = []; let cur = parse(from);
    while (cur <= end) {
        const gj = cur.getUTCMonth() >= 3 ? cur.getUTCFullYear() : cur.getUTCFullYear() - 1;   // GJAHR
        const segEnd = new Date(Date.UTC(gj + 1, 3, 0));      // 31 Mar of gj+1 = FY end
        const e = segEnd > end ? end : segEnd;
        out.push({ f: fmt(cur), t: fmt(e), fiscal: String(gj) });
        cur = new Date(e); cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}

const pickKeys = (row, keys) => { const o = {}; for (const k of keys) o[k] = row[k]; return o; };
const KEYS = {
    bkpf: ['Document Number', 'Fiscal Year', 'Document Type', 'Reference', 'Document Date', 'Reversed With', 'Posting Date'],
    bseg: ['Document Number', 'Fiscal Year', 'Supplier', 'Amount in Loc. Curr.', 'Amount', 'Text', 'Debit/Credit Ind.', 'G/L Account', 'hkont', 'Tax Code'],
    bset: ['Company Code', 'Document Number', 'Fiscal Year', 'Item', 'Condition Type', 'Amount', 'Transaction'],
    rbkp: ['Invoice Document No.', 'Fiscal Year', 'Document Type', 'Reference', 'Invoicing Party', 'Reversed by', 'Value-Added Tax Amt', 'Tax in Supplier Error', 'Document Date', 'Gross Invoice Amount', 'Tax Number 3', 'Name'],
    lfa1: ['Supplier', 'Tax Number 3', 'Name', 'Permanent account number'],
};

function buildUrl(endpoint, params) {
    const u = new URL(`${BASE_URL}/${endpoint}`);
    u.searchParams.append('sap-client', CLIENT);
    for (const [k, v] of Object.entries(params || {})) {
        if (Array.isArray(v)) v.forEach((x) => { if (x != null && x !== '') u.searchParams.append(k, x); });
        else if (v != null && v !== '') u.searchParams.append(k, v);
    }
    return u.toString();
}

function httpGetJson(url, token) {
    return new Promise((resolve, reject) => {
        const headers = { Accept: 'application/json' };
        if (token) headers['x-authorization'] = `Bearer ${token}`;   // note: x-authorization, per SAP doc
        const req = https.get(url, { agent, headers }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                const e = new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim());
                e.status = res.statusCode;                            // let getJson detect 401 → re-login
                return reject(e);
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    resolve(Array.isArray(j) ? j : (j.data || j.results || j.value || []));
                } catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`)));
    });
}

// ── SAP login → cached Bearer token, single-flight + auto-refresh ──
let _token = null, _tokenAt = 0, _loginInFlight = null;

function login() {
    return new Promise((resolve, reject) => {
        if (!SAP_USER || !SAP_PASSWORD) {
            return reject(new Error('SAP API credentials not configured — set SAP_API_USER and SAP_API_PASSWORD.'));
        }
        const body = JSON.stringify({ user: SAP_USER, password: SAP_PASSWORD });
        const req = https.request(new URL(`${BASE_URL}/login`), {
            method: 'POST', agent,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { data += c; });
            res.on('end', () => {
                // Response body is (malformed) JSON containing `"Token" : Bearer <token>` — extract by regex.
                const m = data.match(/Bearer\s+([^\s"']+)/i);
                if (res.statusCode >= 200 && res.statusCode < 300 && m) return resolve(m[1]);
                reject(new Error(`SAP login failed: HTTP ${res.statusCode} ${data.slice(0, 120)}`));
            });
        });
        req.on('error', reject);
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('login timeout')));
        req.write(body); req.end();
    });
}

// Valid token, refreshed before the 2h expiry. Single-flight so the ~concurrent chunk
// fetches share ONE login. force=true (on a 401) discards the cached token first.
async function getToken(force = false) {
    if (force) _token = null;
    if (_token && (Date.now() - _tokenAt) < TOKEN_TTL_MS) return _token;
    if (!_loginInFlight) {
        _loginInFlight = login()
            .then((t) => { _token = t; _tokenAt = Date.now(); return t; })
            .finally(() => { _loginInFlight = null; });
    }
    return _loginInFlight;
}

// GET with retry + backoff; projects each row to `keys` immediately.
async function getJson(endpoint, params, keys) {
    const url = buildUrl(endpoint, params);
    let lastErr;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            const token = await getToken();
            const rows = await httpGetJson(url, token);
            return keys ? rows.map((r) => pickKeys(r, keys)) : rows;
        } catch (err) {
            lastErr = err;
            if (err && (err.status === 401 || err.status === 403)) await getToken(true);   // token expired/invalid → force re-login before retry
            if (attempt === RETRIES) break;
            await new Promise((r) => setTimeout(r, 300 * attempt + ((attempt * 137) % 200)));
        }
    }
    throw new Error(`[${endpoint}] failed after ${RETRIES} tries: ${lastErr && lastErr.message}`);
}

// Bounded-concurrency pool. A failed item resolves to null (logged) so one bad chunk
// never aborts the whole window.
async function pool(items, limit, worker) {
    const results = new Array(items.length);
    let i = 0; let done = 0;
    const runners = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
        while (i < items.length) {
            const idx = i++;
            try { results[idx] = await worker(items[idx], idx); }
            catch (e) { console.error('  sapClient pool item failed:', e.message); results[idx] = null; }
            done++;
        }
    });
    await Promise.all(runners);
    return results;
}

/**
 * Fetch one reconcile window as many small parallel calls.
 * @param {Object} opts { from:'YYYYMMDD', to:'YYYYMMDD', fiscal:'2026', onProgress?:(label)=>void }
 * @returns {Promise<{bkpf,bseg,bset,rbkp,lfa1, saImport:{bkpf,bseg,bset}}>}
 */
async function fetchWindow({ from, to, onProgress } = {}) {
    const log = (m) => { if (onProgress) onProgress(m); };
    const segs = fiscalSegments(from, to);      // one contiguous range per GJAHR

    // Phase A — BKPF headers: ONE call per fiscal segment (all AP+SA doc types). A month
    // loads in ~5s as a single call, so no tiny date-slicing.
    log(`Fetching SAP headers (${segs.length} range${segs.length > 1 ? 's' : ''})…`);
    let failed = 0, total = 0;
    const bkpfRes = await pool(segs, CONCURRENCY,
        (s) => getJson('bkpf', { bkpf_from: s.f, bkpf_to: s.t, fiscal: s.fiscal, doc_type: ['RE', 'KR', 'KG', 'SA'] }, KEYS.bkpf));
    failed += bkpfRes.filter((x) => x == null).length; total += bkpfRes.length;
    const bkpfAll = bkpfRes.flatMap((r) => r || []);

    const apRows = bkpfAll.filter((r) => ['RE', 'KR', 'KG'].includes(r['Document Type']));
    const saRows = bkpfAll.filter((r) => r['Document Type'] === 'SA');
    const saImportRows = saRows.filter((r) => CUSTOMS_RE.test(String(r['Reference'] || '')));

    // Group doc numbers by their fiscal year (from the header) so BSEG/BSET use the right fiscal.
    const byFiscal = (rows) => { const m = new Map(); for (const r of rows) { const d = String(r['Document Number']); if (!d) continue; const fy = String(r['Fiscal Year']); if (!m.has(fy)) m.set(fy, new Set()); m.get(fy).add(d); } return m; };
    const apByFy = byFiscal(apRows);
    const bsegByFy = byFiscal(BSEG_ALL ? apRows : apRows.filter((r) => r['Document Type'] !== 'RE'));
    const saByFy = byFiscal(saImportRows);
    const sz = (m) => [...m.values()].reduce((s, x) => s + x.size, 0);
    log(`Headers: ${apRows.length} AP (RE/KR/KG), ${saImportRows.length}/${saRows.length} SA-import`);

    // Phase B — details: BSET/BSEG by document in LARGE chunks, RBKP by segment. One pool.
    const tasks = [];
    for (const [fy, set] of apByFy) for (const c of chunk([...set], CHUNK)) tasks.push({ kind: 'bset', run: () => getJson('bset', { document: c, fiscal: fy }, KEYS.bset) });
    for (const [fy, set] of bsegByFy) for (const c of chunk([...set], CHUNK)) tasks.push({ kind: 'bseg', run: () => getJson('bseg', { document: c, fiscal: fy }, KEYS.bseg) });
    for (const s of segs) tasks.push({ kind: 'rbkp', run: () => getJson('rbkp', { rbkp_from: s.f, rbkp_to: s.t, fiscal: s.fiscal }, KEYS.rbkp) });
    // SA (imports): only BSEG is needed (Bill-of-Entry text + import-IGST GL line).
    // SA BSET is never consumed by buildImpgInvoices, so we don't fetch it.
    for (const [fy, set] of saByFy) for (const c of chunk([...set], CHUNK)) {
        tasks.push({ kind: 'saBseg', run: () => getJson('bseg', { document: c, fiscal: fy }, KEYS.bseg) });
    }
    log(`Fetching details: ${tasks.length} calls (BSET ${sz(apByFy)} docs, BSEG ${sz(bsegByFy)} docs, RBKP ${segs.length})…`);
    const detail = await pool(tasks, CONCURRENCY, async (task) => ({ kind: task.kind, rows: (await task.run()) || [] }));
    failed += detail.filter((x) => x == null).length; total += detail.length;
    const by = (k) => detail.filter((d) => d && d.kind === k).flatMap((d) => d.rows);
    const bset = by('bset'), bseg = by('bseg'), rbkp = by('rbkp');
    const saImport = { bkpf: saImportRows, bseg: by('saBseg') };

    // Phase C — LFA1 for the distinct vendor codes discovered.
    const vendorCodes = [...new Set([...bseg.map((r) => r['Supplier']), ...rbkp.map((r) => r['Invoicing Party'])]
        .filter((v) => v != null && String(v).trim() !== '').map(String))];
    log(`Fetching ${vendorCodes.length} vendors…`);
    const lfa1Res = await pool(chunk(vendorCodes, VENDOR_CHUNK), CONCURRENCY, (codes) => getJson('lfa1', { vendor: codes }, KEYS.lfa1));
    failed += lfa1Res.filter((x) => x == null).length; total += lfa1Res.length;
    const lfa1 = lfa1Res.flatMap((r) => r || []);

    log(`SAP fetch complete${failed ? ` (${failed}/${total} calls FAILED)` : ''}.`);
    return { bkpf: apRows, bseg, bset, rbkp, lfa1, saImport, failed, total };
}

module.exports = { fetchWindow, getJson, buildUrl, BASE_URL, CLIENT, KEYS };
