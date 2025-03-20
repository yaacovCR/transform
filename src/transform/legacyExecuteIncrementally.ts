import type { ExecutionArgs, ExecutionResult, GraphQLError } from 'graphql';

import type { ObjMap } from '../jsutils/ObjMap.js';
import { addPath, pathToArray } from '../jsutils/Path.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

import { buildBranchingExecutionPlan } from './buildBranchingExecutionPlan.js';
import type {
  PayloadPublisher,
  SubsequentPayloadPublisher,
} from './PayloadPublisher.js';
import { transformResult } from './transformResult.js';
import type {
  DeferredFragment,
  ExecutionGroupResult,
  Stream,
  StreamItemsResult,
  SubsequentResultRecord,
} from './types.js';

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

export function legacyExecuteIncrementally(
  args: ExecutionArgs,
  prefix = '__legacyExecuteIncrementally__',
): PromiseOrValue<
  ExecutionResult | LegacyExperimentalIncrementalExecutionResults
> {
  return transformResult(
    args,
    getLegacyPayloadPublisher(),
    buildBranchingExecutionPlan,
    prefix,
  );
}

function getLegacyPayloadPublisher(): PayloadPublisher<
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
        path: pathToArray(addPath(path, index, undefined)),
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
        path: pathToArray(addPath(path, index, undefined)),
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
    subsequentResults: AsyncGenerator<
      LegacySubsequentIncrementalExecutionResult,
      void,
      void
    >,
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
