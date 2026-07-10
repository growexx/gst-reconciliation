/**
 * SAP API → MongoDB ETL Script
 * 
 * This script is an optimal replacement for `loadSapData.js`. Instead of loading
 * massive Excel files, it fetches data directly from SAP APIs incrementally.
 * 
 * Optimal Data Handling Strategy:
 * 1. Fetch BKPF for a specified date range.
 * 2. Extract Document Numbers from the BKPF response.
 * 3. Split the Document Numbers into smaller chunks to respect URL length limits.
 * 4. Fetch BSEG, BSET, and RBKP data concurrently for each chunk.
 * 5. Collect Vendor Codes, chunk them, and fetch LFA1 data.
 * 6. Merge, map, and bulk upsert to MongoDB (ap_invoices & vendors).
 *
 * Usage: node server/scripts/syncSapApi.js [--company "Nandan Terry"] [--from YYYYMMDD] [--to YYYYMMDD] [--fresh]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { connect, collections, disconnect } = require('../config/db');
const { normalizeInvoiceNum } = require('../modules/reconcile/matcher');
// We use native fetch, which is available in Node.js 18+

const arg = (name, def) => { const i = process.argv.indexOf(name); return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def; };
const COMPANY = arg('--company', (process.env.COMPANIES || 'Nandan Terry').split(',')[0].trim());
const FRESH = process.argv.includes('--fresh');

// Get dates. Default to today if not provided.
const getTodayStr = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const FROM_DATE = arg('--from', getTodayStr());
const TO_DATE = arg('--to', getTodayStr());

const BASE_URL = process.env.SAP_API_BASE_URL || 'https://vhntxps4ap01.sap.nandanterry.com/zapi_tables';
const SAP_CLIENT = process.env.SAP_API_CLIENT || '500';

const VENDOR_TYPES = new Set(['RE', 'KR', 'KG', 'SA']);
const DOC_CATEGORY = { RE: 'B2B', KR: 'B2B', KG: 'CDNR', SA: 'NONE' };

// Helpers for Tax logic
const CGST = new Set(['JICG', 'JICR', 'JICN']);
const SGST = new Set(['JISG', 'JISR', 'JISN']);
const IGST = new Set(['JIIG', 'JIIR', 'JIIN']);

const num = (v) => Number(v) || 0;

// Chunk array into smaller arrays of size `chunkSize`
const chunkArray = (arr, chunkSize) => {
    const res = [];
    for (let i = 0; i < arr.length; i += chunkSize) res.push(arr.slice(i, i + chunkSize));
    return res;
};

// Generic API fetch wrapper
async function fetchApi(endpoint, params = {}) {
    const url = new URL(`${BASE_URL}/${endpoint}`);
    url.searchParams.append('sap-client', SAP_CLIENT);
    for (const [key, val] of Object.entries(params)) {
        if (Array.isArray(val)) {
            val.forEach(v => url.searchParams.append(key, v));
        } else if (val) {
            url.searchParams.append(key, val);
        }
    }
    
    // console.log(`Fetching: ${url.toString().substring(0, 150)}...`);
    const res = await fetch(url.toString(), {
        headers: { 'Accept': 'application/json' }
    });
    
    if (!res.ok) throw new Error(`API Error [${endpoint}]: ${res.status} ${res.statusText}`);
    return await res.json();
}

/**
 * 1. Build BKPF list
 */
async function fetchBkpf() {
    console.log(`Fetching BKPF from ${FROM_DATE} to ${TO_DATE}...`);
    // Assuming API accepts doc_type array.
    const bkpfData = await fetchApi('bkpf', {
        bkpf_from: FROM_DATE,
        bkpf_to: TO_DATE,
        doc_type: Array.from(VENDOR_TYPES)
    });
    
    const docs = Array.isArray(bkpfData) ? bkpfData : (bkpfData.data || []);
    console.log(`  -> Retrieved ${docs.length} BKPF records.`);
    return docs;
}

/**
 * 2. Fetch Details (BSEG, BSET, RBKP) in chunks to avoid URL limits
 */
async function fetchDetailsInChunks(documentIds) {
    const CHUNK_SIZE = 200; // Optimal safe limit for URL length
    const chunks = chunkArray(documentIds, CHUNK_SIZE);
    
    let allBseg = [], allBset = [], allRbkp = [];
    
    console.log(`Fetching BSEG, BSET, RBKP for ${documentIds.length} docs in ${chunks.length} chunks...`);
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
            const [bseg, bset, rbkp] = await Promise.all([
                fetchApi('bseg', { document: chunk }),
                fetchApi('bset', { document: chunk }),
                fetchApi('rbkp', { document: chunk })
            ]);
            
            allBseg = allBseg.concat(Array.isArray(bseg) ? bseg : (bseg.data || []));
            allBset = allBset.concat(Array.isArray(bset) ? bset : (bset.data || []));
            allRbkp = allRbkp.concat(Array.isArray(rbkp) ? rbkp : (rbkp.data || []));
            
        } catch (err) {
            console.error(`  Error in chunk ${i + 1}:`, err.message);
        }
    }
    
    console.log(`  -> BSEG records: ${allBseg.length}`);
    console.log(`  -> BSET records: ${allBset.length}`);
    console.log(`  -> RBKP records: ${allRbkp.length}`);
    
    return { allBseg, allBset, allRbkp };
}

/**
 * 3. Fetch LFA1 for extracted vendors
 */
async function fetchLfa1InChunks(vendorCodes) {
    if (!vendorCodes.length) return [];
    
    const uniqueVendors = [...new Set(vendorCodes)];
    const CHUNK_SIZE = 200;
    const chunks = chunkArray(uniqueVendors, CHUNK_SIZE);
    
    let allLfa1 = [];
    console.log(`Fetching LFA1 for ${uniqueVendors.length} unique vendors in ${chunks.length} chunks...`);
    
    for (let i = 0; i < chunks.length; i++) {
        try {
            const lfa1 = await fetchApi('lfa1', { vendor: chunks[i] });
            allLfa1 = allLfa1.concat(Array.isArray(lfa1) ? lfa1 : (lfa1.data || []));
        } catch (err) {
            console.error(`  Error fetching LFA1 chunk ${i + 1}:`, err.message);
        }
    }
    console.log(`  -> LFA1 records: ${allLfa1.length}`);
    return allLfa1;
}

// Map Dates robustly (JSON APIs usually return YYYY-MM-DD or YYYYMMDD)
const parseDate = (d) => {
    if (!d) return null;
    const str = String(d).replace(/-/g, '');
    if (str.length === 8) {
        return new Date(Date.UTC(+str.substring(0,4), +str.substring(4,6) - 1, +str.substring(6,8)));
    }
    return new Date(d);
};

// ----------------------------------------------------------------------
// MAPPERS (These keys depend on the exact JSON schema returned by ZAPIs)
// Note: We use lowercase fallbacks in case the API returns lowercase keys.
// ----------------------------------------------------------------------

function buildBsetSplit(bsetRows) {
    const map = new Map();
    for (const r of bsetRows) {
        // Map fields (adjust keys based on actual API payload)
        const docNo = r.DocumentNo || r.documentno || r.BELNR;
        const year = r.Year || r.year || r.GJAHR;
        const cnTy = r.CnTy || r.cnty || r.KSCHL;
        const amount = r.Amount || r.amount || r.WRBTR;
        const trs = r.Trs || r.trs || r.KTOSL;
        
        if (!docNo) continue;
        if (trs && !String(trs).toUpperCase().startsWith('JI')) continue; // forward GST only
        
        let comp;
        if (CGST.has(cnTy)) comp = 'cgst';
        else if (SGST.has(cnTy)) comp = 'sgst';
        else if (IGST.has(cnTy)) comp = 'igst';
        else continue;
        
        const key = `${docNo}|${year}`;
        const o = map.get(key) || { cgst: 0, sgst: 0, igst: 0 };
        o[comp] += num(amount);
        map.set(key, o);
    }
    return map;
}

function buildVendorByDoc(bsegRows) {
    const map = new Map();
    for (const r of bsegRows) {
        const docNo = r.DocumentNo || r.documentno || r.BELNR;
        const year = r.Year || r.year || r.GJAHR;
        const supplier = r.Supplier || r.supplier || r.LIFNR;
        const amount = r.AmountLC || r.amountlc || r.Amount || r.amount || r.WRBTR || r.DMBTR;
        
        if (!supplier || String(supplier).trim() === '') continue;
        const key = `${docNo}|${year}`;
        if (map.has(key)) continue;
        map.set(key, { code: String(supplier), amount: Math.abs(num(amount)) });
    }
    return map;
}

function buildVendorMaster(lfa1Rows) {
    const map = new Map();
    for (const r of lfa1Rows) {
        const supplier = r.Supplier || r.supplier || r.vendor || r.LIFNR;
        const gstin = r['Tax Number 3'] || r.tax_number_3 || r.gstin || r.STCD3;
        const name = r['Name 1'] || r.name_1 || r.name || r.NAME1;
        const pan = r.PAN || r.pan || r.J_1IPANNO;
        
        if (!supplier) continue;
        map.set(String(supplier), { 
            gstin: gstin ? String(gstin).toUpperCase().trim() : '', 
            name: name || '', 
            pan: pan || '' 
        });
    }
    return map;
}

function buildRbkpIndex(rbkpRows, vendorMaster) {
    const idx = new Map();
    for (const r of rbkpRows) {
        const type = r.type || r.Type || r.BLART;
        const ref = r.ref || r.Reference || r.XBLNR;
        const rvrsd = r.rvrsd || r.Reversed || r.STBLG;
        const pty = r.pty || r.InvParty || r.LIFNR;
        const vat = r.vat || r.VAT || r.WMWST1;
        const taxerr = r.taxerr || r.TaxError;
        
        if (type !== 'RE') continue;
        if (rvrsd != null && rvrsd !== '') continue;
        
        const nref = normalizeInvoiceNum(ref); 
        if (!nref) continue;
        
        const code = String(pty); 
        const vm = vendorMaster.get(code) || { gstin: '', name: '' };
        if (!vm.gstin) continue;
        
        const tax = +(num(vat) + num(taxerr)).toFixed(2);
        (idx.get(nref) || idx.set(nref, []).get(nref)).push({ code, gstin: vm.gstin, name: vm.name, tax });
    }
    return idx;
}

async function upsertData(invoices, vendors) {
    let doneInv = 0, doneVen = 0;
    
    // Invoices
    const invOps = invoices.filter((i) => i.docNo).map((i) => ({
        updateOne: {
            filter: { companyId: i.companyId, docNo: i.docNo, fiscalYear: i.fiscalYear },
            update: { $set: i, $setOnInsert: { reconciled: false, createdAt: new Date() } },
            upsert: true,
        },
    }));
    for (let k = 0; k < invOps.length; k += 1000) {
        const res = await collections.apInvoices().bulkWrite(invOps.slice(k, k + 1000), { ordered: false });
        doneInv += (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
    }

    // Vendors
    const venOps = [];
    for (const [code, v] of vendors.entries()) {
        if (!v.gstin) continue;
        venOps.push({ 
            updateOne: { 
                filter: { companyId: COMPANY, vendorCode: code }, 
                update: { $set: { companyId: COMPANY, vendorCode: code, vendorGstin: v.gstin, vendorName: v.name, pan: v.pan, updatedAt: new Date() } }, 
                upsert: true 
            } 
        });
    }
    if (venOps.length) {
        for (let k = 0; k < venOps.length; k += 1000) {
            const res = await collections.vendors().bulkWrite(venOps.slice(k, k + 1000), { ordered: false });
            doneVen += (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
        }
    }
    return { doneInv, doneVen };
}

(async () => {
    console.log(`API ETL Sync | Company: ${COMPANY} | From: ${FROM_DATE} | To: ${TO_DATE} | Fresh: ${FRESH}`);
    
    try {
        await connect();
        if (FRESH) { 
            const r = await collections.apInvoices().deleteMany({ companyId: COMPANY }); 
            console.log(`  Cleared ${r.deletedCount} existing ap_invoices`); 
        }

        // 1. Fetch BKPF headers
        const bkpfRows = await fetchBkpf();
        if (!bkpfRows.length) {
            console.log('No BKPF documents found for this period.');
            process.exit(0);
        }
        
        // 2. Extract Document IDs
        const documentIds = [...new Set(bkpfRows.map(r => String(r.DocumentNo || r.documentno || r.document || r.BELNR)).filter(Boolean))];
        
        // 3. Fetch details incrementally
        const { allBseg, allBset, allRbkp } = await fetchDetailsInChunks(documentIds);
        
        // 4. Extract Vendor Codes and fetch LFA1
        const bsegVendors = allBseg.map(r => r.Supplier || r.supplier || r.LIFNR).filter(Boolean);
        const rbkpVendors = allRbkp.map(r => r.pty || r.InvParty || r.LIFNR).filter(Boolean);
        const vendorCodes = [...bsegVendors, ...rbkpVendors];
        const allLfa1 = await fetchLfa1InChunks(vendorCodes);
        
        // 5. Build in-memory maps
        console.log('Mapping data...');
        const vendorMaster = buildVendorMaster(allLfa1);
        const bsetSplit = buildBsetSplit(allBset);
        const vendorByDoc = buildVendorByDoc(allBseg);
        const rbkpByRef = buildRbkpIndex(allRbkp, vendorMaster);
        
        // 6. Build BKPF Invoices
        const out = [];
        const stat = { total: 0, withGstin: 0 };
        
        for (const r of bkpfRows) {
            const type = r.Type || r.type || r.BLART;
            if (!VENDOR_TYPES.has(type)) continue;
            
            const rev = r.Reversal || r.reversal || r.STBLG;
            if (rev != null && String(rev).trim() !== '') continue;
            
            const ref = r.Reference || r.reference || r.XBLNR || '';
            const nref = normalizeInvoiceNum(ref);
            if (!nref) continue;
            
            const doc = String(r.DocumentNo || r.documentno || r.BELNR);
            const year = String(r.Year || r.year || r.GJAHR);
            const key = `${doc}|${year}`;
            
            const split = bsetSplit.get(key) || { cgst: 0, sgst: 0, igst: 0 };
            const tax = +(split.cgst + split.sgst + split.igst).toFixed(2);
            const docDate = parseDate(r['Doc. Date'] || r.doc_date || r.bldat || r.BLDAT);
            
            const v = vendorByDoc.get(key);
            const code = v ? v.code : '';
            const vm = code ? (vendorMaster.get(code) || { gstin: '', name: '' }) : { gstin: '', name: '' };
            
            let rbkpVendorCode = '', rbkpGstin = '', rbkpVendorName = '';
            const cands = rbkpByRef.get(nref);
            if (cands && cands.length) {
                const within = cands.filter((c) => Math.abs(c.tax - tax) <= 5);
                const pick = within.reduce((a, b) => (a && Math.abs(a.tax - tax) <= Math.abs(b.tax - tax)) ? a : b, null);
                if (pick) { rbkpVendorCode = pick.code; rbkpGstin = pick.gstin; rbkpVendorName = pick.name; }
            }
            
            stat.total++;
            if (vm.gstin) stat.withGstin++;
            
            out.push({
                companyId: COMPANY, source: 'BKPF', docType: type, docCategory: DOC_CATEGORY[type] || 'B2B',
                docNo: doc, fiscalYear: year,
                vendorCode: code, vendorName: vm.name || '', vendorGstin: vm.gstin || '', gstinSource: vm.gstin ? 'SAP' : null,
                rbkpVendorCode, rbkpGstin, rbkpVendorName,
                vendorRef: ref, normalizedInvoiceNum: nref,
                docDate, taxDate: docDate,
                grossAmount: v ? +v.amount.toFixed(2) : 0,
                tax, cgst: +split.cgst.toFixed(2), sgst: +split.sgst.toFixed(2), igst: +split.igst.toFixed(2),
                cancelled: false,
            });
        }
        
        console.log(`  BKPF mapped: ${stat.total} | With GSTIN: ${stat.withGstin}`);
        
        // 7. Upsert
        console.log(`Upserting to MongoDB...`);
        const { doneInv, doneVen } = await upsertData(out, vendorMaster);
        console.log(`✅ Success! Upserted ${doneInv} invoices and ${doneVen} vendors.`);
        
        // 8. Re-apply manual reconciliations
        const reconcileService = require('../modules/reconcile/reconcileService');
        const { applied } = await reconcileService.applyManualReconciliations(COMPANY);
        console.log(`  Re-applied ${applied} manual reconciliation(s) from recon_log.`);

    } catch (err) {
        console.error('ETL Sync Failed:', err);
    } finally {
        await disconnect();
        process.exit(0);
    }
})();
