export type TextEncodingName = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'latin1';

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
}

function startsWith(bytes: Uint8Array, ...prefix: number[]): boolean {
  return prefix.every((value, i) => bytes[i] === value);
}

function swapBytes(bytes: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1] ?? 0;
    swapped[i + 1] = bytes[i] ?? 0;
  }
  return swapped;
}

/** Returns undefined for binary content, which cannot be edited as text. */
export function decodeText(bytes: Uint8Array): DecodedText | undefined {
  if (startsWith(bytes, 0xef, 0xbb, 0xbf)) {
    return { text: Buffer.from(bytes.subarray(3)).toString('utf8'), encoding: 'utf8-bom' };
  }
  if (startsWith(bytes, 0xff, 0xfe)) {
    return { text: Buffer.from(bytes.subarray(2)).toString('utf16le'), encoding: 'utf16le' };
  }
  if (startsWith(bytes, 0xfe, 0xff)) {
    return { text: Buffer.from(swapBytes(bytes.subarray(2))).toString('utf16le'), encoding: 'utf16be' };
  }
  if (bytes.includes(0)) return undefined;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encoding: 'utf8' };
  } catch {
    // Not UTF-8. Latin-1 maps every byte to one character, so untouched text round-trips exactly.
    return { text: Buffer.from(bytes).toString('latin1'), encoding: 'latin1' };
  }
}

export function encodeText(text: string, encoding: TextEncodingName): Uint8Array {
  switch (encoding) {
    case 'utf8':
      return Buffer.from(text, 'utf8');
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), swapBytes(Buffer.from(text, 'utf16le'))]);
    case 'latin1':
      return Buffer.from(text, 'latin1');
  }
}

export function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && Buffer.compare(a, b) === 0;
}
