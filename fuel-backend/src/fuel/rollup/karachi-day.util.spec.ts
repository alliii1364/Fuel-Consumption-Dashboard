import { karachiDayStrs, dayUtcRange, isDayAligned } from './karachi-day.util';

describe('karachi-day.util', () => {
  it('dayUtcRange maps a Karachi day to [prev 19:00Z, 19:00Z)', () => {
    const { start, end } = dayUtcRange('2026-06-01');
    expect(start.toISOString()).toBe('2026-05-31T19:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T19:00:00.000Z');
  });
  it('isDayAligned true only at Karachi midnight (19:00Z)', () => {
    expect(isDayAligned(new Date('2026-06-01T19:00:00.000Z'))).toBe(true);
    expect(isDayAligned(new Date('2026-06-01T18:30:00.000Z'))).toBe(false);
  });
  it('karachiDayStrs lists full days inside an aligned range', () => {
    const days = karachiDayStrs(
      new Date('2026-05-31T19:00:00.000Z'), // Karachi 2026-06-01 00:00
      new Date('2026-06-03T19:00:00.000Z'), // Karachi 2026-06-04 00:00
    );
    expect(days).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });
});
