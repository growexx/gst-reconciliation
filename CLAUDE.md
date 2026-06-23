# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone GST **2A/2B reconciliation** tool: it matches a company's booked AP
(vendor) invoices against the GSTR-2A/2B portal file the government provides, so
the unmatched bills on either side can be reviewed. Extracted from an Enterprise
Portal and rebuilt on **MongoDB + JWT** — all SAP HANA / Service Layer / USB-token
machinery was removed. AP-invoice data is ingested separately (ETL script), not
fetched live from SAP.

Stack: Node 22 + Express + MongoDB driver (no Mongoose) on the server; React 18 +
Vite + Tailwind on the client. `xlsx` does all spreadsheet parsing.

## Commands

```bash
npm install && (cd client && npm install)   # install both packages

npm run dev          # API (nodemon, :5000) + Vite client (:5173) together
npm run server:dev   # API only, with reload
npm run client       # Vite client only

npm run seed:user <username> <password> [company]   # create a login user
npm run load:sap     # SAP→Mongo ETL (see "AP-invoice ETL" below); 8 GB heap

npm run build        # client → client/dist (runs `npm ci` in client first)
npm start            # serve API + built client on PORT (prod)
```

There is **no test runner, linter, or formatter** configured. There are no tests.

Requires a local/Atlas MongoDB and a `.env` (copy `.env.example`). Key vars:
`JWT_SECRET`, `MONGODB_URI`, `MONGODB_DB` (default `gst_reco`), `COMPANIES`
(comma list for the login dropdown), `BOOTSTRAP_USER`/`BOOTSTRAP_PASS`,
and ETL paths `SAP_DIR`/`SAP_BKPF_FILE`.

## Architecture

### Two data universes, reconciled against each other

1. **2B portal lines** (`gst_recon_lines`) — uploaded by the user per month/year
   (a "period" in `gst_recon_periods`). Parsed from the GSTR-2B "B2B" sheet.
2. **AP invoices** (`ap_invoices`) — the company's booked vendor invoices, loaded
   offline by `scripts/loadSapData.js`. These are NOT uploaded through the web UI.

Collections are accessed only via the named accessors in
[server/config/db.js](server/config/db.js) (`collections.lines()`, `.apInvoices()`,
etc.) — never hardcode collection-name strings. That file also owns all indexes;
the unique ones (`periods` by company+year+month, `ap_invoices` by
company+docNo+fiscalYear) double as upsert keys, so adding/changing an upsert
filter means checking the matching index.

A row's identity across the app is the composite key **`docNo|fiscalYear`** (the
`DocEntry` the client sends back to reconcile manually). RBKP-sourced invoices use
a `RBKP:<doc>` docNo prefix so they can't collide with BKPF doc numbers.

### The matching engine — read this before touching matching

Matching lives in two layers and the distinction matters:

- [matcher.js](server/modules/reconcile/matcher.js) — the **pure tiered algorithm**.
  Given lines + candidate invoices, assigns each line to at most one invoice (and
  each invoice to one line) by best score, in tier order:
  - **T1** GSTIN + invoice-no + tax(±5) + date(±10) — clean
  - **T2** GSTIN + invoice-no only — matched, but flagged `Match-Review` if
    tax/date drift out of tolerance
  - **T3** GSTIN + tax(±5) + date(±10), no invoice-no
  - **T4** invoice-no + tax(±5), **no GSTIN constraint** — the line's 2B GSTIN is
    then *adopted* onto the invoice (`backfillGstin`)
- [reconcileService.js](server/modules/reconcile/reconcileService.js) `importPortalFile`
  — the **orchestration** that runs the matcher twice:
  - **Stage 1**: candidates restricted to `source==='BKPF'` invoices.
  - **Stage 2**: leftover lines re-matched against RBKP-sourced invoices plus
    BKPF leftovers "promoted" with their reserved `rbkpGstin`. RBKP only ever acts
    as a fallback to supply a vendor/GSTIN that BSEG/ACDOCA didn't.
  - **Sibling propagation** (step 8b): a still-GSTIN-less BKPF doc adopts a
    resolved sibling's vendor when they share a normalized invoice no and that
    invoice no maps to exactly one GSTIN.

**Determinism is a hard requirement.** Re-running the same 2B file must produce
the identical result. Two mechanisms enforce this and must be preserved:
- The matcher's scoring has explicit tie-breaks (lower invoice key wins) and a
  guard so a missing/invalid date can't poison the score to `Infinity`.
- `importPortalFile` step 4 **resets** all auto-backfilled state at the start of
  every upload (`reconciledAuto` invoices un-reconciled; `gstinSource` of `2B` /
  `RBKP-promoted` / `sibling` cleared) so a prior run's adopted GSTINs don't drift
  the next match. Manual reconciliations (`reconciledAuto:false`) are preserved.

Tolerances are constants in matcher.js: `AMOUNT_TOLERANCE = 5` (rupees, on **total**
tax), `DATE_WINDOW_DAYS = 10`. Note the matcher compares *total* tax, not
component-wise CGST/SGST/IGST (the README's "CGST & SGST each within ±5" describes
the older logic — the code uses total-tax tolerance).

`normalizeInvoiceNum` (uppercase, strip `/ - space`, drop leading zeros) is the
canonical invoice-number key everywhere — both the ETL and the importer store it
as `normalizedInvoiceNum`, and matching/classification use it. Change it in one
place only (matcher.js) and re-run the ETL if you do.

### Unmatched/matched views

After matching, three views are derived (all in reconcileService.js), classified
into human-readable reason buckets (`classifyUnmatched`, `classify2bUnmatched`):
- `inSapNotIn2b` — booked invoices (BKPF, this month, carrying GST) with no 2B match
- `in2bNotInSap` — 2B lines still `matchStatus:'NEW'` (NOT date-filtered — every
  stored line belongs to the uploaded return, so matched + unmatched ties out to
  the full 2B line count)
- matched pairs — 2B vs SAP tax side-by-side

### AP-invoice ETL (`scripts/loadSapData.js`)

Standalone script, run manually, that reads raw SAP Excel extracts from disk
(BKPF, BSET, BSEG, ACDOCA, LFA1, RBKP — paths under `SAP_DIR`/`NT Data`, **not in
the repo**) and upserts `ap_invoices`. BKPF is the primary source; only document
types `RE` (MM invoice) and `KR` (FI invoice) are kept — credit memos (`KG`) and
everything else are excluded because they reconcile against the 2B CDNR section,
not B2B. RBKP is loaded as a stage-2 fallback / GSTIN-reserve only. Most BKPF docs
have no SAP vendor line, so they load GSTIN-less and rely on T4 / RBKP / sibling
resolution at match time.

### Request flow

`client/src/api/axios.js` attaches `Authorization: Bearer <jwt>` and an
`X-Company` header to every call (baseURL `/api`, Vite proxies to :5000). The
server resolves the company from `X-Company` → JWT `companyId` → `'COMP1'`
([reconcileController.js](server/modules/reconcile/reconcileController.js) `companyOf`).
All `/api/reconcile/*` routes sit behind `verifyToken`. Auth is JWT-only
([routes/auth.js](server/routes/auth.js)): passwords are scrypt-hashed in the
`users` collection; when that collection is empty, the `.env` bootstrap creds are
accepted once.

Upload progress is tracked per session in an **in-memory** Map
([progressStore.js](server/modules/reconcile/progressStore.js)) — the only
non-DB state. Running more than one backend replica requires moving this to Redis.

In production a single Express process serves both the API and the built client
([server/app.js](server/app.js) static-serves `client/dist` and SPA-falls-through
non-`/api` routes).
