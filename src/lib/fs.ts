import {access} from "node:fs/promises";

/**
 * Returns true when the current process can read `filePath`.
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throws the error returned by `errorFactory` when `filePath` is not readable.
 */
export async function assertPathReadable(
  filePath: string,
  errorFactory: (filePath: string) => Error = (missingPath) => new Error(`No readable file found at ${missingPath}`),
): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw errorFactory(filePath);
  }
}
