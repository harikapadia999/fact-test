export const formatDuration = (minutes: number) => {
  if (minutes === 0) return "0 sec";
  if (minutes < 1) {
    return `${Math.round(minutes * 60)} sec`;
  } else if (minutes < 60) {
    return `${minutes.toFixed(1)} min`;
  } else {
    return `${(minutes / 60).toFixed(2)} hrs`;
  }
};

export const formatReportDate = (
  isoString: string,
  startDate?: string,
  endDate?: string,
) => {
  const d = new Date(isoString);
  if (startDate && endDate && startDate === endDate) {
    return d.toLocaleTimeString("en-US", { hour12: false });
  }
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
};
