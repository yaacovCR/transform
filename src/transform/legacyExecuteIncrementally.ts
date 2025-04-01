import type { ExecutionArgs, ExecutionResult, GraphQLError } from 'graphql';

import type { ObjMap } from '../jsutils/ObjMap.js';
import { pathToArray } from '../jsutils/Path.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';
import type { SimpleAsyncGenerator } from '../jsutils/SimpleAsyncGenerator.js';

import { buildBranchingExecutionPlan } from './buildBranchingExecutionPlan.js';
import type {
  PayloadPublisher,
  SubsequentPayloadPublisher,
} from './PayloadPublisher.js';
import { transformResult } from './transformResult.js';
import type {
  DeferredFragment,
  ExecutionGroupResult,
  ExternalStream,
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
    undefined,
    getLegacyPayloadPublisher(),
    buildBranchingExecutionPlan,
    prefix,
  );
}

function getLegacyPayloadPublisher(): PayloadPublisher<
  LegacyInitialIncrementalExecutionResult,
  LegacySubsequentIncrementalExecutionResult
> {
  return {
    getSubsequentPayloadPublisher,
    getPayloads,
  };

  function getSubsequentPayloadPublisher(): SubsequentPayloadPublisher<
    LegacyInitialIncrementalExecutionResult,
    LegacySubsequentIncrementalExecutionResult
  > {
    let incremental: Array<LegacyIncrementalResult> = [];

    return {
      addFailedDeferredFragment,
      addSuccessfulDeferredFragment,
      addFailedStream,
      addSuccessfulStream,
      addStreamItems,
      addExternalStream,
      getSubsequentPayload,
    };

    function addFailedDeferredFragment(
      deferredFragment: DeferredFragment<LegacyExperimentalIncrementalExecutionResults>,
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
      deferredFragment: DeferredFragment<LegacyExperimentalIncrementalExecutionResults>,
      _newRootNodes: ReadonlyArray<
        SubsequentResultRecord<LegacyExperimentalIncrementalExecutionResults>
      >,
      executionGroupResults: ReadonlyArray<
        ExecutionGroupResult<LegacyExperimentalIncrementalExecutionResults>
      >,
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
      stream: Stream<LegacyExperimentalIncrementalExecutionResults>,
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
      stream: Stream<LegacyExperimentalIncrementalExecutionResults>,
      _newRootNodes: ReadonlyArray<
        SubsequentResultRecord<LegacyExperimentalIncrementalExecutionResults>
      >,
      streamItemsResult: StreamItemsResult<LegacyExperimentalIncrementalExecutionResults>,
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

    function addExternalStream(
      externalStream: ExternalStream<LegacyExperimentalIncrementalExecutionResults>,
    ) {}

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
    _newRootNodes: ReadonlyArray<
      SubsequentResultRecord<LegacyExperimentalIncrementalExecutionResults>
    >,
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
