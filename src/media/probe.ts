// src/media/probe.ts
// Extract intrinsic media facts so the Phase 5 validator can decide publishability BEFORE scheduling.
// Image dimensions are parsed from headers here (no external tool). Video probing (duration, codec,
// frame rate) needs ffprobe in production; it is modelled as an injectable VideoProber so tests can
// supply known values without shelling out.
export interface MediaProbe {
  width?: number;
  height?: number;
  durationSec?: number;
  codec?: string;
  frameRate?: number;
  bytes: number;
}

const ascii = (b: Buffer, s: number, e: number): string => b.toString('latin1', s, e);

export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && ascii(buf, 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && /^GIF8[79]a$/.test(ascii(buf, 0, 6))) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return jpegDimensions(buf);
  if (buf.length >= 30 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return webpDimensions(buf);
  return null;
}

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    // SOF0..SOF15 (excluding DHT/DAC/DRI markers) carry frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

function webpDimensions(buf: Buffer): { width: number; height: number } | null {
  const format = ascii(buf, 12, 16);
  if (format === 'VP8X') return { width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
  if (format === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (format === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

// Injectable video prober. Production impl shells out to ffprobe (streams a header range from
// storage rather than loading the whole file); tests inject a fake.
export interface VideoProber {
  probe(bytes: Buffer): Promise<MediaProbe>;
}

let videoProber: VideoProber | null = null;
export function setVideoProber(p: VideoProber | null): void {
  videoProber = p;
}

export async function probeAsset(kind: 'image' | 'video' | 'gif', bytes: Buffer): Promise<MediaProbe> {
  if (kind === 'video') {
    if (!videoProber) throw new Error('no video prober configured (ffprobe in production, injected in tests)');
    const p = await videoProber.probe(bytes);
    return { ...p, bytes: bytes.length };
  }
  const dims = imageDimensions(bytes);
  return { width: dims?.width, height: dims?.height, bytes: bytes.length };
}
