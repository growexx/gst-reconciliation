/**
 * SAP → MongoDB ETL — BKPF-driven (RBKP is no longer used).
 *
 * Vendor AP invoices come from BKPF (the accounting document header), covering
 * MM invoices (BLART 'RE') and FI invoices ('KR') only. Credit memos ('KG') and
 * all other document types are excluded (credit/debit notes reconcile against the
 * 2B CDNR section, not the B2B invoice pile):
 *   BKPF   : Reference (= supplier invoice no, XBLNR), Doc. Date, doc type
 *   BSET   : CGST/SGST/IGST — joined DIRECTLY on BKPF DocumentNo+Year (no RefKey hop)
 *   BSEG   : vendor (Supplier / LIFNR) + amount, where the vendor line exists
 *   ACDOCA : vendor fallback (where present)
 *   LFA1   : Supplier -> Tax Number 3 (GSTIN)
 *
 * Most BKPF docs have no SAP vendor line (the BSEG/ACDOCA extracts are
 * incomplete), so their GSTIN is left blank and the matcher resolves them on
 * invoice-no + tax (tier T4), adopting the GSTIN from the 2B. The total tax
 * (cgst+sgst+igst from BSET) is what matching uses.
 *
 * Usage:  node server/scripts/loadSapData.js [--company "Nandan Terry"] [--fresh]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const path = require('path');
const XLSX = require('xlsx');
const { connect, collections, disconnect } = require('../config/db');
const { normalizeInvoiceNum } = require('../modules/reconcile/matcher');

const ROOT = process.env.SAP_DIR || path.resolve(__dirname, '..', '..');
const NT = path.join(ROOT, 'NT Data');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def; };
const COMPANY = arg('--company', (process.env.COMPANIES || 'Nandan Terry').split(',')[0].trim());
const FRESH = process.argv.includes('--fresh');

// BKPF source (the agreed vendor-invoice source) — the FULL extract. Override via
// SAP_BKPF_FILE. ('bkpf smaller.xlsx' was a partial subset; do not use it.)
const BKPF_FILE = { file: process.env.SAP_BKPF_FILE || 'BKPF Full Data.xlsx', dir: ROOT, sheet: null };
const BSET_FILES = [{ file: 'BSET data.xlsx', dir: NT }, { file: 'BSET data.xlsx', dir: ROOT }];
// Both the NT and the root BSEG extracts are needed — the root file holds vendor
// lines (≈34 docs) that the NT extract is missing. buildVendorByDoc unions them
// (first-seen per document wins; later files only add documents not already present).
const BSEG_FILES = [{ file: 'BSEG data.xlsx', dir: NT }, { file: 'BSEG data.xlsx', dir: ROOT }];
const ACDOCA_FILE = { file: 'ACDOCA.xlsx', dir: ROOT };
const LFA1_GST = { file: 'LFA1 DATA GST.xlsx', dir: ROOT };
// RBKP is NOT a primary source — used (a) as a FALLBACK to fill the vendor code/GSTIN
// for BKPF docs with no SAP vendor line, and (b) for RBKP-only bills not in BKPF at all
// (matched by reference + tax). 'RBKP Data Full.xlsx' is the COMPLETE extract (its 4760
// RE rows == the old NT file + the april-26 workbook sheet combined), so it replaces
// both partials. Columns: Reference @7, Inv. Pty @9, VAT @160, Tax,error @173.
const RBKP_FILES = [{ file: 'RBKP Data Full.xlsx', dir: ROOT }];
// Document types loaded from BKPF, and which GSTR-2B section each reconciles against:
//   RE = MM invoice, KR = FI invoice  -> B2B section   (vendor invoices)
//   KG = credit/debit note            -> B2B-CDNR section
//   SA = G/L document                 -> NONE (loaded for completeness, not reconciled yet)
const VENDOR_TYPES = new Set(['RE', 'KR', 'KG', 'SA']);
const DOC_CATEGORY = { RE: 'B2B', KR: 'B2B', KG: 'CDNR', SA: 'NONE' };

function read({ file, dir, sheet }) {
  // NOTE: no { cellDates: true }. cellDates makes XLSX build Date objects by
  // interpreting Excel serials in the machine's local timezone (IST), which
  // shifts every date back ~5.5h (+a rounding error) — e.g. a Doc. Date of
  // 01-05-2026 becomes 2026-04-30T18:29:50Z and reads as April. We instead keep
  // the raw serial and decode it ourselves (see toDate), which is timezone-safe.
  // When a sheet is named, parse ONLY that sheet so a workbook that also holds a
  // huge tab (e.g. a 159k-row BKPF sheet) isn't loaded into memory.
  // dense:true stores the sheet as a 2D array — the full BKPF (≈413k rows × 22 cols)
  // reads in ~1 min this way; the default cell-by-cell object build stalls on it.
  const opts = { dense: true };
  if (sheet) opts.sheets = sheet;
  const wb = XLSX.readFile(path.join(dir, file), opts);
  const sn = sheet && wb.Sheets[sheet] ? sheet : wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null, blankrows: false });
}
const num = (v) => Number(v) || 0;
// Decode an Excel date cell to the exact IST calendar date shown in SAP, anchored
// at midnight so no timezone math can drift the day/month. Handles raw serials
// (the normal path now that cellDates is off), Date objects, and dd/mm/yyyy or
// ISO strings as fallbacks.
const toDate = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const o = XLSX.SSF.parse_date_code(v);
    return o ? new Date(Date.UTC(o.y, o.m - 1, o.d)) : null;
  }
  if (v instanceof Date) return isNaN(v) ? null : new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);   // dd/mm/yyyy (Indian)
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                    // ISO yyyy-mm-dd
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return null;
};
const CGST = new Set(['JICG', 'JICR', 'JICN']);
const SGST = new Set(['JISG', 'JISR', 'JISN']);
const IGST = new Set(['JIIG', 'JIIR', 'JIIN']);

// BSET: CGST/SGST/IGST per document, deduped across overlapping extracts.
// Only the FORWARD GST conditions are summed — those have a transaction key (Trs)
// starting 'JI' (JIC/JIS/JII). Reverse-charge offsets carry Trs 'JR' (JRC/JRS/JRI)
// under condition types JICR/JISR/JIIR; counting them double-counts the tax on RCM
// bills (forward + reverse), so they are excluded.
function buildBsetSplit() {
  const map = new Map(); const seen = new Set();
  for (const src of BSET_FILES) {
    let rows; try { rows = read(src); } catch { continue; }
    const H = rows[0]; const co = H.indexOf('CoCd'), d = H.indexOf('DocumentNo'), y = H.indexOf('Year'), it = H.indexOf('Itm'), cn = H.indexOf('CnTy'), am = H.indexOf('Amount'), tr = H.indexOf('Trs');
    if (d < 0 || cn < 0 || am < 0) continue;
    for (const r of rows.slice(1)) {
      if (tr >= 0 && !String(r[tr] || '').toUpperCase().startsWith('JI')) continue;  // forward GST only (skip JR% reverse)
      let comp; if (CGST.has(r[cn])) comp = 'cgst'; else if (SGST.has(r[cn])) comp = 'sgst'; else if (IGST.has(r[cn])) comp = 'igst'; else continue;
      const lk = `${r[co]}|${r[d]}|${r[y]}|${r[it]}|${r[cn]}`; if (seen.has(lk)) continue; seen.add(lk);
      const k = `${r[d]}|${r[y]}`; const o = map.get(k) || { cgst: 0, sgst: 0, igst: 0 }; o[comp] += num(r[am]); map.set(k, o);
    }
  }
  return map;
}

// Vendor (Supplier code) + amount per document: BSEG primary, ACDOCA fallback.
function buildVendorByDoc() {
  const map = new Map(); let bsegN = 0, acdocaN = 0;
  for (const src of BSEG_FILES) {
    let rows; try { rows = read(src); } catch { continue; }
    const H = rows[0]; const d = H.indexOf('DocumentNo'), y = H.indexOf('Year'), s = H.indexOf('Supplier'), a = H.indexOf('Amount'), alc = H.indexOf('Amount LC');
    for (const r of rows.slice(1)) {
      const sup = r[s]; if (sup == null || String(sup).trim() === '') continue;
      const k = `${r[d]}|${r[y]}`; if (map.has(k)) continue;
      map.set(k, { code: String(sup), amount: Math.abs(num(r[alc]) || num(r[a])) }); bsegN++;
    }
  }
  try {
    const rows = read(ACDOCA_FILE); const H = rows[0]; const d = H.indexOf('DocumentNo'), y = H.indexOf('Year'), s = H.indexOf('Supplier'), a = H.indexOf('Amount');
    for (const r of rows.slice(1)) {
      const sup = r[s]; if (sup == null || String(sup).trim() === '') continue;
      const k = `${r[d]}|${r[y]}`; if (map.has(k)) continue;
      map.set(k, { code: String(sup), amount: Math.abs(num(r[a])) }); acdocaN++;
    }
  } catch { /* ACDOCA optional */ }
  return { map, bsegN, acdocaN };
}

function buildVendorMaster() {
  const rows = read(LFA1_GST); const H = rows[0];
  const cSup = H.indexOf('Supplier'), cGst = H.indexOf('Tax Number 3'), cName = H.indexOf('Name 1'), cPan = H.indexOf('PAN');
  const map = new Map();
  for (const r of rows.slice(1)) map.set(String(r[cSup]), { gstin: r[cGst] ? String(r[cGst]).toUpperCase().trim() : '', name: r[cName] || '', pan: cPan >= 0 ? (r[cPan] || '') : '' });
  return map;
}

// RBKP fallback index: normalized invoice no -> [{code, gstin, name, tax}].
// RBKP carries the vendor (Inv. Party) directly, so it can supply the vendor
// code/GSTIN for BKPF docs whose vendor line is missing from BSEG/ACDOCA.
function buildRbkpIndex(vendorMaster) {
  const idx = new Map();
  for (const src of RBKP_FILES) {
    let rows; try { rows = read(src); } catch { continue; }
    // RBKP total input tax = VAT + Tax-error (SAP splits part of the tax into the
    // 'Tax, error' column; the deductible total is the sum of both).
    const R = { doc: 0, year: 1, type: 2, ref: 7, pty: 9, rvrsd: 18, vat: 160, taxerr: 173 };
    const reverser = new Set(rows.slice(1).map((r) => r[R.rvrsd]).filter(Boolean).map(String));
    for (const r of rows.slice(1)) {
      if (r[R.type] !== 'RE') continue;
      if ((r[R.rvrsd] != null && r[R.rvrsd] !== '') || reverser.has(String(r[R.doc]))) continue;
      const nref = normalizeInvoiceNum(r[R.ref]); if (!nref) continue;
      const code = String(r[R.pty]); const vm = vendorMaster.get(code) || { gstin: '', name: '' };
      if (!vm.gstin) continue; // only useful if it yields a GSTIN
      const tax = +(num(r[R.vat]) + num(r[R.taxerr])).toFixed(2);
      (idx.get(nref) || idx.set(nref, []).get(nref)).push({ code, gstin: vm.gstin, name: vm.name, tax });
    }
  }
  return idx;
}

// RBKP-only invoices (reference NOT already in BKPF) as stage-2 fallback
// candidates: source='RBKP', GSTIN from LFA1, tax = RBKP VAT + Tax-error total.
function buildRbkpOnlyInvoices(bkpfRefs, vendorMaster) {
  const out = []; const seen = new Set();
  for (const src of RBKP_FILES) {
    let rows; try { rows = read(src); } catch { continue; }
    const R = { doc: 0, year: 1, type: 2, ref: 7, pty: 9, rvrsd: 18, docDate: 151, gross: 156, vat: 160, taxerr: 173 };
    const reverser = new Set(rows.slice(1).map((r) => r[R.rvrsd]).filter(Boolean).map(String));
    for (const r of rows.slice(1)) {
      if (r[R.type] !== 'RE') continue;
      const doc = String(r[R.doc]);
      if ((r[R.rvrsd] != null && r[R.rvrsd] !== '') || reverser.has(doc)) continue;
      const nref = normalizeInvoiceNum(r[R.ref]); if (!nref || bkpfRefs.has(nref)) continue;  // only refs BKPF lacks
      const year = String(r[R.year]); const key = `RBKP:${doc}|${year}`;
      if (seen.has(key)) continue; seen.add(key);
      const code = String(r[R.pty]); const vm = vendorMaster.get(code) || { gstin: '', name: '' };
      const docDate = toDate(r[R.docDate]);
      out.push({
        companyId: COMPANY, source: 'RBKP', docType: 'RE', docCategory: 'B2B',
        docNo: `RBKP:${doc}`, fiscalYear: year,                 // prefixed so it can't collide with BKPF doc nos
        vendorCode: code, vendorName: vm.name || '', vendorGstin: vm.gstin || '', gstinSource: vm.gstin ? 'RBKP-master' : null,
        vendorRef: r[R.ref] != null ? String(r[R.ref]) : '', normalizedInvoiceNum: nref,
        docDate, taxDate: docDate, grossAmount: +num(r[R.gross]).toFixed(2),
        tax: +(num(r[R.vat]) + num(r[R.taxerr])).toFixed(2), cgst: 0, sgst: 0, igst: 0,   // VAT + Tax-error; split not available
        cancelled: false,
      });
    }
  }
  return out;
}

function buildBkpfInvoices(bsetSplit, vendorByDoc, vendorMaster, rbkpByRef) {
  const rows = read(BKPF_FILE); const H = rows[0];
  const B = { doc: H.indexOf('DocumentNo'), ref: H.indexOf('Reference'), year: H.indexOf('Year'), type: H.indexOf('Type'), date: H.indexOf('Doc. Date') };
  const rev = H.indexOf('Reversal');           // not present in every extract
  const out = []; const seen = new Set();
  const stat = { total: 0, withTax: 0, withGstin: 0, fromBseg: 0, fromRbkp: 0, byType: {} };
  for (const r of rows.slice(1)) {
    const type = r[B.type];
    if (!VENDOR_TYPES.has(type)) continue;
    if (rev >= 0 && r[rev] != null && String(r[rev]).trim() !== '') continue; // skip reversed when the column exists
    const ref = r[B.ref] != null ? String(r[B.ref]) : '';
    const nref = normalizeInvoiceNum(ref);
    if (!nref) continue;
    const doc = String(r[B.doc]); const year = String(r[B.year]); const key = `${doc}|${year}`;
    if (seen.has(key)) continue; seen.add(key);

    const split = bsetSplit.get(key) || { cgst: 0, sgst: 0, igst: 0 };
    const tax = +(split.cgst + split.sgst + split.igst).toFixed(2);
    const docDate = toDate(r[B.date]);

    // STAGE-1 vendor: BSEG/ACDOCA only (BKPF + BSET + BSEG + ACDOCA + LFA1).
    const v = vendorByDoc.get(key);
    const code = v ? v.code : '';
    const vm = code ? (vendorMaster.get(code) || { gstin: '', name: '' }) : { gstin: '', name: '' };
    const gstinSource = vm.gstin ? 'SAP' : null;
    if (vm.gstin) stat.fromBseg++;

    // STAGE-2 RESERVE: RBKP fallback (reference + tax), kept in SEPARATE fields.
    // It is NOT used for stage-1 matching — the reconcile applies it only to
    // invoices still unreconciled after stage 1 (BKPF), then via LFA1 -> GSTIN.
    let rbkpVendorCode = '', rbkpGstin = '', rbkpVendorName = '';
    const cands = rbkpByRef.get(nref);
    if (cands && cands.length) {
      // Adopt an RBKP vendor ONLY when its tax actually matches (within ±5). A generic
      // invoice ref (e.g. "5/26-27", reused by many vendors) must not pull in a vendor
      // whose amount is different. (Previously a lone candidate was taken regardless of
      // tax, which attached one vendor's RBKP row to unrelated, different-amount bills.)
      const within = cands.filter((c) => Math.abs(c.tax - tax) <= 5);
      const pick = within.reduce((a, b) => (a && Math.abs(a.tax - tax) <= Math.abs(b.tax - tax)) ? a : b, null);
      if (pick) { rbkpVendorCode = pick.code; rbkpGstin = pick.gstin; rbkpVendorName = pick.name; stat.fromRbkp++; }
    }

    stat.total++; if (tax > 0) stat.withTax++; if (vm.gstin) stat.withGstin++;
    stat.byType[type] = (stat.byType[type] || 0) + 1;

    out.push({
      companyId: COMPANY, source: 'BKPF', docType: type, docCategory: DOC_CATEGORY[type] || 'B2B',
      docNo: doc, fiscalYear: year,
      vendorCode: code, vendorName: vm.name || '', vendorGstin: vm.gstin || '', gstinSource,
      rbkpVendorCode, rbkpGstin, rbkpVendorName,           // stage-2 reserve
      vendorRef: ref, normalizedInvoiceNum: nref,
      docDate, taxDate: docDate,
      grossAmount: v ? +v.amount.toFixed(2) : 0,
      tax, cgst: +split.cgst.toFixed(2), sgst: +split.sgst.toFixed(2), igst: +split.igst.toFixed(2),
      cancelled: false,
    });
  }
  return { invoices: out, stat };
}

async function upsertInvoices(invoices) {
  const ops = invoices.filter((i) => i.docNo).map((i) => ({
    updateOne: {
      filter: { companyId: i.companyId, docNo: i.docNo, fiscalYear: i.fiscalYear },
      update: { $set: i, $setOnInsert: { reconciled: false, createdAt: new Date() } },
      upsert: true,
    },
  }));
  let done = 0;
  for (let k = 0; k < ops.length; k += 1000) {
    const res = await collections.apInvoices().bulkWrite(ops.slice(k, k + 1000), { ordered: false });
    done += (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
  }
  return done;
}

async function upsertVendors(vendorMaster) {
  const ops = [];
  for (const [code, v] of vendorMaster.entries()) {
    if (!v.gstin) continue;
    ops.push({ updateOne: { filter: { companyId: COMPANY, vendorCode: code }, update: { $set: { companyId: COMPANY, vendorCode: code, vendorGstin: v.gstin, vendorName: v.name, pan: v.pan, updatedAt: new Date() } }, upsert: true } });
  }
  if (ops.length) await collections.vendors().bulkWrite(ops, { ordered: false });
  return ops.length;
}

(async () => {
  console.log(`SAP→Mongo ETL (BKPF-driven) | company=${COMPANY} | fresh=${FRESH} | BKPF=${BKPF_FILE.file}`);
  await connect();
  if (FRESH) { const r = await collections.apInvoices().deleteMany({ companyId: COMPANY }); console.log(`  cleared ${r.deletedCount} existing ap_invoices`); }

  console.log('Loading vendor master (LFA1 DATA GST), BSET (tax), BSEG+ACDOCA (vendor), RBKP (fallback) …');
  const vendorMaster = buildVendorMaster();
  const bsetSplit = buildBsetSplit();
  const { map: vendorByDoc, bsegN, acdocaN } = buildVendorByDoc();
  const rbkpByRef = buildRbkpIndex(vendorMaster);
  console.log(`  BSET docs with GST: ${bsetSplit.size} | vendor-by-doc: ${vendorByDoc.size} (BSEG ${bsegN} + ACDOCA ${acdocaN}) | RBKP fallback refs: ${rbkpByRef.size}`);

  console.log('Building BKPF (RE/KR/KG) invoices …');
  const { invoices, stat } = buildBkpfInvoices(bsetSplit, vendorByDoc, vendorMaster, rbkpByRef);
  console.log(`  BKPF vendor invoices: ${stat.total} (${JSON.stringify(stat.byType)}) | with tax: ${stat.withTax}`);
  console.log(`  stage-1 GSTIN from BSEG/ACDOCA: ${stat.fromBseg} | RBKP reserve (display/promote) for: ${stat.fromRbkp} | GSTIN-less at load: ${stat.total - stat.withGstin}`);

  // RBKP-only invoices (reference NOT in BKPF) — loaded as source='RBKP' so the
  // stage-2 fallback can match leftover 2B lines against invoices BKPF lacks.
  const bkpfRefs = new Set(invoices.map((i) => i.normalizedInvoiceNum).filter(Boolean));
  const rbkpOnly = buildRbkpOnlyInvoices(bkpfRefs, vendorMaster);
  console.log(`  RBKP-only invoices (ref not in BKPF) loaded as stage-2 candidates: ${rbkpOnly.length}`);

  const nInv = await upsertInvoices(invoices.concat(rbkpOnly));
  const nVen = await upsertVendors(vendorMaster);
  console.log(`✅ Upserted ${nInv} ap_invoices (source=BKPF) + ${nVen} vendors into "${process.env.MONGODB_DB || 'gst_reco'}".`);

  // Re-apply manual reconciliations from the durable recon_log — this rebuild just
  // wiped the on-invoice flags, so restore the user's manual matches (else those
  // bills resurface as unmatched and re-gate a payment a human already cleared).
  const reconcileService = require('../modules/reconcile/reconcileService');
  const { applied } = await reconcileService.applyManualReconciliations(COMPANY);
  console.log(`  re-applied ${applied} manual reconciliation(s) from recon_log.`);

  await disconnect();
})().catch((e) => { console.error('ETL failed:', e); process.exit(1); });
