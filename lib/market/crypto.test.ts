import assert from "node:assert/strict";
import { test } from "node:test";

import { accessPublicKey, decryptText, docsHash, encryptText, newAccessKeyPair, newFileKey, openFileKey, sealFileKey } from "./crypto";

test("a file key encrypts and decrypts text", () => {
  const key = newFileKey();
  const blob = encryptText(key, "# Instructions\n\nBe exact.");
  assert.notEqual(blob, encryptText(key, "# Instructions\n\nBe exact."), "a new nonce each time");
  assert.equal(decryptText(key, blob), "# Instructions\n\nBe exact.");
  assert.throws(() => decryptText(newFileKey(), blob), "the wrong key fails");
});

test("a sealed file key opens only with the matching secret", () => {
  const key = newFileKey();
  const me = newAccessKeyPair();
  const other = newAccessKeyPair();
  assert.equal(accessPublicKey(me.secretKey), me.publicKey);
  const sealed = sealFileKey(key, me.publicKey);
  assert.equal(openFileKey(sealed, me.secretKey), key);
  assert.throws(() => openFileKey(sealed, other.secretKey));
});

test("the docs hash depends on the content and not on the order", () => {
  const a = docsHash({ "a.md": "1", "b.md": "2" });
  assert.equal(a, docsHash({ "b.md": "2", "a.md": "1" }));
  assert.notEqual(a, docsHash({ "a.md": "1", "b.md": "3" }));
});
