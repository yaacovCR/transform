import type { GraphQLError } from 'graphql';

import { invariant } from '../jsutils/invariant.js';
import { isObjectLike } from '../jsutils/isObjectLike.js';
import type { ObjMap } from '../jsutils/ObjMap.js';

import { EmbeddedErrors } from './EmbeddedError.js';

export function embedErrors(
  data: ObjMap<unknown>,
  errors: ReadonlyArray<GraphQLError> | undefined,
): void {
  if (errors == null || errors.length === 0) {
    return;
  }
  for (const error of errors) {
    if (!error.path || error.path.length === 0) {
      continue;
    }
    embedErrorByPath(error, error.path, error.path[0], 1, data);
  }
}

function embedErrorByPath(
  error: GraphQLError,
  path: ReadonlyArray<string | number>,
  currentKey: string | number,
  nextIndex: number,
  parent: unknown,
): void {
  if (nextIndex === path.length) {
    if (Array.isArray(parent)) {
      if (typeof currentKey !== 'number') {
        return;
      }
      invariant(
        maybeEmbed(
          parent as unknown as ObjMap<unknown>,
          currentKey as unknown as string,
          error,
        ) instanceof EmbeddedErrors,
      );
      return;
    }
    if (isObjectLike(parent)) {
      if (typeof currentKey !== 'string') {
        return;
      }
      invariant(
        maybeEmbed(parent, currentKey, error) instanceof EmbeddedErrors,
      );
      return;
    }
    return;
  }

  let next: unknown;
  if (Array.isArray(parent)) {
    if (typeof currentKey !== 'number') {
      return;
    }
    next = maybeEmbed(
      parent as unknown as ObjMap<unknown>,
      currentKey as unknown as string,
      error,
    );
    if (next instanceof EmbeddedErrors) {
      return;
    }
  } else if (isObjectLike(parent)) {
    if (typeof currentKey !== 'string') {
      return;
    }
    next = maybeEmbed(parent, currentKey, error);
    if (next instanceof EmbeddedErrors) {
      return;
    }
  } else {
    return;
  }

  embedErrorByPath(error, path, path[nextIndex], nextIndex + 1, next);
}

function maybeEmbed(
  parent: ObjMap<unknown>,
  key: string,
  error: GraphQLError,
): unknown {
  let next = parent[key];
  if (next == null) {
    next = parent[key] = new EmbeddedErrors([error]);
  } else if (next instanceof EmbeddedErrors) {
    next.errors.push(error);
  }
  return next;
}
