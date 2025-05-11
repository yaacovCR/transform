import type { GraphQLError } from 'graphql';
import type {
  CompletedResult,
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
  IncrementalResult,
  PendingResult,
  SubsequentIncrementalExecutionResult,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

import { AsyncGeneratorCombinator } from '../jsutils/AsyncGeneratorCombinator.js';
import { invariant } from '../jsutils/invariant.js';
import { isObjectLike } from '../jsutils/isObjectLike.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { SimpleAsyncGenerator } from '../jsutils/SimpleAsyncGenerator.js';

import { EmbeddedErrors } from './EmbeddedError.js';
import { embedErrors } from './embedErrors.js';
import { getObjectAtPath } from './getObjectAtPath.js';
import { mapAsyncIterable } from './mapAsyncIterable.js';

interface KeyedStream {
  key: string; // path
  list: Array<unknown>;
}

interface KeyedDefer {
  key: string; // label + path
  object: ObjMap<unknown>;
}

function isKeyedStream(
  keyedPendingResult: KeyedPendingResult,
): keyedPendingResult is KeyedStream {
  return 'list' in keyedPendingResult;
}

export type KeyedPendingResult = KeyedStream | KeyedDefer;

export interface PositionInfo {
  pending: KeyedPendingResult;
  errors: ReadonlyArray<GraphQLError> | undefined;
}

export interface SubsequentResultEvents {
  streamsWithNewItems: Set<string>;
  completedStreams: Map<string, ReadonlyArray<GraphQLError> | undefined>;
  completedDeferredFragments: Map<
    string,
    ReadonlyArray<GraphQLError> | undefined
  >;
}

/**
 * @internal
 */
export class MergedResult {
  private _events: AsyncGeneratorCombinator<SubsequentResultEvents>;

  private _mergedResult: ObjMap<unknown> | EmbeddedErrors;
  private _keyedPendingResults: Map<string, KeyedPendingResult>;
  private _positionInfo: Map<string, PositionInfo>;

  constructor() {
    this._mergedResult = Object.create(null);
    this._keyedPendingResults = new Map();
    this._positionInfo = new Map();
    this._events = new AsyncGeneratorCombinator<SubsequentResultEvents>();
    this._keyedPendingResults = new Map();
    this._positionInfo = new Map();
  }

  add(
    subschemaLabel: string,
    result: ExecutionResult | ExperimentalIncrementalExecutionResults,
    mergePoint = this._mergedResult,
  ): void {
    let data;
    let errors;
    let pending;
    let subsequentResults;

    if ('initialResult' in result) {
      const initialResult = result.initialResult;
      ({ data, errors, pending } = initialResult);
      subsequentResults = result.subsequentResults;
    } else {
      ({ data, errors } = result);
    }

    // TODO: add test case
    /* c8 ignore next 6 */
    if (mergePoint instanceof EmbeddedErrors) {
      if (errors) {
        mergePoint.errors.push(...errors);
      }
      return;
    }

    if (data == null) {
      invariant(errors !== undefined);
      this._mergedResult = new EmbeddedErrors(errors);
      return;
    }

    embedErrors(data, errors);
    Object.assign(mergePoint, data);

    if (subsequentResults) {
      this._events.add(
        mapAsyncIterable(subsequentResults, (subsequentResult) =>
          this._processSubsequentResult(subschemaLabel, subsequentResult),
        ),
      );
    }
    if (pending) {
      const pendingById = this._getPendingById(subschemaLabel, pending);
      this._keyPendingResults(pendingById);
    }
  }

  getMergedData(): ObjMap<unknown> | EmbeddedErrors {
    return this._mergedResult;
  }

  getEvents(): SimpleAsyncGenerator<SubsequentResultEvents> {
    return this._events;
  }

  getPositionInfo(key: string): PositionInfo | undefined {
    return this._positionInfo.get(key);
  }

  private _processSubsequentResult(
    subschemaLabel: string,
    subsequentIncrementalExecutionResult: SubsequentIncrementalExecutionResult,
  ): SubsequentResultEvents {
    const { pending, incremental, completed } =
      subsequentIncrementalExecutionResult;

    const events: SubsequentResultEvents = {
      streamsWithNewItems: new Set(),
      completedStreams: new Map(),
      completedDeferredFragments: new Map(),
    };

    let pendingById: Map<string, PendingResult> | undefined;
    if (pending) {
      pendingById = this._getPendingById(subschemaLabel, pending);
    }

    if (incremental) {
      const streamsWithNewItems = this._processIncremental(
        subschemaLabel,
        incremental,
        pendingById,
      );
      streamsWithNewItems.forEach((key) => events.streamsWithNewItems.add(key));
    }

    // Key any *new* pending results that arrived in this payload
    if (pendingById) {
      this._keyPendingResults(pendingById);
    }

    if (completed) {
      const { completedStreams, completedDeferredFragments } =
        this._processCompleted(subschemaLabel, completed);
      completedStreams.forEach((errors, key) =>
        events.completedStreams.set(key, errors),
      );
      completedDeferredFragments.forEach((errors, key) =>
        events.completedDeferredFragments.set(key, errors),
      );
    }

    return events;
  }

  private _getPendingById(
    subschemaLabel: string,
    pendingResults: ReadonlyArray<PendingResult>,
  ): Map<string, PendingResult> {
    const pendingById = new Map<string, PendingResult>();
    for (const pendingResult of pendingResults) {
      const prefixedId = `${subschemaLabel}:${pendingResult.id}`;
      pendingById.set(prefixedId, pendingResult);
    }
    return pendingById;
  }

  private _keyPendingResults(pendingById: Map<string, PendingResult>): void {
    pendingById.forEach((pendingResult, id) =>
      this._keyPendingResult(id, pendingResult),
    );
  }

  private _keyPendingResult(
    id: string,
    pendingResult: PendingResult,
  ): KeyedPendingResult {
    invariant(!(this._mergedResult instanceof EmbeddedErrors));
    const path = pendingResult.path;
    const incompleteAtPath = getObjectAtPath(this._mergedResult, path);
    let key: string;
    let keyedPendingResult: KeyedPendingResult;
    if (Array.isArray(incompleteAtPath)) {
      key = path.join('.');
      keyedPendingResult = {
        key,
        list: incompleteAtPath,
      };
    } else {
      key = pendingResult.label + '.' + path.join('.');
      keyedPendingResult = {
        key,
        object: incompleteAtPath,
      };
    }
    this._keyedPendingResults.set(id, keyedPendingResult);
    this._positionInfo.set(key, {
      pending: keyedPendingResult,
      errors: undefined,
    });
    return keyedPendingResult;
  }

  private _processCompleted(
    subschemaLabel: string,
    completedResults: ReadonlyArray<CompletedResult>,
  ): {
    completedStreams: Map<string, ReadonlyArray<GraphQLError> | undefined>;
    completedDeferredFragments: Map<
      string,
      ReadonlyArray<GraphQLError> | undefined
    >;
  } {
    const completedStreams = new Map<
      string,
      ReadonlyArray<GraphQLError> | undefined
    >();
    const completedDeferredFragments = new Map<
      string,
      ReadonlyArray<GraphQLError> | undefined
    >();

    for (const completedResult of completedResults) {
      const id = `${subschemaLabel}:${completedResult.id}`;
      const keyedPendingResult = this._keyedPendingResults.get(id);
      invariant(keyedPendingResult !== undefined);
      this._keyedPendingResults.delete(id);

      const key = keyedPendingResult.key;
      const errors = completedResult.errors;
      if (errors) {
        // we cannot clean up this._positionInfo in the error
        // case because we might complete early, and we may need to retain
        // errors for publisher to send
        const positionInfo = this._positionInfo.get(key);
        invariant(positionInfo !== undefined);
        positionInfo.errors = errors;
      } else {
        // clean up positionInfo by mimicking inlining
        this._positionInfo.delete(key);
      }

      if (isKeyedStream(keyedPendingResult)) {
        completedStreams.set(key, errors);
      } else {
        completedDeferredFragments.set(key, errors);
      }
    }
    return { completedStreams, completedDeferredFragments };
  }

  private _processIncremental(
    subschemaLabel: string,
    incrementalResults: ReadonlyArray<IncrementalResult>,
    pendingById: Map<string, PendingResult> | undefined,
  ): Set<string> {
    const streams = new Set<string>();
    for (const incrementalResult of incrementalResults) {
      const id = `${subschemaLabel}:${incrementalResult.id}`;
      const keyedPendingResult = this._getKeyedPendingResult(id, pendingById);

      if (isKeyedStream(keyedPendingResult)) {
        invariant('items' in incrementalResult);
        keyedPendingResult.list.push(
          ...(incrementalResult.items as ReadonlyArray<unknown>),
        );
        invariant(isKeyedStream(keyedPendingResult));
        streams.add(keyedPendingResult.key);
      } else {
        const subPath = incrementalResult.subPath;

        const incompleteAtPath = subPath
          ? getObjectAtPath(keyedPendingResult.object, subPath)
          : keyedPendingResult.object;

        invariant(isObjectLike(incompleteAtPath));

        invariant('data' in incrementalResult);
        for (const [key, value] of Object.entries(
          incrementalResult.data as ObjMap<unknown>,
        )) {
          incompleteAtPath[key] = value;
        }
      }

      invariant(!(this._mergedResult instanceof EmbeddedErrors));
      embedErrors(this._mergedResult, incrementalResult.errors);
    }
    return streams;
  }

  private _getKeyedPendingResult(
    id: string,
    pendingById: Map<string, PendingResult> | undefined,
  ): KeyedPendingResult {
    const keyedPendingResult = this._keyedPendingResults.get(id);
    if (keyedPendingResult !== undefined) {
      return keyedPendingResult;
    }

    invariant(pendingById !== undefined);
    const pendingResult = pendingById.get(id);
    invariant(pendingResult !== undefined);

    // This handles the case where an incremental result arrives *before*
    // its corresponding pending result in the same payload.
    return this._keyPendingResult(id, pendingResult);
  }
}
