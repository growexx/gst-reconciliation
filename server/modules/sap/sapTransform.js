/**
 * SAP API rows → ap_invoices — pure, deterministic mappers.
 *
 * This mirrors the LOGIC of `server/scripts/loadSapData.js` (the offline Excel
 * ETL) exactly — same dedup, same forward-GST filter, same RBKP reserve/fallback,
 * same reversal exclusion, same `tax = VAT + Tax-error` — but reads the live
 * `/zapi_tables` JSON keys instead of Excel column headers. Both paths must
 * produce byte-identical `ap_invoices` so the matcher stays deterministic.
 * (Follow-up: fold loadSapData.js onto these functions so there is one source.)
 *
 * Field names verified live (2026-07): keys are verbose human labels, e.g.
 * "Document Number" / "Fiscal Year" / "Document Type" / "Reference", not BELNR.
 */
const { normalizeInvoiceNum } = require('../reconcile/matcher');

// GST condition types (BSET "Condition Type" / KSCHL). Forward + reverse-charge + non-deductible.
const CGST = new Set(['JICG', 'JICR', 'JICN']);
const SGST = new Set(['JISG', 'JISR', 'JISN']);
const IGST = new Set(['JIIG', 'JIIR', 'JIIN']);

// BKPF doc types kept as vendor invoices, and the 2B section each reconciles against.
const VENDOR_TYPES = new Set(['RE', 'KR', 'KG']);           // SA (imports) handled separately (IMPG)
const DOC_CATEGORY = { RE: 'B2B', KR: 'B2B', KG: 'CDNR' };

const num = (v) => Number(v) || 0;

// Decode an API date. The APIs return ISO "YYYY-MM-DD" (or "" ); anchor at UTC
// midnight so no timezone math can drift the day. DD/MM/YYYY tolerated as a fallback.
function toDate(v) {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);              // ISO
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);     // dd/mm/yyyy
    if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

// ── API field accessors (one place to adjust if the API labels ever change) ──
const F = {
    bkpf: {
        doc: (r) => r['Document Number'], year: (r) => r['Fiscal Year'], type: (r) => r['Document Type'],
        ref: (r) => r['Reference'], date: (r) => r['Document Date'], reversal: (r) => r['Reversed With'],
    },
    bseg: {
        doc: (r) => r['Document Number'], year: (r) => r['Fiscal Year'], supplier: (r) => r['Supplier'],
        amountLC: (r) => r['Amount in Loc. Curr.'], amount: (r) => r['Amount'], text: (r) => r['Text'],
    },
    bset: {
        coCd: (r) => r['Company Code'], doc: (r) => r['Document Number'], year: (r) => r['Fiscal Year'],
        itm: (r) => r['Item'], cnTy: (r) => r['Condition Type'], amount: (r) => r['Amount'], trs: (r) => r['Transaction'],
    },
    rbkp: {
        doc: (r) => r['Invoice Document No.'], year: (r) => r['Fiscal Year'], type: (r) => r['Document Type'],
        ref: (r) => r['Reference'], pty: (r) => r['Invoicing Party'], rvrsd: (r) => r['Reversed by'],
        vat: (r) => r['Value-Added Tax Amt'], taxerr: (r) => r['Tax in Supplier Error'],
        docDate: (r) => r['Document Date'], gross: (r) => r['Gross Invoice Amount'],
    },
    lfa1: {
        supplier: (r) => r['Supplier'], gstin: (r) => r['Tax Number 3'],
        name: (r) => r['Name'], pan: (r) => r['Permanent account number'],
    },
};

// BSET: CGST/SGST/IGST per document, deduped, FORWARD GST only (Trs starts 'JI';
// reverse-charge JR% offsets excluded — counting them double-counts RCM tax).
function buildBsetSplit(rows) {
    const map = new Map(); const seen = new Set(); const b = F.bset;
    for (const r of rows) {
        const trs = b.trs(r);
        if (trs != null && !String(trs).toUpperCase().startsWith('JI')) continue;
        const cn = b.cnTy(r);
        let comp; if (CGST.has(cn)) comp = 'cgst'; else if (SGST.has(cn)) comp = 'sgst'; else if (IGST.has(cn)) comp = 'igst'; else continue;
        const lk = `${b.coCd(r)}|${b.doc(r)}|${b.year(r)}|${b.itm(r)}|${cn}`;
        if (seen.has(lk)) continue; seen.add(lk);
        const k = `${b.doc(r)}|${b.year(r)}`;
        const o = map.get(k) || { cgst: 0, sgst: 0, igst: 0 };
        o[comp] += num(b.amount(r)); map.set(k, o);
    }
    return map;
}

// Vendor (Supplier code) + amount per document, first-seen (BSEG only here — the API
// has no ACDOCA endpoint; most RE docs resolve their vendor via RBKP instead).
function buildVendorByDoc(rows) {
    const map = new Map(); const b = F.bseg;
    for (const r of rows) {
        const sup = b.supplier(r);
        if (sup == null || String(sup).trim() === '') continue;
        const k = `${b.doc(r)}|${b.year(r)}`; if (map.has(k)) continue;
        map.set(k, { code: String(sup), amount: Math.abs(num(b.amountLC(r)) || num(b.amount(r))) });
    }
    return map;
}

function buildVendorMaster(rows) {
    const map = new Map(); const l = F.lfa1;
    for (const r of rows) {
        const sup = l.supplier(r); if (sup == null) continue;
        map.set(String(sup), {
            gstin: l.gstin(r) ? String(l.gstin(r)).toUpperCase().trim() : '',
            name: l.name(r) || '', pan: l.pan(r) || '',
        });
    }
    return map;
}

// RBKP fallback index: normalized invoice-no -> [{code, gstin, name, tax}]. RBKP carries
// the vendor (Invoicing Party) directly, supplying vendor/GSTIN for BKPF docs whose
// vendor line is missing. tax = VAT + Tax-error (SAP splits part of the tax into the
// error column — the deductible total needs both).
function buildRbkpIndex(rows, vendorMaster) {
    const idx = new Map(); const r_ = F.rbkp;
    const reverser = new Set(rows.map((r) => r_.rvrsd(r)).filter((v) => v != null && v !== '').map(String));
    for (const r of rows) {
        if (r_.type(r) !== 'RE') continue;
        const rv = r_.rvrsd(r);
        if ((rv != null && rv !== '') || reverser.has(String(r_.doc(r)))) continue;
        const nref = normalizeInvoiceNum(r_.ref(r)); if (!nref) continue;
        const code = String(r_.pty(r)); const vm = vendorMaster.get(code) || { gstin: '', name: '' };
        if (!vm.gstin) continue;
        const tax = +(num(r_.vat(r)) + num(r_.taxerr(r))).toFixed(2);
        if (!idx.has(nref)) idx.set(nref, []);
        idx.get(nref).push({ code, gstin: vm.gstin, name: vm.name, tax });
    }
    return idx;
}

// RBKP-only invoices (reference NOT in BKPF) as stage-2 fallback candidates:
// source='RBKP', GSTIN from LFA1, tax = VAT + Tax-error.
function buildRbkpOnlyInvoices(rows, bkpfRefs, vendorMaster, companyId) {
    const out = []; const seen = new Set(); const r_ = F.rbkp;
    const reverser = new Set(rows.map((r) => r_.rvrsd(r)).filter((v) => v != null && v !== '').map(String));
    for (const r of rows) {
        if (r_.type(r) !== 'RE') continue;
        const doc = String(r_.doc(r));
        const rv = r_.rvrsd(r);
        if ((rv != null && rv !== '') || reverser.has(doc)) continue;
        const nref = normalizeInvoiceNum(r_.ref(r)); if (!nref || bkpfRefs.has(nref)) continue;
        const year = String(r_.year(r)); const key = `RBKP:${doc}|${year}`;
        if (seen.has(key)) continue; seen.add(key);
        const code = String(r_.pty(r)); const vm = vendorMaster.get(code) || { gstin: '', name: '' };
        const docDate = toDate(r_.docDate(r));
        out.push({
            companyId, source: 'RBKP', docType: 'RE', docCategory: 'B2B',
            docNo: `RBKP:${doc}`, fiscalYear: year,
            vendorCode: code, vendorName: vm.name || '', vendorGstin: vm.gstin || '', gstinSource: vm.gstin ? 'RBKP-master' : null,
            vendorRef: r_.ref(r) != null ? String(r_.ref(r)) : '', normalizedInvoiceNum: nref,
            docDate, taxDate: docDate, grossAmount: +num(r_.gross(r)).toFixed(2),
            tax: +(num(r_.vat(r)) + num(r_.taxerr(r))).toFixed(2), cgst: 0, sgst: 0, igst: 0,
            cancelled: false,
        });
    }
    return out;
}

// BKPF (RE/KR/KG) invoices with BSET tax, BSEG vendor, and the RBKP reserve fields.
function buildBkpfInvoices(rows, bsetSplit, vendorByDoc, vendorMaster, rbkpByRef, companyId) {
    const out = []; const seen = new Set(); const b = F.bkpf;
    const stat = { total: 0, withTax: 0, withGstin: 0, fromBseg: 0, fromRbkp: 0, byType: {} };
    for (const r of rows) {
        const type = b.type(r);
        if (!VENDOR_TYPES.has(type)) continue;
        const rev = b.reversal(r);
        if (rev != null && String(rev).trim() !== '') continue;               // skip reversed
        const ref = b.ref(r) != null ? String(b.ref(r)) : '';
        const nref = normalizeInvoiceNum(ref); if (!nref) continue;
        const doc = String(b.doc(r)); const year = String(b.year(r)); const key = `${doc}|${year}`;
        if (seen.has(key)) continue; seen.add(key);

        const split = bsetSplit.get(key) || { cgst: 0, sgst: 0, igst: 0 };
        const tax = +(split.cgst + split.sgst + split.igst).toFixed(2);
        const docDate = toDate(b.date(r));

        const v = vendorByDoc.get(key);
        const code = v ? v.code : '';
        const vm = code ? (vendorMaster.get(code) || { gstin: '', name: '' }) : { gstin: '', name: '' };
        const gstinSource = vm.gstin ? 'SAP' : null;
        if (vm.gstin) stat.fromBseg++;

        // RBKP reserve (separate fields; used only as a stage-2 fallback). Adopt an RBKP
        // vendor only when its tax matches within ±5 (a generic invoice ref reused by many
        // vendors must not pull in a different-amount vendor).
        let rbkpVendorCode = '', rbkpGstin = '', rbkpVendorName = '';
        const cands = rbkpByRef.get(nref);
        if (cands && cands.length) {
            const within = cands.filter((c) => Math.abs(c.tax - tax) <= 5);
            const pick = within.reduce((a, c) => (a && Math.abs(a.tax - tax) <= Math.abs(c.tax - tax)) ? a : c, null);
            if (pick) { rbkpVendorCode = pick.code; rbkpGstin = pick.gstin; rbkpVendorName = pick.name; stat.fromRbkp++; }
        }

        stat.total++; if (tax > 0) stat.withTax++; if (vm.gstin) stat.withGstin++;
        stat.byType[type] = (stat.byType[type] || 0) + 1;

        out.push({
            companyId, source: 'BKPF', docType: type, docCategory: DOC_CATEGORY[type] || 'B2B',
            docNo: doc, fiscalYear: year,
            vendorCode: code, vendorName: vm.name || '', vendorGstin: vm.gstin || '', gstinSource,
            rbkpVendorCode, rbkpGstin, rbkpVendorName,
            vendorRef: ref, normalizedInvoiceNum: nref,
            docDate, taxDate: docDate,
            grossAmount: v ? +v.amount.toFixed(2) : 0,
            tax, cgst: +split.cgst.toFixed(2), sgst: +split.sgst.toFixed(2), igst: +split.igst.toFixed(2),
            cancelled: false,
        });
    }
    return { invoices: out, stat };
}

// ── IMPG (imports) ──
// A customs Bill-of-Entry number lives in the SA doc's BSEG "Text" as `BE:1234567`
// (also `BE 1234567`); the import IGST is the amount posted to the import-IGST GL
// account (SAP_IMPG_IGST_GL, default 0000170025). SA docs with no BE token (e.g. a
// ROSTL-licence line) are not imports and are skipped. `boe` is normalized (leading
// zeros stripped) so it can compare to the 2B IMPG Bill-of-Entry number.
const BOE_RE = /\bBO?E[:\s]+0*(\d{4,8})\b/i;
const normBoe = (s) => String(s == null ? '' : s).replace(/\D/g, '').replace(/^0+/, '');

function buildImpgInvoices(saImport, companyId) {
    const igstGl = process.env.SAP_IMPG_IGST_GL || '0000170025';
    const igstGlN = Number(igstGl);   // compare numerically → robust to zero-padding (0000170025 vs 170025)
    const out = [];
    const bsegByDoc = new Map();
    for (const r of (saImport.bseg || [])) {
        const d = String(r['Document Number']); if (!bsegByDoc.has(d)) bsegByDoc.set(d, []); bsegByDoc.get(d).push(r);
    }
    for (const h of (saImport.bkpf || [])) {
        const doc = String(h['Document Number']); const year = String(h['Fiscal Year']);
        const lines = bsegByDoc.get(doc) || [];
        let boe = '';
        for (const l of lines) { const m = String(l['Text'] || '').match(BOE_RE); if (m) { boe = normBoe(m[1]); break; } }
        if (!boe) continue;                                  // no Bill-of-Entry → not an import doc
        const igst = +lines.filter((l) => Number(l['hkont'] || l['G/L Account'] || 0) === igstGlN)
            .reduce((s, l) => s + Math.abs(num(l['Amount'])), 0).toFixed(2);
        const docDate = toDate(h['Document Date']);
        out.push({
            companyId, source: 'BKPF', docType: 'SA', docCategory: 'IMPG',
            docNo: doc, fiscalYear: year,
            boe, vendorRef: `BOE:${boe}`, normalizedInvoiceNum: boe,
            vendorName: 'Customs (Import)', vendorCode: '', vendorGstin: '', gstinSource: null,
            docDate, taxDate: docDate,
            grossAmount: 0, tax: igst, igst, cgst: 0, sgst: 0, igst_split: igst,
            cancelled: false,
        });
    }
    return out;
}

// Keys (docNo|fiscalYear, in the SAME form stored on ap_invoices) of docs SAP now flags
// as reversed. These are already excluded from the invoice list; syncSapWindow uses this
// set to cancel any copy an earlier fetch left in ap_invoices, so a bill reversed after it
// was first loaded stops being a match candidate. Mirrors the skip logic in
// buildBkpfInvoices / buildRbkpOnlyInvoices exactly.
function collectReversedKeys(bkpf, rbkp) {
    const keys = new Set();
    const B = F.bkpf, R = F.rbkp;
    for (const r of bkpf) {
        if (!VENDOR_TYPES.has(B.type(r))) continue;
        const rev = B.reversal(r);
        if (rev != null && String(rev).trim() !== '') keys.add(`${String(B.doc(r))}|${String(B.year(r))}`);
    }
    const reverser = new Set(rbkp.map((r) => R.rvrsd(r)).filter((v) => v != null && v !== '').map(String));
    for (const r of rbkp) {
        if (R.type(r) !== 'RE') continue;
        const doc = String(R.doc(r));
        const rv = R.rvrsd(r);
        if ((rv != null && rv !== '') || reverser.has(doc)) keys.add(`RBKP:${doc}|${String(R.year(r))}`);
    }
    return keys;
}

/**
 * Build the full ap_invoices list from raw API tables.
 * @param {Object} tables { bkpf, bseg, bset, rbkp, lfa1, saImport } arrays of raw API rows
 * @param {string} companyId
 * @returns {{ invoices, vendorMaster, stat, reversedKeys }}
 */
function buildInvoices(tables, companyId) {
    const { bkpf = [], bseg = [], bset = [], rbkp = [], lfa1 = [], saImport = {} } = tables;
    const vendorMaster = buildVendorMaster(lfa1);
    const bsetSplit = buildBsetSplit(bset);
    const vendorByDoc = buildVendorByDoc(bseg);
    const rbkpByRef = buildRbkpIndex(rbkp, vendorMaster);

    const { invoices: bkpfInv, stat } = buildBkpfInvoices(bkpf, bsetSplit, vendorByDoc, vendorMaster, rbkpByRef, companyId);
    const bkpfRefs = new Set(bkpfInv.map((i) => i.normalizedInvoiceNum).filter(Boolean));
    const rbkpOnly = buildRbkpOnlyInvoices(rbkp, bkpfRefs, vendorMaster, companyId);
    const impg = buildImpgInvoices(saImport, companyId);

    return {
        invoices: bkpfInv.concat(rbkpOnly, impg), vendorMaster,
        reversedKeys: collectReversedKeys(bkpf, rbkp),
        stat: { ...stat, rbkpOnly: rbkpOnly.length, impg: impg.length },
    };
}

module.exports = {
    F, toDate, num, normBoe, CGST, SGST, IGST, VENDOR_TYPES, DOC_CATEGORY,
    buildBsetSplit, buildVendorByDoc, buildVendorMaster, buildRbkpIndex, buildRbkpOnlyInvoices,
    buildBkpfInvoices, buildImpgInvoices, buildInvoices,
};
