// src/media/storage.ts
// Object-storage abstraction. Uploads go DIRECT to storage via a presigned URL — bytes never pass
// through the app. The probe/variant/provider-upload workers read from storage (a background path,
// not the request path). Production binds an S3 adapter; tests use MemoryStorage. Swap via setStorage.
export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  headers?: Record<string, string>;
}

export interface StorageAdapter {
  presignUpload(key: string, opts: { contentType: string; maxBytes: number }): Promise<PresignedUpload>;
  putObject(key: string, bytes: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  getRange(key: string, start: number, endInclusive: number): Promise<Buffer>;
  headObject(key: string): Promise<{ size: number; contentType?: string } | null>;
  signedGetUrl(key: string, ttlSec: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

// In-memory storage for tests and local dev.
export class MemoryStorage implements StorageAdapter {
  private store = new Map<string, { bytes: Buffer; contentType: string }>();

  async presignUpload(key: string): Promise<PresignedUpload> {
    return { uploadUrl: `memory://upload/${encodeURIComponent(key)}`, key };
  }
  async putObject(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.store.set(key, { bytes: Buffer.from(bytes), contentType });
  }
  async getObject(key: string): Promise<Buffer> {
    const o = this.store.get(key);
    if (!o) throw new Error(`object not found: ${key}`);
    return o.bytes;
  }
  async getRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    return (await this.getObject(key)).subarray(start, endInclusive + 1);
  }
  async headObject(key: string): Promise<{ size: number; contentType?: string } | null> {
    const o = this.store.get(key);
    return o ? { size: o.bytes.length, contentType: o.contentType } : null;
  }
  async signedGetUrl(key: string, ttlSec: number): Promise<string> {
    // A real signature would embed an expiry + HMAC; here we just make it look like one so the
    // signed-URL rule (don't persist/canonicalise these) is exercised.
    return `memory://get/${encodeURIComponent(key)}?exp=${ttlSec}&sig=${Buffer.from(key).toString('base64url').slice(0, 8)}`;
  }
  async deleteObject(key: string): Promise<void> {
    this.store.delete(key);
  }
}

let current: StorageAdapter = new MemoryStorage();
export function getStorage(): StorageAdapter {
  return current;
}
export function setStorage(s: StorageAdapter): void {
  current = s;
}
