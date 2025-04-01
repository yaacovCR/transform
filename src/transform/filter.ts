import type { GraphQLError } from 'graphql';

import { invariant } from '../jsutils/invariant.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';
import { pathToArray } from '../jsutils/Path.js';

import type { IncrementalDataRecord, IncrementalResults } from './types.js';

export function filter<TData, TInitial, TSubsequent>(
  data: TData,
  initialPath: Path | undefined,
  errors: ReadonlyMap<Path | undefined, GraphQLError>,
  incrementalDataRecords: ReadonlyArray<
    IncrementalDataRecord<IncrementalResults<TInitial, TSubsequent>>
  >,
): {
  filteredData: TData;
  filteredRecords: ReadonlyArray<
    IncrementalDataRecord<IncrementalResults<TInitial, TSubsequent>>
  >;
} {
  const nullableErrorPaths = new Set<Path | undefined>();

  let filteredData: unknown = data;

  const initialPathLength = pathToArray(initialPath).length;

  for (const errorPath of errors.keys()) {
    const nullableParentPath = getNullableParentPath(errorPath);
    nullableErrorPaths.add(nullableParentPath);

    const nullableParentPathArr = pathToArray(nullableParentPath);

    if (nullableParentPathArr.length <= initialPathLength) {
      filteredData = null;
    } else {
      const pathToNull = nullableParentPathArr.slice(initialPathLength);
      nullDataAtPath(filteredData, pathToNull);
    }
  }

  const filteredRecords: Array<
    IncrementalDataRecord<IncrementalResults<TInitial, TSubsequent>>
  > = [];
  for (const incrementalDataRecord of incrementalDataRecords) {
    let currentPath: Path | undefined = incrementalDataRecord.path;

    // TODO: add test case - filtering atm not necessary unless we add transformations that can return new nulls
    /* c8 ignore next 3 */
    if (nullableErrorPaths.has(currentPath)) {
      continue;
    }

    const paths: Array<Path | undefined> = [currentPath];
    let filtered = false;
    while (currentPath !== initialPath) {
      // Because currentPath leads to initialPath or is undefined, and the
      // loop will exit if initialPath is undefined, currentPath must be
      // defined.
      // TODO: Consider, however, adding an invariant.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      currentPath = currentPath!.prev;
      // TODO: add test case - filtering atm not necessary unless we add transformations that can return new nulls
      /* c8 ignore next 4 */
      if (nullableErrorPaths.has(currentPath)) {
        filtered = true;
        break;
      }
      paths.push(currentPath);
    }

    if (!filtered) {
      filteredRecords.push(incrementalDataRecord);
    }
  }

  return {
    filteredData: filteredData as TData,
    filteredRecords,
  };
}

function getNullableParentPath(errorPath: Path | undefined): Path | undefined {
  if (errorPath === undefined) {
    return undefined;
  }

  if (errorPath.nullable) {
    return errorPath;
  }

  return getNullableParentPath(errorPath.prev);
}

function nullDataAtPath(
  data: unknown,
  pathToNull: ReadonlyArray<string | number>,
): void {
  let parent = data;
  let index = 0;
  const pathLength = pathToNull.length;
  while (index < pathLength) {
    const key = pathToNull[index++];

    // TODO: add test case, add case for overlapping error paths
    /* c8 ignore next 3 */
    if (parent === null) {
      return;
    }

    invariant(typeof data === 'object');

    if (index === pathLength) {
      (parent as ObjMap<unknown>)[key] = null;
      return;
    } /* c8 ignore start */

    parent = (data as ObjMap<unknown>)[key];
  }
}
