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
const { normalizeInvoiceNum, reconcile } = require('./matcher');

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

const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{13}$/i;

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

    // Standard GSTR-2B B2B column order.
    const C = {
        gstin: 0, name: 1, invno: 2, invtype: 3, invdate: 4, invval: 5,
        pos: 6, rcm: 7, taxable: 8, igst: 9, cgst: 10, sgst: 11, cess: 12,
        period: 13, filingDate: 14, itc: 15,
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

class ReconcileService {
    async getPeriod(companyId, month, year) {
        return collections.periods().findOne({ companyId, month, year: String(year) });
    }

    async getPeriodIdByMonth(companyId, month) {
        const p = await collections.periods()
            .find({ companyId, month }).sort({ createdAt: -1 }).limit(1).next();
        return p ? String(p._id) : null;
    }

    async deletePeriod(periodId) {
        const _id = new ObjectId(periodId);
        await collections.lines().deleteMany({ periodId: _id });
        await collections.periods().deleteOne({ _id });
    }

    /**
     * Import the GSTR-2B Excel, store lines, match, auto-reconcile,
     * and return the unmatched bills.
     */
    async importPortalFile(fileBuffer, companyId, month, year, sessionId, onProgress) {
        // 1. Upsert the period; clear any previous lines for a clean re-upload.
        let period = await this.getPeriod(companyId, month, year);
        if (period) {
            await collections.lines().deleteMany({ periodId: period._id });
        } else {
            const res = await collections.periods().insertOne({
                companyId, month, year: String(year), source: '2B', createdAt: new Date(),
            });
            period = { _id: res.insertedId };
        }
        const periodId = period._id;

        // 2. Parse the GSTR-2B workbook (handles the real multi-row header).
        const parsed = parseGstr2bB2B(fileBuffer);
        if (!parsed.length) throw new Error('No B2B invoices found in the GSTR-2B file.');

        // 3. Build + insert line docs.
        const lineDocs = [];
        for (let i = 0; i < parsed.length; i++) {
            const p = parsed[i];
            lineDocs.push({
                periodId, companyId,
                supplierGstin: p.supplierGstin,
                supplierName: p.supplierName,
                invoiceNum: p.invoiceNum,
                normalizedInvoiceNum: normalizeInvoiceNum(p.invoiceNum),
                invoiceType: p.invoiceType,
                pos: p.pos,
                invoiceDate: p.invoiceDate,
                invoiceValue: p.invoiceValue,
                centralTax: p.centralTax,
                stateTax: p.stateTax,
                integratedTax: p.integratedTax,
                cess: p.cess,
                tax: +(p.centralTax + p.stateTax + p.integratedTax + p.cess).toFixed(2),
                itcAvailable: p.itcAvailable,
                matchStatus: 'NEW',
                matchedDocNo: null,
            });
            if (onProgress) onProgress(i + 1, parsed.length);
        }
        const inserted = await collections.lines().insertMany(lineDocs);
        const lines = lineDocs.map((d, i) => ({ ...d, _id: inserted.insertedIds[i] }));

        // 4. Deterministic reset — restore the clean ETL state so re-running the
        //    same 2B always yields the same result (prior auto-backfilled GSTINs
        //    must not drift the matcher). Manual reconciliations are preserved.
        await collections.apInvoices().updateMany(
            { companyId, reconciledAuto: true },
            { $set: { reconciled: false },
              $unset: { reconciledAuto: '', reconciledAt: '', reconciledPeriodId: '', reconciledTier: '', reconciledReason: '', reconciledFlag: '', reconciledTaxDelta: '', reconciledStage: '' } });
        await collections.apInvoices().updateMany(
            { companyId, gstinSource: { $in: ['2B', 'RBKP-promoted', 'sibling'] } },
            { $set: { vendorGstin: '', vendorCode: '' }, $unset: { gstinSource: '' } });

        // 5. Load candidates (all non-cancelled; deterministic order).
        const candidates = await collections.apInvoices()
            .find({ companyId, cancelled: { $ne: true } })
            .sort({ docNo: 1, fiscalYear: 1 })
            .toArray();
        const candByKey = new Map(candidates.map((c) => [`${c.docNo}|${c.fiscalYear}`, c]));
        const lineById = new Map(lines.map((l) => [String(l._id), l]));

        // 6. STAGE 1 — BKPF + BSET + BSEG + ACDOCA + LFA1: match on the SAP GSTIN
        //    (where BSEG/ACDOCA gave one) then on invoice-no + tax. BKPF only.
        const bkpfCandidates = candidates.filter((c) => c.source === 'BKPF');
        const matches = reconcile(lines, bkpfCandidates).matches.map((m) => ({ ...m, stage: 1 }));

        // 7. STAGE 2 — RBKP + LFA1 fallback for the 2B lines STILL unreconciled.
        //    Candidates: RBKP-only invoices (source 'RBKP', carry the LFA1 GSTIN —
        //    invoices BKPF doesn't have) PLUS BKPF leftovers promoted with their
        //    reserved RBKP GSTIN. Then re-match the leftover 2B lines.
        const usedLine = new Set(matches.map((m) => String(m.lineId)));
        const usedInv = new Set(matches.map((m) => `${m.invoiceDocNo}|${m.invoiceFiscalYear}`));
        const stage2Lines = lines.filter((l) => !usedLine.has(String(l._id)));
        const stage2Invs = candidates
            .filter((i) => !usedInv.has(`${i.docNo}|${i.fiscalYear}`) && (i.source === 'RBKP' || i.rbkpGstin))
            .map((i) => i.source === 'RBKP'
                ? i
                : { ...i, vendorGstin: i.rbkpGstin, vendorCode: i.rbkpVendorCode || i.vendorCode, vendorName: i.rbkpVendorName || i.vendorName });
        if (stage2Lines.length && stage2Invs.length) {
            for (const m of reconcile(stage2Lines, stage2Invs).matches) matches.push({ ...m, stage: 2 });
        }

        // 8. Persist matches: mark lines + auto-reconcile invoices (adopt the
        //    matched 2B GSTIN for display; tag the stage + GSTIN source).
        if (matches.length) {
            await collections.lines().bulkWrite(matches.map((m) => ({
                updateOne: { filter: { _id: m.lineId }, update: { $set: {
                    matchStatus: m.status, matchedDocNo: m.invoiceDocNo, matchTier: m.tier,
                    matchReason: m.reason, matchStage: m.stage, taxDelta: m.taxDelta, dateDeltaDays: m.dateDelta } } },
            })), { ordered: false });

            await collections.apInvoices().bulkWrite(matches.map((m) => {
                const ln = lineById.get(String(m.lineId));
                const cand = candByKey.get(`${m.invoiceDocNo}|${m.invoiceFiscalYear}`);
                const set = {
                    reconciled: true, reconciledAuto: true, reconciledAt: new Date(), reconciledPeriodId: periodId,
                    reconciledTier: m.tier, reconciledReason: m.reason, reconciledStage: m.stage,
                    reconciledFlag: m.status === 'Match-Review' ? m.reason : null, reconciledTaxDelta: m.taxDelta,
                };
                if (m.stage === 2) {
                    if (cand && cand.source === 'BKPF') {             // BKPF leftover promoted via its RBKP GSTIN
                        set.vendorGstin = cand.rbkpGstin || (ln && ln.supplierGstin) || '';
                        set.vendorCode = cand.rbkpVendorCode || cand.vendorCode || '';
                        set.vendorName = cand.rbkpVendorName || cand.vendorName || '';
                        set.gstinSource = 'RBKP-promoted';
                    }
                    // source 'RBKP' invoices already carry their LFA1 vendor/GSTIN — leave as-is.
                } else if (m.backfillGstin) {                         // T4: GSTIN taken from 2B
                    set.vendorGstin = m.backfillGstin; set.gstinSource = '2B';
                }
                return { updateOne: { filter: { companyId, docNo: m.invoiceDocNo, fiscalYear: m.invoiceFiscalYear }, update: { $set: set } } };
            }), { ordered: false });
        }

        // 8b. Sibling propagation — a still-undefined doc (e.g. split posting) adopts
        //     a resolved sibling's vendor (same invoice no, single GSTIN). Deterministic.
        const resolved = await collections.apInvoices().find(
            { companyId, vendorGstin: { $nin: ['', null] }, normalizedInvoiceNum: { $nin: ['', null] } },
            { projection: { normalizedInvoiceNum: 1, vendorGstin: 1, vendorCode: 1, vendorName: 1 } },
        ).toArray();
        const sibByRef = new Map();
        for (const r of resolved) {
            const cur = sibByRef.get(r.normalizedInvoiceNum);
            if (cur === undefined) sibByRef.set(r.normalizedInvoiceNum, r);
            else if (cur !== 'AMBIG' && cur.vendorGstin !== r.vendorGstin) sibByRef.set(r.normalizedInvoiceNum, 'AMBIG');
        }
        const undefinedDocs = await collections.apInvoices().find(
            { companyId, source: 'BKPF', reconciled: { $ne: true }, $or: [{ vendorGstin: '' }, { vendorGstin: null }] },
        ).toArray();
        const propOps = [];
        for (const inv of undefinedDocs) {
            const sib = sibByRef.get(inv.normalizedInvoiceNum);
            if (!sib || sib === 'AMBIG') continue;
            propOps.push({ updateOne: { filter: { _id: inv._id }, update: { $set: { vendorGstin: sib.vendorGstin, vendorCode: sib.vendorCode || inv.vendorCode, vendorName: sib.vendorName || inv.vendorName, gstinSource: 'sibling' } } } });
        }
        if (propOps.length) await collections.apInvoices().bulkWrite(propOps, { ordered: false });

        // 7. Unmatched bills for the response = the period-scoped "in SAP, not in
        //    2B" list (BKPF, this month), identical to the Unmatched Bills tab so
        //    the post-upload view is consistent.
        const sections = await this.getUnmatchedSections(companyId, month, year);
        const unmatchedBills = sections.inSapNotIn2b;

        const matchedCount = matches.length;
        const reviewCount = matches.filter((m) => m.status === 'Match-Review').length;
        return {
            result: {
                success: true,
                message: 'File processed successfully',
                periodId: String(periodId),
                lines: lines.length,
                matched: matchedCount,
                flaggedForReview: reviewCount,
                unmatchedBills: unmatchedBills.length,
            },
            unmatchedBills,
        };
    }

    /** GET /fetch-sap-bills — all unreconciled AP invoices (for the "All" view). */
    async fetchUnreconciledBills(companyId) {
        const invoices = await collections.apInvoices().find({
            companyId,
            reconciled: { $ne: true },
            cancelled: { $ne: true },
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
        const m0 = monthIndex0(month);
        const y = Number(year);

        const invoices = await collections.apInvoices().find({
            companyId, cancelled: { $ne: true },
        }).toArray();
        const lines = await collections.lines().find({ companyId }).toArray();

        const portalIdx = buildPortalIndex(lines);   // for SAP-side reasons
        const sapIdx = buildSapIndex(invoices);       // for 2B-side reasons
        const hasGst = (i) => (Number(i.tax) || 0) + (Number(i.cgst) || 0) + (Number(i.sgst) || 0) + (Number(i.igst) || 0) > 0;

        // SAP invoices booked in the period, carrying GST, not reconciled.
        // Restricted to BKPF (the agreed AP source; RBKP is no longer used).
        const inSapNotIn2b = invoices
            .filter((i) => i.source === 'BKPF' && i.reconciled !== true && hasGst(i) && (m0 == null || inMonth(i.docDate || i.taxDate, y, m0)))
            .map((i) => toBillDTO(i, classifyUnmatched(i, portalIdx)));

        // 2B lines still NEW (unmatched). NOT invoice-date-filtered: every stored
        // line belongs to the uploaded return (suppliers late-report earlier-dated
        // invoices in it), so matched + in2bNotInSap ties out to the full 2B count.
        const in2bNotInSap = lines
            .filter((l) => l.matchStatus === 'NEW')
            .map((l) => to2bLineDTO(l, classify2bUnmatched(l, sapIdx)));

        return {
            period: { month, year: String(year) },
            inSapNotIn2b,
            in2bNotInSap,
            counts: { inSapNotIn2b: inSapNotIn2b.length, in2bNotInSap: in2bNotInSap.length },
        };
    }

    /**
     * GET /matched-bills — reconciled pairs for the period, Excel (2B) vs SAP tax
     * side by side. One row per matched 2B line joined to its SAP invoice.
     */
    async getMatchedBills(companyId, month = 'Apr', year = '2026') {
        // All matched 2B lines belong to the uploaded return — not invoice-date
        // filtered, so this count + in2bNotInSap equals the full 2B line count.
        const lines = await collections.lines()
            .find({ companyId, matchStatus: { $in: ['Match', 'Match-Review'] } })
            .toArray();
        const invoices = await collections.apInvoices().find({ companyId, reconciled: true }).toArray();
        const byDoc = new Map();
        for (const inv of invoices) byDoc.set(String(inv.docNo), inv);

        const rows = lines
            .map((l) => {
                const inv = byDoc.get(String(l.matchedDocNo)) || {};
                return {
                    VendorGST: l.supplierGstin || inv.vendorGstin || '',
                    VendorBillNo: l.invoiceNum || inv.vendorRef || '',
                    ExcelSGST: +(Number(l.stateTax) || 0).toFixed(2),
                    ExcelCGST: +(Number(l.centralTax) || 0).toFixed(2),
                    ExcelIGST: +(Number(l.integratedTax) || 0).toFixed(2),
                    SAP_SGST: +(Number(inv.sgst) || 0).toFixed(2),
                    SAP_CGST: +(Number(inv.cgst) || 0).toFixed(2),
                    SAP_IGST: +(Number(inv.igst) || 0).toFixed(2),
                    InvoiceDate: l.invoiceDate || inv.docDate || null,
                    Status: l.matchStatus,
                };
            });
        rows.sort((a, b) => String(a.VendorGST).localeCompare(String(b.VendorGST)) || String(a.VendorBillNo).localeCompare(String(b.VendorBillNo)));
        return { period: { month, year: String(year) }, matched: rows, count: rows.length };
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
            } });
        return { success: true };
    }
}

module.exports = new ReconcileService();
