/**
 * One-off cleanup: purge ALL stored GSTR-2B lines and period docs for a company,
 * so a fresh re-upload rebuilds them cleanly. Use this if duplicate/accumulated 2B
 * lines have inflated the "In 2B, not in SAP" counts.
 *
 * Safe: it touches only gst_recon_lines + gst_recon_periods. SAP invoices are left
 * alone (the next 2B import re-matches them), and manual reconciliations live in the
 * durable recon_log (re-applied automatically on the next import).
 *
 * Usage:  node server/scripts/cleanupReco.js "Nandan Terry"
 *         (defaults to the first COMPANIES entry from .env if omitted)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { connect, collections, disconnect } = require('../config/db');

(async () => {
    const company = process.argv[2] || (process.env.COMPANIES || '').split(',')[0].trim();
    if (!company) {
        console.error('Usage: node server/scripts/cleanupReco.js "<Company>"');
        process.exit(1);
    }
    await connect();
    const periods = await collections.periods().countDocuments({ companyId: company });
    const lines = await collections.lines().countDocuments({ companyId: company });
    console.log(`Before: ${lines} 2B lines, ${periods} period(s) for "${company}".`);

    const dl = await collections.lines().deleteMany({ companyId: company });
    const dp = await collections.periods().deleteMany({ companyId: company });
    console.log(`Purged ${dl.deletedCount} lines and ${dp.deletedCount} period(s).`);
    console.log('Next: re-upload each month\'s GSTR-2B from the app — it will rebuild cleanly.');
    await disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
