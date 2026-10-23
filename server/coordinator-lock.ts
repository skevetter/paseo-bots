import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

interface LockOwnership {
  dev: number;
  ino: number;
  text: string;
}

/** Stale locks require explicit operator recovery; a dead PID is not proof of safe ownership. */
export class CoordinatorLock {
  private readonly path: string;
  private readonly directory: string;
  private ownership: LockOwnership | null = null;
  private busy = false;

  constructor(directory: string) {
    this.directory = directory;
    this.path = join(directory, "coordinator.lock");
  }

  async acquire(): Promise<void> {
    if (this.busy || this.ownership) throw new Error("Coordinator lock is already acquired");
    this.busy = true;
    try {
      await this.prepareDirectory();
      await this.createLock();
    } finally {
      this.busy = false;
    }
  }

  async release(): Promise<void> {
    if (this.busy) throw new Error("Coordinator lock operation is in progress");
    if (!this.ownership) return;
    this.busy = true;
    try {
      await this.removeOwnedLock(this.ownership);
      this.ownership = null;
    } finally {
      this.busy = false;
    }
  }

  private async prepareDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const handle = await open(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }

  private async createLock(): Promise<void> {
    const handle = await open(
      this.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new Error(
          `Coordinator lock exists at ${this.path}; stop all coordinators and recover it manually`,
        );
      throw error;
    });
    try {
      const info = await handle.stat();
      const text = JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID() });
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await this.syncDirectory();
      this.ownership = { dev: info.dev, ino: info.ino, text };
    } finally {
      await handle.close();
    }
  }

  private async removeOwnedLock(owner: LockOwnership): Promise<void> {
    const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      const text = await handle.readFile("utf8");
      if (info.dev !== owner.dev || info.ino !== owner.ino || text !== owner.text)
        throw new Error("Coordinator lock ownership changed; refusing to release it");
      const current = await lstat(this.path);
      if (current.dev !== owner.dev || current.ino !== owner.ino)
        throw new Error("Coordinator lock ownership changed; refusing to release it");
      await unlink(this.path);
      await this.syncDirectory();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(): Promise<void> {
    const handle = await open(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
