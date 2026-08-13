// Ed25519 signing inside the Workers runtime.
//
// js/tx.js signs with node:crypto, which does not exist in a Worker.
// Spec §9 flagged "confirm a pure-JS/WASM ed25519 signing path works inside the
// Workers runtime" as an open item back when signing was a background job; the
// first-buy flow (§3.6) puts it on the synchronous path of every purchase, so
// it is now load-bearing.
//
// WebCrypto covers it, with one wrinkle: the algorithm name. Workers shipped
// Ed25519 as the non-standard `NODE-ED25519` before the WebCrypto spec settled
// on `Ed25519`, and which one a given runtime accepts depends on its compat
// date. Both are tried rather than guessed at, once, and the working one is
// cached — an import per signature would be a real cost on a hot path.
//
// The signing key never leaves this module and is never serialized anywhere.

const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
]);

const ALGORITHMS = ['Ed25519', 'NODE-ED25519'];

function pkcs8From(seed) {
  const der = new Uint8Array(PKCS8_PREFIX.length + 32);
  der.set(PKCS8_PREFIX);
  der.set(seed, PKCS8_PREFIX.length);
  return der;
}

/// Parse the 64-byte solana-keygen JSON array form: seed ‖ public key.
///
/// The 32-byte seed alone is deliberately NOT accepted here. Deriving a public
/// key from a seed needs a scalar multiplication this module does not do, and
/// WebCrypto will not export one from a private key — so a bare seed would
/// leave us signing for an address we cannot name, which fails at submit time
/// with nothing pointing at the cause.
export function parseSecretKey(text) {
  let bytes;
  try {
    bytes = Uint8Array.from(JSON.parse(text));
  } catch {
    throw new Error('key must be a JSON array of bytes, as solana-keygen writes it');
  }
  if (bytes.length !== 64) {
    throw new Error(
      `key must be the 64-byte solana-keygen form (seed ‖ public key), got ${bytes.length} bytes`
    );
  }
  return { seed: bytes.subarray(0, 32), publicKeyBytes: bytes.subarray(32, 64) };
}

/// An async signer over WebCrypto. `sign` returns the 64-byte signature.
export async function webSigner(secretKeyText, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('WebCrypto subtle is unavailable in this runtime');
  const { seed, publicKeyBytes } = parseSecretKey(secretKeyText);
  const der = pkcs8From(seed);

  let key = null;
  let algorithm = null;
  const failures = [];
  for (const name of ALGORITHMS) {
    try {
      key = await subtle.importKey('pkcs8', der, { name }, false, ['sign']);
      algorithm = name;
      break;
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  if (!key) {
    throw new Error(`no Ed25519 implementation this runtime accepts — ${failures.join('; ')}`);
  }

  return {
    algorithm,
    publicKeyBytes,
    async sign(message) {
      const sig = await subtle.sign({ name: algorithm }, key, message);
      return new Uint8Array(sig);
    }
  };
}
