/**
 * Matching engine — RBKP/FI (SAP AP invoices) ↔ GSTR-2B.
 *
 * Tiered, classified, best-match logic (ported from the validated offline
 * analysis). Each portal line is matched to at most one AP invoice and each
 * invoice to at most one line, choosing the best-scoring candidate within the
 * same GSTIN. Tolerance rules:
 *   - invoice-number standardization (uppercase, strip / - space, leading zeros)
 *   - vendor match by GSTIN
 *   - total-tax tolerance ±5  and  date window ±10 days
 *
 * Tiers (first that assigns wins, per line):
 *   T1  GSTIN + invoice-no + tax(±5) + date(±10)   → clean match
 *   T2  GSTIN + invoice-no                          → matched, but flagged if
 *                                                     tax/date are out of tolerance
 *   T3  GSTIN + tax(±5) + date(±10), no invoice-no  → e.g. '&&' auto-refs
 */

const AMOUNT_TOLERANCE = 5;     // rupees, on total tax
const DATE_WINDOW_DAYS = 10;    // ± days

/** Standardize an invoice number: drop separators and leading zeros within EACH
 *  segment, so "AC/26-27/6" == "AC/26-27/006" and "INV/01" == "INV/1". */
function normalizeInvoiceNum(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .toUpperCase()
        .trim()
        .split(/[^A-Z0-9]+/)                          // split on /, -, space, ., (, ) …
        .map((seg) => seg.replace(/^0+(?=[0-9])/, '')) // strip a segment's leading zeros (keep ≥1 digit)
        .join('');
}

// Tolerant vendor-name comparison — treats the SAME vendor written differently as a
// match: corporate suffixes (PVT/LTD/LIMITED), 'M/s'/'Ms.' prefixes, '&'/'(India)',
// and acronym spacing ("R S W M" == "RSWM"). Genuinely different names still conflict.
const NAME_GENERIC = ['PRIVATELIMITED', 'PRIVATE', 'LIMITED', 'PVTLTD', 'PVT', 'LTD', 'LLP',
    'INDIA', 'ENTERPRISES', 'ENTERPRISE', 'INDUSTRIES', 'INDUSTRY', 'TRADERS', 'TRADING', 'COMPANY', 'CORPORATION'];
const nameCore = (s) => {
    let x = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');   // drop spaces/punct → handles "R S W M", "M/s", "&", "()"
    for (const g of NAME_GENERIC) x = x.split(g).join('');             // strip generic suffix/words
    return x;
};
const nameSigTokens = (s) => String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 4 && !NAME_GENERIC.includes(t));
function vendorNamesAgree(a, b) {
    if (!a || !b) return true;                                  // nothing to compare → don't block
    const ca = nameCore(a); const cb = nameCore(b);
    if (ca && cb && (ca === cb || ca.includes(cb) || cb.includes(ca))) return true;
    const ta = new Set(nameSigTokens(a)); const tb = nameSigTokens(b);
    return tb.some((t) => ta.has(t));                           // share a significant brand word
}

function toDate(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

function daysApart(a, b) {
    const da = toDate(a), db = toDate(b);
    if (!da || !db) return Infinity;
    return Math.abs(da.getTime() - db.getTime()) / 86400000;
}

function approx(a, b, tol = AMOUNT_TOLERANCE) {
    return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tol;
}

/** Total tax of an AP invoice — prefer the stored total, else sum the split. */
function invoiceTax(inv) {
    const t = Number(inv.tax);
    if (t) return t;
    return (Number(inv.cgst) || 0) + (Number(inv.sgst) || 0) + (Number(inv.igst) || 0);
}

/** Total tax of a portal line — prefer the stored total, else sum the split. */
function lineTax(line) {
    const t = Number(line.tax);
    if (t) return t;
    return (Number(line.centralTax) || 0) + (Number(line.stateTax) || 0)
        + (Number(line.integratedTax) || 0) + (Number(line.cess) || 0);
}

function invDate(inv) { return inv.taxDate || inv.docDate; }

function normRef(line) {
    return line.normalizedInvoiceNum || normalizeInvoiceNum(line.invoiceNum);
}
function normInvRef(inv) {
    return inv.normalizedInvoiceNum || normalizeInvoiceNum(inv.vendorRef);
}

/**
 * Decide whether a portal line and an AP invoice are a *clean* match
 * (T1 — all of GSTIN, invoice-no, tax and date agree). Kept for compatibility.
 */
function isMatch(line, inv) {
    if (inv.cancelled) return false;
    if (!line.supplierGstin || !inv.vendorGstin) return false;
    if (String(line.supplierGstin).toUpperCase() !== String(inv.vendorGstin).toUpperCase()) return false;
    if (!normRef(line) || normRef(line) !== normInvRef(inv)) return false;
    if (daysApart(line.invoiceDate, invDate(inv)) > DATE_WINDOW_DAYS) return false;
    return approx(invoiceTax(inv), lineTax(line));
}

// ── Result categories (stored verbatim on the line and used by the service) ──
//   GSTIN "ok" means the SAP GSTIN equals the 2B GSTIN, OR the SAP bill has no
//   GSTIN at all (it then adopts the 2B GSTIN). Bills are paired on bill number.
const CATEGORY = {
    MATCH:       'Match',               // GSTIN ok (or adopted + vendor verified) + bill + value + date -> reconciled
    DATE_DIFF:   'Match-DateDiff',      // as Match but date out of tolerance                            -> reconciled
    GST_DIFF:    'NotMatch-GstDiff',    // bill + value (+date) agree, native GSTIN differs              -> NOT reconciled
    VALUE_DIFF:  'NotMatch-ValueDiff',  // GSTIN + bill agree, tax value off > ±5                        -> NOT reconciled
    VENDOR_DIFF: 'NotMatch-VendorDiff', // bill + value match, GSTIN adopted from 2B but SAP's own vendor differs -> NOT reconciled
    NO_BILL:     'NotMatch-NoBillNo',   // GSTIN + value + date agree, bill-no does NOT                  -> NOT reconciled (manual)
};
const REASONS = {
    'Match':              'exact (GSTIN + bill-no + value + date)',
    'Match-DateDiff':     'GSTIN + bill-no + value match; invoice date differs',
    'NotMatch-GstDiff':   'bill-no + value + date match but GSTIN differs',
    'NotMatch-ValueDiff': 'GSTIN + bill-no match but tax value differs > tolerance',
    'NotMatch-VendorDiff':'bill-no + value match, but SAP’s vendor for this bill differs from the 2B supplier',
    'NotMatch-NoBillNo':  'GSTIN + value + date match but bill number differs — reconcile manually',
};
// Categories that count as an actual (reconciled) match. The rest are "near
// misses" surfaced in their own Not-Matched buckets, NOT reconciled.
const MATCHED_CATEGORIES = new Set([CATEGORY.MATCH, CATEGORY.DATE_DIFF]);

/**
 * Run reconciliation for a set of 2B lines against candidate AP invoices.
 * @param {Array}  lines     2B lines (each needs _id, supplierGstin, invoiceNum, tax, invoiceDate)
 * @param {Array}  invoices  candidate AP invoices (same company / window / category)
 * @param {Object} [opts]    { absTax } — compare |tax| (CDNR credit/debit notes can be signed)
 * @returns {{ matches: Array }} each: { lineId, invoiceDocNo, invoiceFiscalYear, category,
 *          status, reason, backfillGstin, taxDelta, dateDelta }
 */
function reconcile(lines, invoices, opts = {}) {
    const absTax = !!opts.absTax;
    const tx = absTax ? (v) => Math.abs(Number(v) || 0) : (v) => Number(v) || 0;

    const byRef = new Map();    // normalized bill/note no -> [inv]
    const byGstin = new Map();  // GSTIN -> [inv]
    for (const inv of invoices) {
        if (inv.cancelled) continue;
        const r = normInvRef(inv);
        if (r) { if (!byRef.has(r)) byRef.set(r, []); byRef.get(r).push(inv); }
        const g = String(inv.vendorGstin || '').toUpperCase();
        if (g) { if (!byGstin.has(g)) byGstin.set(g, []); byGstin.get(g).push(inv); }
    }

    const usedLine = new Set();
    const usedInv = new Set();
    const invKey = (i) => `${i.docNo}|${i.fiscalYear}`;
    const matches = [];

    const lineG       = (l) => String(l.supplierGstin || '').toUpperCase();
    const invG        = (i) => String(i.vendorGstin || '').toUpperCase();
    const valueOk     = (l, i) => Math.abs(tx(invoiceTax(i)) - tx(lineTax(l))) <= AMOUNT_TOLERANCE;
    const dateOk      = (l, i) => daysApart(l.invoiceDate, invDate(i)) <= DATE_WINDOW_DAYS;
    const gstinEq     = (l, i) => !!lineG(l) && lineG(l) === invG(i);
    const gstinAbsent = (i) => !invG(i);
    const gstinDiff   = (l, i) => !gstinAbsent(i) && !!lineG(l) && lineG(l) !== invG(i);
    const billEq      = (l, i) => !!normRef(l) && normRef(l) === normInvRef(i);

    // ── Vendor checks for a GSTIN-less SAP bill that would adopt the 2B GSTIN ──
    // SAP's OWN identity for the bill = its RBKP-reserve vendor (or BSEG name).
    const hasOwnVendor = (i) => !!(i.rbkpGstin || i.vendorName);
    const ownVendorAgrees = (l, i) => {
        if (i.rbkpGstin && String(i.rbkpGstin).toUpperCase() === lineG(l)) return true; // reserve confirms same GSTIN
        return vendorNamesAgree(i.rbkpVendorName || i.vendorName, l.supplierName);
    };
    // Look the 2B GSTIN up in SAP's vendor master; does its registered name match the 2B?
    const vendorByGstin = opts.vendorByGstin || null;
    const masterAgrees = (l, i) => {
        if (!vendorByGstin) return true;
        const names = vendorByGstin.get(lineG(l));     // a GSTIN can map to several SAP vendor codes
        if (!names || !names.length) return true;      // 2B GSTIN not in SAP master → can't disprove
        return names.some((nm) => vendorNamesAgree(nm, l.supplierName));   // ANY SAP vendor for it agrees
    };
    // A GSTIN-less bill matches only if SAP's vendor for it agrees with the 2B:
    //  - if SAP has its own vendor for the bill → that must agree (else it's a different
    //    vendor's invoice; the bill simply isn't this 2B line → stays unmatched);
    //  - else fall back to the vendor-master name for the 2B GSTIN.
    const vendorVerified = (l, i) => hasOwnVendor(i) ? ownVendorAgrees(l, i) : masterAgrees(l, i);
    const vendorOk    = (l, i) => gstinEq(l, i) || (gstinAbsent(i) && vendorVerified(l, i));

    function buildMatch(line, inv, category) {
        const taxDelta = +(invoiceTax(inv) - lineTax(line)).toFixed(2);
        const dd = daysApart(line.invoiceDate, invDate(inv));
        return {
            lineId: line._id,
            invoiceDocNo: inv.docNo,
            invoiceFiscalYear: inv.fiscalYear,
            category, status: category, reason: REASONS[category] || category,
            // adopt the 2B GSTIN only when SAP has none AND this is a real match
            backfillGstin: (MATCHED_CATEGORIES.has(category) && gstinAbsent(inv)) ? lineG(line) : undefined,
            taxDelta,
            dateDelta: isFinite(dd) ? Math.round(dd) : null,
        };
    }

    // One pass: assign each still-free line to its best still-free invoice that
    // satisfies `pred`. `index` chooses the candidate pool (by bill-no or GSTIN).
    function pass(pred, category, index) {
        for (const line of lines) {
            if (usedLine.has(line._id)) continue;
            const key = index === 'gstin' ? lineG(line) : normRef(line);
            if (!key) continue;
            const cands = (index === 'gstin' ? byGstin : byRef).get(key) || [];
            let best = null, bestScore = Infinity;
            for (const inv of cands) {
                if (usedInv.has(invKey(inv))) continue;
                if (!pred(line, inv)) continue;
                const dd = daysApart(line.invoiceDate, invDate(inv));
                const score = Math.abs(tx(invoiceTax(inv)) - tx(lineTax(line)))
                    + (isFinite(dd) ? dd : DATE_WINDOW_DAYS * 100);
                // Deterministic tie-break so the result is independent of DB order.
                if (score < bestScore || (score === bestScore && best && invKey(inv) < invKey(best))) {
                    bestScore = score; best = inv;
                }
            }
            if (best) {
                usedLine.add(line._id);
                usedInv.add(invKey(best));
                matches.push(buildMatch(line, best, category));
            }
        }
    }

    // Real matches always run.
    pass((l, i) => billEq(l, i) && valueOk(l, i) && vendorOk(l, i) && dateOk(l, i),  CATEGORY.MATCH,      'ref');
    pass((l, i) => billEq(l, i) && valueOk(l, i) && vendorOk(l, i) && !dateOk(l, i), CATEGORY.DATE_DIFF,  'ref');

    // GST-Diff (native GSTIN present but differs). Skipped in the RBKP-fallback pass
    // (opts.skipGstDiff): there the candidate GSTIN is the RBKP-reserve GSTIN, so a
    // mismatch just means SAP's reserve vendor differs (a collision) — that 2B line must
    // fall through to "In 2B, not in SAP", not become a GST-Diff near-miss.
    if (!opts.skipGstDiff) {
        pass((l, i) => billEq(l, i) && valueOk(l, i) && gstinDiff(l, i),             CATEGORY.GST_DIFF,   'ref');
    }
    // Diff-Vendor-Name (clause 2): GSTIN-less bill with NO own SAP vendor, where the 2B
    // GSTIN looked up in SAP's vendor master resolves to a DIFFERENT supplier name.
    pass((l, i) => billEq(l, i) && valueOk(l, i) && gstinAbsent(i) && !hasOwnVendor(i) && !masterAgrees(l, i), CATEGORY.VENDOR_DIFF, 'ref');
    // Value-Diff requires the SAME GSTIN — else a shared bill number across two
    // different vendors would falsely pair. (Safe in the fallback pass: gstinEq guards it.)
    pass((l, i) => billEq(l, i) && gstinEq(l, i) && !valueOk(l, i),                  CATEGORY.VALUE_DIFF, 'ref');
    // No bill-no match anywhere, but GSTIN + value + date agree → manual bucket.
    pass((l, i) => gstinEq(l, i) && valueOk(l, i) && dateOk(l, i),                   CATEGORY.NO_BILL,    'gstin');

    return { matches };
}

module.exports = {
    normalizeInvoiceNum, isMatch, reconcile,
    invoiceTax, lineTax,
    CATEGORY, REASONS, MATCHED_CATEGORIES,
    AMOUNT_TOLERANCE, DATE_WINDOW_DAYS,
};
