// Age and pregnancy labels (F5). All maths is on calendar dates in UTC, so time zones
// and daylight saving can never shift a date by a day.

const DAY = 86400000;
const toDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY : null;
};

// Whole calendar months between two YYYY-MM-DD dates (a - b >= 0 assumed).
function monthsBetween(from, to) {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let m = (ty - fy) * 12 + (tm - fm);
  if (td < fd) m -= 1;
  return Math.max(0, m);
}

/**
 * Where an event falls in the child's life.
 * Returns { phase, label, sort } where sort orders groups chronologically.
 *  - before birth, with a due date: "Pregnancy, week N" (40 weeks ends on the due date)
 *  - before birth, no due date: "Before birth"
 *  - birth day: "Birth day"; first weeks: "Week N"; then "Month N"; then "N years, M months"
 */
export function lifeStage(eventDate, { dob, due_date } = {}) {
  const e = toDay(eventDate);
  if (e === null) return { phase: "unknown", label: "Undated", sort: -1e9 };
  const b = toDay(dob);
  if (b === null || e < b) {
    const d = toDay(due_date);
    if (d !== null) {
      // Pregnancy is 280 days ending on the due date. Weeks are completed weeks, as people
      // say them (the due date is week 40); the first fortnight is shown as week 1.
      const daysIn = 280 - (d - e);
      if (daysIn < 0) return { phase: "pregnancy", label: "Before pregnancy", sort: -1 };
      const week = Math.min(42, Math.max(1, Math.floor(daysIn / 7)));
      return { phase: "pregnancy", label: `Pregnancy, week ${week}`, sort: week };
    }
    return { phase: "pregnancy", label: b === null ? "Journal" : "Before birth", sort: 0 };
  }
  const days = e - b;
  if (days === 0) return { phase: "birth", label: "Birth day", sort: 100 };
  if (days < 56) {
    const w = Math.floor(days / 7) + 1;
    return { phase: "newborn", label: `Week ${w}`, sort: 100 + w };
  }
  const months = monthsBetween(dob, eventDate);
  if (months < 24) return { phase: "infant", label: `Month ${months}`, sort: 200 + months };
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return { phase: "child", label: rem ? `${years} years, ${rem} months` : `${years} years`, sort: 200 + months };
}

// "3 weeks old", "4 months old": the child's age on a given date, for entry headers.
export function ageOn(eventDate, { dob } = {}) {
  const e = toDay(eventDate), b = toDay(dob);
  if (e === null || b === null) return "";
  const days = e - b;
  if (days < 0) return "";
  if (days === 0) return "Born today";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} old`;
  if (days < 56) return `${Math.floor(days / 7)} weeks old`;
  const m = monthsBetween(dob, eventDate);
  if (m < 24) return `${m} month${m === 1 ? "" : "s"} old`;
  const y = Math.floor(m / 12), r = m % 12;
  return r ? `${y} years, ${r} months old` : `${y} years old`;
}

export function formatDate(s, locale) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return s || "";
  // Noon UTC keeps the same calendar day in every time zone.
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
