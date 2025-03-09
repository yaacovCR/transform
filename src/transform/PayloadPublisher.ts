import type { ExecutionResult, GraphQLError } from 'graphql';

import type { ObjMap } from '../jsutils/ObjMap.js';
import { addPath, pathToArray } from '../jsutils/Path.js';

import type {
  DeferredFragment,
  ExecutionGroupResult,
  Stream,
  StreamItemsResult,
} from './buildTransformationContext.js';

export interface LegacyExperimentalIncrementalExecutionResults {
  initialResult: LegacyInitialIncrementalExecutionResult;
  subsequentResults: AsyncGenerator<
    LegacySubsequentIncrementalExecutionResult,
    void,
    void
  >;
}

export interface LegacyInitialIncrementalExecutionResult
  extends ExecutionResult {
  data: ObjMap<unknown>;
  hasNext: true;
}

export interface LegacySubsequentIncrementalExecutionResult {
  incremental?: ReadonlyArray<LegacyIncrementalResult>;
  hasNext: boolean;
}

export interface LegacyIncrementalDeferResult extends ExecutionResult {
  path: ReadonlyArray<string | number>;
  label?: string;
}

export interface LegacyIncrementalStreamResult {
  items: ReadonlyArray<unknown> | null;
  errors?: ReadonlyArray<GraphQLError>;
  path: ReadonlyArray<string | number>;
  label?: string;
}

export type LegacyIncrementalResult =
  | LegacyIncrementalDeferResult
  | LegacyIncrementalStreamResult;

export interface PayloadPublisher<TInitialPayload, TSubsequentPayload> {
  getInitialPayload: (
    data: ObjMap<unknown>,
    errors: ReadonlyArray<GraphQLError> | undefined,
  ) => TInitialPayload;
  getSubsequentPayloadPublisher: () => SubsequentPayloadPublisher<TSubsequentPayload>;
}

export interface SubsequentPayloadPublisher<TSubsequentPayload> {
  addFailedDeferredFragment: (
    deferredFragment: DeferredFragment,
    errors: ReadonlyArray<GraphQLError>,
  ) => void;
  addSuccessfulDeferredFragment: (
    deferredFragment: DeferredFragment,
    executionGroupResults: ReadonlyArray<ExecutionGroupResult>,
  ) => void;
  addFailedStream: (
    stream: Stream,
    errors: ReadonlyArray<GraphQLError>,
  ) => void;
  addStreamItems: (
    stream: Stream,
    streamItemsResult: StreamItemsResult,
  ) => void;
  getSubsequentPayload: (hasNext: boolean) => TSubsequentPayload | undefined;
}

export function getPayloadPublisher(): PayloadPublisher<
  LegacyInitialIncrementalExecutionResult,
  LegacySubsequentIncrementalExecutionResult
> {
  return {
    getInitialPayload,
    getSubsequentPayloadPublisher,
  };

  function getInitialPayload(
    data: ObjMap<unknown>,
    errors: ReadonlyArray<GraphQLError> | undefined,
  ): LegacyInitialIncrementalExecutionResult {
    return errors === undefined
      ? { data, hasNext: true }
      : { errors, data, hasNext: true };
  }

  function getSubsequentPayloadPublisher(): SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult> {
    let incremental: Array<LegacyIncrementalResult> = [];

    return {
      addFailedDeferredFragment,
      addSuccessfulDeferredFragment,
      addFailedStream,
      addStreamItems,
      getSubsequentPayload,
    };

    function addFailedDeferredFragment(
      deferredFragment: DeferredFragment,
      errors: ReadonlyArray<GraphQLError>,
    ): void {
      const { path, originalLabel } = deferredFragment;
      const incrementalEntry: LegacyIncrementalDeferResult = {
        errors,
        data: null,
        path: pathToArray(path),
      };
      incrementalEntry.path = pathToArray(path);
      // TODO: add test case
      /* c8 ignore next 3 */
      if (originalLabel !== undefined) {
        incrementalEntry.label = originalLabel;
      }
      incremental.push(incrementalEntry);
    }

    function addSuccessfulDeferredFragment(
      deferredFragment: DeferredFragment,
      executionGroupResults: ReadonlyArray<ExecutionGroupResult>,
    ): void {
      for (const executionGroupResult of executionGroupResults) {
        const { path, originalLabel } = deferredFragment;
        const { data, errors } = executionGroupResult;
        const incrementalEntry: LegacyIncrementalDeferResult = {
          data,
          path: pathToArray(path),
        };
        if (errors.size > 0) {
          incrementalEntry.errors = Array.from(errors.values());
        }
        if (originalLabel !== undefined) {
          incrementalEntry.label = originalLabel;
        }
        incremental.push(incrementalEntry);
      }
    }

    function addFailedStream(
      stream: Stream,
      errors: ReadonlyArray<GraphQLError>,
    ): void {
      const { path, originalLabel } = stream;
      const incrementalEntry: LegacyIncrementalStreamResult = {
        errors,
        items: null,
        path: pathToArray(addPath(path, stream.nextIndex, undefined)),
      };
      // TODO: add test case
      /* c8 ignore next 3 */
      if (originalLabel !== undefined) {
        incrementalEntry.label = originalLabel;
      }
      incremental.push(incrementalEntry);
    }

    function addStreamItems(
      stream: Stream,
      streamItemsResult: StreamItemsResult,
    ): void {
      const { path, originalLabel } = stream;
      const { items, errors } = streamItemsResult;
      const newIncrementalResult: LegacyIncrementalStreamResult = {
        items,
        path: pathToArray(addPath(path, stream.nextIndex, undefined)),
      };
      if (errors.size > 0) {
        newIncrementalResult.errors = Array.from(errors.values());
      }
      if (originalLabel != null) {
        newIncrementalResult.label = originalLabel;
      }
      incremental.push(newIncrementalResult);
    }

    function getSubsequentPayload(
      hasNext: boolean,
    ): LegacySubsequentIncrementalExecutionResult | undefined {
      if (incremental.length > 0) {
        const subsequentIncrementalExecutionResult: LegacySubsequentIncrementalExecutionResult =
          { hasNext };

        if (incremental.length > 0) {
          subsequentIncrementalExecutionResult.incremental = incremental;
        }

        incremental = [];

        return subsequentIncrementalExecutionResult;
      }
    }
  }
}
