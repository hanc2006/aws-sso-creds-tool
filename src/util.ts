import { access } from "fs/promises";

/**
 * Throws an error with the provided message
 * @param err - Error message(s) to throw
 * @throws Error with the provided message
 */
export function error(...err: string[]): never {
  throw Error(...err);
}

/**
 * Check if a file exists asynchronously
 * @param path - Path to check
 * @returns true if the file exists, false otherwise
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
