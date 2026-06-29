/**
 * Cache-buster timestamp formatters. Mirrors Rust `core/time.rs`
 * (WPF `GetCurrentTime`). Both use LOCAL time (matches .NET `DateTime.Now`).
 */

const p2 = (n: number) => String(n).padStart(2, '0');
const p3 = (n: number) => String(n).padStart(3, '0');

/**
 * `Y(M-1)DDhhmmssfff` — the `?dt=` cache buster on `game_zone/*.aspx`.
 *
 * Quirk (1:1 with WPF/Rust): month is **0-indexed and NOT zero-padded**
 * (Jan -> "0", Oct -> "9", Dec -> "11"). `Date.getMonth()` is already
 * 0-indexed, so we use it directly. Everything else is zero-padded.
 *
 * e.g. 2024-01-05 03:09:07.042 -> "2024005030907042".
 */
export function dtCompact(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}${d.getMonth()}` +
    `${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${p3(d.getMilliseconds())}`
  );
}

/**
 * `yyyyMMddHHmmss.fff` — the `?_=` cache buster on `get_result.ashx`.
 * e.g. 2024-01-05 03:09:07.042 -> "20240105030907.042".
 */
export function dtIso(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
  );
}
