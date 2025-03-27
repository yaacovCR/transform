import type { ExecutionResult, GraphQLError } from 'graphql';

import type { ObjMap } from '../jsutils/ObjMap.js';
import { pathToArray } from '../jsutils/Path.js';
import type { SimpleAsyncGenerator } from '../jsutils/SimpleAsyncGenerator.js';

import type {
  PayloadPublisher,
  SubsequentPayloadPublisher,
} from './PayloadPublisher.js';
import type {
  DeferredFragment,
  ExecutionGroupResult,
  Stream,
  StreamItemsResult,
  SubsequentResultRecord,
} from './types.js';

export interface LegacyExperimentalIncrementalExecutionResults {
  initialResult: LegacyInitialIncrementalExecutionResult;
  subsequentResults: SimpleAsyncGenerator<LegacySubsequentIncrementalExecutionResult>;
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

interface LegacyIncrementalDeferResult extends ExecutionResult {
  path: ReadonlyArray<string | number>;
  label?: string;
}

interface LegacyIncrementalStreamResult {
  items: ReadonlyArray<unknown> | null;
  errors?: ReadonlyArray<GraphQLError>;
  path: ReadonlyArray<string | number>;
  label?: string;
}

type LegacyIncrementalResult =
  | LegacyIncrementalDeferResult
  | LegacyIncrementalStreamResult;

export function getLegacyPayloadPublisher(): PayloadPublisher<
  LegacySubsequentIncrementalExecutionResult,
  LegacyExperimentalIncrementalExecutionResults
> {
  return {
    getSubsequentPayloadPublisher,
    getPayloads,
  };

  function getSubsequentPayloadPublisher(): SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult> {
    let incremental: Array<LegacyIncrementalResult> = [];

    return {
      addFailedDeferredFragment,
      addSuccessfulDeferredFragment,
      addFailedStream,
      addSuccessfulStream,
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
      _newRootNodes: ReadonlyArray<SubsequentResultRecord>,
      executionGroupResults: ReadonlyArray<ExecutionGroupResult>,
    ): void {
      for (const executionGroupResult of executionGroupResults) {
        const { path, originalLabel } = deferredFragment;
        const { data, errors } = executionGroupResult;
        const incrementalEntry: LegacyIncrementalDeferResult = {
          data,
          path: pathToArray(path),
        };
        if (errors.length > 0) {
          incrementalEntry.errors = errors;
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
      index: number,
    ): void {
      const { path, originalLabel } = stream;
      const incrementalEntry: LegacyIncrementalStreamResult = {
        errors,
        items: null,
        path: [...pathToArray(path), index],
      };
      // TODO: add test case
      /* c8 ignore next 3 */
      if (originalLabel !== undefined) {
        incrementalEntry.label = originalLabel;
      }
      incremental.push(incrementalEntry);
    }

    function addSuccessfulStream(): void {
      // do nothing
    }

    function addStreamItems(
      stream: Stream,
      _newRootNodes: ReadonlyArray<SubsequentResultRecord>,
      streamItemsResult: StreamItemsResult,
      index: number,
    ): void {
      const { path, originalLabel } = stream;
      const { items, errors } = streamItemsResult;
      const newIncrementalResult: LegacyIncrementalStreamResult = {
        items,
        path: [...pathToArray(path), index],
      };
      if (errors.length > 0) {
        newIncrementalResult.errors = errors;
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

      if (!hasNext) {
        return { hasNext };
      }
    }
  }

  function getPayloads(
    data: ObjMap<unknown>,
    errors: ReadonlyArray<GraphQLError>,
    _newRootNodes: ReadonlyArray<SubsequentResultRecord>,
    subsequentResults: SimpleAsyncGenerator<LegacySubsequentIncrementalExecutionResult>,
  ): LegacyExperimentalIncrementalExecutionResults {
    return {
      initialResult:
        errors.length === 0
          ? { data, hasNext: true }
          : { errors, data, hasNext: true },
      subsequentResults,
    };
  }
}
