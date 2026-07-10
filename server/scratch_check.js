require('dotenv').config();
const { connect, collections, disconnect } = require('./config/db');
(async () => {
  await connect();
  const db = collections.apInvoices();
  const docs = await db.find({
    companyId: 'Nandan Terry',
    source: 'BKPF',
    docCategory: 'B2B',
    reconciled: { $ne: true },
    pairCategory: { $in: [null] },
    docDate: { $gte: new Date('2026-04-01T00:00:00Z'), $lt: new Date('2026-05-01T00:00:00Z') }
  }).toArray();
  const hasGst = (i) => (Number(i.tax) || 0) + (Number(i.cgst) || 0) + (Number(i.sgst) || 0) + (Number(i.igst) || 0) > 0;
  const filtered = docs.filter(hasGst);
  const withoutGstin = filtered.filter(i => !i.vendorGstin).length;
  console.log('Total:', filtered.length, 'Without GSTIN:', withoutGstin);
  await disconnect();
})();
