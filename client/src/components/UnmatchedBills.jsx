import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FiSearch, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import Pagination from './common/Pagination';

const endpoints = {
    updateReconciliation: '/api/reconcile/update-status',
    fetchSapBills: '/api/reconcile/fetch-sap-bills'
};

const UnmatchedBills = ({ unmatchedBills: initialUnmatchedBills, onReconcile, source, context, readOnly = false }) => {
    const [expandedVendor, setExpandedVendor] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [reconciledBills, setReconciledBills] = useState(new Set()); // Track reconciled bills
    const [reconciliationOption, setReconciliationOption] = useState('current'); // 'current' or 'all'
    const [unmatchedBills, setUnmatchedBills] = useState(initialUnmatchedBills); // Initialize state for unmatched bills
    const [billSearches, setBillSearches] = useState({});
    const [confirmationData, setConfirmationData] = useState(null);
    const [gstBillData, setGstBillData] = useState({ gst: '', bill: '' }); // State for GST and Bill fields
    const [showGstBillPopup, setShowGstBillPopup] = useState(false); // State to control GST/Bill popup visibility
    const [currentDocEntry, setCurrentDocEntry] = useState(null); // State to store the current DocEntry

    const [currentPage, setCurrentPage] = useState(1);
    const [itemsPerPage, setItemsPerPage] = useState(10);
    const [totalPages, setTotalPages] = useState(0);

    // Add date filter constant
    const FILTER_DATE = new Date('2024-04-01');

    // Add state to track visible bills per vendor
    const [visibleBills, setVisibleBills] = useState({});

    // Filter bills by date, vendor, and bill number
    const groupedBills = unmatchedBills.reduce((acc, bill) => {
        const billDate = new Date(bill.DocDate);
        if (billDate < FILTER_DATE) return acc;

        const vendorCode = bill.CardCode || bill.VendorCode;
        const billNumber = bill.NumAtCard || '';
        const term = searchTerm.toLowerCase();
        const vendorMatch = String(vendorCode || '').toLowerCase().includes(term) ||
            String(bill.CardName || bill.VendorName || '').toLowerCase().includes(term);
        const billNumberMatch = String(billNumber).toLowerCase().includes(term);

        if (vendorMatch || billNumberMatch) {
            if (!acc[vendorCode]) {
                acc[vendorCode] = {
                    vendorName: bill.CardName || bill.VendorName,
                    vendorGST: bill.GSTRegnNo || bill.VendorGST,
                    bills: []
                };
            }
            acc[vendorCode].bills.push(bill);
        }
        return acc;
    }, {});

    // Filter out vendors with no bills (in case all bills were filtered out by date or search)
    const filteredVendors = Object.entries(groupedBills)
        .filter(([_, data]) => data.bills.length > 0);

    // Calculate total pages
    useEffect(() => {
        const total = Math.ceil(filteredVendors.length / itemsPerPage);
        setTotalPages(total);
    }, [filteredVendors, itemsPerPage]);

    // Reset to page 1 when the view filters change
    useEffect(() => {
        setCurrentPage(1);
    }, [itemsPerPage, searchTerm]);

    // Calculate the current vendors to display based on pagination
    const indexOfLastVendor = currentPage * itemsPerPage;
    const indexOfFirstVendor = indexOfLastVendor - itemsPerPage;
    const currentVendors = filteredVendors.slice(indexOfFirstVendor, indexOfLastVendor);

    const formatAmount = (amount) => {
        if (amount === undefined || amount === null) return "N/A";
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            minimumFractionDigits: 2
        }).format(amount);
    };

    const confirmReconcile = (docEntry) => {
        // For both "Current Unreconciled Bills" and "All Unreconciled Bills"
        setCurrentDocEntry(docEntry); // Store the DocEntry
        setShowGstBillPopup(true); // Show GST/Bill popup
    };

    const handleGstBillSubmit = async () => {
        if (!gstBillData.gst || !gstBillData.bill) {
            alert('Both GST and Bill fields are required');
            return;
        }

        try {
            const database = localStorage.getItem('database');
            const sessionId = localStorage.getItem('sessionId');
            const username = localStorage.getItem('username');

            const bill = unmatchedBills.find(b => b.DocEntry === currentDocEntry);
            if (!bill) {
                throw new Error('Bill not found');
            }

            const response = await fetch(endpoints.updateReconciliation, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${sessionId}`,
                    'X-Database': database
                },
                body: JSON.stringify({
                    docEntry: currentDocEntry,
                    vendorCode: bill.CardCode,
                    vendorName: bill.CardName,
                    vendorGST: bill.GSTRegnNo,
                    billNumber: bill.NumAtCard,
                    billDate: bill.DocDate,
                    totalAmount: bill.DocTotal,
                    CGST: bill.CGST,
                    SGST: bill.SGST,
                    IGST: bill.IGST,
                    username: username || 'Unknown User',
                    excelGST: gstBillData.gst, // Add GST data
                    excelBill: gstBillData.bill // Add Bill data
                })
            });

            if (!response.ok) {
                throw new Error('Failed to reconcile bill');
            }

            const result = await response.json();
            console.log('Reconciliation result:', result);

            // Update the local state
            setReconciledBills(prev => new Set([...prev, currentDocEntry]));
            setGstBillData({ gst: '', bill: '' }); // Reset GST/Bill data
            setShowGstBillPopup(false); // Close the popup
            alert(`Bill with DocEntry ${currentDocEntry} successfully reconciled!`);
        } catch (error) {
            console.error('Reconciliation error:', error);
            alert(`Error: ${error.message}`);
        }
    };

    const handleOptionChange = (e) => {
        const option = e.target.value;
        setReconciliationOption(option);

        // If manual reconciliation is selected, reset the bills to the initial state
        if (option === 'manual') {
            setUnmatchedBills(initialUnmatchedBills);
        }
    };

    // Fetch bills based on the selected option
    useEffect(() => {
        if (reconciliationOption === 'sap') {
            fetchSapBills();
        }
    }, [reconciliationOption]);

    const fetchSapBills = async () => {
        try {
            const database = localStorage.getItem('database');
            const sessionId = localStorage.getItem('sessionId');

            console.log('Fetching SAP bills from:', endpoints.fetchSapBills); // Debugging log

            const response = await fetch(endpoints.fetchSapBills, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${sessionId}`,
                    'X-Database': database
                }
            });

            if (!response.ok) {
                throw new Error('Failed to fetch SAP bills');
            }

            const data = await response.json();
            setUnmatchedBills(data.unmatchedBills);
        } catch (error) {
            console.error('Error fetching SAP bills:', error);
            alert(`Error: ${error.message}`);
        }
    };

    const handleBillSearch = (vendorCode, searchValue) => {
        setBillSearches(prev => ({
            ...prev,
            [vendorCode]: searchValue
        }));
    };

    // Function to show more bills for a vendor
    const showMoreBills = (vendorCode) => {
        setVisibleBills(prev => ({
            ...prev,
            [vendorCode]: (prev[vendorCode] || 10) + 10 // Show 10 more bills
        }));
    };

    // Function to reset visible bills when vendor is collapsed
    const handleVendorToggle = (vendorCode) => {
        if (expandedVendor === vendorCode) {
            // Collapsing the vendor, reset visible bills
            setVisibleBills(prev => ({
                ...prev,
                [vendorCode]: 10
            }));
        }
        setExpandedVendor(expandedVendor === vendorCode ? null : vendorCode);
    };

    // Effect to update the bills when reconciliationOption changes
    useEffect(() => {
        if (reconciliationOption === 'current') {
            // Reset to the original state (current unreconciled bills)
            setUnmatchedBills(initialUnmatchedBills);
        } else if (reconciliationOption === 'all') {
            // Fetch all unreconciled bills
            fetchAllUnreconciledBills();
        }
    }, [reconciliationOption, initialUnmatchedBills]);

    // Function to fetch all unreconciled bills
    const fetchAllUnreconciledBills = async () => {
        try {
            const database = localStorage.getItem('database');
            const sessionId = localStorage.getItem('sessionId');

            if (!database || !sessionId) {
                alert('Please log in first');
                return;
            }

            const response = await fetch(endpoints.fetchSapBills, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${sessionId}`,
                    'X-Database': database
                }
            });

            if (!response.ok) {
                throw new Error('Failed to fetch all unreconciled bills');
            }

            const data = await response.json();
            console.log('Received all unreconciled bills:', data);

            if (data.unmatchedBills && data.unmatchedBills.length > 0) {
                setUnmatchedBills(data.unmatchedBills);
            } else {
                setUnmatchedBills([]);
                alert('No unreconciled bills found');
            }
        } catch (error) {
            console.error('Error fetching all unreconciled bills:', error);
            alert(`Error: ${error.message}`);
        }
    };

    console.log('Source prop:', source); // Add this for debugging

    return (
        <div className={`w-full animate-fade-in ${source === 'sap' ? 'max-w-7xl mx-auto' : ''} ${context ? context : ''}`}>
            {/* Header Area */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
                <h2 className="text-2xl font-bold tracking-tight text-foreground">
                    {source === 'sap' ? 'Unmatched Bills' : 'Unmatched Bills by Vendor'}
                </h2>

                <div className="flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto">
                    {source !== 'sap' && (
                        <select
                            className="h-10 rounded-xl border border-border bg-card px-4 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium min-w-[220px]"
                            value={reconciliationOption}
                            onChange={(e) => setReconciliationOption(e.target.value)}
                        >
                            <option value="current">Current Unreconciled Bills</option>
                            <option value="all">All Unreconciled Bills</option>
                        </select>
                    )}

                    <div className="relative w-full sm:w-64">
                        <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
                        <input
                            type="text"
                            placeholder="Search Vendor / Bill No."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="h-10 w-full rounded-xl border border-border bg-card pl-10 pr-4 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-muted-foreground outline-none shadow-sm"
                        />
                    </div>
                </div>
            </div>

            {/* GST/Bill Popup */}
            {showGstBillPopup && createPortal(
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-fade-in">
                    <div className="bg-card border border-border w-full max-w-sm rounded-2xl shadow-xl overflow-hidden animate-slide-up p-6">
                        <h3 className="text-xl font-bold text-foreground mb-4">Enter Details</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-foreground mb-1">Excel GST:</label>
                                <input
                                    type="text"
                                    value={gstBillData.gst}
                                    onChange={(e) => setGstBillData({ ...gstBillData, gst: e.target.value })}
                                    className="h-10 w-full rounded-xl border border-border bg-background px-4 text-sm focus:ring-2 flex items-center"
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-foreground mb-1">Excel Bill:</label>
                                <input
                                    type="text"
                                    value={gstBillData.bill}
                                    onChange={(e) => setGstBillData({ ...gstBillData, bill: e.target.value })}
                                    className="h-10 w-full rounded-xl border border-border bg-background px-4 text-sm focus:ring-2 flex items-center"
                                    required
                                />
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 mt-6">
                            <button
                                onClick={() => setShowGstBillPopup(false)}
                                className="px-4 py-2 rounded-xl border border-border bg-card text-foreground hover:bg-accent transition-colors text-sm font-medium"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleGstBillSubmit}
                                className="px-4 py-2 rounded-xl border border-border bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-medium shadow-sm"
                            >
                                Submit
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {/* Vendor List */}
            {currentVendors.length === 0 ? (
                <div className="bg-card rounded-2xl border border-border p-12 text-center shadow-sm">
                    <p className="text-muted-foreground">
                        {searchTerm ? 'No vendors match your search.' : 'No unmatched bills found for the selected period.'}
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    {currentVendors.map(([vendorCode, data]) => (
                        <div key={vendorCode} className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm transition-all hover:border-primary/30">
                            {/* Vendor Header */}
                            <div
                                className="px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-accent/30 transition-colors"
                                onClick={() => handleVendorToggle(vendorCode)}
                            >
                                <div>
                                    <h3 className="text-lg font-bold text-foreground">{data.vendorName}</h3>
                                    <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                                        <span className="bg-muted px-2 py-0.5 rounded-md font-medium text-xs">{vendorCode}</span>
                                        <span>•</span>
                                        <span>GST: <span className="text-foreground">{data.vendorGST || 'N/A'}</span></span>
                                        <span>•</span>
                                        <span>{data.bills.length} Bill{data.bills.length !== 1 ? 's' : ''}</span>
                                    </div>
                                </div>
                                <div className="text-muted-foreground p-2 rounded-full hover:bg-muted transition-colors">
                                    {expandedVendor === vendorCode ? <FiChevronDown size={20} /> : <FiChevronRight size={20} />}
                                </div>
                            </div>

                            {/* Expanded Bills Grid */}
                            {expandedVendor === vendorCode && (
                                <div className="border-t border-border bg-muted/10 p-6 animate-fade-in">
                                    <div className="mb-4">
                                        <div className="relative max-w-sm">
                                            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
                                            <input
                                                type="text"
                                                placeholder="Search by Bill Number..."
                                                value={billSearches[vendorCode] || ''}
                                                onChange={(e) => handleBillSearch(vendorCode, e.target.value)}
                                                className="h-9 w-full rounded-xl border border-border bg-card pl-9 pr-4 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all outline-none"
                                            />
                                        </div>
                                    </div>

                                    <div className="overflow-x-auto overflow-y-auto max-h-[350px] relative rounded-xl border border-border bg-card shadow-sm">
                                        <table className="w-full text-sm text-left">
                                            <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border sticky top-0 z-10 backdrop-blur-md">
                                                <tr>
                                                    <th className="px-6 py-3 font-medium">Bill Number</th>
                                                    <th className="px-6 py-3 font-medium">Date</th>
                                                    <th className="px-6 py-3 font-medium text-right">Total Amount</th>
                                                    <th className="px-6 py-3 font-medium text-right">CGST</th>
                                                    <th className="px-6 py-3 font-medium text-right">SGST</th>
                                                    <th className="px-6 py-3 font-medium text-right">IGST</th>
                                                    {!readOnly && <th className="px-6 py-3 font-medium text-center">Action</th>}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {data.bills
                                                    .filter(bill => {
                                                        if (!billSearches[vendorCode]) return true;
                                                        const billNumber = bill.NumAtCard || '';
                                                        return billNumber.toString().toLowerCase().includes(
                                                            billSearches[vendorCode].toLowerCase()
                                                        );
                                                    })
                                                    .slice(0, visibleBills[vendorCode] || 10)
                                                    .map((bill, index) => (
                                                        <tr key={bill.DocEntry} className={`border-b border-border/40 hover:bg-accent/30 transition-colors ${index % 2 === 0 ? '' : 'bg-muted/5'}`}>
                                                            <td className="px-6 py-3 font-medium text-foreground">{bill.NumAtCard || 'NA'}</td>
                                                            <td className="px-6 py-3 text-foreground/80">{bill.DocDate ? new Date(bill.DocDate).toLocaleDateString('en-GB') : 'N/A'}</td>
                                                            <td className="px-6 py-3 text-foreground/90 font-medium text-right">{formatAmount(bill.DocTotal)}</td>
                                                            <td className="px-6 py-3 text-muted-foreground text-right">{formatAmount(bill.CGST)}</td>
                                                            <td className="px-6 py-3 text-muted-foreground text-right">{formatAmount(bill.SGST)}</td>
                                                            <td className="px-6 py-3 text-muted-foreground text-right">{formatAmount(bill.IGST)}</td>
                                                            {!readOnly && (
                                                            <td className="px-6 py-3 flex justify-center">
                                                                <button
                                                                    onClick={() => confirmReconcile(bill.DocEntry)}
                                                                    disabled={reconciledBills.has(bill.DocEntry)}
                                                                    className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                                                        reconciledBills.has(bill.DocEntry)
                                                                            ? 'bg-muted text-muted-foreground cursor-not-allowed border border-border'
                                                                            : 'bg-primary/10 text-primary hover:bg-primary hover:text-white border border-primary/20 hover:border-primary'
                                                                    }`}
                                                                >
                                                                    {reconciledBills.has(bill.DocEntry) ? 'Reconciled' : 'Reconcile'}
                                                                </button>
                                                            </td>
                                                            )}
                                                        </tr>
                                                    ))}
                                            </tbody>
                                        </table>
                                    </div>

                                    {/* Show More button if there are more bills */}
                                    {data.bills.length > (visibleBills[vendorCode] || 10) && (
                                        <div className="flex justify-center mt-6">
                                            <button
                                                className="px-6 py-2 rounded-full border border-border bg-card text-foreground text-sm font-medium hover:bg-accent hover:border-primary/30 transition-all shadow-sm"
                                                onClick={() => showMoreBills(vendorCode)}
                                            >
                                                Load More Bills
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* Pagination Controls */}
            {filteredVendors.length > 0 && (
                <Pagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={setCurrentPage}
                    totalItems={filteredVendors.length}
                    pageSize={itemsPerPage}
                    onPageSizeChange={setItemsPerPage}
                    className="mt-8 px-2"
                />
            )}
        </div>
    );
};

export default UnmatchedBills;
