// src/auth/password.ts
import argon2 from 'argon2';

// argon2id with OWASP-recommended parameters (~19 MiB, t=2). Memory-hard and deliberately
// slow to blunt offline guessing if the hash column ever leaks.
const OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, OPTS);
export const verifyPassword = (hash: string, plain: string): Promise<boolean> => argon2.verify(hash, plain);
