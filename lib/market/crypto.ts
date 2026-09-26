/**
 * The encryption behind the harness market. Pure, and the same in the browser
 * and on the server.
 *
 * Every version's documents are encrypted once with a random 32-byte file key
 * (XChaCha20-Poly1305). The ciphertext goes into the version's text records,
 * where anyone can see it and nobody can read it.
 *
 * The file key is never on chain in the clear. For each chosen verifier, and
 * each buyer, the platform seals the key to that person's access key: an
 * X25519-style ECDH on secp256k1, then XChaCha20-Poly1305 again. The sealed
 * key goes into that person's own text record. Only their secret key opens it.
 *
 * The access key pair lives in the person's browser. They prove it is theirs
 * by signing its public key with their wallet (see access.ts).
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getPublicKey, getSharedSecret } from "@noble/secp256k1";

const NONCE_BYTES = 24;

/** "0x" + hex, the form every record and every API uses. */
export type Hex0x = `0x${string}`;
const hex = (b: Uint8Array): Hex0x => `0x${bytesToHex(b)}`;
const bytes = (h: string): Uint8Array => hexToBytes(h.replace(/^0x/, ""));

/** A fresh 32-byte file key. */
export const newFileKey = (): Hex0x => hex(randomBytes(32));

/** A fresh access key pair. The secret stays in the browser. */
export function newAccessKeyPair(): { secretKey: Hex0x; publicKey: Hex0x } {
  const sk = randomBytes(32);
  return { secretKey: hex(sk), publicKey: hex(getPublicKey(sk, true)) };
}

/** The public key of an access secret key, compressed (33 bytes). */
export const accessPublicKey = (secretKey: string): Hex0x => hex(getPublicKey(bytes(secretKey), true));

/** Encrypts text with a file key. The result is nonce ‖ ciphertext, as hex. */
export function encryptText(fileKey: string, text: string): Hex0x {
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(bytes(fileKey), nonce).encrypt(utf8ToBytes(text));
  return hex(concatBytes(nonce, sealed));
}

/** The reverse of encryptText. Throws when the key is wrong or the data was changed. */
export function decryptText(fileKey: string, blob: string): string {
  const data = bytes(blob);
  const plain = xchacha20poly1305(bytes(fileKey), data.slice(0, NONCE_BYTES)).decrypt(data.slice(NONCE_BYTES));
  return new TextDecoder().decode(plain);
}

/** The symmetric key two parties share: sha256 of the ECDH point. */
function sharedKey(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return sha256(getSharedSecret(secretKey, publicKey, true));
}

/**
 * Seals the file key to one access public key. The result is
 * ephemeralPublicKey (33) ‖ nonce (24) ‖ ciphertext, as hex. A new ephemeral
 * key per call, so two seals of one key never look alike.
 */
export function sealFileKey(fileKey: string, toPublicKey: string): Hex0x {
  const eph = randomBytes(32);
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(sharedKey(eph, bytes(toPublicKey)), nonce).encrypt(bytes(fileKey));
  return hex(concatBytes(getPublicKey(eph, true), nonce, sealed));
}

/** Opens a sealed file key with the access secret key it was sealed to. */
export function openFileKey(sealed: string, secretKey: string): Hex0x {
  const data = bytes(sealed);
  const eph = data.slice(0, 33);
  const nonce = data.slice(33, 33 + NONCE_BYTES);
  const key = xchacha20poly1305(sharedKey(bytes(secretKey), eph), nonce).decrypt(data.slice(33 + NONCE_BYTES));
  return hex(key);
}

/** The hash of the plain documents, so a reader can prove what they read. */
export function docsHash(docs: Record<string, string>): Hex0x {
  const names = Object.keys(docs).sort();
  const parts = names.flatMap((n) => [utf8ToBytes(n), new Uint8Array([0]), utf8ToBytes(docs[n]), new Uint8Array([0])]);
  return hex(sha256(concatBytes(...parts)));
}
