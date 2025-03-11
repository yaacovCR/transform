import type { GraphQLError } from 'graphql';
import type {
  CompletedResult,
  IncrementalResult,
  PendingResult,
  SubsequentIncrementalExecutionResult,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

import { invariant } from '../jsutils/invariant.js';
import type { ObjMap } from '../jsutils/ObjMap.js';

import { embedErrors } from './embedErrors.js';
import { getObjectAtPath } from './getObjectAtPath.js';

export interface EncounteredPendingResult {
  id: string;
  path: ReadonlyArray<string | number>;
  label: string;
  pathStr: string;
  key: string;
  type: 'stream' | 'deferred' | undefined;
  completed: undefined | ReadonlyArray<GraphQLError>;
}

/**
 * @internal
 */
export class MergedResult {
  private _mergedResult: ObjMap<unknown>;
  private _pendingResultsById: Map<string, EncounteredPendingResult>;
  private _pendingResultsByPath: Map<
    string,
    Map<string, EncounteredPendingResult>
  >;

  constructor(originalData: ObjMap<unknown>) {
    this._mergedResult = originalData;
    this._pendingResultsById = new Map();
    this._pendingResultsByPath = new Map();
  }

  getPendingResultsByPath(
    pathStr: string,
  ): ReadonlyMap<string, EncounteredPendingResult> | undefined {
    return this._pendingResultsByPath.get(pathStr);
  }

  processPending(
    pendingResults: ReadonlyArray<PendingResult>,
    skipTyping?: boolean,
  ): ReadonlyArray<EncounteredPendingResult> | undefined {
    const newPendingResults: Array<EncounteredPendingResult> = [];
    for (const pendingResult of pendingResults) {
      const { id, path, label } = pendingResult;
      invariant(label != null);
      const pathStr = path.join('.');
      const key = label + '.' + pathStr;
      const newPendingResult: EncounteredPendingResult = {
        id,
        path,
        label,
        pathStr,
        key,
        type: undefined,
        completed: undefined,
      };
      newPendingResults.push(newPendingResult);
      this._pendingResultsById.set(id, newPendingResult);
      let pendingResultsByPath = this._pendingResultsByPath.get(pathStr);
      if (pendingResultsByPath === undefined) {
        pendingResultsByPath = new Map();
        this._pendingResultsByPath.set(pathStr, pendingResultsByPath);
      }
      pendingResultsByPath.set(label, newPendingResult);
    }
    if (skipTyping) {
      return newPendingResults;
    }
    this._typeNewPending(newPendingResults);
  }

  onSubsequentIncrementalExecutionResult(
    subsequentIncrementalExecutionResult: SubsequentIncrementalExecutionResult,
    onStreamItems: (pendingResult: EncounteredPendingResult) => void,
    onCompletedStream: (pendingResult: EncounteredPendingResult) => void,
    onCompletedDeferredFragment: (
      pendingResult: EncounteredPendingResult,
    ) => void,
  ): void {
    const { pending, incremental, completed } =
      subsequentIncrementalExecutionResult;

    let newPendingResults: ReadonlyArray<EncounteredPendingResult> | undefined;
    if (pending) {
      newPendingResults = this.processPending(pending, true);
    }

    if (incremental) {
      this._onIncremental(incremental, onStreamItems);
    }

    if (newPendingResults) {
      this._typeNewPending(newPendingResults);
    }

    if (completed) {
      this._onCompleted(
        completed,
        onCompletedStream,
        onCompletedDeferredFragment,
      );
    }
  }

  private _typeNewPending(
    newPendingResults: ReadonlyArray<EncounteredPendingResult>,
  ): void {
    for (const pendingResult of newPendingResults) {
      const incompleteAtPath = getObjectAtPath(
        this._mergedResult,
        pendingResult.path,
      );
      pendingResult.type = Array.isArray(incompleteAtPath)
        ? 'stream'
        : 'deferred';
    }
  }

  private _onCompleted(
    completedResults: ReadonlyArray<CompletedResult>,
    onCompletedStream: (pendingResult: EncounteredPendingResult) => void,
    onCompletedDeferredFragment: (
      pendingResult: EncounteredPendingResult,
    ) => void,
  ): void {
    for (const completedResult of completedResults) {
      const pendingResult = this._pendingResultsById.get(completedResult.id);
      invariant(pendingResult != null);

      if ('errors' in completedResult) {
        pendingResult.completed = completedResult.errors;
      }

      if (pendingResult.type === 'stream') {
        onCompletedStream(pendingResult);

        if (pendingResult.completed === undefined) {
          // we cannot clean this up in the case of errors, because in branching mode,
          // there may be a deferred version of the stream for which we will need to send errors
          this._pendingResultsByPath.delete(pendingResult.pathStr);
        }
      } else {
        onCompletedDeferredFragment(pendingResult);

        const pendingResultsByPath = this._pendingResultsByPath.get(
          pendingResult.pathStr,
        );
        invariant(pendingResultsByPath != null);
        pendingResultsByPath.delete(pendingResult.label);
        if (pendingResultsByPath.size === 0) {
          this._pendingResultsByPath.delete(pendingResult.pathStr);
        }
      }
      this._pendingResultsById.delete(pendingResult.id);
    }
  }

  private _onIncremental(
    incrementalResults: ReadonlyArray<IncrementalResult>,
    onStream: (pendingResult: EncounteredPendingResult) => void,
  ): void {
    const streams = new Set<EncounteredPendingResult>();
    for (const incrementalResult of incrementalResults) {
      const id = incrementalResult.id;
      const pendingResult = this._pendingResultsById.get(id);
      invariant(pendingResult != null);
      const path = incrementalResult.subPath
        ? [...pendingResult.path, ...incrementalResult.subPath]
        : pendingResult.path;

      const incompleteAtPath = getObjectAtPath(this._mergedResult, path);
      if (Array.isArray(incompleteAtPath)) {
        invariant('items' in incrementalResult);
        incompleteAtPath.push(
          ...(incrementalResult.items as ReadonlyArray<unknown>),
        );
        embedErrors(this._mergedResult, incrementalResult.errors);
        streams.add(pendingResult);
      } else {
        invariant('data' in incrementalResult);
        for (const [key, value] of Object.entries(
          incrementalResult.data as ObjMap<unknown>,
        )) {
          incompleteAtPath[key] = value;
        }
        embedErrors(this._mergedResult, incrementalResult.errors);
      }
    }
    streams.forEach(onStream);
  }
}
