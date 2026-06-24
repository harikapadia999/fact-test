import React from "react";
import { motion } from "motion/react";
import { X, FileText, Download, RefreshCw } from "lucide-react";
import { TelemetryDetails, Node } from "../types";
import {
  formatDuration,
  formatReportDate,
  formatDurationHHMMSS,
  formatDurationInWords,
} from "../utils";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import ExcelJS from "exceljs";
import { saveAs } from "file-saver";

interface DetailedReportModalProps {
  show: boolean;
  onClose: () => void;
  selectedNode: Node | null;
  startDate: string;
  endDate: string;
  data: TelemetryDetails[];
  loading: boolean;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
}

export function DetailedReportModal({
  show,
  onClose,
  selectedNode,
  startDate,
  endDate,
  data,
  loading,
  onStartDateChange,
  onEndDateChange,
}: DetailedReportModalProps) {
  if (!show) return null;

  const exportToPDF = () => {
    const doc = new jsPDF();
    doc.text(
      `Telemetry Report for Node: ${selectedNode?.alias || selectedNode?.id}`,
      14,
      15
    );
    doc.text(`Date Range: ${startDate} to ${endDate}`, 14, 25);

    autoTable(doc, {
      startY: 30,
      head: [
        [
          "Date",
          "ON Time",
          "OFF Time",
          "Working Time",
          "Working Time(In Words)",
        ],
      ],
      body: data.map((log) => [
        new Date(log.onTime).toLocaleDateString("en-US"),
        formatReportDate(log.onTime, startDate, endDate),
        formatReportDate(log.offTime, startDate, endDate),
        formatDurationHHMMSS(log.durationMinutes),
        formatDurationInWords(log.durationMinutes),
      ]),
      foot: [
        [
          "Total",
          "",
          "",
          formatDurationHHMMSS(
            data.reduce((acc, curr) => acc + curr.durationMinutes, 0)
          ),
          formatDurationInWords(
            data.reduce((acc, curr) => acc + curr.durationMinutes, 0)
          ),
        ],
      ],
      showFoot: "lastPage",
    });

    doc.save(`telemetry_report_${selectedNode?.id}_${startDate}.pdf`);
  };

  const exportToExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Telemetry");

    // Add Title and Date Range
    sheet.addRow([
      `Telemetry Report for Node: ${selectedNode?.alias || selectedNode?.id}`,
    ]);
    sheet.addRow([`Date Range: ${startDate} to ${endDate}`]);
    sheet.addRow([]); // empty row for spacing

    // Style Title
    sheet.getCell("A1").font = { size: 16, bold: true };
    sheet.getCell("A2").font = { size: 14 };

    // Define columns (starting from row 4)
    const headerRow = sheet.addRow([
      "Date",
      "ON Time",
      "OFF Time",
      "Working Time",
      "Working Time(In Words)",
    ]);

    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF2980B9" },
      };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    data.forEach((log) => {
      sheet.addRow([
        new Date(log.onTime).toLocaleDateString("en-US"),
        formatReportDate(log.onTime, startDate, endDate),
        formatReportDate(log.offTime, startDate, endDate),
        formatDurationHHMMSS(log.durationMinutes),
        formatDurationInWords(log.durationMinutes),
      ]);
    });

    const totalMinutes = data.reduce(
      (acc, curr) => acc + curr.durationMinutes,
      0
    );
    const totalRow = sheet.addRow([
      "Total",
      "",
      "",
      formatDurationHHMMSS(totalMinutes),
      formatDurationInWords(totalMinutes),
    ]);

    totalRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF2980B9" },
      };
    });

    // Auto-fit columns
    sheet.columns.forEach((column, index) => {
      let maxLength = 0;
      // skip the first 3 rows for length calculation
      column.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
        if (rowNumber > 3) {
          const columnLength = cell.value ? cell.value.toString().length : 10;
          if (columnLength > maxLength) {
            maxLength = columnLength;
          }
        }
      });
      column.width = maxLength < 10 ? 10 : maxLength + 2;
    });

    const buffer = (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    saveAs(blob, `telemetry_report_${selectedNode?.id}_${startDate}.xlsx`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
      />
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 20 }}
        className="relative w-full max-w-2xl bg-white rounded-[32px] p-8 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
      >
        <div className="flex items-start justify-between mb-6 shrink-0">
          <div>
            <h3 className="text-xl font-black text-slate-800">
              Detailed Report
            </h3>
            <div className="mt-3 flex items-center gap-2">
              <label className="text-sm text-slate-500 font-medium">
                Start Date:
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => onStartDateChange(e.target.value)}
                className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-slate-50"
              />
              <label className="text-sm text-slate-500 font-medium ml-2">
                End Date:
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => onEndDateChange(e.target.value)}
                className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-slate-50"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={exportToPDF}
              title="Export to PDF"
              className="p-2 hover:bg-slate-100 text-red-600 rounded-full transition-colors"
            >
              <FileText className="w-5 h-5" />
            </button>
            <button
              onClick={exportToExcel}
              title="Export to Excel"
              className="p-2 hover:bg-slate-100 text-green-600 rounded-full transition-colors"
            >
              <Download className="w-5 h-5" />
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-100 rounded-full transition-colors"
            >
              <X className="w-5 h-5 text-slate-400" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 pr-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
            </div>
          ) : data.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              No detailed logs available for this date range.
            </div>
          ) : (
            <div className="bg-slate-50 rounded-2xl border border-slate-100 overflow-hidden">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-100/50 text-slate-500 text-[10px] uppercase tracking-widest sticky top-0 backdrop-blur-md">
                  <tr>
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">ON Time</th>
                    <th className="px-4 py-3 font-medium">OFF Time</th>
                    <th className="px-4 py-3 font-medium text-right">
                      Working Time
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.map((log, i) => (
                    <tr
                      key={i}
                      className="hover:bg-slate-50/50 transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-slate-700">
                        {new Date(log.onTime).toLocaleDateString("en-US")}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-700">
                        {formatReportDate(log.onTime, startDate, endDate)}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-700">
                        {formatReportDate(log.offTime, startDate, endDate)}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-900 font-medium text-right">
                        {formatDuration(log.durationMinutes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-100/50 font-bold text-slate-900 border-t-2 border-slate-200 sticky bottom-0">
                  <tr>
                    <td
                      colSpan={3}
                      className="px-4 py-3 text-right uppercase tracking-widest text-[11px] text-slate-500"
                    >
                      Total
                    </td>
                    <td className="px-4 py-3 font-mono text-right">
                      {formatDuration(
                        data.reduce(
                          (acc, curr) => acc + curr.durationMinutes,
                          0
                        )
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
