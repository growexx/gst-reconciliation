import React, { useState, useEffect } from 'react';
import { FiUploadCloud, FiEye, FiTrash2, FiFileText } from 'react-icons/fi';
import UnmatchedBills from './UnmatchedBills';

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
  setFileName
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [months] = useState([
    { value: 'Jan', label: 'January' },
    { value: 'Feb', label: 'February' },
    { value: 'Mar', label: 'March' },
    { value: 'Apr', label: 'April' },
    { value: 'May', label: 'May' },
    { value: 'Jun', label: 'June' },
    { value: 'Jul', label: 'July' },
    { value: 'Aug', label: 'August' },
    { value: 'Sep', label: 'September' },
    { value: 'Oct', label: 'October' },
    { value: 'Nov', label: 'November' },
    { value: 'Dec', label: 'December' },
  ]);
  const [docEntry, setDocEntry] = useState(null);
  const [selectedYear, setSelectedYear] = useState('');
  const [unmatchedBills, setUnmatchedBills] = useState([]);
  const [isReconciled, setIsReconciled] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showProgress, setShowProgress] = useState(false);
  const [rowProgress, setRowProgress] = useState({ current: 0, total: 0 });

  useEffect(() => {
    const storedYear = localStorage.getItem('selectedYear');
    if (storedYear) {
      setSelectedYear(storedYear);
    }
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

    // Hoisted so the finally block can always clear it (fix vs. original).
    let progressInterval;

    try {
      setIsProcessing(true);
      setShowProgress(true);
      setUploadProgress(0);
      setRowProgress({ current: 0, total: 0 });

      // Start polling for row-level progress
      progressInterval = setInterval(async () => {
        try {
          const res = await fetch('/api/reconcile/progress', {
            headers: {
              'Authorization': `Bearer ${localStorage.getItem('sessionId')}`,
              'X-Database': localStorage.getItem('database')
            }
          });
          if (res.ok) {
            const progress = await res.json();
            if (progress && progress.total > 0) {
              setRowProgress(progress);
              if (progress.current > 0) {
                const processingPercent = (progress.current / progress.total) * 100;
                setUploadProgress(Math.max(uploadProgress, processingPercent));
              }
            }
          }
        } catch (err) {
          console.error('Progress polling error:', err);
        }
      }, 3000);

      const formData = new FormData();
      formData.append('file', uploadedFile);
      formData.append('month', selectedMonth);
      formData.append('year', selectedYear);

      const database = localStorage.getItem('database');
      const sessionId = localStorage.getItem('sessionId');

      // Stage 1: Checking and clearing existing entries
      const responseCheck = await fetch(`/api/reconcile/check/${selectedMonth}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${sessionId}`,
          'X-Database': database
        }
      });

      if (responseCheck.ok) {
        const existingDocEntry = await responseCheck.json();
        if (existingDocEntry) {
          // Stage 2: Deleting existing entry
          await fetch(`/api/reconcile/delete/${existingDocEntry}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${sessionId}`,
              'X-Database': database
            }
          });
        }
      }

      // Stage 3: Uploading and processing file
      const response = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.addEventListener('load', async () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const data = JSON.parse(xhr.responseText);
              console.log('Reconciliation response:', data);
              alert('File processed successfully!');
              setIsReconciled(true);

              if (data.unmatchedBills && data.unmatchedBills.length > 0) {
                setUnmatchedBills(data.unmatchedBills);
                localStorage.setItem('unmatchedBills', JSON.stringify(data.unmatchedBills));
              } else {
                setUnmatchedBills([]);
                localStorage.removeItem('unmatchedBills');
              }

              setUploadProgress(100);
              setIsProcessing(false);
              setTimeout(() => setShowProgress(false), 500);

              resolve(data);
            } catch (error) {
              console.error('Error parsing response:', error);
              setIsProcessing(false);
              reject(new Error('Failed to parse server response'));
            }
          } else {
            setIsProcessing(false);
            reject(new Error('Failed to process file'));
          }
        });

        xhr.addEventListener('error', () => {
          setIsProcessing(false);
          reject(new Error('Network error occurred'));
        });

        xhr.addEventListener('abort', () => {
          setIsProcessing(false);
          reject(new Error('Upload aborted'));
        });

        xhr.open('POST', endpoints.reconcile);
        xhr.setRequestHeader('Authorization', `Bearer ${sessionId}`);
        xhr.setRequestHeader('X-Database', database);

        xhr.send(formData);
      });

      if (response.unmatchedBills) {
        await new Promise(resolve => {
          const checkUnmatchedBills = () => {
            if (unmatchedBills.length === response.unmatchedBills.length) {
              resolve();
            } else {
              setTimeout(checkUnmatchedBills, 100);
            }
          };
          checkUnmatchedBills();
        });
      }

    } catch (error) {
      console.error('Reconciliation error:', error);
      setIsProcessing(false);
      alert(`Error: ${error.message}`);
    } finally {
      if (progressInterval) clearInterval(progressInterval);
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
                <div className="flex flex-col sm:flex-row items-center gap-4 mb-8">
                    <select
                        value={selectedMonth}
                        onChange={handleMonthChange}
                        className="h-11 w-full sm:w-48 rounded-xl border border-border bg-background px-4 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium"
                    >
                        <option value="">Select Month</option>
                        {months.map((month) => (
                            <option key={month.value} value={month.value}>
                                {month.label}
                            </option>
                        ))}
                    </select>

                    <select
                        value={selectedYear}
                        onChange={handleYearChange}
                        className="h-11 w-full sm:w-48 rounded-xl border border-border bg-background px-4 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium"
                    >
                        <option value="">Select Year</option>
                        {Array.from({ length: 31 }, (_, i) => 2020 + i).map((year) => (
                            <option key={year} value={year}>
                                {year}
                            </option>
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
                            {rowProgress.total > 0
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
