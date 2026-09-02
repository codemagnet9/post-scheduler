// src/media/sniff.ts
// Verify the REAL file type from its leading bytes — never trust the extension or the client-declared
// content type. A .png that is actually a JPEG (or an executable) must be caught here.
export type SniffedMime =
  | 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'video/mp4' | 'video/quicktime';

const ascii = (b: Buffer, s: number, e: number): string => b.toString('latin1', s, e);

export function sniffMimeType(buf: Buffer): SniffedMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && ascii(buf, 1, 4) === 'PNG') return 'image/png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(ascii(buf, 0, 6))) return 'image/gif';
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'image/webp';
  // ISO Base Media (mp4/mov): a 'ftyp' box near the start.
  if (buf.length >= 12 && ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12);
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }
  return null;
}

export const MIME_TO_KIND: Record<SniffedMime, 'image' | 'video' | 'gif'> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'gif',
  'video/mp4': 'video',
  'video/quicktime': 'video',
};
