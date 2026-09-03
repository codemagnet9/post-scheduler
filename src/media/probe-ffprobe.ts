// src/media/probe-ffprobe.ts
// Real VideoProber via ffprobe (see renderer-sharp.ts for the host/deployment note). Writes the bytes
// to a temp file because ffprobe can't seek stdin reliably for all container formats; production
// streams a header range from storage rather than the full object.
import { spawn } from 'node:child_process';
import type { VideoProber, MediaProbe } from './probe';

// Untyped dynamic import so optional native deps (ffprobe-static) need not be installed to build.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- module namespace is intentionally loose
const dyn = (m: string): Promise<any> => import(m);

interface FfprobeStream { codec_type?: string; width?: number; height?: number; duration?: string; codec_name?: string; r_frame_rate?: string }
interface FfprobeJson { streams?: FfprobeStream[]; format?: { duration?: string } }

async function ffprobePath(): Promise<string> {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  return ((await dyn('ffprobe-static')).path as string) ?? 'ffprobe';
}

export const ffprobeVideoProber: VideoProber = {
  async probe(bytes: Buffer): Promise<MediaProbe> {
    const { writeFile, unlink } = await dyn('node:fs/promises');
    const { tmpdir } = await dyn('node:os');
    const { join } = await dyn('node:path');
    const file = join(tmpdir(), `probe-${process.pid}-${Date.now()}-${bytes.length}.bin`);
    await writeFile(file, bytes);
    try {
      const bin = await ffprobePath();
      const json = await new Promise<FfprobeJson>((resolve, reject) => {
        const p = spawn(bin, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file]);
        const chunks: Buffer[] = [];
        p.stdout.on('data', (d: Buffer) => chunks.push(d));
        p.on('error', reject);
        p.on('close', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as FfprobeJson); } catch (e) { reject(e); }
        });
      });
      const v: FfprobeStream = (json.streams ?? []).find((s) => s.codec_type === 'video') ?? {};
      const [num, den] = String(v.r_frame_rate ?? '0/1').split('/').map(Number);
      return {
        width: v.width,
        height: v.height,
        durationSec: Number(json.format?.duration ?? v.duration ?? 0) || undefined,
        codec: v.codec_name,
        frameRate: den ? num / den : undefined,
        bytes: bytes.length,
      };
    } finally {
      await unlink(file).catch(() => undefined);
    }
  },
};
