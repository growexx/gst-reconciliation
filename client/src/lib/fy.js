// Calendar month/year helpers for the period pickers (the Reconcile upload window and
// the Unmatched/Matched filter). GST 2B is filed per CALENDAR month, so a "period" is a
// calendar month + calendar year — "2026" means calendar 2026 (Jan–Dec 2026).

export const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const MONTH_LABEL = {
  Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June',
  Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December',
};

export function currentYear(now = new Date()) { return now.getFullYear(); }

// Year options: current year + `pastYears` past years, latest first, NEVER a future year.
// `include` keeps an already-selected (possibly older) year in the list.
export function yearOptions(pastYears = 5, include) {
  const cur = new Date().getFullYear();
  const ys = new Set();
  for (let i = 0; i <= pastYears; i += 1) ys.add(cur - i);
  if (Number(include)) ys.add(Number(include));
  return [...ys].filter((y) => y <= cur).sort((a, b) => b - a).map(String);
}

// Months valid for a year: the current year shows Jan → the current month (no future
// months); a past year shows all 12 (Jan→Dec).
export function monthsForYear(year) {
  const now = new Date();
  return Number(year) >= now.getFullYear() ? CAL_MONTHS.slice(0, now.getMonth() + 1) : CAL_MONTHS;
}
