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

/** Standardize an invoice number the same way the old SQL did. */
function normalizeInvoiceNum(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .toUpperCase()
        .trim()
        .replace(/[\/\-\s]/g, '')   // strip slashes, dashes, spaces
        .replace(/^0+/, '');        // strip leading zeros
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

/** Classify a T2 (invoice-no) match: clean, or flagged for amount/date drift. */
function classifyT2(taxDelta, dateDelta) {
    const flags = [];
    if (Math.abs(taxDelta) > AMOUNT_TOLERANCE) flags.push('amount_mismatch');
    if (dateDelta > DATE_WINDOW_DAYS) flags.push('date_mismatch');
    if (!flags.length) return { status: 'Match', reason: 'invno (tax & date within tolerance)' };
    return { status: 'Match-Review', reason: flags.join(' + ') };
}

/**
 * Run reconciliation for one upload.
 * @param {Array} lines     portal 2B lines for this period (each needs an _id)
 * @param {Array} invoices  candidate AP invoices (same company)
 * @returns {{ matches: Array, matchedInvoiceKeys: Set }}
 *   matches: { lineId, invoiceDocNo, invoiceFiscalYear, tier, reason, status, taxDelta, dateDelta }
 */
function reconcile(lines, invoices) {
    // Index live (non-cancelled) invoices two ways:
    //  - byGstin: GSTIN-bearing invoices, for the strict GSTIN tiers (T1-T3).
    //  - byRef:   ALL invoices by normalized invoice no, for the T4 fallback
    //             (invoice-no + tax). T4 must consider invoices that DO carry a
    //             GSTIN too — a fallback-assigned GSTIN can differ from the 2B's,
    //             in which case the GSTIN tiers miss it but invoice-no + tax still
    //             matches (and the 2B GSTIN is then adopted).
    const byGstin = new Map();
    const byRef = new Map();
    for (const inv of invoices) {
        if (inv.cancelled) continue;
        const g = String(inv.vendorGstin || '').toUpperCase();
        if (g) {
            if (!byGstin.has(g)) byGstin.set(g, []);
            byGstin.get(g).push(inv);
        }
        const r = normInvRef(inv);
        if (r) {
            if (!byRef.has(r)) byRef.set(r, []);
            byRef.get(r).push(inv);
        }
    }

    const usedLine = new Set();
    const usedInvoice = new Set();
    const invKey = (inv) => `${inv.docNo}|${inv.fiscalYear}`;
    const matches = [];

    function buildMatch(line, inv, tier) {
        const taxDelta = +(invoiceTax(inv) - lineTax(line)).toFixed(2);
        const dateDelta = daysApart(line.invoiceDate, invDate(inv));
        let status = 'Match', reason, backfillGstin;
        if (tier === 'T1') reason = 'exact (GSTIN+inv+tax+date)';
        else if (tier === 'T3') reason = 'tax+date (auto/no reference)';
        else if (tier === 'T4') {
            reason = 'invoice-no + tax (GSTIN taken from 2B)';
            backfillGstin = String(line.supplierGstin || '').toUpperCase();   // no SAP vendor -> adopt the 2B GSTIN
        } else ({ status, reason } = classifyT2(taxDelta, dateDelta));
        return {
            lineId: line._id,
            invoiceDocNo: inv.docNo,
            invoiceFiscalYear: inv.fiscalYear,
            tier, status, reason, backfillGstin,
            taxDelta,
            dateDelta: isFinite(dateDelta) ? Math.round(dateDelta) : null,
        };
    }

    // One tier pass: assign each still-free line to its best still-free invoice.
    function pass(predicate, tier) {
        for (const line of lines) {
            if (usedLine.has(line._id)) continue;
            const g = String(line.supplierGstin || '').toUpperCase();
            if (!g) continue;
            const cands = byGstin.get(g) || [];
            let best = null, bestScore = Infinity;
            for (const inv of cands) {
                if (usedInvoice.has(invKey(inv))) continue;
                if (!predicate(line, inv)) continue;
                const dd = daysApart(line.invoiceDate, invDate(inv));
                // The date term must not poison the score when a date is missing:
                // T2 matches on invoice-no alone, so a null/invalid date must still
                // produce a finite score (else `score < Infinity` is never true and
                // a valid invoice-no match is silently dropped).
                const score = Math.abs(invoiceTax(inv) - lineTax(line))
                    + (isFinite(dd) ? dd : DATE_WINDOW_DAYS * 100);
                // Deterministic tie-break: on an exact score tie prefer the lower
                // invoice key, so the result is independent of DB/return order.
                if (score < bestScore || (score === bestScore && best && invKey(inv) < invKey(best))) {
                    bestScore = score; best = inv;
                }
            }
            if (best) {
                usedLine.add(line._id);
                usedInvoice.add(invKey(best));
                matches.push(buildMatch(line, best, tier));
            }
        }
    }

    const refEq = (l, i) => normRef(l) && normRef(l) === normInvRef(i);
    const amtDateOk = (l, i) => approx(invoiceTax(i), lineTax(l))
        && daysApart(l.invoiceDate, invDate(i)) <= DATE_WINDOW_DAYS;

    pass((l, i) => refEq(l, i) && amtDateOk(l, i), 'T1');   // exact
    pass((l, i) => refEq(l, i), 'T2');                       // invoice-no only
    pass((l, i) => amtDateOk(l, i), 'T3');                   // amount+date, no ref

    // T4: fallback — any still-unmatched invoice matched on invoice-no + total
    // tax (±tolerance), regardless of whether it carries a (possibly wrong)
    // GSTIN. The GSTIN is then adopted from the 2B line.
    for (const line of lines) {
        if (usedLine.has(line._id)) continue;
        const r = normRef(line);
        if (!r) continue;
        const cands = byRef.get(r) || [];
        let best = null, bestScore = Infinity;
        for (const inv of cands) {
            if (usedInvoice.has(invKey(inv))) continue;
            if (!approx(invoiceTax(inv), lineTax(line))) continue;   // tax must agree (±tol)
            const score = Math.abs(invoiceTax(inv) - lineTax(line));
            if (score < bestScore || (score === bestScore && best && invKey(inv) < invKey(best))) {
                bestScore = score; best = inv;
            }
        }
        if (best) {
            usedLine.add(line._id);
            usedInvoice.add(invKey(best));
            matches.push(buildMatch(line, best, 'T4'));
        }
    }

    const matchedInvoiceKeys = new Set(matches.map((m) => `${m.invoiceDocNo}|${m.invoiceFiscalYear}`));
    return { matches, matchedInvoiceKeys };
}

module.exports = {
    normalizeInvoiceNum, isMatch, reconcile,
    invoiceTax, lineTax,
    AMOUNT_TOLERANCE, DATE_WINDOW_DAYS,
};
