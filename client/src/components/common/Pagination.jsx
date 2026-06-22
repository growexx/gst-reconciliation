import React from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '../../lib/utils';

export function Pagination({
    currentPage,
    totalPages,
    onPageChange,
    totalItems,
    pageSize,
    onPageSizeChange,
    className
}) {
    const startIdx = (currentPage - 1) * pageSize + 1;
    const endIdx = Math.min(currentPage * pageSize, totalItems);

    return (
        <div className={cn("flex items-center justify-between", className)}>
            <div className="flex items-center gap-4">
                <p className="text-muted-foreground italic font-medium text-[10px]">
                    Showing {startIdx} - {endIdx} of {totalItems}
                </p>

                {onPageSizeChange && (
                    <div className="flex items-center gap-1.5 border-l border-border pl-4">
                        <span className="text-muted-foreground font-medium text-[10px]">Rows:</span>
                        <select
                            value={pageSize}
                            onChange={(e) => onPageSizeChange(Number(e.target.value))}
                            className="bg-card border border-border rounded-lg text-foreground font-bold focus:outline-none focus:border-primary/50 transition-all cursor-pointer text-[10px] px-2 py-1"
                        >
                            {[10, 25, 50, 100].map(size => (
                                <option key={size} value={size}>{size}</option>
                            ))}
                        </select>
                    </div>
                )}
            </div>
            <div className="flex items-center gap-1.5 font-bold">
                <button
                    onClick={() => onPageChange(1)}
                    disabled={currentPage === 1}
                    className="p-1.5 rounded-lg border border-border bg-card text-muted-foreground disabled:opacity-20 hover:bg-muted active:scale-95 transition-all overflow-hidden"
                >
                    <ChevronsLeft className="w-4 h-4" />
                </button>
                <button
                    onClick={() => onPageChange(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    className="p-1.5 rounded-lg border border-border bg-card text-muted-foreground disabled:opacity-20 hover:bg-muted active:scale-95 transition-all overflow-hidden"
                >
                    <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="flex items-center justify-center bg-primary text-primary-foreground rounded-lg font-black shadow-lg shadow-primary/20 min-w-[32px] h-8 text-xs">
                    {currentPage}
                </span>
                <button
                    onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage === totalPages}
                    className="p-1.5 rounded-lg border border-border bg-card text-muted-foreground disabled:opacity-20 hover:bg-muted active:scale-95 transition-all overflow-hidden"
                >
                    <ChevronRight className="w-4 h-4" />
                </button>
                <button
                    onClick={() => onPageChange(totalPages)}
                    disabled={currentPage === totalPages}
                    className="p-1.5 rounded-lg border border-border bg-card text-muted-foreground disabled:opacity-20 hover:bg-muted active:scale-95 transition-all overflow-hidden"
                >
                    <ChevronsRight className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}

export default Pagination;
