const KHI_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5, no DST in Pakistan

/** UTC bounds of a Karachi calendar day `YYYY-MM-DD`. */
export function dayUtcRange(dayStr: string): { start: Date; end: Date } {
  const start = new Date(`${dayStr}T00:00:00.000Z`).getTime() - KHI_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + 24 * 60 * 60 * 1000) };
}

/** True when `d` sits exactly on a Karachi midnight boundary. */
export function isDayAligned(d: Date): boolean {
  return (d.getTime() + KHI_OFFSET_MS) % (24 * 60 * 60 * 1000) === 0;
}

/** Karachi YYYY-MM-DD of an instant. */
function toKarachiDayStr(d: Date): string {
  return new Date(d.getTime() + KHI_OFFSET_MS).toISOString().slice(0, 10);
}

/** Full Karachi days entirely inside [from, to). */
export function karachiDayStrs(from: Date, to: Date): string[] {
  const firstFull = isDayAligned(from)
    ? from
    : dayUtcRange(toKarachiDayStr(new Date(from.getTime() + 24 * 60 * 60 * 1000))).start;
  const out: string[] = [];
  for (let s = firstFull.getTime(); s + 24 * 60 * 60 * 1000 <= to.getTime(); s += 24 * 60 * 60 * 1000) {
    out.push(toKarachiDayStr(new Date(s)));
  }
  return out;
}
