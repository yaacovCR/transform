import type { ObjMap, ReadOnlyObjMap } from './ObjMap.js';

/**
 * Creates an object map with the same values as `map` and keys generated by
 * running each key of `map` thru `fn`.
 */
export function mapKey<T>(
  map: ReadOnlyObjMap<T>,
  fn: (key: string, value: T) => string,
): ObjMap<T> {
  const result = Object.create(null);

  for (const key of Object.keys(map)) {
    result[fn(key, map[key])] = map[key];
  }
  return result;
}
