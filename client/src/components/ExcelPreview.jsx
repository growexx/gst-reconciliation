import React from 'react';

const ExcelPreview = ({ data }) => {
  if (!data || data.length === 0) return null;

  return (
    <div className="w-full h-full flex flex-col bg-card">
      <div className="flex-1 overflow-auto rounded-xl border border-border shadow-sm m-4 mt-0 bg-background">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border sticky top-0 z-10 backdrop-blur-sm">
            <tr>
              {Object.keys(data[0]).map((header, index) => (
                <th key={index} className="px-6 py-3 font-medium whitespace-nowrap">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {data.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-muted/30 transition-colors">
                {Object.values(row).map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-6 py-3 whitespace-nowrap text-foreground">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ExcelPreview;
