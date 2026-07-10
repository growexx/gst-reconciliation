const reconcileService = require('./reconcileService');
const { logReconciliation } = require('./logUtils');
const progressStore = require('./progressStore');

// A GSTIN is 15 chars: 2-digit state code + 10-char PAN + 1 entity char + 'Z' + 1 checksum.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// Company id: from the X-Company header, else from the JWT, else a default.
function companyOf(req) {
    return req.headers['x-company'] || req.headers['x-database'] || req.user?.companyId || 'Nandan Terry';
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
            if (!sessionId) return res.status(401).json({ error: 'Unauthorized' });

            // Run the reconcile in the BACKGROUND — the on-demand SAP fetch can take a
            // while, so we return 202 immediately and the client polls /progress for the
            // phase and the final result (so the upload request never blocks/times out).
            const buf = req.file.buffer;
            progressStore.set(sessionId, { phase: 'Starting…', current: 0, total: 0, done: false });
            const report = (p) => {
                const prev = progressStore.get(sessionId) || {};
                progressStore.set(sessionId, { ...prev, ...(p && typeof p === 'object' ? p : {}), done: false });
            };
            reconcileService.importPortalFile(buf, companyId, month, year, sessionId, report)
                .then(({ result, unmatchedBills }) => {
                    progressStore.set(sessionId, { phase: 'Done', done: true, result, unmatchedBills });
                })
                .catch((error) => {
                    console.error('Reconciliation error:', error.message);
                    progressStore.set(sessionId, { phase: 'Error', done: true, error: error.message || 'Reconciliation failed' });
                });

            return res.status(202).json({ running: true });
        } catch (error) {
            console.error('Reconciliation start error:', error.message);
            res.status(500).json({ error: error.message || 'Failed to start reconciliation' });
        }
    }

    // POST /refresh?month=&year= — re-reconcile a stored period against CURRENT SAP data
    // (no re-upload). Background job like processFile; client polls /progress.
    async refresh(req, res) {
        try {
            const companyId = companyOf(req);
            const sessionId = sessionOf(req);
            const { month, year } = req.query;
            if (!month || !year) return res.status(400).json({ error: 'Missing month/year' });
            if (month === 'All') return res.status(400).json({ error: 'Pick a specific month to refresh.' });
            if (!sessionId) return res.status(401).json({ error: 'Unauthorized' });

            progressStore.set(sessionId, { phase: 'Starting refresh…', current: 0, total: 0, done: false });
            const report = (p) => {
                const prev = progressStore.get(sessionId) || {};
                progressStore.set(sessionId, { ...prev, ...(p && typeof p === 'object' ? p : {}), done: false });
            };
            reconcileService.refreshPeriod(companyId, month, year, report)
                .then(({ result, unmatchedBills }) => { progressStore.set(sessionId, { phase: 'Done', done: true, result, unmatchedBills }); })
                .catch((error) => {
                    console.error('Refresh error:', error.message);
                    progressStore.set(sessionId, { phase: 'Error', done: true, error: error.message || 'Refresh failed' });
                });
            return res.status(202).json({ running: true });
        } catch (error) {
            console.error('Refresh start error:', error.message);
            res.status(500).json({ error: error.message || 'Failed to start refresh' });
        }
    }

    async getProgress(req, res) {
        const sessionId = sessionOf(req);
        if (!sessionId) return res.status(401).json({ error: 'Unauthorized' });
        res.json(progressStore.get(sessionId) || { current: 0, total: 0 });
    }

    async fetchPeriods(req, res) {
        try {
            res.json(await reconcileService.getPeriods(companyOf(req)));
        } catch (error) {
            console.error('Error fetching periods:', error.message);
            res.status(500).json({ error: 'Failed to fetch periods' });
        }
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

    async fetchTaxMismatchBills(req, res) {
        try {
            const month = req.query.month || 'Apr';
            const year = req.query.year || '2026';
            const data = await reconcileService.getTaxMismatchBills(companyOf(req), month, year);
            res.json(data);
        } catch (error) {
            console.error('Error fetching tax-mismatch bills:', error.message);
            res.status(500).json({ error: 'Failed to fetch tax-mismatch bills' });
        }
    }

    async fetchManualMatchedBills(req, res) {
        try {
            const data = await reconcileService.getManuallyMatchedBills(companyOf(req));
            res.json(data);
        } catch (error) {
            console.error('Error fetching manually-matched bills:', error.message);
            res.status(500).json({ error: 'Failed to fetch manually-matched bills' });
        }
    }

    // Counts for every category (small payload, drives the tab badges).
    async fetchBillCounts(req, res) {
        try {
            const month = req.query.month || 'Apr';
            const year = req.query.year || '2026';
            res.json(await reconcileService.getBillCounts(companyOf(req), month, year));
        } catch (error) {
            console.error('Error fetching bill counts:', error.message);
            res.status(500).json({ error: 'Failed to fetch bill counts' });
        }
    }

    // One page of one category (vendor-grouped for SAP/2B lists, row-paged otherwise).
    async fetchBillPage(req, res) {
        try {
            const { key, month = 'Apr', year = '2026', page = 1, pageSize = 25, q = '' } = req.query;
            res.json(await reconcileService.getBillPage(companyOf(req), key, month, year, Number(page), Number(pageSize), q));
        } catch (error) {
            console.error('Error fetching bill page:', error.message);
            res.status(500).json({ error: 'Failed to fetch bill page' });
        }
    }

    async updateBillStatus(req, res) {
        try {
            const companyId = companyOf(req);
            const {
                docEntry, vendorCode, vendorName, vendorGST, billNumber, billDate,
                totalAmount, CGST, SGST, IGST, username, excelBill,
            } = req.body;

            // Reconciling requires a proper GSTIN — reject anything that isn't one.
            const excelGST = String(req.body.excelGST || '').trim().toUpperCase();
            if (!GSTIN_RE.test(excelGST)) {
                return res.status(400).json({ message: 'A valid 15-character GSTIN is required to reconcile.' });
            }

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
