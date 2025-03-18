import type { GraphQLError } from 'graphql';
import type {
  PendingResult,
  SubsequentIncrementalExecutionResult,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

import { invariant } from '../jsutils/invariant.js';
import type { ObjMap } from '../jsutils/ObjMap.js';

import { IncrementalGraph } from './IncrementalGraph.js';
import type { EncounteredPendingResult } from './MergedResult.js';
import { MergedResult } from './MergedResult.js';
import type {
  LegacySubsequentIncrementalExecutionResult,
  SubsequentPayloadPublisher,
} from './PayloadPublisher.js';
import type {
  CompletedIncrementalData,
  DeferredFragment,
  ExecutionGroupResult,
  IncrementalDataRecord,
  Stream,
  StreamItems,
  SubsequentResultRecord,
} from './types.js';
import { isStream } from './types.js';

/**
 * This class is used to publish incremental results to the client, enabling semi-concurrent
 * execution while preserving result order.
 *
 * @internal
 */
export class IncrementalPublisher {
  private _isDone: boolean;
  private _mergedResult: MergedResult;
  private _subsequentResults:
    | AsyncGenerator<SubsequentIncrementalExecutionResult>
    | undefined;
  private _incrementalGraph: IncrementalGraph;
  private _subsequentPayloadPublisher: SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult>;

  constructor(
    originalData: ObjMap<unknown>,
    incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>,
    subsequentPayloadPublisher: SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult>,
    pending?: ReadonlyArray<PendingResult>,
    subsequentResults?: AsyncGenerator<SubsequentIncrementalExecutionResult>,
  ) {
    this._isDone = false;
    this._mergedResult = new MergedResult(originalData);
    if (pending != null) {
      this._mergedResult.processPending(pending);
    }
    this._subsequentResults = subsequentResults;

    this._subsequentPayloadPublisher = subsequentPayloadPublisher;
    this._incrementalGraph = new IncrementalGraph();

    const newRootNodes = this._incrementalGraph.getNewRootNodes(
      incrementalDataRecords,
    );
    this._handleNewRootNodes(newRootNodes);
  }

  subscribe(): AsyncGenerator<
    LegacySubsequentIncrementalExecutionResult,
    void,
    void
  > {
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => this._next(),
      return: () => this._return(),
      throw: (error) => this._throw(error),
    };
  }

  private _handleNewRootNodes(
    newRootNodes: ReadonlyArray<SubsequentResultRecord>,
  ): void {
    for (const newRootNode of newRootNodes) {
      const pendingResultsByPath = this._mergedResult.getPendingResultsByPath(
        newRootNode.pathStr,
      );

      if (isStream(newRootNode)) {
        this._handleNewStream(newRootNode, pendingResultsByPath);
      } else {
        this._handleNewDeferredFragment(newRootNode, pendingResultsByPath);
      }
    }
  }

  private async _next(): Promise<
    IteratorResult<LegacySubsequentIncrementalExecutionResult, void>
  > {
    if (this._isDone) {
      if (this._subsequentResults) {
        await this._returnAsyncIteratorsIgnoringErrors(this._subsequentResults);
      }
      return { value: undefined, done: true };
    }

    let batch: Iterable<CompletedIncrementalData> | undefined =
      this._incrementalGraph.currentCompletedBatch();
    while (true) {
      const currentBatchResult = this._handleBatch(batch);

      if (currentBatchResult !== undefined) {
        return currentBatchResult;
      }

      // TODO: add test cases for async transformation
      /* c8 ignore next 7 */
      if (this._incrementalGraph.hasPending()) {
        // eslint-disable-next-line no-await-in-loop
        batch = await this._incrementalGraph.nextCompletedBatch();
        if (batch !== undefined) {
          continue;
        }
      }

      invariant(this._subsequentResults != null);

      // eslint-disable-next-line no-await-in-loop
      const next = await this._subsequentResults.next();

      if (this._isDone) {
        return { value: undefined, done: true };
      }

      this._onSubsequentIncrementalExecutionResult(next.value);

      batch = this._incrementalGraph.currentCompletedBatch();
    }
  }

  private async _return(): Promise<
    IteratorResult<LegacySubsequentIncrementalExecutionResult, void>
  > {
    this._isDone = true;
    if (this._subsequentResults) {
      await this._returnAsyncIterators(this._subsequentResults);
    }
    return { value: undefined, done: true };
  }

  private async _throw(
    error?: unknown,
  ): Promise<IteratorResult<LegacySubsequentIncrementalExecutionResult, void>> {
    this._isDone = true;
    if (this._subsequentResults) {
      await this._returnAsyncIterators(this._subsequentResults);
    }
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(error);
  }

  private _handleBatch(
    batch: Iterable<CompletedIncrementalData>,
  ):
    | IteratorResult<LegacySubsequentIncrementalExecutionResult, void>
    | undefined {
    for (const completedResult of batch) {
      this._handleCompletedIncrementalData(completedResult);
    }

    const hasNext = this._incrementalGraph.hasNext();
    const subsequentPayload =
      this._subsequentPayloadPublisher.getSubsequentPayload(hasNext);

    if (subsequentPayload !== undefined) {
      if (!hasNext) {
        this._isDone = true;
      }

      return { value: subsequentPayload, done: false };
    } else if (!hasNext) {
      this._isDone = true;
      return { value: { hasNext }, done: false };
    }
  }

  private _handleCompletedIncrementalData(
    completedIncrementalData: CompletedIncrementalData,
  ): void {
    if ('pendingExecutionGroup' in completedIncrementalData) {
      this._handleCompletedExecutionGroup(completedIncrementalData);
    } else {
      this._handleCompletedStreamItems(completedIncrementalData);
    }
  }

  private _handleCompletedStreamItems(streamItems: StreamItems): void {
    const { stream, errors, result } = streamItems;
    if (errors) {
      this._subsequentPayloadPublisher.addFailedStream(
        stream,
        errors,
        stream.publishedItems,
      );
      this._incrementalGraph.removeStream(stream);
    } else if (result) {
      const newRootNodes = this._incrementalGraph.getNewRootNodes(
        result.incrementalDataRecords,
      );
      this._handleNewRootNodes(newRootNodes);

      this._subsequentPayloadPublisher.addStreamItems(
        stream,
        result,
        stream.publishedItems,
      );

      stream.publishedItems += result.items.length;
    } else {
      this._incrementalGraph.removeStream(stream);
    }
  }

  private _handleCompletedExecutionGroup(
    executionGroupResult: ExecutionGroupResult,
  ): void {
    this._incrementalGraph.addCompletedSuccessfulExecutionGroup(
      executionGroupResult,
    );

    for (const deferredFragment of executionGroupResult.pendingExecutionGroup
      .deferredFragments) {
      const completion =
        this._incrementalGraph.completeDeferredFragment(deferredFragment);
      // TODO: add test cases for async transformation
      /* c8 ignore next 3 */
      if (completion === undefined) {
        continue;
      }

      const { newRootNodes, successfulExecutionGroups } = completion;
      this._handleNewRootNodes(newRootNodes);

      this._subsequentPayloadPublisher.addSuccessfulDeferredFragment(
        deferredFragment,
        successfulExecutionGroups,
      );
    }
  }

  private _handleNewStream(
    newRootNode: Stream,
    pendingResultsByPath:
      | ReadonlyMap<string, EncounteredPendingResult>
      | undefined,
  ): void {
    this._incrementalGraph.completeStreamItems(newRootNode);

    // TODO: add test case - original executor completes stream early normally
    /* c8 ignore next 4 */
    if (pendingResultsByPath === undefined) {
      this._incrementalGraph.terminateStream(newRootNode, null);
    } else {
      for (const pendingResult of pendingResultsByPath.values()) {
        const maybeErrors = pendingResult.completed;
        // TODO: add test case - original executor completes stream early with errors
        /* c8 ignore start */
        if (maybeErrors !== undefined) {
          this._incrementalGraph.terminateStream(newRootNode, maybeErrors);
          break;
        }
        /* c8 ignore stop */
      }
    }
  }

  private _handleNewDeferredFragment(
    newRootNode: DeferredFragment,
    pendingResultsByPath:
      | ReadonlyMap<string, EncounteredPendingResult>
      | undefined,
  ): void {
    const label = newRootNode.label;
    invariant(label != null);
    const pendingResult = pendingResultsByPath?.get(label);

    let completed = true;
    let errors: ReadonlyArray<GraphQLError> | undefined;
    if (pendingResult !== undefined) {
      const maybeErrors = pendingResult.completed;
      if (maybeErrors === undefined) {
        completed = false;
      } /* c8 ignore start */ else {
        // TODO: add test case - original executor completes fragment early with errors
        errors = maybeErrors;
      }
      /* c8 ignore stop */
    }

    if (completed) {
      this._handleCompletedOriginalDeferredFragment(errors, newRootNode);
    }
  }

  private _handleCompletedOriginalDeferredFragment(
    errors: ReadonlyArray<GraphQLError> | undefined,
    deferredFragment: DeferredFragment,
  ): void {
    if (Array.isArray(errors)) {
      this._subsequentPayloadPublisher.addFailedDeferredFragment(
        deferredFragment,
        errors,
      );
      this._incrementalGraph.removeDeferredFragment(deferredFragment);
    } else {
      this._incrementalGraph.onCompletedOriginalDeferredFragment(
        deferredFragment,
      );
    }
  }

  private _onSubsequentIncrementalExecutionResult(
    subsequentIncrementalExecutionResult: SubsequentIncrementalExecutionResult,
  ): void {
    this._mergedResult.onSubsequentIncrementalExecutionResult(
      subsequentIncrementalExecutionResult,
      (pendingResult) => this._onOriginalStreamItems(pendingResult),
      (pendingResult) => this._onCompletedOriginalStream(pendingResult),
      (pendingResult) =>
        this._onCompletedOriginalDeferredFragment(pendingResult),
    );
  }

  private _onOriginalStreamItems(
    pendingResult: EncounteredPendingResult,
  ): void {
    const streams = this._incrementalGraph.getStreams(pendingResult.pathStr);
    if (streams != null) {
      for (const stream of streams) {
        this._incrementalGraph.completeStreamItems(stream);
      }
    }
  }

  private _onCompletedOriginalStream(
    pendingResult: EncounteredPendingResult,
  ): void {
    const streams = this._incrementalGraph.getStreams(pendingResult.pathStr);

    // TODO: add test case - original executor completes pending result early, not found in graph
    /* c8 ignore next 3 */
    if (streams === undefined) {
      return;
    }

    const maybeErrors = pendingResult.completed ?? null;
    for (const stream of streams) {
      this._incrementalGraph.terminateStream(stream, maybeErrors);
    }
  }

  private _onCompletedOriginalDeferredFragment(
    pendingResult: EncounteredPendingResult,
  ): void {
    const deferredFragment = this._incrementalGraph.getDeferredFragment(
      pendingResult.key,
    );

    // TODO: add test case - original executor completes pending result early, not found in graph
    /* c8 ignore next 3 */
    if (deferredFragment === undefined) {
      return;
    }

    this._handleCompletedOriginalDeferredFragment(
      pendingResult.completed,
      deferredFragment,
    );
  }

  private async _returnAsyncIterators(
    subsequentResults: AsyncGenerator<SubsequentIncrementalExecutionResult>,
  ): Promise<void> {
    await subsequentResults.return?.(undefined);
  }

  private async _returnAsyncIteratorsIgnoringErrors(
    subsequentResults: AsyncGenerator<SubsequentIncrementalExecutionResult>,
  ): Promise<void> {
    await this._returnAsyncIterators(subsequentResults).catch(() => {
      // Ignore errors
    });
  }
}
