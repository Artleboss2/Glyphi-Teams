/**
 * The team chat key never leaves the machine.
 *
 * Both ends derive it from the team invite code — the same eight characters the
 * manager hands out — with PBKDF2-SHA256. Messages are sealed with AES-256-GCM
 * before they are sent, so the API stores ciphertext and an IV and cannot read
 * a single message.
 */

const PBKDF2_ITERATIONS = 200_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function deriveChatKey(secret: string, teamId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, [
    "deriveKey"
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(`glyphi-teams:${teamId}`),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sealMessage(
  key: CryptoKey,
  plaintext: string
): Promise<{ cipher: string; iv: string }> {
  const iv = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(iv);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return { cipher: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

export async function openMessage(key: CryptoKey, cipher: string, iv: string): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    key,
    fromBase64(cipher)
  );
  return decoder.decode(plain);
}
