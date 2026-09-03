// src/media/storage-s3.ts
// S3-compatible StorageAdapter for AWS S3 AND Cloudflare R2. R2 = set S3_ENDPOINT to the R2 S3 API
// URL, S3_REGION='auto', and force path style. The AWS SDK is loaded LAZILY so the app (and the
// tests, which use MemoryStorage) don't need it unless S3 is actually configured.
import type { StorageAdapter, PresignedUpload } from './storage';

// Non-literal specifier => TypeScript treats these as Promise<any>, so the SDK need not be installed
// to typecheck or to run the test suite.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional dep (@aws-sdk/*), namespace intentionally loose
const dyn = (m: string): Promise<any> => import(m);

export interface S3Config {
  bucket: string;
  region: string; // 'auto' for R2
  endpoint?: string; // R2: https://<account>.r2.cloudflarestorage.com ; AWS: omit
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export class S3Storage implements StorageAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- holds the loosely-typed S3 client from dyn()
  private clientP: Promise<any>;
  constructor(private cfg: S3Config) {
    this.clientP = (async () => {
      const { S3Client } = await dyn('@aws-sdk/client-s3');
      return new S3Client({
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      });
    })();
  }

  async presignUpload(key: string, opts: { contentType: string }): Promise<PresignedUpload> {
    const [{ PutObjectCommand }, { getSignedUrl }] = await Promise.all([dyn('@aws-sdk/client-s3'), dyn('@aws-sdk/s3-request-presigner')]);
    const uploadUrl = await getSignedUrl(await this.clientP, new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, ContentType: opts.contentType }), { expiresIn: 900 });
    return { uploadUrl, key, headers: { 'content-type': opts.contentType } };
  }

  async putObject(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const { PutObjectCommand } = await dyn('@aws-sdk/client-s3');
    await (await this.clientP).send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: bytes, ContentType: contentType }));
  }

  async getObject(key: string): Promise<Buffer> {
    const { GetObjectCommand } = await dyn('@aws-sdk/client-s3');
    const res = await (await this.clientP).send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    const { GetObjectCommand } = await dyn('@aws-sdk/client-s3');
    const res = await (await this.clientP).send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }));
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async headObject(key: string): Promise<{ size: number; contentType?: string } | null> {
    const { HeadObjectCommand } = await dyn('@aws-sdk/client-s3');
    try {
      const res = await (await this.clientP).send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
    } catch {
      return null;
    }
  }

  async signedGetUrl(key: string, ttlSec: number): Promise<string> {
    const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([dyn('@aws-sdk/client-s3'), dyn('@aws-sdk/s3-request-presigner')]);
    return getSignedUrl(await this.clientP, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: ttlSec });
  }

  async deleteObject(key: string): Promise<void> {
    const { DeleteObjectCommand } = await dyn('@aws-sdk/client-s3');
    await (await this.clientP).send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}
