// src/media/bootstrap.ts
// Wire the real media backends from env at process boot (server.ts + worker.ts). Tests never call
// this — they inject fakes and use MemoryStorage. Importing this module does NOT load sharp/aws-sdk/
// ffmpeg (those are dynamic-imported on first use), so it's cheap and dependency-optional at import.
import { setStorage } from './storage';
import { setVariantRenderer } from './variants';
import { setVideoProber } from './probe';
import { S3Storage } from './storage-s3';
import { sharpFfmpegRenderer } from './renderer-sharp';
import { ffprobeVideoProber } from './probe-ffprobe';

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required for STORAGE_BACKEND=s3`);
  return v;
}

export function initMediaBackends(): void {
  const backend = process.env.STORAGE_BACKEND ?? 'memory';
  if (backend === 's3' || backend === 'r2') {
    setStorage(new S3Storage({
      bucket: required('S3_BUCKET'),
      region: process.env.S3_REGION ?? 'auto',
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    }));
  } else if (process.env.NODE_ENV === 'production') {
    // Backstop for item 3: production must never fall back to the in-memory store.
    throw new Error('STORAGE_BACKEND=memory is not allowed in production');
  }
  setVariantRenderer(sharpFfmpegRenderer);
  setVideoProber(ffprobeVideoProber);
}
