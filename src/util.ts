export function error(...err: string[]): never {
  throw Error(...err);
}
