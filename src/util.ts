/**
 * Throws an error with the provided message
 * @param err - Error message(s) to throw
 * @throws Error with the provided message
 */
export function error(...err: string[]): never {
  throw Error(...err);
}
