export interface Path {
  readonly prev: Path | undefined;
  readonly key: string | number;
  readonly nullable: boolean;
}

/**
 * Given a Path and a key, return a new Path containing the new key.
 */
export function addPath(
  prev: Readonly<Path> | undefined,
  key: string | number,
  nullable: boolean,
): Path {
  return { prev, key, nullable };
}

/**
 * Given a Path, return an Array of the path keys.
 */
export function pathToArray(
  path: Readonly<Path> | undefined,
): Array<string | number> {
  const flattened = [];
  let curr = path;
  while (curr) {
    flattened.push(curr.key);
    curr = curr.prev;
  }
  return flattened.reverse();
}
