import React, { useState } from 'react';
import { createPortal } from 'react-dom';
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
];

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState('reconcile');

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
  const [sections, setSections] = useState({ inSapNotIn2b: [], in2bNotInSap: [], counts: {}, period: {} });
  const [matched, setMatched] = useState({ rows: [], count: 0 });
  const [matchedSearch, setMatchedSearch] = useState('');
  const [unmatchedSection, setUnmatchedSection] = useState('sap'); // 'sap' | '2b' | 'matched'
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

  const loadAllBills = async () => {
    setLoadingAll(true);
    try {
      const month = localStorage.getItem('selectedMonth') || 'Apr';
      const year = localStorage.getItem('selectedYear') || '2026';
      const headers = {
        Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
        'X-Database': localStorage.getItem('database'),
      };
      const qs = `month=${encodeURIComponent(month)}&year=${encodeURIComponent(year)}`;
      const [uRes, mRes] = await Promise.all([
        fetch(`/api/reconcile/unmatched-sections?${qs}`, { headers }),
        fetch(`/api/reconcile/matched-bills?${qs}`, { headers }),
      ]);
      const data = await uRes.json();
      const mData = await mRes.json();
      setSections({
        inSapNotIn2b: data.inSapNotIn2b || [],
        in2bNotInSap: data.in2bNotInSap || [],
        counts: data.counts || {},
        period: data.period || {},
      });
      setMatched({ rows: mData.matched || [], count: mData.count || 0 });
    } catch (e) {
      alert(`Error: ${e.message}`);
    } finally {
      setLoadingAll(false);
    }
  };

  const onTab = (key) => {
    setTab(key);
    if (key === 'unmatched') loadAllBills();
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

        {tab === 'unmatched' && (
          loadingAll
            ? <div className="text-center py-16 text-muted-foreground">Loading bills...</div>
            : (
              <div className="animate-fade-in">
                {/* Section toggle: the two directions of "unmatched" */}
                <div className="flex flex-wrap items-center gap-3 mb-6">
                  <button
                    onClick={() => setUnmatchedSection('sap')}
                    className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all ${
                      unmatchedSection === 'sap'
                        ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                        : 'bg-card text-foreground border-border hover:bg-accent'
                    }`}
                  >
                    In SAP, not in 2B <span className="opacity-70">({sections.counts.inSapNotIn2b || 0})</span>
                  </button>
                  <button
                    onClick={() => setUnmatchedSection('2b')}
                    className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all ${
                      unmatchedSection === '2b'
                        ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                        : 'bg-card text-foreground border-border hover:bg-accent'
                    }`}
                  >
                    In 2B, not in SAP <span className="opacity-70">({sections.counts.in2bNotInSap || 0})</span>
                  </button>
                  <button
                    onClick={() => setUnmatchedSection('matched')}
                    className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all ${
                      unmatchedSection === 'matched'
                        ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                        : 'bg-card text-foreground border-border hover:bg-accent'
                    }`}
                  >
                    Matched <span className="opacity-70">({matched.count || 0})</span>
                  </button>
                  {sections.period?.month && (
                    <span className="text-xs text-muted-foreground ml-auto">
                      Period: {sections.period.month}-{String(sections.period.year).slice(-2)}
                    </span>
                  )}
                </div>

                <p className="text-sm text-muted-foreground mb-4">
                  {unmatchedSection === 'sap'
                    ? 'Bills booked in SAP whose ITC is not confirmed in the 2B — hold / review before payment.'
                    : unmatchedSection === '2b'
                      ? 'Invoices the supplier reported in the 2B that are not booked in SAP — verify / book.'
                      : 'Reconciled bills — 2B (Excel) vs SAP tax side by side. Rows where the tax differs are highlighted.'}
                </p>

                {unmatchedSection === 'matched' ? (
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
                              <th className="px-4 py-3 font-medium">Vendor GST</th>
                              <th className="px-4 py-3 font-medium">Vendor Bill No.</th>
                              <th className="px-4 py-3 font-medium text-right">Excel SGST</th>
                              <th className="px-4 py-3 font-medium text-right">Excel CGST</th>
                              <th className="px-4 py-3 font-medium text-right">Excel IGST</th>
                              <th className="px-4 py-3 font-medium text-right">SAP SGST</th>
                              <th className="px-4 py-3 font-medium text-right">SAP CGST</th>
                              <th className="px-4 py-3 font-medium text-right">SAP IGST</th>
                              <th className="px-4 py-3 font-medium">Invoice Date</th>
                            </tr>
                          </thead>
                          <tbody>
                            {matched.rows
                              .filter((r) => {
                                const t = matchedSearch.trim().toLowerCase();
                                if (!t) return true;
                                return String(r.VendorGST || '').toLowerCase().includes(t)
                                  || String(r.VendorBillNo || '').toLowerCase().includes(t);
                              })
                              .map((r, i) => {
                                const ex = (r.ExcelSGST || 0) + (r.ExcelCGST || 0) + (r.ExcelIGST || 0);
                                const sp = (r.SAP_SGST || 0) + (r.SAP_CGST || 0) + (r.SAP_IGST || 0);
                                const mismatch = Math.abs(ex - sp) > 1;
                                const n = (v) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                                return (
                                  <tr key={i} className={`border-b border-border/40 hover:bg-accent/30 transition-colors ${mismatch ? 'bg-amber-50' : (i % 2 ? 'bg-muted/5' : '')}`}>
                                    <td className="px-4 py-2.5 text-muted-foreground">{i + 1}</td>
                                    <td className="px-4 py-2.5 font-medium text-foreground">{r.VendorGST || '—'}</td>
                                    <td className="px-4 py-2.5 text-foreground/90">{r.VendorBillNo || '—'}</td>
                                    <td className="px-4 py-2.5 text-right text-muted-foreground">{n(r.ExcelSGST)}</td>
                                    <td className="px-4 py-2.5 text-right text-muted-foreground">{n(r.ExcelCGST)}</td>
                                    <td className="px-4 py-2.5 text-right text-muted-foreground">{n(r.ExcelIGST)}</td>
                                    <td className={`px-4 py-2.5 text-right ${mismatch ? 'text-amber-700 font-medium' : 'text-muted-foreground'}`}>{n(r.SAP_SGST)}</td>
                                    <td className={`px-4 py-2.5 text-right ${mismatch ? 'text-amber-700 font-medium' : 'text-muted-foreground'}`}>{n(r.SAP_CGST)}</td>
                                    <td className={`px-4 py-2.5 text-right ${mismatch ? 'text-amber-700 font-medium' : 'text-muted-foreground'}`}>{n(r.SAP_IGST)}</td>
                                    <td className="px-4 py-2.5 text-foreground/80">{r.InvoiceDate ? new Date(r.InvoiceDate).toLocaleDateString('en-GB') : '—'}</td>
                                  </tr>
                                );
                              })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    {matched.count === 0 && (
                      <div className="text-center py-12 text-muted-foreground">No matched bills for this period.</div>
                    )}
                  </div>
                ) : (
                  <UnmatchedBills
                    key={unmatchedSection}
                    unmatchedBills={unmatchedSection === 'sap' ? sections.inSapNotIn2b : sections.in2bNotInSap}
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
