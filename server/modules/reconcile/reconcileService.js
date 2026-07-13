/**
 * Reconciliation service — MongoDB implementation.
 *
 * AP-invoice data lives in `ap_invoices`, loaded from BKPF by the SAP ETL
 * (server/scripts/loadSapData.js). This module imports the GSTR-2B portal file,
 * stores the B2B lines, runs the tiered matcher, auto-reconciles matched AP
 * invoices, and returns the unmatched bills for manual review.
 */
const xlsx = require('xlsx');
const { ObjectId } = require('mongodb');
const { collections } = require('../../config/db');
const { normalizeInvoiceNum, reconcile, matchImpg, MATCHED_CATEGORIES } = require('./matcher');
const { fetchWindow } = require('../sap/sapClient');
const { buildInvoices } = require('../sap/sapTransform');

// When true (default), each 2B upload pulls that month's SAP data on-demand via the
// /zapi_tables API and upserts ap_invoices before matching. Set SAP_FETCH_ON_RECONCILE
// =false to reconcile against whatever the offline ETL (loadSapData.js) already loaded.
const SAP_FETCH_ON_RECONCILE = process.env.SAP_FETCH_ON_RECONCILE !== 'false';

// ── Fallback header mapping for an already-flat portal sheet ───────────────
const HEADER_ALIASES = {
    supplierGstin:  ['gstin of supplier', 'supplier gstin', 'gstin', 'u_supplier_gst'],
    invoiceNum:     ['invoice number', 'invoice no', 'invoice no.', 'u_invoice_num'],
    invoiceDate:    ['invoice date', 'u_invoice_date'],
    invoiceValue:   ['invoice value', 'taxable value', 'total value'],
    centralTax:     ['central tax', 'cgst', 'central tax(₹)', 'u_central_tax'],
    stateTax:       ['state/ut tax', 'state tax', 'sgst', 'u_state_ut_tax'],
    integratedTax:  ['integrated tax', 'igst', 'u_integrated_tax'],
};

function buildHeaderIndex(sampleRow) {
    const idx = {};
    const keys = Object.keys(sampleRow || {});
    for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
        const found = keys.find((k) => aliases.includes(String(k).trim().toLowerCase()));
        if (found) idx[canonical] = found;
    }
    return idx;
}

function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    return Number(String(v).replace(/,/g, '')) || 0;
}

function parseDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date && !isNaN(value)) return value;
    const s = String(value).trim();
    if (/^\d+$/.test(s)) {                       // Excel serial
        const n = Number(s);
        const base = Date.UTC(1899, 11, 30);
        return new Date(base + n * 86400000);
    }
    let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/); // DD/MM/YYYY
    if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);     // YYYY-MM-DD
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function financialYearStart(month, year) {
    const m = MONTHS[month] || Number(month) || 1;
    const startYear = m >= 4 ? Number(year) : Number(year) - 1;
    return new Date(Date.UTC(startYear, 3, 1)); // April 1
}

/**
 * Reconciliation window = the current financial year (of month/year) PLUS the
 * previous one — two Indian FYs (Apr–Mar). Both SAP invoices (by Doc Date) and
 * 2B lines (by invoice date) within [start, end) are eligible to be re-matched.
 */
function fyWindow(month, year) {
    const fyStart = financialYearStart(month, year);
    const y = fyStart.getUTCFullYear();
    return {
        start: new Date(Date.UTC(y - 1, 3, 1)),   // previous FY, 1 April
        end:   new Date(Date.UTC(y + 1, 3, 1)),    // next FY, 1 April (exclusive)
    };
}

const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{13}$/i;

/**
 * Map canonical column names → indexes by matching header TEXT (whitespace-stripped,
 * lowercased) across the header block, per column. Robust to GSTR-2B layout changes —
 * e.g. the newer IMS-format 2B inserts a "Rate(%)" column that shifts the tax columns,
 * which would break any fixed-position parser. Only returns keys it actually finds.
 */
function detectColumns(headerRows, patterns) {
    let ncol = 0;
    for (const r of headerRows) if (Array.isArray(r)) ncol = Math.max(ncol, r.length);
    const colText = [];
    for (let c = 0; c < ncol; c++) {
        colText[c] = headerRows.map((r) => String((r && r[c] != null) ? r[c] : '')).join(' ').toLowerCase().replace(/\s+/g, '');
    }
    const idx = {};
    for (const [key, pats] of Object.entries(patterns)) {
        for (let c = 0; c < ncol; c++) { if (pats.some((p) => colText[c].includes(p))) { idx[key] = c; break; } }
    }
    return idx;
}

/**
 * Parse a GSTR-2B workbook (the government B2B sheet has a multi-row header
 * block, so we locate the data by position). Falls back to an alias-based flat
 * parse for already-shaped sheets.
 * @returns {Array} raw line objects (pre-DB-shape)
 */
function parseGstr2bB2B(fileBuffer) {
    const wb = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
    // Prefer the B2B sheet; else the first sheet.
    const sheetName = wb.SheetNames.find((n) => String(n).trim().toUpperCase() === 'B2B') || wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
    if (!rows.length) throw new Error('No data found in the Excel file');

    // Find the header row that names the supplier GSTIN column.
    const headerRowIdx = rows.findIndex((r) =>
        Array.isArray(r) && r.some((c) => String(c || '').trim().toLowerCase().includes('gstin of supplier')));

    if (headerRowIdx === -1) {
        return parseFlatSheet(sheet); // not a standard GSTR-2B layout
    }

    // Data starts at the first row (after the header block) whose col 0 is a GSTIN.
    let dataStart = -1;
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
        if (GSTIN_RE.test(String((rows[i] || [])[0] || '').trim())) { dataStart = i; break; }
    }
    if (dataStart === -1) throw new Error('GSTR-2B file: could not locate the B2B data rows.');

    // Columns by header label (robust to the newer IMS layout's extra "Rate(%)" column
    // that shifts the tax columns). Falls back to the classic fixed positions if a label
    // isn't found.
    const D = detectColumns(rows.slice(0, dataStart), {
        gstin: ['gstinofsupplier'], name: ['legalname'], invno: ['invoicenumber'], invtype: ['invoicetype'],
        invdate: ['invoicedate'], invval: ['invoicevalue'], igst: ['integratedtax'], cgst: ['centraltax'],
        sgst: ['state/uttax', 'stateuttax'], cess: ['cess'], pos: ['placeofsupply'], itc: ['itcavailability'],
    });
    const C = {
        gstin: D.gstin ?? 0, name: D.name ?? 1, invno: D.invno ?? 2, invtype: D.invtype ?? 3,
        invdate: D.invdate ?? 4, invval: D.invval ?? 5, pos: D.pos ?? 6,
        igst: D.igst ?? 9, cgst: D.cgst ?? 10, sgst: D.sgst ?? 11, cess: D.cess ?? 12, itc: D.itc ?? 15,
    };
    const out = [];
    for (let i = dataStart; i < rows.length; i++) {
        const r = rows[i] || [];
        const gstin = String(r[C.gstin] || '').trim().toUpperCase();
        if (!GSTIN_RE.test(gstin)) continue; // skip stray/total rows
        out.push({
            supplierGstin: gstin,
            supplierName: r[C.name] != null ? String(r[C.name]).trim() : '',
            invoiceNum: r[C.invno] != null ? String(r[C.invno]).trim() : '',
            invoiceType: r[C.invtype] != null ? String(r[C.invtype]).trim() : '',
            pos: r[C.pos] != null ? String(r[C.pos]).trim() : '',
            invoiceDate: parseDate(r[C.invdate]),
            invoiceValue: num(r[C.invval]),
            centralTax: num(r[C.cgst]),
            stateTax: num(r[C.sgst]),
            integratedTax: num(r[C.igst]),
            cess: num(r[C.cess]),
            itcAvailable: r[C.itc] != null ? String(r[C.itc]).trim() : '',
        });
    }
    return out;
}

/**
 * Parse the GSTR-2B "B2B-CDNR" sheet (credit/debit notes received). Same multi-row
 * header layout as B2B; the note number plays the role of the invoice number for
 * matching, and the note type (Credit Note / Debit Note) is preserved.
 * @returns {Array} raw CDNR line objects (pre-DB-shape); [] if the sheet is absent.
 */
function parseGstr2bCDNR(fileBuffer) {
    const wb = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames.find((n) => String(n).trim().toUpperCase() === 'B2B-CDNR');
    if (!sheetName) return [];                          // file has no CDNR sheet
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, blankrows: false });
    if (!rows.length) return [];

    // Data starts at the first row whose col 0 is a GSTIN (after the 2-row header block).
    let dataStart = -1;
    for (let i = 0; i < rows.length; i++) {
        if (GSTIN_RE.test(String((rows[i] || [])[0] || '').trim())) { dataStart = i; break; }
    }
    if (dataStart === -1) return [];

    // Standard GSTR-2B B2B-CDNR column order.
    const D = detectColumns(rows.slice(0, dataStart), {
        gstin: ['gstinofsupplier'], name: ['legalname'], noteno: ['notenumber'], notetype: ['notetype'],
        notedate: ['notedate'], noteval: ['notevalue'], igst: ['integratedtax'], cgst: ['centraltax'],
        sgst: ['state/uttax', 'stateuttax'], cess: ['cess'], pos: ['placeofsupply'],
    });
    const C = {
        gstin: D.gstin ?? 0, name: D.name ?? 1, noteno: D.noteno ?? 2, notetype: D.notetype ?? 3,
        notedate: D.notedate ?? 5, noteval: D.noteval ?? 6, pos: D.pos ?? 7,
        igst: D.igst ?? 10, cgst: D.cgst ?? 11, sgst: D.sgst ?? 12, cess: D.cess ?? 13,
    };
    const out = [];
    for (let i = dataStart; i < rows.length; i++) {
        const r = rows[i] || [];
        const gstin = String(r[C.gstin] || '').trim().toUpperCase();
        if (!GSTIN_RE.test(gstin)) continue;            // skip stray / total rows
        const noteType = r[C.notetype] != null ? String(r[C.notetype]).trim() : '';
        out.push({
            supplierGstin: gstin,
            supplierName: r[C.name] != null ? String(r[C.name]).trim() : '',
            invoiceNum: r[C.noteno] != null ? String(r[C.noteno]).trim() : '',   // note no == match key
            invoiceType: noteType,
            noteType,                                    // 'Credit Note' | 'Debit Note'
            pos: r[C.pos] != null ? String(r[C.pos]).trim() : '',
            invoiceDate: parseDate(r[C.notedate]),
            invoiceValue: num(r[C.noteval]),
            centralTax: num(r[C.cgst]),
            stateTax: num(r[C.sgst]),
            integratedTax: num(r[C.igst]),
            cess: num(r[C.cess]),
            itcAvailable: '',
        });
    }
    return out;
}

/**
 * Parse the GSTR-2B "IMPG" sheet (import of goods on bill of entry). Two-row header;
 * data columns: 0 Icegate ref date, 1 port code, 2 BoE number, 3 BoE date, 4 taxable
 * value, 5 IGST, 6 cess. The normalized Bill-of-Entry number is the match key.
 * @returns {Array} raw IMPG line objects (pre-DB-shape); [] if the sheet is absent.
 */
function parseGstr2bIMPG(fileBuffer) {
    const wb = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames.find((n) => String(n).trim().toUpperCase() === 'IMPG');
    if (!sheetName) return [];
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, blankrows: false });
    const out = [];
    for (const r of rows) {
        const raw = String((r || [])[2] == null ? '' : r[2]).trim();
        if (!/^\d{3,}$/.test(raw) || r[5] == null) continue;    // BoE-number data rows only
        out.push({
            boe: raw.replace(/^0+/, ''),
            portCode: r[1] != null ? String(r[1]).trim() : '',
            invoiceDate: parseDate(r[3]),                        // BoE date
            taxable: num(r[4]), igst: num(r[5]), cess: num(r[6]),
        });
    }
    return out;
}

/** Fallback: a flat sheet with recognizable headers (one header row). */
function parseFlatSheet(sheet) {
    const rows = xlsx.utils.sheet_to_json(sheet);
    if (!rows.length) throw new Error('No data found in the Excel file');
    const hi = buildHeaderIndex(rows[0]);
    if (!hi.supplierGstin || !hi.invoiceNum) {
        throw new Error('Could not find required columns (supplier GSTIN / invoice number) in the file.');
    }
    return rows.map((r) => ({
        supplierGstin: hi.supplierGstin ? String(r[hi.supplierGstin] || '').trim().toUpperCase() : '',
        supplierName: '',
        invoiceNum: hi.invoiceNum && r[hi.invoiceNum] != null ? String(r[hi.invoiceNum]).trim() : '',
        invoiceType: '',
        pos: '',
        invoiceDate: hi.invoiceDate ? parseDate(r[hi.invoiceDate]) : null,
        invoiceValue: hi.invoiceValue ? num(r[hi.invoiceValue]) : 0,
        centralTax: hi.centralTax ? num(r[hi.centralTax]) : 0,
        stateTax: hi.stateTax ? num(r[hi.stateTax]) : 0,
        integratedTax: hi.integratedTax ? num(r[hi.integratedTax]) : 0,
        cess: 0,
        itcAvailable: '',
    }));
}

function toBillDTO(inv, cls) {
    // Show the RBKP-reserve vendor when SAP (BSEG/ACDOCA) didn't give one, so an
    // unreconciled bill isn't "undefined" if RBKP actually knows the vendor.
    const gstin = inv.vendorGstin || inv.rbkpGstin || '';
    const code = inv.vendorCode || inv.rbkpVendorCode || '';
    const name = inv.vendorName || inv.rbkpVendorName || '';
    return {
        CardCode: code,
        CardName: name,
        GSTRegnNo: gstin,
        VendorGST: gstin,
        DocEntry: `${inv.docNo}|${inv.fiscalYear}`,
        DocNum: inv.docNo,
        NumAtCard: inv.vendorRef,
        DocDate: inv.taxDate || inv.docDate,
        DocTotal: inv.grossAmount,
        Tax: inv.tax != null ? inv.tax : (Number(inv.cgst) || 0) + (Number(inv.sgst) || 0) + (Number(inv.igst) || 0),
        CGST: inv.cgst || 0,
        SGST: inv.sgst || 0,
        IGST: inv.igst || 0,
        Source: inv.source || 'RBKP',
        ReasonCategory: cls ? cls.category : 'unknown',
        Reason: cls ? cls.reason : '',
    };
}

// Index the uploaded portal lines so we can explain why a SAP bill didn't match.
function buildPortalIndex(lines) {
    const gstins = new Set();
    const invIndex = new Map(); // normalizedInvoiceNum -> Set(gstin)
    for (const l of lines) {
        const g = String(l.supplierGstin || '').toUpperCase();
        if (g) gstins.add(g);
        const r = l.normalizedInvoiceNum || normalizeInvoiceNum(l.invoiceNum);
        if (r) {
            if (!invIndex.has(r)) invIndex.set(r, new Set());
            invIndex.get(r).add(g);
        }
    }
    return { gstins, invIndex };
}

/** Bucket an unmatched AP invoice into a reason category vs the 2B universe. */
function classifyUnmatched(inv, idx) {
    const gstin = String(inv.vendorGstin || inv.rbkpGstin || '').toUpperCase();   // effective GSTIN (incl. RBKP)
    if (!gstin) return { category: 'gstin_not_found', reason: 'GSTIN not found (not in BKPF/BSEG/ACDOCA or RBKP)' };
    if (/^&&/.test(String(inv.vendorRef || ''))) {
        return { category: 'auto_ref', reason: 'Auto-ref (&&) — no invoice number to match on' };
    }
    const ref = inv.normalizedInvoiceNum || normalizeInvoiceNum(inv.vendorRef);
    const gset = ref ? idx.invIndex.get(ref) : null;
    if (gset && gset.size && !gset.has(gstin)) {
        return { category: 'gstin_mismatch', reason: 'GSTIN mismatch — invoice no. is in 2B under a different GSTIN' };
    }
    if (!idx.gstins.has(gstin)) {
        return { category: 'gstin_not_in_2b', reason: 'Vendor GSTIN not present in the 2B file' };
    }
    return { category: 'invoice_not_in_2b', reason: 'Invoice not in 2B (GSTIN is in 2B) — likely timing / unbooked' };
}

// ── 2B-side (mirror): a 2B line present in the portal but not matched in SAP ──
function buildSapIndex(invoices) {
    const gstins = new Set();
    const invIndex = new Map(); // normalizedInvoiceNum -> Set(gstin)
    for (const inv of invoices) {
        const g = String(inv.vendorGstin || '').toUpperCase();
        if (g) gstins.add(g);
        const r = inv.normalizedInvoiceNum || normalizeInvoiceNum(inv.vendorRef);
        if (r) { if (!invIndex.has(r)) invIndex.set(r, new Set()); invIndex.get(r).add(g); }
    }
    return { gstins, invIndex };
}

/** Bucket an unmatched 2B line into a reason category vs the SAP universe. */
function classify2bUnmatched(line, idx) {
    const gstin = String(line.supplierGstin || '').toUpperCase();
    const ref = line.normalizedInvoiceNum || normalizeInvoiceNum(line.invoiceNum);
    const gset = ref ? idx.invIndex.get(ref) : null;
    if (gset && gset.size && !gset.has(gstin)) {
        return { category: 'gstin_mismatch', reason: 'GSTIN mismatch — invoice no. is in SAP under a different GSTIN' };
    }
    if (idx.gstins.has(gstin)) {
        return { category: 'known_vendor_not_booked', reason: 'Supplier is a known SAP vendor — invoice not booked (timing / FI)' };
    }
    return { category: 'vendor_not_in_sap', reason: 'Vendor GSTIN not present in SAP (FI / non-AP / new vendor)' };
}

/** Map an unmatched 2B portal line to the bill-DTO shape the UI groups on. */
function to2bLineDTO(line, cls) {
    const tax = line.tax != null ? line.tax : (Number(line.centralTax) || 0) + (Number(line.stateTax) || 0) + (Number(line.integratedTax) || 0);
    return {
        CardCode: line.supplierGstin || '—',
        CardName: line.supplierName || line.supplierGstin || '—',
        GSTRegnNo: line.supplierGstin,
        VendorGST: line.supplierGstin,
        DocEntry: null,                       // no SAP document — read-only row
        NumAtCard: line.invoiceNum,
        DocDate: line.invoiceDate,
        DocTotal: line.invoiceValue,
        Tax: tax,
        CGST: line.centralTax || 0,
        SGST: line.stateTax || 0,
        IGST: line.integratedTax || 0,
        Source: '2B',
        ReasonCategory: cls ? cls.category : 'unknown',
        Reason: cls ? cls.reason : '',
    };
}

function monthIndex0(month) {
    if (month == null) return null;
    const m = MONTHS[month] || Number(month);
    return Number.isFinite(m) ? m - 1 : null;
}
function inMonth(d, year, m0) {
    if (!d) return false;
    const x = new Date(d);
    return x.getUTCFullYear() === Number(year) && x.getUTCMonth() === m0;
}

// Fetch + match window = the reconcile month ± `pad` months (SAP_MATCH_PAD_MONTHS, default
// 2), NOT the whole financial year. This bounds SAP fetch volume and memory to a fixed span so
// it stays flat no matter how many years of history accumulate in SAP. `fiscalSegments`
// splits the range across the Mar↔Apr GJAHR boundary, so a window that crosses fiscal years
// is fetched correctly. Returns Date bounds (for the docDate match/candidate window) and
// YYYYMMDD strings (for the SAP API date filter).
const fmtYmd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
function monthPadWindow(month, year, pad) {
    const m0 = monthIndex0(month); const y = Number(year);
    if (m0 == null) throw new Error(`monthPadWindow needs a specific month, got "${month}"`);
    const start = new Date(Date.UTC(y, m0 - pad, 1));
    const end = new Date(Date.UTC(y, m0 + pad + 1, 1));               // exclusive (last day of month+pad)
    return { start, end, from: fmtYmd(start), to: fmtYmd(new Date(end.getTime() - 86400000)) };
}

// The single window used for BOTH the SAP fetch/match AND every report/count view, so a
// report can never claim coverage the matcher didn't attempt. A specific month → that
// month ± SAP_MATCH_PAD_MONTHS; 'All' → the current + previous FY. Always returns Date
// bounds (start/end) and YYYYMMDD strings (from/to) for the SAP API.
function reconcileWindow(month, year) {
    if (monthIndex0(month) == null) {
        const w = fyWindow('Apr', year);
        return { start: w.start, end: w.end, from: fmtYmd(w.start), to: fmtYmd(new Date(w.end.getTime() - 86400000)) };
    }
    return monthPadWindow(month, year, Number(process.env.SAP_MATCH_PAD_MONTHS || 2));
}

class ReconcileService {
    async getPeriod(companyId, month, year) {
        return collections.periods().findOne({ companyId, month, year: String(year) });
    }

    async getPeriodIdByMonth(companyId, month) {
        const p = await collections.periods()
            .find({ companyId, month }).sort({ createdAt: -1 }).limit(1).next();
        return p ? String(p._id) : null;
    }

    /**
     * GET /periods — the distinct {month, year} that have been uploaded/reconciled,
     * latest first, plus `latest` (most recent FY-month). Drives the smart month/year
     * filter: which periods exist, and what to default the view to.
     */
    async getPeriods(companyId) {
        const docs = await collections.periods()
            .find({ companyId }, { projection: { month: 1, year: 1 } }).toArray();
        const MO = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
        const seen = new Map();   // 'year|month' -> { month, year } (year may be stored as string or number)
        for (const p of docs) {
            const year = String(p.year); const key = `${year}|${p.month}`;
            if (!seen.has(key)) seen.set(key, { month: p.month, year });
        }
        const calKey = (p) => Number(p.year) * 100 + (MO[p.month] || 0);   // chronological (calendar)
        const periods = [...seen.values()].sort((a, b) => calKey(b) - calKey(a));   // latest first
        return { periods, latest: periods[0] || null };
    }

    async deletePeriod(periodId) {
        const _id = new ObjectId(periodId);
        await collections.lines().deleteMany({ periodId: _id });
        await collections.periods().deleteOne({ _id });
    }

    /**
     * Pull one reconcile month's SAP data on-demand (BKPF/BSEG/BSET/RBKP/LFA1 + SA-import
     * for IMPG) and upsert ap_invoices + vendors. Replaces the offline ETL for the live
     * path; keyed by (companyId, docNo, fiscalYear) so it is idempotent.
     */
    async syncSapWindow(companyId, win, onProgress) {
        const tables = await fetchWindow({ ...win, onProgress });
        const failed = tables.failed || 0, total = tables.total || 0;
        const { invoices, vendorMaster, reversedKeys } = buildInvoices(tables, companyId);
        // Free the raw SAP rows now that invoices are built — they dominate memory and are
        // not needed for the upsert/match. This lets GC reclaim them before the bulk writes,
        // keeping the peak low enough for a small (1 GB) host.
        tables.bkpf = tables.bseg = tables.bset = tables.rbkp = tables.lfa1 = tables.saImport = null;

        // Upsert in chunks, building each chunk's ops on the fly (no full parallel ops array).
        const withDoc = invoices.filter((i) => i.docNo);
        for (let k = 0; k < withDoc.length; k += 1000) {
            const ops = withDoc.slice(k, k + 1000).map((i) => ({
                updateOne: {
                    filter: { companyId, docNo: i.docNo, fiscalYear: i.fiscalYear },
                    update: { $set: i, $setOnInsert: { reconciled: false, createdAt: new Date() } },
                    upsert: true,
                },
            }));
            await collections.apInvoices().bulkWrite(ops, { ordered: false });
        }

        const venOps = [];
        for (const [code, v] of vendorMaster.entries()) {
            if (!v.gstin) continue;
            venOps.push({ updateOne: {
                filter: { companyId, vendorCode: code },
                update: { $set: { companyId, vendorCode: code, vendorGstin: v.gstin, vendorName: v.name, pan: v.pan, updatedAt: new Date() } },
                upsert: true,
            } });
        }
        if (venOps.length) for (let k = 0; k < venOps.length; k += 1000) {
            await collections.vendors().bulkWrite(venOps.slice(k, k + 1000), { ordered: false });
        }

        // Reversal cleanup: a doc SAP now flags as reversed is dropped from `invoices`, but
        // a copy from an EARLIER fetch may still sit in ap_invoices and keep matching. Mark
        // those `cancelled` (the candidate query filters cancelled≠true) and drop any auto/
        // manual reconciliation on them — a reversed bill must not stay matched. The audit
        // trail in recon_log is untouched. GUARD: only when the fetch fully succeeded, so a
        // transient failure (some calls dropped) can never mistake a not-fetched doc for a
        // reversed one and wrongly cancel a live bill.
        let cancelledReversed = 0;
        if (failed === 0 && reversedKeys && reversedKeys.size) {
            const revOps = [...reversedKeys].map((k) => {
                const p = k.lastIndexOf('|');
                return { updateOne: {
                    filter: { companyId, docNo: k.slice(0, p), fiscalYear: k.slice(p + 1) },
                    update: {
                        $set: { cancelled: true, reconciled: false },
                        $unset: { reconciledAuto: '', reconciledAt: '', reconciledPeriodId: '', reconciledCategory: '', reconciledReason: '', reconciledStage: '', reconciledTaxDelta: '', reconciledFlag: '', reconciledTier: '' },
                    },
                } };
            });
            for (let k = 0; k < revOps.length; k += 1000) {
                const res = await collections.apInvoices().bulkWrite(revOps.slice(k, k + 1000), { ordered: false });
                cancelledReversed += res.modifiedCount || 0;
            }
        }
        return { invoices: invoices.length, vendors: venOps.length, window: win, failed, total, cancelledReversed };
    }

    /**
     * Import the GSTR-2B Excel, store lines, match, auto-reconcile,
     * and return the unmatched bills.
     */
    async importPortalFile(fileBuffer, companyId, month, year, sessionId, onProgress) {
        // 1. A re-upload must REPLACE this month's 2B lines, never accumulate. Match
        //    EVERY period doc for this company+month+year (year stored as string OR
        //    number, to catch legacy/duplicate periods), delete ALL their lines, and
        //    collapse to a single period. This prevents a stray duplicate period from
        //    leaving an un-deleted copy of the lines behind on each run.
        const ystr = String(year);
        const periods = await collections.periods()
            .find({ companyId, month, year: { $in: [ystr, Number(year)] } }).toArray();
        let period;
        if (!fileBuffer) {
            // REFRESH: re-reconcile the already-stored 2B for this period against CURRENT
            // SAP data (no new file). Keep the stored lines as-is.
            if (!periods.length) throw new Error('Nothing to refresh — upload the 2B for this period first.');
            period = periods[0];
        } else if (periods.length) {
            const ids = periods.map((p) => p._id);
            await collections.lines().deleteMany({ periodId: { $in: ids } });
            period = periods[0];
            if (periods.length > 1) {                                  // keep one, drop duplicates
                await collections.periods().deleteMany({ _id: { $in: ids.slice(1) } });
            }
            if (period.year !== ystr) await collections.periods().updateOne({ _id: period._id }, { $set: { year: ystr } });
        } else {
            const res = await collections.periods().insertOne({
                companyId, month, year: ystr, source: '2B', createdAt: new Date(),
            });
            period = { _id: res.insertedId };
        }
        const periodId = period._id;

        // 2–3. (Upload only) parse B2B / CDNR / IMPG and REPLACE this month's stored lines.
        //      On a refresh (no file) the stored lines are kept and just re-matched.
        let insertedCount = 0;
        if (fileBuffer) {
            const b2b = parseGstr2bB2B(fileBuffer);
            const cdnr = parseGstr2bCDNR(fileBuffer);
            const impg = parseGstr2bIMPG(fileBuffer);
            if (!b2b.length && !cdnr.length && !impg.length) throw new Error('No B2B, CDNR or IMPG rows found in the GSTR-2B file.');
            const mkLine = (p, section) => ({
                periodId, companyId, section,
                supplierGstin: p.supplierGstin, supplierName: p.supplierName,
                invoiceNum: p.invoiceNum, normalizedInvoiceNum: normalizeInvoiceNum(p.invoiceNum),
                invoiceType: p.invoiceType, noteType: p.noteType || null, pos: p.pos,
                invoiceDate: p.invoiceDate, invoiceValue: p.invoiceValue,
                centralTax: p.centralTax, stateTax: p.stateTax, integratedTax: p.integratedTax, cess: p.cess,
                tax: +(p.centralTax + p.stateTax + p.integratedTax + p.cess).toFixed(2),
                itcAvailable: p.itcAvailable, matchStatus: 'NEW', matchedDocNo: null,
            });
            // IMPG lines carry a Bill-of-Entry (as invoiceNum/boe) + IGST instead of a GSTIN.
            const mkImpgLine = (p) => ({
                periodId, companyId, section: 'IMPG',
                supplierGstin: '', supplierName: `Import (BoE ${p.boe})`,
                invoiceNum: p.boe, normalizedInvoiceNum: p.boe, boe: p.boe, portCode: p.portCode,
                invoiceType: 'IMPG', noteType: null, pos: '',
                invoiceDate: p.invoiceDate, invoiceValue: p.taxable, centralTax: 0, stateTax: 0, integratedTax: p.igst, cess: p.cess,
                tax: +(p.igst + (p.cess || 0)).toFixed(2), igst: p.igst,
                itcAvailable: '', matchStatus: 'NEW', matchedDocNo: null,
            });
            const lineDocs = [
                ...b2b.map((p) => mkLine(p, 'B2B')),
                ...cdnr.map((p) => mkLine(p, 'CDNR')),
                ...impg.map(mkImpgLine),
            ];
            insertedCount = lineDocs.length;
            if (onProgress) onProgress({ phase: 'Parsed 2B — fetching SAP…', current: insertedCount, total: insertedCount });
            await collections.lines().insertMany(lineDocs);
        } else if (onProgress) {
            onProgress({ phase: 'Refreshing — fetching SAP…' });
        }

        // 4. Match window = the reconcile month ± SAP_MATCH_PAD_MONTHS (default 2), NOT the
        //    whole FY — bounds fetch volume + memory to a fixed span. The SAME window is used by
        //    every report/view (reconcileWindow), so views never claim coverage matching didn't
        //    attempt. Trade-off: a bill dated >±pad months from the reconcile month won't match,
        //    and prior months don't auto re-match on a new upload — refresh an old month to heal it.
        const win = reconcileWindow(month, year);
        const inWin = { $gte: win.start, $lt: win.end };

        // Load the in-window 2B lines up front — they drive the matching.
        const allLines = await collections.lines().find({ companyId, invoiceDate: inWin }).toArray();

        // 3b/fetch. Pull the ±pad-month SAP window on-demand → upsert ap_invoices. Guarded:
        //     a fetch failure does NOT abort — we match against whatever is already stored.
        let fetchWarning = null;
        if (SAP_FETCH_ON_RECONCILE) {
            try {
                const fwin = { from: win.from, to: win.to };
                const r = await this.syncSapWindow(companyId, fwin, (m) => {
                    console.log('  [SAP]', m);
                    if (onProgress) onProgress({ phase: `SAP: ${m}` });
                });
                console.log(`  SAP on-demand fetch: upserted ${r.invoices} invoices for ${r.window.from}–${r.window.to} (${r.failed || 0}/${r.total || 0} calls failed, ${r.cancelledReversed || 0} reversed cancelled)`);
                if (r.failed) fetchWarning = `SAP data may be incomplete — ${r.failed} of ${r.total} fetch calls failed. Some bills may show as unmatched; re-run to be sure.`;
            } catch (e) {
                console.error('  SAP on-demand fetch FAILED (continuing with stored data):', e.message);
                fetchWarning = `SAP fetch failed (${e.message}) — matched against previously-stored data only.`;
            }
        }
        if (onProgress) onProgress({ phase: 'Matching…' });

        // 4a. Deterministic reset of in-window state (idempotent re-run). Auto
        //     reconciliations + adopted GSTINs are cleared; manual matches are kept
        //     (reconciledAuto != true) and re-applied at the end.
        await collections.apInvoices().updateMany(
            { companyId, reconciledAuto: true, docDate: inWin },
            { $set: { reconciled: false },
              $unset: { reconciledAuto: '', reconciledAt: '', reconciledPeriodId: '', reconciledCategory: '', reconciledReason: '', reconciledStage: '', reconciledTaxDelta: '', reconciledFlag: '', reconciledTier: '' } });
        await collections.apInvoices().updateMany(
            { companyId, docDate: inWin, pairCategory: { $ne: null } },
            { $unset: { pairCategory: '', pairedBillNo: '', pairedDate: '' } });
        await collections.apInvoices().updateMany(
            { companyId, gstinSource: { $in: ['2B', 'RBKP-promoted', 'sibling'] } },
            { $set: { vendorGstin: '', vendorCode: '' }, $unset: { gstinSource: '' } });

        // 4b. Reset the in-window lines to NEW so a line left unmatched this run can't keep
        //     a stale prior status. (allLines is already loaded above.)
        await collections.lines().updateMany(
            { companyId, invoiceDate: inWin },
            { $set: { matchStatus: 'NEW', matchedDocNo: null },
              $unset: { matchCategory: '', matchReason: '', matchStage: '', taxDelta: '', dateDeltaDays: '' } });
        const b2bLines = allLines.filter((l) => (l.section || 'B2B') === 'B2B');
        const cdnrLines = allLines.filter((l) => l.section === 'CDNR');
        const impgLines = allLines.filter((l) => l.section === 'IMPG');

        // 4c. Load in-window candidates (non-cancelled, reconcilable — SA excluded), PRE-FILTERED
        //     to bills that could possibly match a 2B line. Every tier requires the bill to share
        //     a vendor GSTIN (own or RBKP reserve), a normalized invoice-no, or a Bill-of-Entry
        //     with some 2B line — so a bill sharing none can never match and is skipped here.
        //     This keeps only the relevant few thousand (of tens of thousands) in memory. The
        //     "in SAP, not in 2B" view is computed straight from Mongo, so it is unaffected.
        const gstinSet = [...new Set(allLines.map((l) => String(l.supplierGstin || '').toUpperCase()).filter(Boolean))];
        const invNoSet = [...new Set(allLines.map((l) => l.normalizedInvoiceNum).filter(Boolean))];
        const boeSet = [...new Set(allLines.filter((l) => l.section === 'IMPG').map((l) => l.boe).filter(Boolean))];
        const candOr = [];
        if (gstinSet.length) candOr.push({ vendorGstin: { $in: gstinSet } }, { rbkpGstin: { $in: gstinSet } });
        if (invNoSet.length) candOr.push({ normalizedInvoiceNum: { $in: invNoSet } });
        if (boeSet.length) candOr.push({ boe: { $in: boeSet } });
        const candFilter = { companyId, cancelled: { $ne: true }, docCategory: { $ne: 'NONE' }, docDate: inWin };
        if (candOr.length) candFilter.$or = candOr;
        const candidates = await collections.apInvoices()
            .find(candFilter)
            .sort({ docNo: 1, fiscalYear: 1 })
            .toArray();
        const candByKey = new Map(candidates.map((c) => [`${c.docNo}|${c.fiscalYear}`, c]));
        const lineById = new Map(allLines.map((l) => [String(l._id), l]));

        // 4d. SAP vendor master (LFA1) GSTIN → name, used to verify a GSTIN-less bill's
        //     adopted 2B GSTIN against the vendor SAP has registered for it.
        const vmRows = await collections.vendors()
            .find({ companyId, vendorGstin: { $nin: ['', null] } }, { projection: { vendorGstin: 1, vendorName: 1 } }).toArray();
        const vendorByGstin = new Map();
        for (const v of vmRows) { const g = String(v.vendorGstin).toUpperCase(); if (!vendorByGstin.has(g)) vendorByGstin.set(g, []); vendorByGstin.get(g).push(v.vendorName || ''); }
        const matchOpts = { vendorByGstin };

        // 5. B2B reconciliation — STAGE 1 (BKPF on its SAP GSTIN / bill-no + value),
        //    then STAGE 2 (RBKP-promoted GSTINs) for lines stage 1 left with NO
        //    record at all (near-misses keep their stage-1 classification).
        const b2bCands = candidates.filter((c) => c.docCategory === 'B2B');
        const bkpfCands = b2bCands.filter((c) => c.source === 'BKPF');
        const matches = reconcile(b2bLines, bkpfCands, matchOpts).matches.map((m) => ({ ...m, stage: 1 }));

        const seenLine1 = new Set(matches.map((m) => String(m.lineId)));
        const usedInv1 = new Set(matches.map((m) => `${m.invoiceDocNo}|${m.invoiceFiscalYear}`));
        const stage2Lines = b2bLines.filter((l) => !seenLine1.has(String(l._id)));
        const stage2Invs = b2bCands
            .filter((i) => !usedInv1.has(`${i.docNo}|${i.fiscalYear}`) && (i.source === 'RBKP' || i.rbkpGstin))
            .map((i) => i.source === 'RBKP'
                ? i
                : { ...i, vendorGstin: i.rbkpGstin, vendorCode: i.rbkpVendorCode || i.vendorCode, vendorName: i.rbkpVendorName || i.vendorName });
        if (stage2Lines.length && stage2Invs.length) {
            // skipGstDiff: in the RBKP fallback the candidate GSTIN is the reserve GSTIN,
            // so a GSTIN mismatch is a collision (different vendor) — it must fall through
            // to "In 2B, not in SAP", not become a GST-Diff near-miss.
            for (const m of reconcile(stage2Lines, stage2Invs, { ...matchOpts, skipGstDiff: true }).matches) matches.push({ ...m, stage: 2 });
        }

        // 6. KG ↔ CDNR (credit/debit notes). Single stage; compare |tax| since SAP
        //    credit memos can be signed. KG bills carry docCategory 'CDNR'.
        const kgCands = candidates.filter((c) => c.docCategory === 'CDNR');
        if (cdnrLines.length && kgCands.length) {
            // Note-mode: match on GSTIN + tax + date only (note number ignored).
            for (const m of reconcile(cdnrLines, kgCands, { absTax: true, noteMode: true }).matches) matches.push({ ...m, stage: 1 });
        }

        // 6b. IMPG (imports) ↔ SAP customs (SA) docs, matched on Bill-of-Entry no + IGST.
        const impgCands = candidates.filter((c) => c.docCategory === 'IMPG');
        if (impgLines.length && impgCands.length) {
            for (const m of matchImpg(impgLines, impgCands).matches) matches.push({ ...m, stage: 1 });
        }

        // 7. Persist. Matched categories reconcile the invoice; near-misses
        //    (GST-Diff / Value-Diff) only tag a pairing so they surface in their own
        //    Not-Matched bucket instead of under "in SAP, not in 2B".
        if (matches.length) {
            await collections.lines().bulkWrite(matches.map((m) => ({
                updateOne: { filter: { _id: m.lineId }, update: { $set: {
                    matchStatus: m.status, matchedDocNo: m.invoiceDocNo, matchCategory: m.category,
                    matchReason: m.reason, matchStage: m.stage, taxDelta: m.taxDelta, dateDeltaDays: m.dateDelta } } },
            })), { ordered: false });

            await collections.apInvoices().bulkWrite(matches.map((m) => {
                const ln = lineById.get(String(m.lineId));
                const cand = candByKey.get(`${m.invoiceDocNo}|${m.invoiceFiscalYear}`);
                if (!MATCHED_CATEGORIES.has(m.category)) {              // near miss — record pairing, do NOT reconcile
                    return { updateOne: { filter: { companyId, docNo: m.invoiceDocNo, fiscalYear: m.invoiceFiscalYear },
                        update: { $set: { pairCategory: m.category, pairedBillNo: ln ? ln.invoiceNum : null, pairedDate: ln ? ln.invoiceDate : null } } } };
                }
                const set = {
                    reconciled: true, reconciledAuto: true, reconciledAt: new Date(), reconciledPeriodId: periodId,
                    reconciledCategory: m.category, reconciledReason: m.reason, reconciledStage: m.stage,
                    reconciledFlag: m.category === 'Match-DateDiff' ? m.reason : null, reconciledTaxDelta: m.taxDelta,
                };
                if (m.stage === 2 && cand && cand.source === 'BKPF') {  // BKPF leftover promoted via its RBKP GSTIN
                    set.vendorGstin = cand.rbkpGstin || (ln && ln.supplierGstin) || '';
                    set.vendorCode = cand.rbkpVendorCode || cand.vendorCode || '';
                    set.vendorName = cand.rbkpVendorName || cand.vendorName || '';
                    set.gstinSource = 'RBKP-promoted';
                } else if (m.backfillGstin) {                           // GSTIN adopted from the 2B line
                    set.vendorGstin = m.backfillGstin; set.gstinSource = '2B';
                }
                return { updateOne: { filter: { companyId, docNo: m.invoiceDocNo, fiscalYear: m.invoiceFiscalYear }, update: { $set: set } } };
            }), { ordered: false });
        }

        // 8. (Removed) Sibling propagation. A GSTIN-less bill stays GSTIN-less — we do
        //    NOT borrow a vendor from another bill that merely shares an invoice-number
        //    string. Matching alone decides a bill's vendor; if it didn't match, it
        //    shows as unresolved rather than guessing (which spread one match's GSTIN
        //    onto unrelated, different-amount bills). Any GSTIN a prior run propagated
        //    this way is cleared by the step-4a reset on the next import.

        // 9. Re-apply durable manual reconciliations (survive ETL reloads).
        await this.applyManualReconciliations(companyId);

        // 10. Response = the post-upload "in SAP, not in 2B" list for this period.
        const sections = await this.getUnmatchedSections(companyId, month, year);
        const unmatchedBills = sections.inSapNotIn2b;
        const matched = matches.filter((m) => MATCHED_CATEGORIES.has(m.category));
        return {
            result: {
                success: true,
                message: fileBuffer ? 'File processed successfully' : 'Refreshed against current SAP data',
                periodId: String(periodId),
                lines: fileBuffer ? insertedCount : allLines.length,
                windowLines: allLines.length,
                matched: matched.length,
                dateDiff: matched.filter((m) => m.category === 'Match-DateDiff').length,
                gstDiff: matches.filter((m) => m.category === 'NotMatch-GstDiff').length,
                valueDiff: matches.filter((m) => m.category === 'NotMatch-ValueDiff').length,
                unmatchedBills: unmatchedBills.length,
                warning: fetchWarning,
            },
            unmatchedBills,
        };
    }

    /**
     * GET /refresh — re-reconcile a period's already-stored 2B against CURRENT SAP data
     * (no re-upload). Picks up bills booked since the last run, drops reversed ones, and
     * re-evaluates changed amounts. Thin wrapper over importPortalFile with no file.
     */
    async refreshPeriod(companyId, month, year, onProgress) {
        return this.importPortalFile(null, companyId, month, year, null, onProgress);
    }

    /** GET /fetch-sap-bills — all unreconciled AP invoices (for the "All" view). */
    async fetchUnreconciledBills(companyId) {
        const invoices = await collections.apInvoices().find({
            companyId,
            reconciled: { $ne: true },
            cancelled: { $ne: true },
            docCategory: { $ne: 'NONE' },          // SA docs are stored but never reconciled / shown
            $expr: { $gt: [{ $add: [{ $ifNull: ['$tax', 0] }, { $ifNull: ['$cgst', 0] }, { $ifNull: ['$sgst', 0] }, { $ifNull: ['$igst', 0] }] }, 0] },
        }).sort({ vendorCode: 1, taxDate: 1 }).toArray();

        // Build the reason index from all stored 2B lines for this company.
        const lines = await collections.lines()
            .find({ companyId }, { projection: { supplierGstin: 1, normalizedInvoiceNum: 1, invoiceNum: 1 } })
            .toArray();
        const portalIdx = buildPortalIndex(lines);
        return invoices.map((inv) => toBillDTO(inv, lines.length ? classifyUnmatched(inv, portalIdx) : null));
    }

    /**
     * GET /unmatched-sections — two-section, period-scoped unmatched view:
     *   - in2bNotInSap : 2B portal lines not matched to any SAP invoice
     *   - inSapNotIn2b : SAP AP invoices not reconciled to the 2B
     * Both scoped to the given month/year by document/invoice date (default Apr-2026).
     */
    async getUnmatchedSections(companyId, month = 'Apr', year = '2026') {
        const m0 = monthIndex0(month);                 // null when month = 'All'
        const y = Number(year);
        const win = reconcileWindow(month, year);   // month ± pad (specific month) or 2-FY ('All')
        const inWin = { $gte: win.start, $lt: win.end };
        const monthOk = (d) => (m0 == null) ? true : inMonth(d, y, m0);

        const invoices = await collections.apInvoices()
            .find({ companyId, cancelled: { $ne: true }, docDate: inWin }).toArray();
        const lines = await collections.lines().find({ companyId, invoiceDate: inWin }).toArray();

        // SAP vendor-master GSTIN → name, so near-miss rows can show what SAP has registered.
        const vmRows = await collections.vendors()
            .find({ companyId, vendorGstin: { $nin: ['', null] } }, { projection: { vendorGstin: 1, vendorName: 1 } }).toArray();
        const vendorByGstin = new Map();
        for (const v of vmRows) { const g = String(v.vendorGstin).toUpperCase(); if (!vendorByGstin.has(g)) vendorByGstin.set(g, []); vendorByGstin.get(g).push(v.vendorName || ''); }

        const portalIdx = buildPortalIndex(lines.filter((l) => (l.section || 'B2B') === 'B2B'));
        const sapIdx = buildSapIndex(invoices.filter((i) => i.docCategory === 'B2B'));
        const hasGst = (i) => (Number(i.tax) || 0) + (Number(i.cgst) || 0) + (Number(i.sgst) || 0) + (Number(i.igst) || 0) > 0;

        // SAP B2B invoices in the period, carrying GST, NOT reconciled and NOT a
        // near-match (GST/Value-Diff bills show in their own buckets below).
        const inSapNotIn2b = invoices
            .filter((i) => i.source === 'BKPF' && i.docCategory === 'B2B' && i.reconciled !== true && !i.pairCategory && hasGst(i) && monthOk(i.docDate || i.taxDate))
            .map((i) => toBillDTO(i, classifyUnmatched(i, portalIdx)));

        // SAP KG (debit/credit notes) not matched to 2B CDNR — the Debit-Note section.
        const debitNotes = invoices
            .filter((i) => i.source === 'BKPF' && i.docCategory === 'CDNR' && i.reconciled !== true && !i.pairCategory && hasGst(i) && monthOk(i.docDate || i.taxDate))
            .map((i) => toBillDTO(i, { category: 'debit_note_unmatched', reason: 'KG note not found in the 2B CDNR section' }));

        // 2B B2B lines still NEW (in 2B, not in SAP).
        const in2bNotInSap = lines
            .filter((l) => (l.section || 'B2B') === 'B2B' && l.matchStatus === 'NEW' && monthOk(l.invoiceDate))
            .map((l) => to2bLineDTO(l, classify2bUnmatched(l, sapIdx)));

        // 2B CDNR lines still NEW (note in 2B, no SAP KG).
        const cdnr2bNotInSap = lines
            .filter((l) => l.section === 'CDNR' && l.matchStatus === 'NEW' && monthOk(l.invoiceDate))
            .map((l) => to2bLineDTO(l, { category: 'cdnr_not_in_sap', reason: 'CDNR note not booked as a KG in SAP' }));

        // Near-miss buckets — joined 2B↔SAP rows (NOT reconciled). Diff-Bill-No pairs on
        // GSTIN+value+date with a different bill number, so it carries both bill numbers.
        const nm = { win, m0, y, excludeReconciled: true, vendorByGstin };
        const gstDiff = await this._matchedRows(companyId, ['NotMatch-GstDiff'], nm);
        const valueDiff = await this._matchedRows(companyId, ['NotMatch-ValueDiff'], nm);
        const vendorDiff = await this._matchedRows(companyId, ['NotMatch-VendorDiff'], nm);
        const noBillNo = await this._matchedRows(companyId, ['NotMatch-NoBillNo'], nm);

        return {
            period: { month, year: String(year) },
            inSapNotIn2b, in2bNotInSap, gstDiff, valueDiff, vendorDiff, noBillNo, debitNotes, cdnr2bNotInSap,
            counts: {
                inSapNotIn2b: inSapNotIn2b.length, in2bNotInSap: in2bNotInSap.length,
                gstDiff: gstDiff.length, valueDiff: valueDiff.length, vendorDiff: vendorDiff.length,
                noBillNo: noBillNo.length, debitNotes: debitNotes.length, cdnr2bNotInSap: cdnr2bNotInSap.length,
            },
        };
    }

    /**
     * Shared: 2B lines with the given match statuses, joined to their paired SAP
     * invoice (whether reconciled or a near-miss), Excel vs SAP tax. Optionally
     * scoped to a window/month.
     */
    async _matchedRows(companyId, statuses, opts = {}) {
        const q = { companyId, section: { $ne: 'IMPG' }, matchStatus: { $in: statuses } };   // IMPG has its own buckets
        if (opts.win) q.invoiceDate = { $gte: opts.win.start, $lt: opts.win.end };
        const all = await collections.lines().find(q).toArray();

        const docNos = [...new Set(all.map((l) => String(l.matchedDocNo)).filter(Boolean))];
        const invs = docNos.length
            ? await collections.apInvoices().find({ companyId, docNo: { $in: docNos } }).toArray() : [];
        const byDoc = new Map();
        for (const inv of invs) byDoc.set(String(inv.docNo), inv);

        // Month filter by the 2B invoice date (consistent with the paginated counts).
        // For near-miss buckets, drop any pair whose SAP bill has since been reconciled
        // (e.g. a manual reconcile from the table) so it leaves the bucket.
        const lines = all.filter((l) => {
            const inv = byDoc.get(String(l.matchedDocNo)) || {};
            if (opts.excludeReconciled && inv.reconciled === true) return false;
            if (opts.m0 == null) return true;
            return inMonth(l.invoiceDate, opts.y, opts.m0);
        });

        const rows = lines.map((l) => {
            const inv = byDoc.get(String(l.matchedDocNo)) || {};
            // Prefer the stored total `tax` (RBKP carries tax there, with no split),
            // else sum the CGST/SGST/IGST components — mirrors the matcher's totals.
            const excelTax = +(Number(l.tax) || ((Number(l.stateTax) || 0) + (Number(l.centralTax) || 0) + (Number(l.integratedTax) || 0) + (Number(l.cess) || 0))).toFixed(2);
            const sapTax = +(Number(inv.tax) || ((Number(inv.sgst) || 0) + (Number(inv.cgst) || 0) + (Number(inv.igst) || 0))).toFixed(2);
            return {
                VendorGST: l.supplierGstin || inv.vendorGstin || '',
                SapGST: inv.vendorGstin || inv.rbkpGstin || '',   // effective GSTIN (RBKP reserve fills a blank vendorGstin)
                Vendor2BName: l.supplierName || '',
                SapVendorName: inv.vendorName || inv.rbkpVendorName
                    || (opts.vendorByGstin ? ((opts.vendorByGstin.get(String(l.supplierGstin || '').toUpperCase()) || []).join(' / ')) : ''),
                VendorBillNo: l.invoiceNum || inv.vendorRef || '',
                SapBillNo: inv.vendorRef || '',
                Section: l.section || 'B2B',
                ExcelSGST: +(Number(l.stateTax) || 0).toFixed(2),
                ExcelCGST: +(Number(l.centralTax) || 0).toFixed(2),
                ExcelIGST: +(Number(l.integratedTax) || 0).toFixed(2),
                SAP_SGST: +(Number(inv.sgst) || 0).toFixed(2),
                SAP_CGST: +(Number(inv.cgst) || 0).toFixed(2),
                SAP_IGST: +(Number(inv.igst) || 0).toFixed(2),
                ExcelTax: excelTax, SAP_Tax: sapTax,
                TaxDelta: l.taxDelta != null ? l.taxDelta : +(sapTax - excelTax).toFixed(2),
                DateDeltaDays: l.dateDeltaDays != null ? l.dateDeltaDays : null,
                InvoiceDate: l.invoiceDate || null,
                SapDate: inv.docDate || inv.taxDate || null,
                Category: l.matchCategory || l.matchStatus,
                Status: l.matchStatus,
                // fields the manual-reconcile action needs (identify + log the SAP bill)
                DocEntry: inv.docNo ? `${inv.docNo}|${inv.fiscalYear}` : null,
                CardCode: inv.vendorCode || '',
                CardName: inv.vendorName || '',
                DocTotal: inv.grossAmount != null ? inv.grossAmount : null,
                Reconciled: inv.reconciled === true,
            };
        });
        rows.sort((a, b) => String(a.VendorGST).localeCompare(String(b.VendorGST)) || String(a.VendorBillNo).localeCompare(String(b.VendorBillNo)));
        return rows;
    }

    /** GET /matched-bills — reconciled matches: clean (`match`) + date-diff (`dateDiff`). */
    async getMatchedBills(companyId, month = 'Apr', year = '2026') {
        const m0 = monthIndex0(month); const y = Number(year);
        const win = reconcileWindow(month, year);
        const match = await this._matchedRows(companyId, ['Match'], { win, m0, y });
        const dateDiff = await this._matchedRows(companyId, ['Match-DateDiff'], { win, m0, y });
        return { period: { month, year: String(year) }, match, dateDiff, matched: match, count: match.length + dateDiff.length };
    }

    /** GET /tax-mismatch-bills — kept for back-compat; now returns the date-diff matches. */
    async getTaxMismatchBills(companyId, month = 'Apr', year = '2026') {
        const m0 = monthIndex0(month); const y = Number(year);
        const win = reconcileWindow(month, year);
        const rows = await this._matchedRows(companyId, ['Match-DateDiff'], { win, m0, y });
        return { period: { month, year: String(year) }, matched: rows, count: rows.length };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Pagination: a counts endpoint (small payload, drives the tab badges) and a
    // per-category page endpoint (only the rows you're looking at are loaded).
    // ──────────────────────────────────────────────────────────────────────────

    /** Date filter for a month, or the whole 2-FY window when month = 'All'. */
    _periodDateRange(month, year) {
        const m0 = monthIndex0(month); const y = Number(year);
        if (m0 == null) { const w = fyWindow('Apr', year); return { $gte: w.start, $lt: w.end }; }
        return { $gte: new Date(Date.UTC(y, m0, 1)), $lt: new Date(Date.UTC(y, m0 + 1, 1)) };
    }

    /** SAP vendor-master GSTIN → [names] (a GSTIN can map to several vendor codes). */
    async _vendorMap(companyId) {
        const rows = await collections.vendors()
            .find({ companyId, vendorGstin: { $nin: ['', null] } }, { projection: { vendorGstin: 1, vendorName: 1 } }).toArray();
        const map = new Map();
        for (const v of rows) { const g = String(v.vendorGstin).toUpperCase(); if (!map.has(g)) map.set(g, []); map.get(g).push(v.vendorName || ''); }
        return map;
    }

    /**
     * SAP vendor-master GSTIN → { code, names } for resolving the vendor of a bill that
     * carries a GSTIN but no name/code (e.g. a GSTIN adopted via sibling/2B backfill,
     * which copies the number but not the vendor master's name). Used to label the
     * "In SAP, not in 2B" rows instead of showing a blank / "undefined" vendor.
     */
    async _vendorByGstin(companyId) {
        const rows = await collections.vendors()
            .find({ companyId, vendorGstin: { $nin: ['', null] } }, { projection: { vendorGstin: 1, vendorName: 1, vendorCode: 1 } }).toArray();
        const map = new Map();   // GSTIN -> { entries:[{code,name}], names:Set, codes:Set }
        for (const v of rows) {
            const g = String(v.vendorGstin).toUpperCase();
            if (!map.has(g)) map.set(g, { entries: [], names: new Set(), codes: new Set() });
            const e = map.get(g);
            e.entries.push({ code: v.vendorCode || '', name: v.vendorName || '' });
            if (v.vendorName) e.names.add(v.vendorName);
            if (v.vendorCode) e.codes.add(v.vendorCode);
        }
        return map;
    }

    /** GET /bill-counts — counts for every category (no rows). */
    async getBillCounts(companyId, month = 'Apr', year = '2026') {
        const A = collections.apInvoices(), L = collections.lines();
        const dr = this._periodDateRange(month, year);
        const m0 = monthIndex0(month); const y = Number(year);
        const win = reconcileWindow(month, year);
        const hasGst = { $expr: { $gt: [{ $add: [{ $ifNull: ['$tax', 0] }, { $ifNull: ['$cgst', 0] }, { $ifNull: ['$sgst', 0] }, { $ifNull: ['$igst', 0] }] }, 0] } };
        const sapBase = { companyId, source: 'BKPF', cancelled: { $ne: true }, reconciled: { $ne: true }, pairCategory: { $in: [null] }, docDate: dr, ...hasGst };
        const nm = { win, m0, y, excludeReconciled: true, vendorByGstin: await this._vendorMap(companyId) };

        const [inSapNotIn2b, debitNotes, in2bNotInSap, cdnr2bNotInSap, matched, dateDiff,
            gstDiff, valueDiff, vendorDiff, noBillNo, manual, impg2b, impgMatched, impgSap] = await Promise.all([
            A.countDocuments({ ...sapBase, docCategory: 'B2B' }),
            A.countDocuments({ ...sapBase, docCategory: 'CDNR' }),
            L.countDocuments({ companyId, section: 'B2B', matchStatus: 'NEW', invoiceDate: dr }),
            L.countDocuments({ companyId, section: 'CDNR', matchStatus: 'NEW', invoiceDate: dr }),
            L.countDocuments({ companyId, section: { $ne: 'IMPG' }, matchStatus: 'Match', invoiceDate: dr }),
            L.countDocuments({ companyId, section: { $ne: 'IMPG' }, matchStatus: 'Match-DateDiff', invoiceDate: dr }),
            this._matchedRows(companyId, ['NotMatch-GstDiff'], nm).then((r) => r.length),
            this._matchedRows(companyId, ['NotMatch-ValueDiff'], nm).then((r) => r.length),
            this._matchedRows(companyId, ['NotMatch-VendorDiff'], nm).then((r) => r.length),
            this._matchedRows(companyId, ['NotMatch-NoBillNo'], nm).then((r) => r.length),
            this.getManuallyMatchedBills(companyId).then((r) => r.count),
            L.countDocuments({ companyId, section: 'IMPG', matchStatus: 'NEW', invoiceDate: dr }),
            L.countDocuments({ companyId, section: 'IMPG', matchStatus: { $in: ['Match', 'Match-DateDiff'] }, invoiceDate: dr }),
            A.countDocuments({ companyId, docCategory: 'IMPG', reconciled: { $ne: true }, docDate: dr, ...hasGst }),
        ]);
        return { period: { month, year: String(year) }, counts: {
            inSapNotIn2b, in2bNotInSap, gstDiff, valueDiff, vendorDiff, noBillNo, debitNotes, cdnr2bNotInSap, matched, dateDiff, manual,
            impg2b, impgMatched, impgSap,
        } };
    }

    /** Build the full DTO list for a SAP-side bucket ('sap' = B2B, 'debit' = CDNR). */
    async _sapBucketRows(companyId, docCategory, dr) {
        const hasGst = (i) => (Number(i.tax) || 0) + (Number(i.cgst) || 0) + (Number(i.sgst) || 0) + (Number(i.igst) || 0) > 0;
        const invoices = await collections.apInvoices()
            .find({ companyId, source: 'BKPF', docCategory, cancelled: { $ne: true }, reconciled: { $ne: true }, pairCategory: { $in: [null] }, docDate: dr }).toArray();
        const lines = await collections.lines()
            .find({ companyId, section: 'B2B' }, { projection: { supplierGstin: 1, normalizedInvoiceNum: 1, invoiceNum: 1 } }).toArray();
        const portalIdx = buildPortalIndex(lines);

        // A bill can carry a GSTIN (adopted via sibling/2B/RBKP) without a vendor name or
        // code. Resolve those from the vendor master by GSTIN so the row shows a real
        // vendor instead of a blank / "undefined".
        const vbg = await this._vendorByGstin(companyId);
        const resolveVendor = (dto) => {
            const g = String(dto.GSTRegnNo || '').toUpperCase();
            if (!g || (dto.CardName && dto.CardCode)) return dto;
            const m = vbg.get(g);
            if (!m) return dto;
            if (!dto.CardName) {
                // Prefer the name of the bill's OWN code; else the GSTIN's name(s). When a
                // GSTIN has several vendor names, join them as a hint rather than guessing.
                const byCode = dto.CardCode && m.entries.find((e) => e.code === dto.CardCode && e.name);
                dto.CardName = byCode ? byCode.name : [...m.names].join(' / ');
            }
            // Only fill the code when the GSTIN maps to exactly one vendor code. If it maps
            // to several (same GSTIN, multiple SAP vendor records), leave it blank so the
            // row groups by GSTIN instead of being pinned to an arbitrary code.
            if (!dto.CardCode && m.codes.size === 1) dto.CardCode = [...m.codes][0];
            return dto;
        };
        return invoices.filter(hasGst).map((i) => resolveVendor(docCategory === 'CDNR'
            ? toBillDTO(i, { category: 'debit_note_unmatched', reason: 'KG note not found in the 2B CDNR section' })
            : toBillDTO(i, classifyUnmatched(i, portalIdx))));
    }

    /** Build the full DTO list for a 2B-side NEW bucket ('2b' = B2B, 'cdnr2b' = CDNR). */
    async _twoBBucketRows(companyId, section, dr) {
        const lines = await collections.lines().find({ companyId, section, matchStatus: 'NEW', invoiceDate: dr }).toArray();
        if (section === 'CDNR') return lines.map((l) => to2bLineDTO(l, { category: 'cdnr_not_in_sap', reason: 'CDNR note not booked as a KG in SAP' }));
        const invoices = await collections.apInvoices()
            .find({ companyId, docCategory: 'B2B' }, { projection: { vendorGstin: 1, normalizedInvoiceNum: 1, vendorRef: 1 } }).toArray();
        const sapIdx = buildSapIndex(invoices);
        return lines.map((l) => to2bLineDTO(l, classify2bUnmatched(l, sapIdx)));
    }

    /**
     * IMPG (imports) rows for three buckets, matched on Bill-of-Entry + IGST:
     *   'impgsap'     — SAP customs (SA) docs carrying IGST, not reconciled to the 2B
     *   'impg2b'      — 2B IMPG lines still NEW (import in 2B, no SAP customs doc)
     *   'impgmatched' — matched pairs, 2B IGST vs SAP IGST side-by-side
     */
    async _impgRows(companyId, kind, dr) {
        const A = collections.apInvoices(), L = collections.lines();
        if (kind === 'impgsap') {
            const invs = await A.find({ companyId, docCategory: 'IMPG', reconciled: { $ne: true }, docDate: dr }).toArray();
            return invs
                .filter((i) => (Number(i.igst) || Number(i.tax) || 0) > 0)
                .map((i) => ({
                    Boe: i.boe || i.normalizedInvoiceNum || '', PortCode: '',
                    Igst: null, SapIgst: +(Number(i.igst) || Number(i.tax) || 0).toFixed(2),
                    InvoiceDate: null, SapDate: i.docDate || i.taxDate || null,
                    SapDocNo: i.docNo, DocEntry: `${i.docNo}|${i.fiscalYear}`,
                    Status: 'NEW', Source: 'SAP', Reconciled: false,
                }));
        }
        const statuses = kind === 'impgmatched' ? ['Match', 'Match-DateDiff'] : ['NEW'];
        const lines = await L.find({ companyId, section: 'IMPG', matchStatus: { $in: statuses }, invoiceDate: dr }).toArray();
        const docNos = [...new Set(lines.map((l) => String(l.matchedDocNo)).filter(Boolean))];
        const invs = docNos.length ? await A.find({ companyId, docNo: { $in: docNos } }).toArray() : [];
        const byDoc = new Map(invs.map((i) => [String(i.docNo), i]));
        return lines.map((l) => {
            const inv = byDoc.get(String(l.matchedDocNo)) || {};
            const twoTax = +(Number(l.igst) || Number(l.integratedTax) || 0).toFixed(2);
            const sapTax = inv.docNo ? +(Number(inv.igst) || Number(inv.tax) || 0).toFixed(2) : null;
            return {
                Boe: l.boe || l.invoiceNum || '', PortCode: l.portCode || '',
                Igst: twoTax, SapIgst: sapTax,
                InvoiceDate: l.invoiceDate || null, SapDate: inv.docDate || inv.taxDate || null,
                SapDocNo: inv.docNo || null, DocEntry: inv.docNo ? `${inv.docNo}|${inv.fiscalYear}` : null,
                TaxDelta: sapTax != null ? +(sapTax - twoTax).toFixed(2) : null,
                Status: l.matchStatus, Source: '2B', Reconciled: inv.reconciled === true,
            };
        });
    }

    /** Group flat bill-DTOs by vendor and return one page of vendor groups (their bills, flat). */
    _vendorPage(rows, page, pageSize) {
        const groups = new Map();   // vendorKey -> bills[]
        for (const r of rows) {
            // Key by code, then GSTIN, then NAME — so a named-but-code/GSTIN-less bill
            // groups by its own vendor name instead of all of them collapsing into one
            // giant "—" card mislabelled by whichever named bill happened to be first.
            const k = String(r.CardCode || r.VendorCode || r.GSTRegnNo || r.VendorGST || r.CardName || r.VendorName || '—');
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(r);
        }
        const keys = [...groups.keys()].sort();
        const totalVendors = keys.length;
        const pageKeys = keys.slice((page - 1) * pageSize, page * pageSize);
        const pageRows = pageKeys.flatMap((k) => groups.get(k));
        return { rows: pageRows, total: totalVendors, totalRows: rows.length, page, pageSize, groupBy: 'vendor' };
    }

    /**
     * GET /bill-page — one page of one category. Vendor-grouped (a page of vendors)
     * for the SAP/2B lists; row-paged for the matched / near-miss / manual tables.
     */
    async getBillPage(companyId, key, month = 'Apr', year = '2026', page = 1, pageSize = 25, search = '') {
        page = Math.max(1, Number(page) || 1); pageSize = Math.max(1, Number(pageSize) || 25);
        const dr = this._periodDateRange(month, year);
        const m0 = monthIndex0(month); const y = Number(year);
        const win = reconcileWindow(month, year);

        // Free-text search runs over the FULL bucket (every row, all vendors) before
        // pagination, so a match is found even if it isn't on the current page.
        const q = String(search || '').trim().toLowerCase();
        const flt = (rows, fields) => (q ? rows.filter((r) => fields.some((f) => String(r[f] == null ? '' : r[f]).toLowerCase().includes(q))) : rows);
        const SAP_FIELDS = ['CardCode', 'CardName', 'GSTRegnNo', 'VendorGST', 'NumAtCard', 'DocNum'];
        const JOIN_FIELDS = ['VendorGST', 'SapGST', 'Vendor2BName', 'SapVendorName', 'VendorBillNo', 'SapBillNo'];
        const MANUAL_FIELDS = ['VendorGST', 'VendorBillNo', 'ExcelGST', 'ExcelBill'];
        const slice = (rows) => ({ rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, groupBy: 'row' });

        // Vendor-grouped SAP/2B lists.
        if (key === 'sap') return this._vendorPage(flt(await this._sapBucketRows(companyId, 'B2B', dr), SAP_FIELDS), page, pageSize);
        if (key === 'debit') return this._vendorPage(flt(await this._sapBucketRows(companyId, 'CDNR', dr), SAP_FIELDS), page, pageSize);
        if (key === '2b') return this._vendorPage(flt(await this._twoBBucketRows(companyId, 'B2B', dr), SAP_FIELDS), page, pageSize);
        if (key === 'cdnr2b') return this._vendorPage(flt(await this._twoBBucketRows(companyId, 'CDNR', dr), SAP_FIELDS), page, pageSize);

        // Manual (row-paged).
        if (key === 'manual') return slice(flt((await this.getManuallyMatchedBills(companyId)).manual, MANUAL_FIELDS));

        // IMPG (imports) — row-paged tables with BoE / IGST columns.
        if (key === 'impg2b' || key === 'impgsap' || key === 'impgmatched') {
            return slice(flt(await this._impgRows(companyId, key, dr), ['Boe', 'PortCode', 'SapDocNo']));
        }

        // Matched / near-miss joined tables (row-paged).
        const statusByKey = { matched: 'Match', datediff: 'Match-DateDiff', gstdiff: 'NotMatch-GstDiff', valuediff: 'NotMatch-ValueDiff', vendordiff: 'NotMatch-VendorDiff', nobill: 'NotMatch-NoBillNo' };
        const status = statusByKey[key];
        if (status) {
            const isNearMiss = key !== 'matched' && key !== 'datediff';
            const rows = await this._matchedRows(companyId, [status], { win, m0, y, excludeReconciled: isNearMiss, vendorByGstin: await this._vendorMap(companyId) });
            return slice(flt(rows, JOIN_FIELDS));
        }
        return { rows: [], total: 0, page, pageSize, groupBy: 'row' };
    }

    /**
     * Read the manual-reconcile audit trail (recon_log), one entry per document
     * (latest action wins). This is the DURABLE source — it survives the ETL
     * reloads that rebuild ap_invoices and wipe the on-invoice reconcile flags.
     */
    async _manualReconLog(companyId) {
        const logs = await collections.reconLog()
            .find({ companyId, action: 'BILL_RECONCILED' }).sort({ ts: 1 }).toArray();
        const byDoc = new Map();          // docEntry ('docNo|fiscalYear') -> latest log entry
        for (const l of logs) byDoc.set(String(l.docNo), l);
        return [...byDoc.values()];
    }

    /**
     * GET /manual-matched-bills — bills reconciled by hand, sourced from recon_log
     * (durable). The live SAP split is enriched from ap_invoices when the doc still
     * exists; a bill that has since been AUTO-matched is dropped here (it shows under
     * Matched instead) so it isn't double-counted.
     */
    async getManuallyMatchedBills(companyId) {
        const entries = await this._manualReconLog(companyId);
        if (!entries.length) return { manual: [], count: 0 };

        const docNos = entries.map((l) => String(l.docNo).split('|')[0]);
        const invs = await collections.apInvoices()
            .find({ companyId, docNo: { $in: docNos } }).toArray();
        const invByKey = new Map(invs.map((i) => [`${i.docNo}|${i.fiscalYear}`, i]));

        const rows = entries
            .filter((l) => {
                const inv = invByKey.get(String(l.docNo));
                return !(inv && inv.reconciledAuto === true);   // now auto-matched → belongs to Matched
            })
            .map((l) => {
                const inv = invByKey.get(String(l.docNo));
                return {
                    VendorGST: (inv && inv.vendorGstin) || l.vendorGstin || '',
                    VendorBillNo: (inv && inv.vendorRef) || l.billNumber || '',
                    VendorName: (inv && inv.vendorName) || l.vendorName || '',
                    SAP_SGST: +(Number(inv ? inv.sgst : l.sgst) || 0).toFixed(2),
                    SAP_CGST: +(Number(inv ? inv.cgst : l.cgst) || 0).toFixed(2),
                    SAP_IGST: +(Number(inv ? inv.igst : l.igst) || 0).toFixed(2),
                    ExcelGST: l.excelGstin || '',               // what the user typed at manual reconcile
                    ExcelBill: l.excelBill || '',
                    InvoiceDate: (inv && (inv.taxDate || inv.docDate)) || l.billDate || null,
                    ReconciledAt: l.ts || null,
                };
            });
        rows.sort((a, b) => (new Date(b.ReconciledAt || 0)) - (new Date(a.ReconciledAt || 0)));
        return { manual: rows, count: rows.length };
    }

    /**
     * Project recon_log decisions back onto ap_invoices, flagging each manually
     * reconciled bill reconciled=true so it leaves the unmatched / payment-gate
     * list. Skips bills already auto-matched this run (keeps them as auto). Idempotent.
     */
    async applyManualReconciliations(companyId) {
        const entries = await this._manualReconLog(companyId);
        if (!entries.length) return { applied: 0 };
        const ops = entries.map((l) => {
            const [docNo, fiscalYear] = String(l.docNo).split('|');
            return { updateOne: {
                filter: { companyId, docNo, fiscalYear, reconciledAuto: { $ne: true } },
                update: { $set: {
                    reconciled: true, reconciledAuto: false,
                    reconciledExcelGstin: l.excelGstin || null,
                    reconciledExcelBill: l.excelBill || null,
                    reconciledAt: l.ts || new Date(),
                } },
            } };
        });
        const res = await collections.apInvoices().bulkWrite(ops, { ordered: false });
        return { applied: res.modifiedCount };
    }

    /** POST /update-status — mark one AP invoice reconciled (manual). */
    async markReconciled(companyId, docEntry, excelGST, excelBill) {
        const [docNo, fiscalYear] = String(docEntry).split('|');
        await collections.apInvoices().updateOne(
            { companyId, docNo, fiscalYear },
            { $set: {
                reconciled: true, reconciledAuto: false,
                reconciledExcelGstin: excelGST || null,
                reconciledExcelBill: excelBill || null,
                reconciledAt: new Date(),
              },
              // drop any near-miss tag so the bill leaves the GST/Value/No-Bill buckets
              $unset: { pairCategory: '', pairedBillNo: '', pairedDate: '' } });
        return { success: true };
    }
}

module.exports = new ReconcileService();
