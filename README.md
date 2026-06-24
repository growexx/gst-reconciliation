# GST Reconciliation (Standalone)

A standalone slice of the **GST 2A/2B reconciliation + unmatched bills** feature,
extracted from the Enterprise Portal. Rebuilt on **MongoDB** with **JWT-only**
authentication (no SAP HANA, no SAP Service Layer, no USB-token signing).

The AP-invoice (SAP **RBKP**) data is **ingested from the client side** — you
upload it into the app, and it is matched against the GSTR-2A/2B file.

---

## What's inside

```
server/                         Node.js + Express API (MongoDB)
  config/db.js                  Mongo connection + collections + indexes
  middleware/auth.js            JWT verification
  routes/auth.js                JWT login (no SAP) + company list
  routes/reconcile.js           reconcile routes (2A/2B upload, bills, sections)
  modules/reconcile/
    matcher.js                  tiered matching logic (GSTIN/invoice-no/tax tiers)
    reconcileService.js         import 2A/2B, match, mark reconciled, list unmatched
    reconcileController.js
    progressStore.js            in-memory upload progress
    logUtils.js                 audit log -> recon_log collection
  scripts/seedUser.js           create a login user
  scripts/loadSapData.js        BKPF-driven ETL -> ap_invoices (run: npm run load:sap)

client/                         React + Vite (Tailwind)
  src/components/
    FileUpload.jsx              upload + reconcile a 2A/2B file
    UnmatchedBills.jsx          grouped unmatched bills + manual reconcile
    ExcelPreview.jsx            preview the uploaded sheet
    common/Pagination.jsx
  src/pages/{Login,Dashboard}.jsx
  src/context/AuthContext.jsx   JWT session (localStorage)
  src/api/axios.js
```

## MongoDB collections

| Collection | Replaces (SAP B1) | Holds |
|---|---|---|
| `gst_recon_periods` | `@GSTRECONH` | one doc per uploaded month/year |
| `gst_recon_lines`   | `@GSTRECOND` | one doc per uploaded 2A/2B invoice |
| `ap_invoices`       | `OPCH` + `PCH4` | AP invoices (RBKP) from the client |
| `recon_log`         | `reconciliation.txt` | audit trail |
| `users`             | `OUSR` (app-side) | login users |

## Prerequisites

- **Node.js 22.x**
- **MongoDB** running locally (`mongodb://127.0.0.1:27017`) or MongoDB Atlas

## Setup

```bash
# 1. install
npm install
cd client && npm install && cd ..

# 2. configure
cp .env.example .env          # then edit JWT_SECRET, MONGODB_URI, COMPANIES

# 3. (optional) create a real login user
npm run seed:user myuser mypassword "Nandan Terry"
# if you skip this, the .env BOOTSTRAP_USER / BOOTSTRAP_PASS works once

# 4. run (API + client together)
npm run dev
```

- API: `http://localhost:5000`
- Client (Vite dev): `http://localhost:5173` (proxies `/api` to the API)

## Using it

1. Sign in.
2. **AP Invoice Data** tab → upload the AP/RBKP extract (Excel).
3. **Reconcile (2A/2B)** tab → pick month/year, upload the GSTR-2A/2B Excel, click **Reconcile**.
   Matched invoices are auto-reconciled; unmatched bills show below.
4. **Unmatched Bills** tab → review all unreconciled bills; reconcile manually.

### Expected columns

**GSTR-2A/2B file** (header names are matched flexibly):
`GSTIN of supplier`, `Invoice number`, `Invoice Date`, `Central Tax`, `State/UT Tax`, `Integrated Tax`.

**AP invoice file** (RBKP-derived):
`DocNo`, `FiscalYear`, `VendorCode`, `VendorName`, `VendorGSTIN`, `VendorRef`, `DocDate`, `TaxDate`, `GrossAmount`, `CGST`, `SGST`, `IGST`, `Cancelled`.

## Matching rules (ported from the original)

- invoice number standardized (uppercase, strip `/ - space`, drop leading zeros)
- vendor matched by GSTIN
- invoice date within ± 10 days
- amounts match when CGST & SGST are each within ± ₹5, **or** IGST within ± ₹5

## Build for production

```bash
npm run build        # builds client into client/dist
npm start            # serves API + the built client on PORT
```

## Notes for deployment (AWS / Azure)

- Stateless backend container (Node 22). Scale behind a load balancer.
- If you run **more than one replica**, move `progressStore` to Redis (the only
  in-memory state).
- Store uploads/exports in object storage (S3 / Azure Blob) if you add file
  persistence later.
- Provide `JWT_SECRET`, `MONGODB_URI`, `COMPANIES` via your secrets manager.
