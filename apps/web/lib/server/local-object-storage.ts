import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { ObjectStoragePort } from "@insightforge/retrieval";

export class LocalObjectStorage implements ObjectStoragePort {
  private readonly root: string;

  constructor(root: string) {
    if (!root.trim()) throw new Error("UPLOAD_STORAGE_DIR_REQUIRED");
    this.root = resolve(root);
  }

  private resolveKey(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(`${this.root}${sep}`))
      throw new Error("STORAGE_KEY_INVALID");
    return path;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolveKey(key)));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolveKey(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
