import assert from "node:assert/strict";
import { test } from "node:test";

import { crc32, zipFiles } from "./zip";

const WHEN = new Date(2026, 8, 27, 4, 30, 0);

test("crc32 matches the standard check values", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test("a zip holds every file, stored, with its name and crc", () => {
  const files = { "v2/harness.md": "# Harness\n", "v2/harness/loop.ts": "export const x = 1;\n" };
  const zip = zipFiles(files, WHEN);
  const view = new DataView(zip.buffer);

  // The end record sits in the last 22 bytes and counts both files.
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);

  let at = 0;
  for (const [path, body] of Object.entries(files)) {
    const data = new TextEncoder().encode(body);
    assert.equal(view.getUint32(at, true), 0x04034b50);
    assert.equal(view.getUint16(at + 8, true), 0, "method 0: stored");
    assert.equal(view.getUint32(at + 14, true), crc32(data));
    assert.equal(view.getUint32(at + 18, true), data.length);
    const nameLength = view.getUint16(at + 26, true);
    assert.equal(new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLength)), path);
    assert.deepEqual(zip.subarray(at + 30 + nameLength, at + 30 + nameLength + data.length), data);
    at += 30 + nameLength + data.length;
  }
  // The central directory starts right after the last file and ends at the end record.
  assert.equal(view.getUint32(end + 16, true), at);
  assert.equal(view.getUint32(end + 12, true), end - at);
});
