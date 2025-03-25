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
  PayloadPublisher,
  SubsequentPayloadPublisher,
} from './PayloadPublisher.js';
import type {
  DeferredFragment,
  ExecutionGroupResult,
  FailedDeferredFragment,
  IncrementalDataRecord,
  IncrementalGraphEvent,
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
export class IncrementalPublisher<TSubsequent, TIncremental> {
  private _isDone: boolean;
  private _mergedResult: MergedResult;
  private _subsequentResults:
    | AsyncGenerator<SubsequentIncrementalExecutionResult>
    | undefined;
  private _incrementalGraph: IncrementalGraph;
  private _payloadPublisher: PayloadPublisher<TSubsequent, TIncremental>;
  private _subsequentPayloadPublisher: SubsequentPayloadPublisher<TSubsequent>;

  constructor(
    originalData: ObjMap<unknown>,
    payloadPublisher: PayloadPublisher<TSubsequent, TIncremental>,
    pending?: ReadonlyArray<PendingResult>,
    subsequentResults?: AsyncGenerator<SubsequentIncrementalExecutionResult>,
  ) {
    this._isDone = false;
    this._mergedResult = new MergedResult(originalData);
    if (pending != null) {
      this._mergedResult.processPending(pending);
    }
    this._subsequentResults = subsequentResults;

    this._payloadPublisher = payloadPublisher;
    this._subsequentPayloadPublisher =
      payloadPublisher.getSubsequentPayloadPublisher();
    this._incrementalGraph = new IncrementalGraph();
  }

  buildResponse(
    data: ObjMap<unknown>,
    errors: ReadonlyArray<GraphQLError>,
    incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>,
  ): TIncremental {
    const newRootNodes = this._incrementalGraph.getNewRootNodes(
      incrementalDataRecords,
    );

    this._handleNewRootNodes(newRootNodes);

    return this._payloadPublisher.getPayloads(
      data,
      errors,
      newRootNodes,
      this._subscribe(),
    );
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

  private _subscribe(): AsyncGenerator<TSubsequent, void, void> {
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => this._next(),
      return: () => this._return(),
      throw: (error) => this._throw(error),
    };
  }

  private async _next(): Promise<IteratorResult<TSubsequent, void>> {
    if (this._isDone) {
      if (this._subsequentResults) {
        await this._returnAsyncIteratorsIgnoringErrors(this._subsequentResults);
      }
      return { value: undefined, done: true };
    }

    let batch: Iterable<IncrementalGraphEvent> | undefined =
      this._incrementalGraph.currentCompletedBatch();
    while (true) {
      for (const event of batch) {
        if ('pendingExecutionGroup' in event) {
          this._handleCompletedExecutionGroup(event);
        } else if ('stream' in event) {
          this._handleCompletedStreamItems(event);
        } else {
          this._handleFailedDeferredFragment(event);
        }
      }

      const hasNext = this._incrementalGraph.hasNext();
      const subsequentPayload =
        this._subsequentPayloadPublisher.getSubsequentPayload(hasNext);

      if (subsequentPayload !== undefined) {
        if (!hasNext) {
          this._isDone = true;
        }

        return { value: subsequentPayload, done: false };
      }

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

  private async _return(): Promise<IteratorResult<TSubsequent, void>> {
    this._isDone = true;
    if (this._subsequentResults) {
      await this._returnAsyncIterators(this._subsequentResults);
    }
    return { value: undefined, done: true };
  }

  private async _throw(
    error?: unknown,
  ): Promise<IteratorResult<TSubsequent, void>> {
    this._isDone = true;
    if (this._subsequentResults) {
      await this._returnAsyncIterators(this._subsequentResults);
    }
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(error);
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
        newRootNodes,
        result,
        stream.publishedItems,
      );

      stream.publishedItems += result.items.length;
    } else {
      this._subsequentPayloadPublisher.addSuccessfulStream(stream);
      this._incrementalGraph.removeStream(stream);
    }
  }

  private _handleCompletedExecutionGroup(
    executionGroupResult: ExecutionGroupResult,
  ): void {
    if (executionGroupResult.data === null) {
      for (const deferredFragment of executionGroupResult.pendingExecutionGroup
        .deferredFragments) {
        // TODO: add test case for failure of an already failed fragment via transformation
        /* c8 ignore next 3 */
        if (deferredFragment.failed) {
          continue;
        }
        this._incrementalGraph.removeDeferredFragment(deferredFragment);

        this._subsequentPayloadPublisher.addFailedDeferredFragment(
          deferredFragment,
          executionGroupResult.errors,
        );
      }
      return;
    }

    this._incrementalGraph.addCompletedSuccessfulExecutionGroup(
      executionGroupResult,
    );

    for (const deferredFragment of executionGroupResult.pendingExecutionGroup
      .deferredFragments) {
      const completion =
        this._incrementalGraph.completeDeferredFragment(deferredFragment);
      if (completion === undefined) {
        continue;
      }

      const { newRootNodes, successfulExecutionGroups } = completion;
      this._handleNewRootNodes(newRootNodes);

      this._subsequentPayloadPublisher.addSuccessfulDeferredFragment(
        deferredFragment,
        newRootNodes,
        successfulExecutionGroups,
      );
    }
  }

  private _handleFailedDeferredFragment(
    failedDeferredFragment: FailedDeferredFragment,
  ): void {
    const { deferredFragment, errors } = failedDeferredFragment;
    // TODO: add test case for removing an already removed deferred fragment
    /* c8 ignore next 3 */
    if (deferredFragment.failed) {
      return;
    }
    deferredFragment.failed = true;
    this._incrementalGraph.removeDeferredFragment(deferredFragment);
    this._subsequentPayloadPublisher.addFailedDeferredFragment(
      deferredFragment,
      errors,
    );
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
      this._incrementalGraph.onCompletedOriginalDeferredFragment(
        newRootNode,
        errors,
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

    if (deferredFragment === undefined) {
      return;
    }

    this._incrementalGraph.onCompletedOriginalDeferredFragment(
      deferredFragment,
      pendingResult.completed,
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
