import type {
  ExperimentalIncrementalExecutionResults,
  GraphQLError,
  IncrementalDeferResult,
  IncrementalResult,
  IncrementalStreamResult,
  SubsequentIncrementalExecutionResult,
} from 'graphql';
import type {
  CompletedResult,
  PendingResult,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

import { invariant } from '../jsutils/invariant.js';
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

export function getDefaultPayloadPublisher(): PayloadPublisher<
  SubsequentIncrementalExecutionResult,
  ExperimentalIncrementalExecutionResults
> {
  const ids = new Map<SubsequentResultRecord, string>();
  let nextId = 0;

  return {
    getSubsequentPayloadPublisher,
    getPayloads,
  };

  function getSubsequentPayloadPublisher(): SubsequentPayloadPublisher<SubsequentIncrementalExecutionResult> {
    let pending: Array<PendingResult> = [];
    let incremental: Array<IncrementalResult> = [];
    let completed: Array<CompletedResult> = [];

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
      const id = ids.get(deferredFragment);
      invariant(id !== undefined);
      completed.push({
        id,
        errors,
      });
      ids.delete(deferredFragment);
    }

    function addSuccessfulDeferredFragment(
      deferredFragment: DeferredFragment,
      newRootNodes: ReadonlyArray<SubsequentResultRecord>,
      executionGroupResults: ReadonlyArray<ExecutionGroupResult>,
    ): void {
      const id = ids.get(deferredFragment);
      invariant(id !== undefined);
      addPendingResults(newRootNodes, pending);
      for (const executionGroupResult of executionGroupResults) {
        const { bestId, subPath } = getBestIdAndSubPath(
          id,
          deferredFragment,
          executionGroupResult,
        );
        const { data, errors } = executionGroupResult;
        const incrementalEntry: IncrementalDeferResult =
          errors.length > 0
            ? {
                errors,
                data,
                id: bestId,
              }
            : { data, id: bestId };
        if (subPath !== undefined) {
          incrementalEntry.subPath = subPath;
        }
        incremental.push(incrementalEntry);
      }
      completed.push({ id });
      ids.delete(deferredFragment);
    }

    function addFailedStream(
      stream: Stream,
      errors: ReadonlyArray<GraphQLError>,
    ): void {
      const id = ids.get(stream);
      invariant(id !== undefined);
      completed.push({
        id,
        errors,
      });
      ids.delete(stream);
    }

    function addSuccessfulStream(stream: Stream): void {
      const id = ids.get(stream);
      invariant(id !== undefined);
      completed.push({ id });
      ids.delete(stream);
    }

    function addStreamItems(
      stream: Stream,
      newRootNodes: ReadonlyArray<SubsequentResultRecord>,
      streamItemsResult: StreamItemsResult,
    ): void {
      const id = ids.get(stream);
      invariant(id !== undefined);
      const { items, errors } = streamItemsResult;
      const incrementalEntry: IncrementalStreamResult =
        errors.length > 0 ? { errors, items, id } : { items, id };

      incremental.push(incrementalEntry);

      addPendingResults(newRootNodes, pending);
    }

    function getSubsequentPayload(
      hasNext: boolean,
    ): SubsequentIncrementalExecutionResult | undefined {
      if (incremental.length > 0 || completed.length > 0) {
        const subsequentIncrementalExecutionResult: SubsequentIncrementalExecutionResult =
          { hasNext };

        if (pending.length > 0) {
          subsequentIncrementalExecutionResult.pending = pending;
        }

        if (incremental.length > 0) {
          subsequentIncrementalExecutionResult.incremental = incremental;
        }

        if (completed.length > 0) {
          subsequentIncrementalExecutionResult.completed = completed;
        }

        pending = [];
        incremental = [];
        completed = [];

        return subsequentIncrementalExecutionResult;
      }
    }
  }

  function getPayloads(
    data: ObjMap<unknown>,
    errors: ReadonlyArray<GraphQLError>,
    newRootNodes: ReadonlyArray<SubsequentResultRecord>,
    subsequentResults: SimpleAsyncGenerator<SubsequentIncrementalExecutionResult>,
  ): ExperimentalIncrementalExecutionResults {
    const pending: Array<PendingResult> = [];
    addPendingResults(newRootNodes, pending);

    return {
      initialResult:
        errors.length === 0
          ? { data, pending, hasNext: true }
          : { errors, data, pending, hasNext: true },
      subsequentResults,
    };
  }

  function addPendingResults(
    newRootNodes: ReadonlyArray<SubsequentResultRecord>,
    pending: Array<PendingResult>,
  ): void {
    for (const node of newRootNodes) {
      const id = String(nextId++);
      ids.set(node, id);
      const pendingResult: PendingResult = {
        id,
        path: pathToArray(node.path),
      };
      if (node.originalLabel !== undefined) {
        pendingResult.label = node.originalLabel;
      }
      pending.push(pendingResult);
    }
  }

  function getBestIdAndSubPath(
    initialId: string,
    initialDeferredFragment: DeferredFragment,
    executionGroupResult: ExecutionGroupResult,
  ): { bestId: string; subPath: ReadonlyArray<string | number> | undefined } {
    let maxLength = pathToArray(initialDeferredFragment.path).length;
    let bestId = initialId;

    for (const deferredFragment of executionGroupResult.pendingExecutionGroup
      .deferredFragments) {
      if (deferredFragment === initialDeferredFragment) {
        continue;
      }
      const id = ids.get(deferredFragment);
      if (id === undefined) {
        continue;
      }
      const fragmentPath = pathToArray(deferredFragment.path);
      const length = fragmentPath.length;
      // TODO: add test cases for when the initialId is not the best id.
      /* c8 ignore next 4 */
      if (length > maxLength) {
        maxLength = length;
        bestId = id;
      }
    }
    const subPath = pathToArray(
      executionGroupResult.pendingExecutionGroup.path,
    ).slice(maxLength);
    return {
      bestId,
      subPath: subPath.length > 0 ? subPath : undefined,
    };
  }
}
