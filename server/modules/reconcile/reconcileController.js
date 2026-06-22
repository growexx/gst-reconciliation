const reconcileService = require('./reconcileService');
const { logReconciliation } = require('./logUtils');
const progressStore = require('./progressStore');

// Company id: from the X-Company header, else from the JWT, else a default.
function companyOf(req) {
    return req.headers['x-company'] || req.headers['x-database'] || req.user?.companyId || 'COMP1';
}
function sessionOf(req) {
    return req.headers.authorization?.split(' ')[1];
}

class ReconcileController {
    async processFile(req, res) {
        try {
            if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
            const companyId = companyOf(req);
            const sessionId = sessionOf(req);
            const { month, year } = req.body;
            if (!month || !year) {
                return res.status(400).json({ error: 'Missing required parameters (month, year)' });
            }

            const { result, unmatchedBills } = await reconcileService.importPortalFile(
                req.file.buffer, companyId, month, year, sessionId,
                (current, total) => progressStore.set(sessionId, { current, total }),
            );

            progressStore.delete(sessionId);
            res.json({ success: true, result, unmatchedBills });
        } catch (error) {
            console.error('Reconciliation error:', error.message);
            const sid = sessionOf(req);
            if (sid) progressStore.delete(sid);
            res.status(500).json({ error: error.message || 'An error occurred while processing the file' });
        }
    }

    async getProgress(req, res) {
        const sessionId = sessionOf(req);
        if (!sessionId) return res.status(401).json({ error: 'Unauthorized' });
        res.json(progressStore.get(sessionId) || { current: 0, total: 0 });
    }

    async getPeriodByMonth(req, res) {
        try {
            const periodId = await reconcileService.getPeriodIdByMonth(companyOf(req), req.params.month);
            res.json(periodId);
        } catch (error) {
            res.status(500).json({ error: 'Failed to check for existing data' });
        }
    }

    async deletePeriod(req, res) {
        try {
            await reconcileService.deletePeriod(req.params.periodId);
            res.status(204).send();
        } catch (error) {
            res.status(500).json({ error: 'Failed to delete document' });
        }
    }

    async fetchBills(req, res) {
        try {
            const unmatchedBills = await reconcileService.fetchUnreconciledBills(companyOf(req));
            res.json({ unmatchedBills });
        } catch (error) {
            console.error('Error fetching bills:', error.message);
            res.status(500).json({ error: 'Failed to fetch bills' });
        }
    }

    async fetchUnmatchedSections(req, res) {
        try {
            const month = req.query.month || 'Apr';
            const year = req.query.year || '2026';
            const data = await reconcileService.getUnmatchedSections(companyOf(req), month, year);
            res.json(data);
        } catch (error) {
            console.error('Error fetching unmatched sections:', error.message);
            res.status(500).json({ error: 'Failed to fetch unmatched sections' });
        }
    }

    async fetchMatchedBills(req, res) {
        try {
            const month = req.query.month || 'Apr';
            const year = req.query.year || '2026';
            const data = await reconcileService.getMatchedBills(companyOf(req), month, year);
            res.json(data);
        } catch (error) {
            console.error('Error fetching matched bills:', error.message);
            res.status(500).json({ error: 'Failed to fetch matched bills' });
        }
    }

    async updateBillStatus(req, res) {
        try {
            const companyId = companyOf(req);
            const {
                docEntry, vendorCode, vendorName, vendorGST, billNumber, billDate,
                totalAmount, CGST, SGST, IGST, username, excelGST, excelBill,
            } = req.body;

            await reconcileService.markReconciled(companyId, docEntry, excelGST, excelBill);
            await logReconciliation({
                companyId, docEntry, vendorCode, vendorName, vendorGST,
                billNumber, billDate, totalAmount, CGST, SGST, IGST, username, excelGST, excelBill,
            });
            res.json({ success: true });
        } catch (error) {
            console.error('Error updating bill status:', error.message);
            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = ReconcileController;
