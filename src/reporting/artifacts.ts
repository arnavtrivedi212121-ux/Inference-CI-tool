import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Publish a complete artifact directory or fail without exposing a partial result. */
export async function publishArtifacts(outputDirectory: string, name: string, files: Record<string, string>, signal?: AbortSignal) {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || Object.keys(files).some(file => !/^[A-Za-z0-9_.-]+$/.test(file) || file === '.' || file === '..')) throw new Error('Invalid artifact name');
  const parent = resolve(outputDirectory);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.pending-'));
  const destination = join(parent, name);
  try {
    const writes = await Promise.allSettled(Object.entries(files).map(([file, contents]) => writeFile(join(staging, file), contents)));
    const failed = writes.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    signal?.throwIfAborted();
    await rename(staging, destination);
  } catch (error) {
    if (dirname(staging) === parent && staging.startsWith(join(parent, '.pending-'))) await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return destination;
}
