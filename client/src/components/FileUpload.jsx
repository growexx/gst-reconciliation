import React, { useState, useEffect } from 'react';
import { FiUploadCloud, FiEye, FiTrash2, FiFileText } from 'react-icons/fi';
import UnmatchedBills from './UnmatchedBills';
import { yearOptions, monthsForYear, MONTH_LABEL, currentYear } from '../lib/fy';

const FileUpload = ({
  onFileUpload,
  onReconcile,
  isProcessing,
  onView,
  onRemove,
  isUploaded,
  fileName,
  uploadedFile,
  setUploadedFile,
  selectedMonth,
  setSelectedMonth,
  setIsProcessing,
  endpoints,
  setIsUploaded,
  setShowPreview,
  setFileName,
  onReconciled,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [docEntry, setDocEntry] = useState(null);
  const [selectedYear, setSelectedYear] = useState(() => localStorage.getItem('selectedYear') || String(currentYear()));
  const [unmatchedBills, setUnmatchedBills] = useState([]);
  const [isReconciled, setIsReconciled] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showProgress, setShowProgress] = useState(false);
  const [rowProgress, setRowProgress] = useState({ current: 0, total: 0 });
  const [progressPhase, setProgressPhase] = useState('');

  useEffect(() => {
    // Default the upload year to the current calendar year (no future years offered) and
    // PERSIST it, so the year is never '' at reconcile time. Fixes the bug where selecting
    // a month + Reconcile on first load errored (year state was '' until the dropdown was
    // toggled) — now the year is a valid value from the first render.
    const y = localStorage.getItem('selectedYear') || String(currentYear());
    setSelectedYear(y);
    localStorage.setItem('selectedYear', y);
  }, []);

  // Effect to restore state from localStorage on component mount
  useEffect(() => {
    const storedFile = localStorage.getItem('uploadedFile');
    const storedMonth = localStorage.getItem('selectedMonth');
    const storedYear = localStorage.getItem('selectedYear');
    const storedUnmatchedBills = localStorage.getItem('unmatchedBills');
    const storedIsReconciled = localStorage.getItem('isReconciled');

    if (storedFile) {
      const fileData = JSON.parse(storedFile);
      // Convert dataUrl back to a Blob
      const byteString = atob(fileData.dataUrl.split(',')[1]);
      const mimeString = fileData.dataUrl.split(',')[0].split(':')[1].split(';')[0];
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: mimeString });
      const file = new File([blob], fileData.name, {
        type: fileData.type,
        lastModified: fileData.lastModified
      });
      setUploadedFile(file);
      setIsUploaded(true);
      setFileName(fileData.name);
    }

    if (storedMonth) {
      setSelectedMonth(storedMonth);
    }

    if (storedYear) {
      setSelectedYear(storedYear);
    }

    if (storedUnmatchedBills) {
      setUnmatchedBills(JSON.parse(storedUnmatchedBills));
    }

    if (storedIsReconciled) {
      setIsReconciled(storedIsReconciled === 'true');
    }
  }, [setUploadedFile, setIsUploaded, setFileName, setSelectedMonth, setSelectedYear, setUnmatchedBills, setIsReconciled]);

  const handleMonthChange = (e) => {
    const month = e.target.value;
    setSelectedMonth(month);
    localStorage.setItem('selectedMonth', month);
  };

  const handleYearChange = (e) => {
    const year = e.target.value;
    setSelectedYear(year);
    localStorage.setItem('selectedYear', year);
    // drop the chosen month if it isn't valid for the newly-picked year (e.g. a future
    // month of the current year)
    if (selectedMonth && !monthsForYear(year).includes(selectedMonth)) {
      setSelectedMonth('');
      localStorage.removeItem('selectedMonth');
    }
  };

  const handleFile = (file) => {
    console.log('File uploaded:', file);
    if (file) {
      console.log('File type:', file.type);
      if (file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        setUploadedFile(file);
        onFileUpload(file, selectedMonth);
        setIsUploaded(true);

        // Store file data in localStorage
        const reader = new FileReader();
        reader.onload = (e) => {
          const fileData = {
            name: file.name,
            lastModified: file.lastModified,
            size: file.size,
            type: file.type,
            dataUrl: e.target.result
          };
          localStorage.setItem('uploadedFile', JSON.stringify(fileData));
        };
        reader.readAsDataURL(file);
      } else {
        alert('Please upload a valid Excel file (.xlsx)');
      }
    } else {
      console.log('No file selected');
    }
  };

  const handleReconcile = async () => {
    if (!uploadedFile) {
      alert('Please upload a file first');
      return;
    }
    if (!selectedMonth) {
      alert('Please select a month first');
      return;
    }
    if (!selectedYear) {
      alert('Please select a year first');
      return;
    }

    try {
      setIsProcessing(true);
      setShowProgress(true);
      setUploadProgress(0);
      setRowProgress({ current: 0, total: 0 });
      setProgressPhase('Starting…');

      const database = localStorage.getItem('database');
      const sessionId = localStorage.getItem('sessionId');
      const authHeaders = { 'Authorization': `Bearer ${sessionId}`, 'X-Database': database };

      // Stage 1/2: replace any existing entry for this month.
      const responseCheck = await fetch(`/api/reconcile/check/${selectedMonth}`, { method: 'GET', headers: authHeaders });
      if (responseCheck.ok) {
        const existingDocEntry = await responseCheck.json();
        if (existingDocEntry) {
          await fetch(`/api/reconcile/delete/${existingDocEntry}`, { method: 'DELETE', headers: authHeaders });
        }
      }

      // Stage 3: start the background reconcile — returns immediately (202). The SAP
      // fetch + match runs server-side; we poll /progress for phase + final result.
      const formData = new FormData();
      formData.append('file', uploadedFile);
      formData.append('month', selectedMonth);
      formData.append('year', selectedYear);
      const startRes = await fetch(endpoints.reconcile, { method: 'POST', body: formData, headers: authHeaders });
      if (!startRes.ok) throw new Error('Failed to start reconciliation');

      // Stage 4: poll until the background job reports done (or error).
      const data = await new Promise((resolve, reject) => {
        const deadline = Date.now() + 10 * 60 * 1000;   // give up after 10 min
        const poll = async () => {
          try {
            const res = await fetch('/api/reconcile/progress', { headers: authHeaders });
            if (res.ok) {
              const p = await res.json();
              if (p) {
                if (p.phase) setProgressPhase(p.phase);
                if (p.total > 0) {
                  setRowProgress({ current: p.current || 0, total: p.total });
                  if (p.current > 0) setUploadProgress((p.current / p.total) * 100);
                }
                if (p.done) {
                  if (p.error) return reject(new Error(p.error));
                  return resolve({ result: p.result, unmatchedBills: p.unmatchedBills || [] });
                }
              }
            }
          } catch (err) { /* transient network error — keep polling */ }
          if (Date.now() < deadline) setTimeout(poll, 2000);
          else reject(new Error('Timed out waiting for reconciliation — it may still be running; reload to check.'));
        };
        poll();
      });

      console.log('Reconciliation response:', data);
      alert('File processed successfully!');
      setIsReconciled(true);
      // Tell the dashboard which period was just reconciled, so the Unmatched/Matched
      // views default to THIS month (not "All months").
      if (onReconciled) onReconciled(selectedMonth, selectedYear);

      if (data.unmatchedBills && data.unmatchedBills.length > 0) {
        setUnmatchedBills(data.unmatchedBills);
        localStorage.setItem('unmatchedBills', JSON.stringify(data.unmatchedBills));
      } else {
        setUnmatchedBills([]);
        localStorage.removeItem('unmatchedBills');
      }
      setUploadProgress(100);
    } catch (error) {
      console.error('Reconciliation error:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setShowProgress(false);
      setIsProcessing(false);
    }
  };

  const handleFileUpload = (file, month) => {
    console.log('File uploaded in handleFileUpload:', file);
    setUploadedFile(file);
    setIsUploaded(true);
    setShowPreview(false);

    localStorage.setItem('selectedMonth', month);

    const reader = new FileReader();
    reader.onload = (e) => {
      const fileData = {
        name: file.name,
        lastModified: file.lastModified,
        size: file.size,
        type: file.type,
        dataUrl: e.target.result
      };
      localStorage.setItem('uploadedFile', JSON.stringify(fileData));
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveFile = () => {
    setUploadedFile(null);
    setIsUploaded(false);
    setShowPreview(false);
    setSelectedMonth('');
    setSelectedYear('');
    setUnmatchedBills([]);
    setIsReconciled(false);

    localStorage.removeItem('uploadedFile');
    localStorage.removeItem('selectedMonth');
    localStorage.removeItem('selectedYear');
    localStorage.removeItem('unmatchedBills');
    localStorage.removeItem('isReconciled');

    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      fileInput.value = null;
    }

    setFileName('');
  };

  const handleBillReconciled = (docEntry) => {
    setUnmatchedBills(prevBills => prevBills.filter(bill => bill.DocEntry !== docEntry));
  };

  return (
        <div className="w-full animate-fade-in max-w-4xl mx-auto space-y-6 pt-4">
            <div className="bg-card rounded-2xl border border-border shadow-sm p-6 sm:p-8">
                {/* Year first, then the months valid for that FY (no future periods). */}
                <div className="flex flex-col sm:flex-row items-center gap-4 mb-8">
                    <select
                        value={selectedYear}
                        onChange={handleYearChange}
                        className="h-11 w-full sm:w-48 rounded-xl border border-border bg-background px-4 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium"
                    >
                        {yearOptions(5, selectedYear).map((year) => (
                            <option key={year} value={year}>{year}</option>
                        ))}
                    </select>

                    <select
                        value={selectedMonth}
                        onChange={handleMonthChange}
                        className="h-11 w-full sm:w-48 rounded-xl border border-border bg-background px-4 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium"
                    >
                        <option value="">Select Month</option>
                        {monthsForYear(selectedYear).map((m) => (
                            <option key={m} value={m}>{MONTH_LABEL[m]}</option>
                        ))}
                    </select>
                </div>

                {/* Upload Area */}
                <div
                    className={`relative w-full border-2 border-dashed rounded-2xl p-10 transition-all ${
                        isDragging
                            ? 'border-primary bg-primary/5'
                            : isUploaded
                                ? 'border-border bg-muted/20'
                                : 'border-border hover:border-primary/50 hover:bg-muted/30'
                    }`}
                    onDragOver={(e) => {
                        e.preventDefault();
                        setIsDragging(true);
                    }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(e) => {
                        e.preventDefault();
                        setIsDragging(false);
                        handleFile(e.dataTransfer.files[0]);
                    }}
                >
                    <div className="flex flex-col items-center justify-center text-center space-y-4">
                        <div className={`p-4 rounded-full ${isUploaded ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                            {isUploaded ? <FiFileText className="w-10 h-10" /> : <FiUploadCloud className="w-10 h-10" />}
                        </div>

                        <div>
                            {fileName ? (
                                <p className="text-lg font-semibold text-foreground">{fileName}</p>
                            ) : (
                                <>
                                    <h3 className="text-lg font-semibold text-foreground mb-1">Drag & Drop your Excel file here</h3>
                                    <p className="text-sm text-muted-foreground">or click below to browse</p>
                                </>
                            )}
                        </div>

                        {!isUploaded && (
                            <label className="cursor-pointer inline-flex items-center justify-center h-10 px-6 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-all mt-4">
                                Browse File
                                <input
                                    type="file"
                                    accept=".xlsx,.xls"
                                    onChange={(e) => handleFile(e.target.files[0])}
                                    className="hidden"
                                />
                            </label>
                        )}
                    </div>
                </div>

                {isUploaded && (
                    <div className="flex flex-wrap items-center justify-center gap-4 mt-8 animate-fade-in-up">
                        <button
                            onClick={onView}
                            className="h-10 px-6 rounded-xl border border-border bg-card text-foreground text-sm font-medium hover:bg-accent transition-all flex items-center gap-2"
                        >
                            <FiEye className="w-4 h-4" /> View Data
                        </button>
                        <button
                            onClick={handleRemoveFile}
                            disabled={isProcessing}
                            className="h-10 px-6 rounded-xl border border-border bg-card text-destructive text-sm font-medium hover:bg-destructive/10 transition-all flex items-center gap-2 disabled:opacity-50"
                        >
                            <FiTrash2 className="w-4 h-4" /> Remove
                        </button>
                        <button
                            onClick={handleReconcile}
                            disabled={isProcessing || isReconciled}
                            className={`h-10 px-8 rounded-xl text-white text-sm font-medium transition-all flex items-center gap-2 shadow-sm ${
                                isProcessing || isReconciled
                                    ? 'bg-muted-foreground cursor-not-allowed opacity-80'
                                    : 'bg-primary hover:bg-primary/90 hover:shadow'
                            }`}
                        >
                            {isProcessing ? 'Processing...' : isReconciled ? 'Reconciled' : 'Reconcile'}
                        </button>
                    </div>
                )}
            </div>

            {showProgress && (
                <div className="bg-card rounded-2xl border border-border shadow-sm p-6 animate-fade-in-up">
                    <div className="flex items-center justify-between mb-3 text-sm">
                        <span className="font-medium text-foreground">
                            {progressPhase
                                ? progressPhase
                                : rowProgress.total > 0
                                    ? `Processing row ${rowProgress.current} of ${rowProgress.total}...`
                                    : 'Uploading and Processing...'}
                        </span>
                        <span className="text-muted-foreground font-semibold">
                            {rowProgress.total > 0 ? ((rowProgress.current / rowProgress.total) * 100).toFixed(0) : '...'}%
                        </span>
                    </div>
                    <div className="h-2.5 w-full bg-muted rounded-full overflow-hidden">
                        <div
                            className="h-full bg-primary transition-all duration-300 ease-out rounded-full"
                            style={{
                                width: rowProgress.total > 0
                                    ? `${(rowProgress.current / rowProgress.total) * 100}%`
                                    : '0%'
                            }}
                        />
                    </div>
                </div>
            )}

            {unmatchedBills && unmatchedBills.length > 0 && (
                <div className="animate-fade-in-up mt-8">
                    <UnmatchedBills
                        unmatchedBills={unmatchedBills}
                        onReconcile={handleBillReconciled}
                        source="file-upload"
                        context="upload-context"
                    />
                </div>
            )}
        </div>
    );
};

export default FileUpload;
