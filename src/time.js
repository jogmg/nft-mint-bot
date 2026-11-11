// time.js — human-readable time formatting in the configured display timezone.
// Priority: TIMEZONE env > local system timezone > UTC.
export function resolveDisplayTimeZone() {
  const envZone = process.env.TIMEZONE;
  if (envZone && envZone.trim()) return envZone.trim();

  const localeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return localeZone || "UTC";
}

function formatPart(parts, type, fallback = "") {
  return parts.find((p) => p.type === type)?.value ?? fallback;
}

// Format a unix-seconds timestamp in the active display timezone, e.g.
// "Wed, 11 Nov 2026 13:00 UTC" or "Wed, 11 Nov 2026 14:00 GMT+1".
export function fmtWAT(unixSec) {
  if (!unixSec || unixSec <= 0) return "—";

  const timeZone = resolveDisplayTimeZone();
  const date = new Date(unixSec * 1000);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });

  const parts = formatter.formatToParts(date);
  const weekday = formatPart(parts, "weekday", "Wed");
  const day = formatPart(parts, "day", "11");
  const month = formatPart(parts, "month", "Nov");
  const year = formatPart(parts, "year", "2026");
  const hour = formatPart(parts, "hour", "00");
  const minute = formatPart(parts, "minute", "00");
  const zone = formatPart(parts, "timeZoneName", timeZone);

  return `${weekday}, ${day} ${month} ${year} ${hour}:${minute} ${zone}`;
}

// Back-compat alias; keep old callers working while the display timezone is
// resolved dynamically from env/local settings.
export const fmtWIB = fmtWAT;

// Format a Date/ms value in the active display timezone.
export function fmtWATms(ms) {
  return fmtWAT(Math.floor(ms / 1000));
}

// Human-readable relative duration, e.g. "2m 5s", "45s", "2h".
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const day = Math.floor(h / 24);
  return `${day}d ${h % 24}h`;
}
