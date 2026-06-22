/**
 * Reconciliation audit log — writes to the `recon_log` MongoDB collection.
 * (Replaces the old append-to-reconciliation.txt approach so the audit
 *  trail survives container restarts and is queryable.)
 */
const { collections } = require('../../config/db');

async function logReconciliation(entry) {
    try {
        await collections.reconLog().insertOne({
            ts: new Date(),
            action: 'BILL_RECONCILED',
            username: entry.username || 'Unknown User',
            companyId: entry.companyId || null,
            docNo: entry.docEntry,
            vendorCode: entry.vendorCode,
            vendorName: entry.vendorName,
            vendorGstin: entry.vendorGST,
            billNumber: entry.billNumber,
            billDate: entry.billDate,
            totalAmount: entry.totalAmount,
            cgst: entry.CGST || 0,
            sgst: entry.SGST || 0,
            igst: entry.IGST || 0,
            excelGstin: entry.excelGST || null,
            excelBill: entry.excelBill || null,
        });
    } catch (err) {
        console.error('logReconciliation failed:', err.message);
    }
}

module.exports = { logReconciliation };
