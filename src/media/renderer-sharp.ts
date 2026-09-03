// src/media/renderer-sharp.ts
// Real VariantRenderer: sharp for image resize/crop, ffmpeg for video crop/transcode.
//
// HOST REQUIREMENTS for video:
//   ffmpeg/ffprobe are SYSTEM binaries, not npm libraries. We resolve the ffmpeg binary from the
//   `ffmpeg-static` package (and ffprobe from `ffprobe-static` in probe-ffprobe.ts) — these download
//   a platform binary at install time, so `npm ci` on the deploy image places them inside
//   node_modules and they SURVIVE DEPLOYMENT as ordinary dependencies (no separate host install,
//   reinstalled on every build). For slim images you may instead `apt-get install -y ffmpeg` in the
//   Dockerfile and set FFMPEG_PATH / FFPROBE_PATH, in which case the -static packages aren't needed.
//   sharp is a native module but ships prebuilt binaries via npm — also just `npm ci`.
import { spawn } from 'node:child_process';
import type { VariantRenderer } from './variants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional dep (sharp), namespace intentionally loose
const dyn = (m: string): Promise<any> => import(m);

async function ffmpegPath(): Promise<string> {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  return ((await dyn('ffmpeg-static')).default as string) ?? 'ffmpeg';
}

function runFfmpeg(bin: string, args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`))));
    p.stdin.write(input);
    p.stdin.end();
  });
}

export const sharpFfmpegRenderer: VariantRenderer = {
  async render(source, spec) {
    if (spec.isVideo) {
      const bin = await ffmpegPath();
      // Centre-crop to the target aspect, then scale to the target dimensions; re-encode to fragmented
      // MP4 on stdout (H.264/AAC). Commas inside expressions are escaped for ffmpeg's parser.
      const vf = `crop=min(iw\\,ih*${spec.targetWidth}/${spec.targetHeight}):min(ih\\,iw*${spec.targetHeight}/${spec.targetWidth}),scale=${spec.targetWidth}:${spec.targetHeight}`;
      const bytes = await runFfmpeg(bin, ['-i', 'pipe:0', '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], source);
      return { bytes, width: spec.targetWidth, height: spec.targetHeight, mimeType: 'video/mp4' };
    }
    const sharp = (await dyn('sharp')).default;
    const bytes = await sharp(source)
      .resize(spec.targetWidth, spec.targetHeight, { fit: spec.crop ? 'cover' : 'inside', position: 'attention' })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { bytes, width: spec.targetWidth, height: spec.targetHeight, mimeType: 'image/jpeg' };
  },
};
