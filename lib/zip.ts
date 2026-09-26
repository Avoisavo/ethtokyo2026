/**
 * A minimal zip writer: files are stored, not compressed. It runs in the
 * browser and in Node. The harness files are a few KB, so compression does
 * not matter, and a stored zip needs no library.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The CRC-32 the zip format uses. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date, as zip headers store them. Local time, 2-second steps. */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Bit 11: the file names are UTF-8. */
const UTF8_NAMES = 0x0800;

/** Builds a zip from `path → contents`. Paths use `/` and may hold folders. */
export function zipFiles(files: Record<string, string | Uint8Array>, when: Date = new Date()): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const { time, date } = dosTime(when);
  const entries = Object.entries(files).map(([path, body]) => {
    const name = enc.encode(path);
    const data = typeof body === "string" ? enc.encode(body) : body;
    return { name, data, crc: crc32(data) };
  });

  const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v: number) => { view.setUint16(at, v, true); at += 2; };
  const u32 = (v: number) => { view.setUint32(at, v, true); at += 4; };
  const bytes = (b: Uint8Array) => { out.set(b, at); at += b.length; };

  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(at);
    u32(0x04034b50); u16(20); u16(UTF8_NAMES); u16(0); u16(time); u16(date);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0);
    bytes(e.name); bytes(e.data);
  }
  const centralStart = at;
  entries.forEach((e, i) => {
    u32(0x02014b50); u16(20); u16(20); u16(UTF8_NAMES); u16(0); u16(time); u16(date);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length);
    u16(0); u16(0); u16(0); u16(0); u32(0); u32(offsets[i]!);
    bytes(e.name);
  });
  const centralLength = at - centralStart;
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
  u32(centralLength); u32(centralStart); u16(0);
  return out;
}
