const express = require('express');
const multer = require('multer');
const { verifyToken } = require('../middleware/auth');
const ReconcileController = require('../modules/reconcile/reconcileController');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const reconcile = new ReconcileController();

const router = express.Router();

// All reconcile routes require a valid JWT.
router.use(verifyToken);

// ── GSTR-2A/2B reconciliation ──
router.post('/upload', upload.single('file'), reconcile.processFile.bind(reconcile));
router.post('/refresh', reconcile.refresh.bind(reconcile));
router.get('/progress', reconcile.getProgress.bind(reconcile));
router.get('/periods', reconcile.fetchPeriods.bind(reconcile));
router.get('/check/:month', reconcile.getPeriodByMonth.bind(reconcile));
router.delete('/delete/:periodId', reconcile.deletePeriod.bind(reconcile));
router.get('/fetch-sap-bills', reconcile.fetchBills.bind(reconcile));
router.get('/unmatched-sections', reconcile.fetchUnmatchedSections.bind(reconcile));
router.get('/matched-bills', reconcile.fetchMatchedBills.bind(reconcile));
router.get('/tax-mismatch-bills', reconcile.fetchTaxMismatchBills.bind(reconcile));
router.get('/manual-matched-bills', reconcile.fetchManualMatchedBills.bind(reconcile));
router.get('/bill-counts', reconcile.fetchBillCounts.bind(reconcile));
router.get('/bill-page', reconcile.fetchBillPage.bind(reconcile));
router.post('/update-status', reconcile.updateBillStatus.bind(reconcile));

module.exports = router;
