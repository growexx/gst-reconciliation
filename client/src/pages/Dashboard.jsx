import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { FiX, FiLogOut } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

import FileUpload from '../components/FileUpload';
import UnmatchedBills from '../components/UnmatchedBills';
import ExcelPreview from '../components/ExcelPreview';

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
const UNMATCHED_KEYS = ['sap', '2b', 'gstdiff', 'valuediff', 'vendordiff', 'nobill', 'debit'];
const MATCHED_KEYS = ['matched', 'datediff', 'manual'];

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

  // "Unmatched bills" view — sections, scoped to the reconciled period
  const [sections, setSections] = useState({ inSapNotIn2b: [], in2bNotInSap: [], gstDiff: [], valueDiff: [], vendorDiff: [], noBillNo: [], debitNotes: [], cdnr2bNotInSap: [], counts: {}, period: {} });
  const [matched, setMatched] = useState({ match: [], dateDiff: [], count: 0 });
  const [manualMatched, setManualMatched] = useState({ rows: [], count: 0 });
  const [matchedSearch, setMatchedSearch] = useState('');
  // sap | 2b | gstdiff | valuediff | nobill | debit | matched | datediff | manual
  const [unmatchedSection, setUnmatchedSection] = useState(qsSection);
  const [filterMonth, setFilterMonth] = useState(searchParams.get('month') || 'All');
  const [filterYear, setFilterYear] = useState(searchParams.get('year') || localStorage.getItem('selectedYear') || '2026');
  const [loadingAll, setLoadingAll] = useState(false);

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

  const loadAllBills = async (month = filterMonth, year = filterYear) => {
    setLoadingAll(true);
    try {
      const headers = {
        Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        'X-Database': localStorage.getItem('database'),
      };
      const qs = `month=${encodeURIComponent(month)}&year=${encodeURIComponent(year)}`;
      const [uRes, mRes, mmRes] = await Promise.all([
        fetch(`/api/reconcile/unmatched-sections?${qs}`, { headers }),
        fetch(`/api/reconcile/matched-bills?${qs}`, { headers }),
        fetch(`/api/reconcile/manual-matched-bills`, { headers }),
      ]);
      const data = await uRes.json();
      const mData = await mRes.json();
      const mmData = await mmRes.json();
      setSections({
        inSapNotIn2b: data.inSapNotIn2b || [],
        in2bNotInSap: data.in2bNotInSap || [],
        gstDiff: data.gstDiff || [],
        valueDiff: data.valueDiff || [],
        vendorDiff: data.vendorDiff || [],
        noBillNo: data.noBillNo || [],
        debitNotes: data.debitNotes || [],
        cdnr2bNotInSap: data.cdnr2bNotInSap || [],
        counts: data.counts || {},
        period: data.period || {},
      });
      setMatched({ match: mData.match || [], dateDiff: mData.dateDiff || [], count: mData.count || 0 });
      setManualMatched({ rows: mmData.manual || [], count: mmData.count || 0 });
    } catch (e) {
      alert(`Error: ${e.message}`);
    } finally {
      setLoadingAll(false);
    }
  };

  // Re-fetch when the month/year filter changes (only while viewing the tab).
  const changeFilter = (month, year) => {
    setFilterMonth(month);
    setFilterYear(year);
    loadAllBills(month, year);
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
      loadAllBills();
    } catch (e) { alert(`Error: ${e.message}`); }
  };

  const onTab = (key) => {
    setTab(key);
    if (key === 'unmatched') { setUnmatchedSection('sap'); loadAllBills(); }
    else if (key === 'matched') { setUnmatchedSection('matched'); loadAllBills(); }
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
    if (qsTab === 'unmatched' || qsTab === 'matched') loadAllBills(filterMonth, filterYear);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sub-section tabs, with live counts, grouped by the top-level tab they belong to.
  const UNMATCHED_SECTIONS = [
    { key: 'sap', label: 'In SAP, not in 2B', count: sections.counts.inSapNotIn2b || 0 },
    { key: '2b', label: 'In 2B, not in SAP', count: sections.counts.in2bNotInSap || 0 },
    { key: 'gstdiff', label: 'Not Matched — GST diff', count: sections.counts.gstDiff || 0 },
    { key: 'valuediff', label: 'Not Matched — Value diff', count: sections.counts.valueDiff || 0 },
    { key: 'vendordiff', label: 'Not Matched — Diff Vendor Name', count: sections.counts.vendorDiff || 0 },
    { key: 'nobill', label: 'Not Matched — Diff Bill No', count: sections.counts.noBillNo || 0 },
    { key: 'debit', label: 'Not Matched — Debit Note', count: sections.counts.debitNotes || 0 },
  ];
  const MATCHED_SECTIONS = [
    { key: 'matched', label: 'Matched', count: (matched.match || []).length },
    { key: 'datediff', label: 'Matched — Date diff', count: (matched.dateDiff || []).length },
    { key: 'manual', label: 'Manually matched', count: manualMatched.count || 0 },
  ];
  const SECTION_TABS = tab === 'matched' ? MATCHED_SECTIONS : UNMATCHED_SECTIONS;

  // If the active sub-section has no bills (its tab is hidden), jump to the first
  // visible one so we never sit on an empty, hidden category.
  useEffect(() => {
    const visible = SECTION_TABS.filter((t) => t.count > 0);
    if (visible.length && !visible.some((t) => t.key === unmatchedSection)) {
      setUnmatchedSection(visible[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, unmatchedSection, sections, matched, manualMatched]);

  // Financial-year months (Apr→Mar) for the month filter; '' = whole window.
  const MONTHS_LIST = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
  // The "joined-row" buckets (2B line ↔ SAP invoice) share one table.
  const joinedRows = unmatchedSection === 'matched' ? matched.match
    : unmatchedSection === 'datediff' ? matched.dateDiff
    : unmatchedSection === 'gstdiff' ? sections.gstDiff
    : unmatchedSection === 'valuediff' ? sections.valueDiff
    : unmatchedSection === 'vendordiff' ? sections.vendorDiff
    : unmatchedSection === 'nobill' ? sections.noBillNo : null;
  // The not-matched near-miss buckets allow a manual reconcile straight from the table.
  const joinedReconcilable = ['gstdiff', 'valuediff', 'vendordiff', 'nobill'].includes(unmatchedSection);
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
  };

  // Export the currently-shown section to an .xlsx file, with clean column names.
  const exportCurrent = () => {
    const fname = `gst-${tab}-${unmatchedSection}-${filterMonth}-${filterYear}.xlsx`;
    if (joinedRows) {
      downloadXlsx(joinedRows.map((r) => ({
        '2B GSTIN': r.VendorGST, 'SAP GSTIN': r.SapGST,
        '2B Vendor': r.Vendor2BName, 'SAP Vendor': r.SapVendorName,
        '2B Bill No': r.VendorBillNo, 'SAP Bill No': r.SapBillNo,
        '2B Tax': r.ExcelTax, 'SAP Tax': r.SAP_Tax, 'Tax Diff': r.TaxDelta,
        '2B Date': fmtXlsDate(r.InvoiceDate), 'SAP Date': fmtXlsDate(r.SapDate), 'Days Diff': r.DateDeltaDays,
      })), fname);
    } else if (unmatchedSection === 'manual') {
      downloadXlsx((manualMatched.rows || []).map((r) => ({
        'Vendor GST': r.VendorGST, 'Vendor Bill No': r.VendorBillNo,
        'SAP SGST': r.SAP_SGST, 'SAP CGST': r.SAP_CGST, 'SAP IGST': r.SAP_IGST,
        '2B GST (entered)': r.ExcelGST, '2B Bill (entered)': r.ExcelBill,
        'Invoice Date': fmtXlsDate(r.InvoiceDate), 'Reconciled On': fmtXlsDate(r.ReconciledAt),
      })), fname);
    } else {
      const rows = unmatchedSection === 'sap' ? sections.inSapNotIn2b
        : unmatchedSection === 'debit' ? sections.debitNotes
        : sections.in2bNotInSap;
      downloadXlsx((rows || []).map((r) => ({
        'Vendor Code': r.CardCode, 'Vendor Name': r.CardName,
        'GSTIN': r.GSTRegnNo || r.VendorGST, 'Bill No': r.NumAtCard,
        'Date': fmtXlsDate(r.DocDate), 'Total': r.DocTotal,
        'CGST': r.CGST, 'SGST': r.SGST, 'IGST': r.IGST, 'Tax': r.Tax, 'Reason': r.Reason,
      })), fname);
    }
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
          />
        )}

        {(tab === 'unmatched' || tab === 'matched') && (
          loadingAll
            ? <div className="text-center py-16 text-muted-foreground">Loading bills...</div>
            : (
              <div className="animate-fade-in">
                {/* Section toggle — only categories that actually have bills */}
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  {SECTION_TABS.filter((t) => t.count > 0).map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setUnmatchedSection(t.key)}
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

                {/* Month / year filter — "All months" shows the whole 2-FY window */}
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <span className="text-xs font-medium text-muted-foreground">Show month:</span>
                  <select
                    value={filterMonth}
                    onChange={(e) => changeFilter(e.target.value, filterYear)}
                    className="h-9 rounded-xl border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="All">All months</option>
                    {MONTHS_LIST.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <select
                    value={filterYear}
                    onChange={(e) => changeFilter(filterMonth, e.target.value)}
                    className="h-9 rounded-xl border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    {[String(Number(filterYear) - 1), filterYear, String(Number(filterYear) + 1)].map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                  <button
                    onClick={exportCurrent}
                    className="ml-auto h-9 px-4 rounded-xl border border-primary/20 bg-primary/10 text-primary text-sm font-medium hover:bg-primary hover:text-white transition-colors"
                  >
                    Export to Excel
                  </button>
                </div>

                <p className="text-sm text-muted-foreground mb-4">{SECTION_DESC[unmatchedSection]}</p>

                {joinedRows ? (
                  <div>
                    <div className="relative w-full sm:w-72 mb-4">
                      <input
                        type="text"
                        placeholder="Search Vendor GST / Bill No."
                        value={matchedSearch}
                        onChange={(e) => setMatchedSearch(e.target.value)}
                        className="h-10 w-full rounded-xl border border-border bg-card px-4 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-muted-foreground shadow-sm"
                      />
                    </div>
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
                              .filter((r) => {
                                const t = matchedSearch.trim().toLowerCase();
                                if (!t) return true;
                                return String(r.VendorGST || '').toLowerCase().includes(t)
                                  || String(r.VendorBillNo || '').toLowerCase().includes(t);
                              })
                              .map((r, i) => {
                                const n = (v) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                                const d = (x) => x ? new Date(x).toLocaleDateString('en-GB') : '—';
                                const gstMismatch = r.SapGST && r.VendorGST && r.SapGST !== r.VendorGST;
                                const valueBad = Math.abs(Number(r.TaxDelta) || 0) > 5;
                                const dateBad = (r.DateDeltaDays || 0) > 10;
                                return (
                                  <tr key={i} className={`border-b border-border/40 hover:bg-accent/30 transition-colors ${i % 2 ? 'bg-muted/5' : ''}`}>
                                    <td className="px-4 py-2.5 text-muted-foreground">{i + 1}</td>
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
                    {joinedRows.length === 0 && (
                      <div className="text-center py-12 text-muted-foreground">No bills in this category for this selection.</div>
                    )}
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
                            {manualMatched.rows.map((r, i) => {
                              const n = (v) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                              return (
                                <tr key={i} className={`border-b border-border/40 hover:bg-accent/30 transition-colors ${i % 2 ? 'bg-muted/5' : ''}`}>
                                  <td className="px-4 py-2.5 text-muted-foreground">{i + 1}</td>
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
                    {manualMatched.count === 0 && (
                      <div className="text-center py-12 text-muted-foreground">No bills have been manually reconciled yet.</div>
                    )}
                  </div>
                ) : (
                  <UnmatchedBills
                    key={unmatchedSection}
                    unmatchedBills={unmatchedSection === 'sap' ? sections.inSapNotIn2b
                      : unmatchedSection === 'debit' ? sections.debitNotes
                      : sections.in2bNotInSap}
                    onReconcile={() => loadAllBills()}
                    source="sap"
                    readOnly={unmatchedSection === '2b'}
                  />
                )}
              </div>
            )
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
