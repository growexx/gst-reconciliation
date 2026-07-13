/**
 * MongoDB connection module (replaces the old SAP HANA / ODBC layer).
 * One shared client for the whole process.
 */
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.MONGODB_DB || 'gst_reco';

let client;
let db;

async function connect() {
    if (db) return db;
    client = new MongoClient(uri, { ignoreUndefined: true });
    await client.connect();
    db = client.db(dbName);
    await ensureIndexes(db);
    console.log(`✅ MongoDB connected → ${dbName}`);
    return db;
}

function getDb() {
    if (!db) throw new Error('MongoDB not connected yet. Call connect() first.');
    return db;
}

// Named collection accessors keep the rest of the code free of string literals.
const collections = {
    periods:   () => getDb().collection('gst_recon_periods'),  // replaces @GSTRECONH
    lines:     () => getDb().collection('gst_recon_lines'),    // replaces @GSTRECOND
    apInvoices:() => getDb().collection('ap_invoices'),        // replaces OPCH + PCH4 (RBKP from client)
    vendors:   () => getDb().collection('vendors'),            // replaces OCRD + CRD1 (optional)
    reconLog:  () => getDb().collection('recon_log'),          // replaces reconciliation.txt
    users:     () => getDb().collection('users'),              // replaces OUSR (app-side)
};

async function ensureIndexes(database) {
    await database.collection('gst_recon_periods').createIndex(
        { companyId: 1, year: 1, month: 1 }, { unique: true });
    await database.collection('gst_recon_lines').createIndex({ periodId: 1 });
    await database.collection('gst_recon_lines').createIndex(
        { companyId: 1, supplierGstin: 1, normalizedInvoiceNum: 1 });
    await database.collection('ap_invoices').createIndex(
        { companyId: 1, docNo: 1, fiscalYear: 1 }, { unique: true });
    await database.collection('ap_invoices').createIndex(
        { companyId: 1, vendorGstin: 1, normalizedInvoiceNum: 1 });
    await database.collection('ap_invoices').createIndex(
        { companyId: 1, reconciled: 1, taxDate: 1 });
    // Support EACH branch of the candidate pre-filter's $or (matcher keys) so a large 2B
    // upload doesn't collection-scan. vendorGstin is covered by the compound above; these
    // add the other three. normalizedInvoiceNum needs its OWN index (it can't use the
    // compound's third key without vendorGstin) — and it's the busiest branch, since
    // GSTIN-less BKPF bills match by invoice-no (T4).
    await database.collection('ap_invoices').createIndex({ companyId: 1, normalizedInvoiceNum: 1 });
    await database.collection('ap_invoices').createIndex({ companyId: 1, rbkpGstin: 1 });
    await database.collection('ap_invoices').createIndex({ companyId: 1, boe: 1 });
    // Primary bound for the candidate query: the reconcile ± pad month docDate window.
    // Keeps the scan proportional to the window, not the whole (growing) collection.
    await database.collection('ap_invoices').createIndex({ companyId: 1, docDate: 1 });
    await database.collection('users').createIndex({ username: 1 }, { unique: true });
    await database.collection('recon_log').createIndex({ ts: -1 });
}

async function disconnect() {
    if (client) await client.close();
    client = null; db = null;
}

module.exports = { connect, getDb, collections, disconnect };
