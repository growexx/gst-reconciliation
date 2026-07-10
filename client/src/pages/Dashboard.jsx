import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { FiX, FiLogOut, FiSearch } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

import FileUpload from '../components/FileUpload';
import UnmatchedBills from '../components/UnmatchedBills';
import ExcelPreview from '../components/ExcelPreview';
import Pagination from '../components/common/Pagination';
import { monthsForYear, yearOptions } from '../lib/fy';

const endpoints = {
  reconcile: '/api/reconcile/upload',
  fetchSapBills: '/api/reconcile/fetch-sap-bills',
};

const TABS = [
  { key: 'reconcile', label: 'Reconcile (2A/2B)' },
  { key: 'unmatched', label: 'Unmatched Bills' },
  { key: 'matched', label: 'Matched Bills' },
];

// Valid sub-section keys per tab — used to validate/restore the ?section= query param.
const UNMATCHED_KEYS = ['sap', '2b', 'gstdiff', 'valuediff', 'vendordiff', 'nobill', 'debit', 'impgsap', 'impg2b'];
const MATCHED_KEYS = ['matched', 'datediff', 'manual', 'impgmatched'];
const IMPG_KEYS = ['impgsap', 'impg2b', 'impgmatched'];

// Default rows/page per top-level tab (user can still change it via the Pagination control).
const defaultPageSize = (t) => (t === 'matched' ? 15 : 10);

// Download an array of plain row objects as an .xlsx file (uses the bundled xlsx lib).
const fmtXlsDate = (x) => (x ? new Date(x).toLocaleDateString('en-GB') : '');
function downloadXlsx(rows, filename) {
  if (!rows || !rows.length) { alert('Nothing to export in this view.'); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');
  XLSX.writeFile(wb, filename);
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Restore view state from the URL query string (so refresh / shared links keep the
  // same tab, sub-section and month). Path stays /reconcile — deployment-safe.
  const qsTab = ['reconcile', 'unmatched', 'matched'].includes(searchParams.get('tab')) ? searchParams.get('tab') : 'reconcile';
  const qsSection = (() => {
    const s = searchParams.get('section');
    const valid = qsTab === 'matched' ? MATCHED_KEYS : UNMATCHED_KEYS;
    return s && valid.includes(s) ? s : (qsTab === 'matched' ? 'matched' : 'sap');
  })();

  const [tab, setTab] = useState(qsTab);

  // FileUpload state
  const [previewData, setPreviewData] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [isUploaded, setIsUploaded] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [fileName, setFileName] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [unmatchedBills, setUnmatchedBills] = useState([]);

  // Paginated bills view: counts drive the badges; only the open category's current
  // page of rows is loaded at a time.
  const [counts, setCounts] = useState({});
  const [sectionData, setSectionData] = useState({ rows: [], total: 0, page: 1, pageSize: defaultPageSize(qsTab), groupBy: 'row' });
  const [pageSize, setPageSize] = useState(defaultPageSize(qsTab));
  const [search, setSearch] = useState('');
  const searchInit = useRef(true);   // skip the debounce effect's first (mount) run
  // sap | 2b | gstdiff | valuediff | vendordiff | nobill | debit | matched | datediff | manual
  const [unmatchedSection, setUnmatchedSection] = useState(qsSection);
  const [filterMonth, setFilterMonth] = useState(searchParams.get('month') || 'All');
  const [filterYear, setFilterYear] = useState(searchParams.get('year') || localStorage.getItem('selectedYear') || '2026');
  const [loadingCounts, setLoadingCounts] = useState(false);
  const [loadingSection, setLoadingSection] = useState(false);

  const handleFileUpload = (file, month) => {
    setUploadedFile(file);
    setFileName(file.name);
    setIsUploaded(true);
    setShowPreview(false);
    localStorage.setItem('selectedMonth', month);
  };

  const handleViewFile = () => {
    if (!uploadedFile) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      setPreviewData(XLSX.utils.sheet_to_json(sheet));
      setShowPreview(true);
    };
    reader.readAsArrayBuffer(uploadedFile);
  };

  const authHeaders = () => ({
    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
    'X-Database': localStorage.getItem('database'),
  });

  // Just the per-category counts (for the tab badges) — small, no rows.
  const loadCounts = async (month = filterMonth, year = filterYear) => {
    setLoadingCounts(true);
    try {
      const r = await fetch(`/api/reconcile/bill-counts?month=${encodeURIComponent(month)}&year=${encodeURIComponent(year)}`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load counts');
      setCounts(d.counts || {});
    } catch (e) { alert(`Error: ${e.message}`); } finally { setLoadingCounts(false); }
  };

  // One page of one category — only loaded when that category is open. Search (q)
  // and page size are sent to the server so they apply across the whole bucket.
  const loadSection = async (key, page = 1, month = filterMonth, year = filterYear, q = search, size = pageSize) => {
    setUnmatchedSection(key);
    setLoadingSection(true);
    try {
      const qs = `key=${key}&month=${encodeURIComponent(month)}&year=${encodeURIComponent(year)}&page=${page}&pageSize=${size}&q=${encodeURIComponent(q)}`;
      const r = await fetch(`/api/reconcile/bill-page?${qs}`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load page');
      setSectionData({ rows: d.rows || [], total: d.total || 0, page: d.page || page, pageSize: d.pageSize || size, groupBy: d.groupBy || 'row' });
    } catch (e) { alert(`Error: ${e.message}`); } finally { setLoadingSection(false); }
  };

  // Rows-per-page change from the Pagination control — reset to page 1 at the new size.
  const changePageSize = (size) => {
    setPageSize(size);
    loadSection(unmatchedSection, 1, filterMonth, filterYear, search, size);
  };

  // Re-fetch when the month/year filter changes (only while viewing the tab).
  const changeFilter = (month, year) => {
    setFilterMonth(month);
    setFilterYear(year);
    loadCounts(month, year);
    loadSection(unmatchedSection, 1, month, year);
  };

  // Manually reconcile a near-miss row (GST-Diff / Value-Diff). The bill no. already
  // matched, so the 2B GSTIN/bill are known — reconcile the SAP bill against them.
  const reconcileRow = async (row) => {
    if (!row.DocEntry) { alert('Cannot reconcile: missing SAP document reference.'); return; }
    if (!window.confirm(`Reconcile SAP bill ${row.SapBillNo || row.DocEntry} against the 2B line, despite the difference?`)) return;
    try {
      const res = await fetch('/api/reconcile/update-status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
          'X-Database': localStorage.getItem('database'),
        },
        body: JSON.stringify({
          docEntry: row.DocEntry,
          vendorCode: row.CardCode,
          vendorName: row.CardName,
          vendorGST: row.SapGST,
          billNumber: row.SapBillNo,
          billDate: row.SapDate,
          totalAmount: row.DocTotal,
          CGST: row.SAP_CGST, SGST: row.SAP_SGST, IGST: row.SAP_IGST,
          username: localStorage.getItem('username') || 'Unknown User',
          excelGST: row.VendorGST,        // the 2B GSTIN it paired with
          excelBill: row.VendorBillNo,    // the 2B bill no it paired with
        }),
      });
      if (!res.ok) throw new Error('Failed to reconcile');
      loadCounts();
      loadSection(unmatchedSection, sectionData.page);
    } catch (e) { alert(`Error: ${e.message}`); }
  };

  const onTab = (key) => {
    setTab(key);
    const size = defaultPageSize(key);
    setPageSize(size);
    if (key === 'unmatched') { loadCounts(); loadSection('sap', 1, filterMonth, filterYear, search, size); }
    else if (key === 'matched') { loadCounts(); loadSection('matched', 1, filterMonth, filterYear, search, size); }
  };

  // Mirror the current view into the URL query string (replace, so it doesn't spam
  // history). Shared links and refresh restore the same tab / section / month / year.
  useEffect(() => {
    const next = { tab };
    if (tab === 'unmatched' || tab === 'matched') {
      next.section = unmatchedSection;
      next.month = filterMonth;
      next.year = filterYear;
    }
    setSearchParams(next, { replace: true });
  }, [tab, unmatchedSection, filterMonth, filterYear]);

  // On first load (e.g. a refresh on ?tab=unmatched), fetch the bills for that tab so
  // we stay put instead of falling back to an empty Reconcile view.
  useEffect(() => {
    const onBills = qsTab === 'unmatched' || qsTab === 'matched';
    const size = defaultPageSize(qsTab);
    // If the URL pins a period (shared link / refresh), honour it. Otherwise seed the
    // view to the latest reconciled month/year (most recent period with data) — done on
    // any tab so that arriving at Unmatched/Matched later already shows that period.
    const pinned = searchParams.get('month') && searchParams.get('year');
    if (pinned) {
      if (onBills) { loadCounts(filterMonth, filterYear); loadSection(qsSection, 1, filterMonth, filterYear, search, size); }
      return;
    }
    (async () => {
      let m = filterMonth, y = filterYear;
      try {
        const r = await fetch('/api/reconcile/periods', { headers: authHeaders() });
        const d = await r.json();
        if (r.ok && d.latest) { m = d.latest.month; y = String(d.latest.year); setFilterMonth(m); setFilterYear(y); }
      } catch { /* no periods yet → keep defaults */ }
      if (onBills) { loadCounts(m, y); loadSection(qsSection, 1, m, y, search, size); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced server-side search: re-fetch the open category (page 1) as the user types.
  // The category badges keep showing the full, unfiltered totals.
  useEffect(() => {
    if (searchInit.current) { searchInit.current = false; return; }
    if (tab !== 'unmatched' && tab !== 'matched') return;
    const t = setTimeout(() => loadSection(unmatchedSection, 1), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Sub-section tabs, with live counts, grouped by the top-level tab they belong to.
  const UNMATCHED_SECTIONS = [
    { key: 'sap', label: 'In SAP, not in 2B', count: counts.inSapNotIn2b || 0 },
    { key: '2b', label: 'In 2B, not in SAP', count: counts.in2bNotInSap || 0 },
    { key: 'gstdiff', label: 'Not Matched — GST diff', count: counts.gstDiff || 0 },
    { key: 'valuediff', label: 'Not Matched — Value diff', count: counts.valueDiff || 0 },
    { key: 'vendordiff', label: 'Not Matched — Diff Vendor Name', count: counts.vendorDiff || 0 },
    { key: 'nobill', label: 'Not Matched — Diff Bill No', count: counts.noBillNo || 0 },
    { key: 'debit', label: 'Not Matched — Debit Note', count: counts.debitNotes || 0 },
    { key: 'impgsap', label: 'IMPG — in SAP, not in 2B', count: counts.impgSap || 0 },
    { key: 'impg2b', label: 'IMPG — in 2B, not in SAP', count: counts.impg2b || 0 },
  ];
  const MATCHED_SECTIONS = [
    { key: 'matched', label: 'Matched', count: counts.matched || 0 },
    { key: 'datediff', label: 'Matched — Date diff', count: counts.dateDiff || 0 },
    { key: 'manual', label: 'Manually matched', count: counts.manual || 0 },
    { key: 'impgmatched', label: 'IMPG — Matched', count: counts.impgMatched || 0 },
  ];
  const SECTION_TABS = tab === 'matched' ? MATCHED_SECTIONS : UNMATCHED_SECTIONS;

  // If the active sub-section has no bills (its tab is hidden), jump to the first
  // visible one and load it, so we never sit on an empty, hidden category.
  useEffect(() => {
    const visible = SECTION_TABS.filter((t) => t.count > 0);
    if (visible.length && !visible.some((t) => t.key === unmatchedSection)) {
      loadSection(visible[0].key, 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts, tab]);

  // Calendar month / year options (shared logic in lib/fy): no future years/months, the
  // current year caps at this month, 5 past years; the selected year is always kept.
  const monthOptionsFor = monthsForYear;
  const monthOptions = monthsForYear(filterYear);
  const YEAR_OPTIONS = yearOptions(5, filterYear);
  // The matched / near-miss buckets render as a joined row table (current page only).
  const JOINED_KEYS = ['matched', 'datediff', 'gstdiff', 'valuediff', 'vendordiff', 'nobill'];
  const joinedRows = JOINED_KEYS.includes(unmatchedSection) ? sectionData.rows : null;
  const impgRows = IMPG_KEYS.includes(unmatchedSection) ? sectionData.rows : null;
  // The not-matched near-miss buckets allow a manual reconcile straight from the table.
  const joinedReconcilable = ['gstdiff', 'valuediff', 'vendordiff', 'nobill'].includes(unmatchedSection);
  const totalPages = Math.max(1, Math.ceil((sectionData.total || 0) / (sectionData.pageSize || defaultPageSize(tab))));
  // Pagination control under each list/table. totalItems is vendors (for the grouped
  // SAP/2B lists) or rows (matched / near-miss / manual tables).
  const renderPager = () => sectionData.total > 0 ? (
    <Pagination
      currentPage={sectionData.page}
      totalPages={totalPages}
      onPageChange={(p) => loadSection(unmatchedSection, p)}
      totalItems={sectionData.total}
      pageSize={sectionData.pageSize}
      onPageSizeChange={changePageSize}
      className="mt-6 px-2"
    />
  ) : null;
  const SECTION_DESC = {
    sap: 'Bills booked in SAP whose ITC is not confirmed in the 2B — hold / review before payment.',
    '2b': 'Invoices the supplier reported in the 2B that are not booked in SAP — verify / book.',
    gstdiff: 'Bill no. + tax value + date match a SAP bill, but the GSTIN differs — NOT a valid match.',
    valuediff: 'Same GSTIN + bill no. as a SAP bill, but the GST value differs beyond ±₹5 — review / reconcile manually.',
    vendordiff: 'Bill no. + tax match, GSTIN was taken from the 2B, but SAP’s own vendor for this bill is a different supplier — likely a wrong match. Review before reconciling.',
    nobill: 'GSTIN, value and date match a 2B line, but the bill number is different — reconcile manually.',
    debit: 'SAP debit/credit notes (KG) not found in the 2B B2B-CDNR section.',
    matched: 'Reconciled bills — GSTIN, bill no., value and date all agree (within ±₹5 / ±10 days).',
    datediff: 'Reconciled bills — GSTIN, bill no. and value agree, but the invoice date differs.',
    manual: 'Bills reconciled manually by a user (with the 2B GSTIN / bill they entered).',
    impgsap: 'Import IGST (Bill-of-Entry) booked in SAP customs docs, not yet found in the 2B IMPG section.',
    impg2b: 'Imports in the 2B IMPG section (Bill-of-Entry) not booked in SAP.',
    impgmatched: 'Reconciled imports — Bill-of-Entry number and IGST value agree between SAP and the 2B.',
  };

  // Export the ENTIRE current section (not just the visible page) to an .xlsx.
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Re-fetch SAP + re-reconcile the currently-viewed period against CURRENT SAP data
  // (no re-upload) — picks up bills booked since the last run, drops reversed ones.
  const refreshFromSap = async () => {
    if (filterMonth === 'All') { alert('Pick a specific month to refresh.'); return; }
    if (!window.confirm(`Re-fetch SAP and re-reconcile ${filterMonth} ${filterYear} against current SAP data? This may take up to a minute.`)) return;
    setRefreshing(true);
    try {
      const start = await fetch(`/api/reconcile/refresh?month=${encodeURIComponent(filterMonth)}&year=${encodeURIComponent(filterYear)}`, { method: 'POST', headers: authHeaders() });
      if (!start.ok) { const d = await start.json().catch(() => ({})); throw new Error(d.error || 'Failed to start refresh'); }
      const done = await new Promise((resolve, reject) => {
        const poll = async () => {
          try {
            const r = await fetch('/api/reconcile/progress', { headers: authHeaders() });
            if (r.ok) { const p = await r.json(); if (p && p.done) { if (p.error) return reject(new Error(p.error)); return resolve(p); } }
          } catch { /* transient — keep polling */ }
          setTimeout(poll, 2000);
        };
        poll();
      });
      await loadCounts(filterMonth, filterYear);
      await loadSection(unmatchedSection, 1, filterMonth, filterYear);
      const warn = done.result && done.result.warning;
      alert(warn ? `Refreshed — but ⚠ ${warn}` : 'Refreshed against current SAP data.');
    } catch (e) { alert(`Refresh error: ${e.message}`); } finally { setRefreshing(false); }
  };
  const exportCurrent = async () => {
    const fname = `gst-${tab}-${unmatchedSection}-${filterMonth}-${filterYear}.xlsx`;
    setExporting(true);
    try {
      // pull every row for this category (big page size) so the file is complete;
      // honour the active search so the export matches what's on screen
      const qs = `key=${unmatchedSection}&month=${encodeURIComponent(filterMonth)}&year=${encodeURIComponent(filterYear)}&page=1&pageSize=100000&q=${encodeURIComponent(search)}`;
      const r = await fetch(`/api/reconcile/bill-page?${qs}`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Export failed');
      const rows = d.rows || [];
      if (JOINED_KEYS.includes(unmatchedSection)) {
        downloadXlsx(rows.map((x) => ({
          '2B GSTIN': x.VendorGST, 'SAP GSTIN': x.SapGST,
          '2B Vendor': x.Vendor2BName, 'SAP Vendor': x.SapVendorName,
          '2B Bill No': x.VendorBillNo, 'SAP Bill No': x.SapBillNo,
          '2B Tax': x.ExcelTax, 'SAP Tax': x.SAP_Tax, 'Tax Diff': x.TaxDelta,
          '2B Date': fmtXlsDate(x.InvoiceDate), 'SAP Date': fmtXlsDate(x.SapDate), 'Days Diff': x.DateDeltaDays,
        })), fname);
      } else if (unmatchedSection === 'manual') {
        downloadXlsx(rows.map((x) => ({
          'Vendor GST': x.VendorGST, 'Vendor Bill No': x.VendorBillNo,
          'SAP SGST': x.SAP_SGST, 'SAP CGST': x.SAP_CGST, 'SAP IGST': x.SAP_IGST,
          '2B GST (entered)': x.ExcelGST, '2B Bill (entered)': x.ExcelBill,
          'Invoice Date': fmtXlsDate(x.InvoiceDate), 'Reconciled On': fmtXlsDate(x.ReconciledAt),
        })), fname);
      } else if (IMPG_KEYS.includes(unmatchedSection)) {
        downloadXlsx(rows.map((x) => ({
          'Bill of Entry': x.Boe, 'Port': x.PortCode,
          '2B IGST': x.Igst, 'SAP IGST': x.SapIgst, 'IGST Diff': x.TaxDelta,
          '2B BoE Date': fmtXlsDate(x.InvoiceDate), 'SAP Date': fmtXlsDate(x.SapDate), 'SAP Doc': x.SapDocNo,
        })), fname);
      } else {
        downloadXlsx(rows.map((x) => ({
          'Vendor Code': x.CardCode, 'Vendor Name': x.CardName,
          'GSTIN': x.GSTRegnNo || x.VendorGST, 'Bill No': x.NumAtCard,
          'Date': fmtXlsDate(x.DocDate), 'Total': x.DocTotal,
          'CGST': x.CGST, 'SGST': x.SGST, 'IGST': x.IGST, 'Tax': x.Tax, 'Reason': x.Reason,
        })), fname);
      }
    } catch (e) { alert(`Error: ${e.message}`); } finally { setExporting(false); }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/60 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🧾</span>
            <div>
              <h1 className="text-base font-bold text-foreground leading-tight">GST Reconciliation</h1>
              <p className="text-[11px] text-muted-foreground">{user?.company || user?.database} · {user?.username}</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="h-9 px-4 rounded-xl border border-border bg-card text-sm font-medium text-foreground hover:bg-accent transition-all flex items-center gap-2"
          >
            <FiLogOut className="w-4 h-4" /> Logout
          </button>
        </div>
        {/* Tabs */}
        <div className="max-w-7xl mx-auto px-6 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => onTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-all ${
                tab === t.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {tab === 'reconcile' && (
          <FileUpload
            onFileUpload={handleFileUpload}
            onView={handleViewFile}
            isProcessing={isProcessing}
            isUploaded={isUploaded}
            fileName={fileName}
            uploadedFile={uploadedFile}
            setUploadedFile={setUploadedFile}
            selectedMonth={selectedMonth}
            setSelectedMonth={setSelectedMonth}
            setIsProcessing={setIsProcessing}
            setIsUploaded={setIsUploaded}
            setShowPreview={setShowPreview}
            endpoints={endpoints}
            setFileName={setFileName}
            unmatchedBills={unmatchedBills}
            setUnmatchedBills={setUnmatchedBills}
            onReconciled={(m, y) => { if (m) setFilterMonth(m); if (y) setFilterYear(String(y)); }}
          />
        )}

        {(tab === 'unmatched' || tab === 'matched') && (
              <div className="animate-fade-in">
                {/* Section toggle — only categories that actually have bills */}
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  {loadingCounts && !SECTION_TABS.some((t) => t.count > 0) && (
                    <span className="text-sm text-muted-foreground">Loading…</span>
                  )}
                  {SECTION_TABS.filter((t) => t.count > 0).map((t) => (
                    <button
                      key={t.key}
                      onClick={() => loadSection(t.key, 1)}
                      className={`px-3.5 py-2 rounded-xl text-sm font-medium border transition-all ${
                        unmatchedSection === t.key
                          ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                          : 'bg-card text-foreground border-border hover:bg-accent'
                      }`}
                    >
                      {t.label} <span className="opacity-70">({t.count})</span>
                    </button>
                  ))}
                </div>

                {/* Month / year filter — FY-aware: no future years/months; "All months"
                    shows the whole window. Defaults to the latest reconciled period. */}
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <span className="text-xs font-medium text-muted-foreground">Show month:</span>
                  <select
                    value={filterMonth}
                    onChange={(e) => changeFilter(e.target.value, filterYear)}
                    className="h-9 rounded-xl border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="All">All months</option>
                    {monthOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <select
                    value={filterYear}
                    onChange={(e) => {
                      const y = e.target.value;
                      // clamp the month if it's no longer valid for the newly-picked year
                      const m = (filterMonth === 'All' || monthOptionsFor(y).includes(filterMonth)) ? filterMonth : 'All';
                      changeFilter(m, y);
                    }}
                    className="h-9 rounded-xl border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                  <div className="relative w-full sm:w-72">
                    <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
                    <input
                      type="text"
                      placeholder="Search vendor / GSTIN / bill no."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="h-9 w-full rounded-xl border border-border bg-card pl-9 pr-4 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-muted-foreground shadow-sm"
                    />
                  </div>
                  <button
                    onClick={refreshFromSap}
                    disabled={refreshing || filterMonth === 'All'}
                    title={filterMonth === 'All' ? 'Pick a specific month to refresh' : 'Re-fetch SAP and re-reconcile this month against current SAP data'}
                    className="ml-auto h-9 px-4 rounded-xl border border-border bg-card text-foreground text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {refreshing ? 'Refreshing…' : '↻ Refresh from SAP'}
                  </button>
                  <button
                    onClick={exportCurrent}
                    disabled={exporting}
                    className="h-9 px-4 rounded-xl border border-primary/20 bg-primary/10 text-primary text-sm font-medium hover:bg-primary hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {exporting ? 'Exporting…' : 'Export to Excel'}
                  </button>
                </div>

                <p className="text-sm text-muted-foreground mb-4">{SECTION_DESC[unmatchedSection]}</p>

                {loadingSection ? (
                  <div className="text-center py-16 text-muted-foreground">Loading bills...</div>
                ) : joinedRows ? (
                  <div>
                    <div className="overflow-x-auto rounded-2xl border border-border bg-card shadow-sm">
                      <div className="max-h-[600px] overflow-y-auto">
                        <table className="w-full text-sm text-left whitespace-nowrap">
                          <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border sticky top-0 z-10 backdrop-blur-md">
                            <tr>
                              <th className="px-4 py-3 font-medium">Sr No.</th>
                              <th className="px-4 py-3 font-medium">2B GSTIN</th>
                              <th className="px-4 py-3 font-medium">SAP GSTIN</th>
                              {joinedReconcilable && <th className="px-4 py-3 font-medium">2B Vendor</th>}
                              {joinedReconcilable && <th className="px-4 py-3 font-medium">SAP Vendor</th>}
                              {joinedReconcilable
                                ? (<><th className="px-4 py-3 font-medium">2B Bill No</th><th className="px-4 py-3 font-medium">SAP Bill No</th></>)
                                : <th className="px-4 py-3 font-medium">Bill No</th>}
                              <th className="px-4 py-3 font-medium text-right">2B Tax</th>
                              <th className="px-4 py-3 font-medium text-right">SAP Tax</th>
                              <th className="px-4 py-3 font-medium text-right">Tax Δ</th>
                              <th className="px-4 py-3 font-medium">2B Date</th>
                              <th className="px-4 py-3 font-medium">SAP Date</th>
                              <th className="px-4 py-3 font-medium text-right">Days Δ</th>
                              {joinedReconcilable && <th className="px-4 py-3 font-medium text-center">Action</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {joinedRows
                              .map((r, i) => {
                                const n = (v) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                                const d = (x) => x ? new Date(x).toLocaleDateString('en-GB') : '—';
                                const gstMismatch = r.SapGST && r.VendorGST && r.SapGST !== r.VendorGST;
                                const valueBad = Math.abs(Number(r.TaxDelta) || 0) > 5;
                                const dateBad = (r.DateDeltaDays || 0) > 10;
                                const srNo = (sectionData.page - 1) * sectionData.pageSize + i + 1;
                                return (
                                  <tr key={i} className={`border-b border-border/40 hover:bg-accent/30 transition-colors ${i % 2 ? 'bg-muted/5' : ''}`}>
                                    <td className="px-4 py-2.5 text-muted-foreground">{srNo}</td>
                                    <td className="px-4 py-2.5 font-medium text-foreground">{r.VendorGST || '—'}</td>
                                    <td className={`px-4 py-2.5 ${gstMismatch ? 'text-rose-600 font-medium' : 'text-foreground/80'}`}>{r.SapGST || '—'}</td>
                                    {joinedReconcilable && <td className="px-4 py-2.5 text-foreground/80">{r.Vendor2BName || '—'}</td>}
                                    {joinedReconcilable && <td className={`px-4 py-2.5 ${unmatchedSection === 'vendordiff' ? 'text-rose-600 font-medium' : 'text-foreground/80'}`}>{r.SapVendorName || '—'}</td>}
                                    {joinedReconcilable
                                      ? (<>
                                          <td className="px-4 py-2.5 text-foreground/90">{r.VendorBillNo || '—'}</td>
                                          <td className={`px-4 py-2.5 ${r.SapBillNo && r.VendorBillNo && r.SapBillNo !== r.VendorBillNo ? 'text-rose-600 font-medium' : 'text-foreground/90'}`}>{r.SapBillNo || '—'}</td>
                                        </>)
                                      : <td className="px-4 py-2.5 text-foreground/90">{r.VendorBillNo || '—'}</td>}
                                    <td className="px-4 py-2.5 text-right text-muted-foreground">{n(r.ExcelTax)}</td>
                                    <td className="px-4 py-2.5 text-right text-muted-foreground">{n(r.SAP_Tax)}</td>
                                    <td className={`px-4 py-2.5 text-right font-medium ${valueBad ? 'text-rose-600' : 'text-muted-foreground'}`}>{n(r.TaxDelta)}</td>
                                    <td className="px-4 py-2.5 text-foreground/80">{d(r.InvoiceDate)}</td>
                                    <td className="px-4 py-2.5 text-foreground/80">{d(r.SapDate)}</td>
                                    <td className={`px-4 py-2.5 text-right ${dateBad ? 'text-amber-700 font-medium' : 'text-muted-foreground'}`}>{r.DateDeltaDays != null ? r.DateDeltaDays : '—'}</td>
                                    {joinedReconcilable && (
                                      <td className="px-4 py-2.5 text-center">
                                        <button
                                          onClick={() => reconcileRow(r)}
                                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary hover:text-white border border-primary/20 hover:border-primary transition-colors"
                                        >
                                          Reconcile
                                        </button>
                                      </td>
                                    )}
                                  </tr>
                                );
                              })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    {sectionData.total === 0 && (
                      <div className="text-center py-12 text-muted-foreground">No bills in this category for this selection.</div>
                    )}
                    {renderPager()}
                  </div>
                ) : impgRows ? (
                  <div>
                    <div className="overflow-x-auto rounded-2xl border border-border bg-card shadow-sm">
                      <div className="max-h-[600px] overflow-y-auto">
                        <table className="w-full text-sm text-left whitespace-nowrap">
                          <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border sticky top-0 z-10 backdrop-blur-md">
                            <tr>
                              <th className="px-4 py-3 font-medium">Sr No.</th>
                              <th className="px-4 py-3 font-medium">Bill of Entry</th>
                              <th className="px-4 py-3 font-medium">Port</th>
                              <th className="px-4 py-3 font-medium text-right">2B IGST</th>
                              <th className="px-4 py-3 font-medium text-right">SAP IGST</th>
                              <th className="px-4 py-3 font-medium text-right">IGST Δ</th>
                              <th className="px-4 py-3 font-medium">2B BoE Date</th>
                              <th className="px-4 py-3 font-medium">SAP Date</th>
                              <th className="px-4 py-3 font-medium">SAP Doc</th>
                            </tr>
                          </thead>
                          <tbody>
                            {impgRows.map((r, i) => {
                              const n = (v) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                              const d = (x) => x ? new Date(x).toLocaleDateString('en-GB') : '—';
                              const srNo = (sectionData.page - 1) * sectionData.pageSize + i + 1;
                              return (
                                <tr key={i} className={`border-b border-border/40 hover:bg-accent/30 transition-colors ${i % 2 ? 'bg-muted/5' : ''}`}>
                                  <td className="px-4 py-2.5 text-muted-foreground">{srNo}</td>
                                  <td className="px-4 py-2.5 font-medium text-foreground">{r.Boe || '—'}</td>
                                  <td className="px-4 py-2.5 text-foreground/80">{r.PortCode || '—'}</td>
                                  <td className="px-4 py-2.5 text-right text-muted-foreground">{r.Igst != null ? n(r.Igst) : '—'}</td>
                                  <td className="px-4 py-2.5 text-right text-muted-foreground">{r.SapIgst != null ? n(r.SapIgst) : '—'}</td>
                                  <td className={`px-4 py-2.5 text-right font-medium ${Math.abs(Number(r.TaxDelta) || 0) > 5 ? 'text-rose-600' : 'text-muted-foreground'}`}>{r.TaxDelta != null ? n(r.TaxDelta) : '—'}</td>
                                  <td className="px-4 py-2.5 text-foreground/80">{d(r.InvoiceDate)}</td>
                                  <td className="px-4 py-2.5 text-foreground/80">{d(r.SapDate)}</td>
                                  <td className="px-4 py-2.5 text-foreground/80">{r.SapDocNo || '—'}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    {sectionData.total === 0 && (
                      <div className="text-center py-12 text-muted-foreground">No import rows in this category for this selection.</div>
                    )}
                    {renderPager()}
                  </div>
                ) : unmatchedSection === 'manual' ? (
                  <div>
                    <div className="overflow-x-auto rounded-2xl border border-border bg-card shadow-sm">
                      <div className="max-h-[600px] overflow-y-auto">
                        <table className="w-full text-sm text-left whitespace-nowrap">
                          <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border sticky top-0 z-10 backdrop-blur-md">
                            <tr>
                              <th className="px-4 py-3 font-medium">Sr No.</th>
                              <th className="px-4 py-3 font-medium">Vendor GST</th>
                              <th className="px-4 py-3 font-medium">Vendor Bill No.</th>
                              <th className="px-4 py-3 font-medium text-right">SAP SGST</th>
                              <th className="px-4 py-3 font-medium text-right">SAP CGST</th>
                              <th className="px-4 py-3 font-medium text-right">SAP IGST</th>
                              <th className="px-4 py-3 font-medium">2B GST (entered)</th>
                              <th className="px-4 py-3 font-medium">2B Bill (entered)</th>
                              <th className="px-4 py-3 font-medium">Invoice Date</th>
                              <th className="px-4 py-3 font-medium">Reconciled On</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sectionData.rows.map((r, i) => {
                              const n = (v) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                              const srNo = (sectionData.page - 1) * sectionData.pageSize + i + 1;
                              return (
                                <tr key={i} className={`border-b border-border/40 hover:bg-accent/30 transition-colors ${i % 2 ? 'bg-muted/5' : ''}`}>
                                  <td className="px-4 py-2.5 text-muted-foreground">{srNo}</td>
                                  <td className="px-4 py-2.5 font-medium text-foreground">{r.VendorGST || '—'}</td>
                                  <td className="px-4 py-2.5 text-foreground/90">{r.VendorBillNo || '—'}</td>
                                  <td className="px-4 py-2.5 text-right text-muted-foreground">{n(r.SAP_SGST)}</td>
                                  <td className="px-4 py-2.5 text-right text-muted-foreground">{n(r.SAP_CGST)}</td>
                                  <td className="px-4 py-2.5 text-right text-muted-foreground">{n(r.SAP_IGST)}</td>
                                  <td className="px-4 py-2.5 text-foreground/80">{r.ExcelGST || '—'}</td>
                                  <td className="px-4 py-2.5 text-foreground/80">{r.ExcelBill || '—'}</td>
                                  <td className="px-4 py-2.5 text-foreground/80">{r.InvoiceDate ? new Date(r.InvoiceDate).toLocaleDateString('en-GB') : '—'}</td>
                                  <td className="px-4 py-2.5 text-foreground/80">{r.ReconciledAt ? new Date(r.ReconciledAt).toLocaleDateString('en-GB') : '—'}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    {sectionData.total === 0 && (
                      <div className="text-center py-12 text-muted-foreground">No bills have been manually reconciled yet.</div>
                    )}
                    {renderPager()}
                  </div>
                ) : (
                  <div>
                    <UnmatchedBills
                      key={unmatchedSection}
                      unmatchedBills={sectionData.rows}
                      serverPaged
                      onReconcile={() => { loadCounts(filterMonth, filterYear); loadSection(unmatchedSection, sectionData.page, filterMonth, filterYear); }}
                      source="sap"
                      readOnly={unmatchedSection === '2b'}
                    />
                    {renderPager()}
                  </div>
                )}
              </div>
        )}
      </main>

      {showPreview && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-card w-full h-[90vh] sm:h-[80vh] flex flex-col rounded-2xl border border-border shadow-2xl overflow-hidden animate-slide-up">
            <div className="flex justify-between items-center px-6 py-4 border-b border-border bg-muted/30">
              <h3 className="text-lg font-semibold text-foreground">File Preview</h3>
              <button onClick={() => setShowPreview(false)} className="p-2 rounded-full hover:bg-muted text-muted-foreground transition-colors">
                <FiX className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <ExcelPreview data={previewData} />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
