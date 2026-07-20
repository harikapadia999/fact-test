export const formatDurationInWords = (minutes: number) => {
  if (!minutes || minutes <= 0) return "0 seconds";
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  const s = Math.round((minutes * 60) % 60);

  const parts = [];
  if (h > 0) parts.push(`${h} hour${h !== 1 ? "s" : ""}`);
  if (m > 0) parts.push(`${m} minute${m !== 1 ? "s" : ""}`);
  if (s > 0) parts.push(`${s} second${s !== 1 ? "s" : ""}`);

  return parts.join(" ") || "0 seconds";
};

export const formatDurationHHMMSS = (minutes: number) => {
  if (!minutes || minutes <= 0) return "00:00:00";
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  const s = Math.round((minutes * 60) % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

export const formatDuration = (minutes: number) => {
  if (!minutes || minutes <= 0) return "0 sec";
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  const s = Math.round((minutes * 60) % 60);

  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);

  return parts.join(" ") || "0s";
};

export const formatReportDate = (
  isoString: string,
  startDate?: string,
  endDate?: string
) => {
  const d = new Date(isoString);
  if (startDate && endDate && startDate === endDate) {
    return d.toLocaleTimeString("en-US", {
      hour12: false,
      timeZone: "Asia/Kolkata",
    });
  }
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
};

export const formatDateDMY = (dateInput: string | Date | number) => {
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).formatToParts(d);
    const day = parts.find((p) => p.type === "day")?.value || "";
    const month = parts.find((p) => p.type === "month")?.value || "";
    const year = parts.find((p) => p.type === "year")?.value || "";
    return `${day}/${month}/${year}`;
  } catch (e) {
    return "";
  }
};
