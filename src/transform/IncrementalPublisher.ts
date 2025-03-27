import type { GraphQLError } from 'graphql';

import { invariant } from '../jsutils/invariant.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { SimpleAsyncGenerator } from '../jsutils/SimpleAsyncGenerator.js';

import { IncrementalGraph } from './IncrementalGraph.js';
import type { MergedResult, SubsequentResultEvents } from './MergedResult.js';
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
import {
  isCompletedStreamItems,
  isDeferredFragment,
  isExecutionGroupResult,
  isFailedDeferredFragment,
  isStream,
} from './types.js';

/**
 * This class is used to publish incremental results to the client, enabling semi-concurrent
 * execution while preserving result order.
 *
 * @internal
 */
export class IncrementalPublisher<TSubsequent, TIncremental> {
  private _isDone: boolean;
  private _mergedResult: MergedResult;
  private _eventsStream:
    | SimpleAsyncGenerator<SubsequentResultEvents>
    | undefined;
  private _incrementalGraph: IncrementalGraph;
  private _payloadPublisher: PayloadPublisher<TSubsequent, TIncremental>;
  private _subsequentPayloadPublisher: SubsequentPayloadPublisher<TSubsequent>;

  constructor(
    payloadPublisher: PayloadPublisher<TSubsequent, TIncremental>,
    mergedResult: MergedResult,
  ) {
    this._isDone = false;
    this._mergedResult = mergedResult;
    this._eventsStream = mergedResult.getEvents();
    this._incrementalGraph = new IncrementalGraph();
    this._payloadPublisher = payloadPublisher;
    this._subsequentPayloadPublisher =
      payloadPublisher.getSubsequentPayloadPublisher();
  }

  buildResponse(
    data: ObjMap<unknown>,
    errors: ReadonlyArray<GraphQLError>,
    deferredFragments: ReadonlyArray<DeferredFragment>,
    incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>,
  ): TIncremental {
    const newRootNodes = this._incrementalGraph.getNewRootNodes(
      deferredFragments,
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
      if (isStream(newRootNode)) {
        this._handleNewStream(newRootNode);
      } else if (isDeferredFragment(newRootNode)) {
        this._handleNewDeferredFragment(newRootNode);
      } /* c8 ignore start */ else {
        invariant(false, 'Unexpected new root node type.');
      } /* c8 ignore stop */
    }
  }

  private _subscribe(): SimpleAsyncGenerator<TSubsequent> {
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
      if (this._eventsStream) {
        await this._returnAsyncIteratorsIgnoringErrors(this._eventsStream);
      }
      return { value: undefined, done: true };
    }

    let batch: Iterable<IncrementalGraphEvent> | undefined =
      this._incrementalGraph.currentCompletedBatch();
    while (true) {
      for (const event of batch) {
        if (isExecutionGroupResult(event)) {
          this._handleCompletedExecutionGroup(event);
        } else if (isCompletedStreamItems(event)) {
          this._handleCompletedStreamItems(event);
        } else if (isFailedDeferredFragment(event)) {
          this._handleFailedDeferredFragment(event);
        } /* c8 ignore start */ else {
          invariant(false, 'Unexpected event type in incremental graph.');
        } /* c8 ignore stop */
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

      // TODO: add test case for async transformation
      /* c8 ignore next 7 */
      if (this._incrementalGraph.hasPending()) {
        // eslint-disable-next-line no-await-in-loop
        batch = await this._incrementalGraph.nextCompletedBatch();
        if (batch !== undefined) {
          continue;
        }
      }

      invariant(this._eventsStream !== undefined); // Check moved to start of function

      // eslint-disable-next-line no-await-in-loop
      const next = await this._eventsStream.next();

      if (next.done || this._isDone) {
        return { value: undefined, done: true };
      }

      this._processEvents(next.value);

      batch = this._incrementalGraph.currentCompletedBatch();
    }
  }

  private async _return(): Promise<IteratorResult<TSubsequent, void>> {
    this._isDone = true;
    if (this._eventsStream) {
      await this._returnAsyncIterators(this._eventsStream);
    }
    return { value: undefined, done: true };
  }

  private async _throw(
    error?: unknown,
  ): Promise<IteratorResult<TSubsequent, void>> {
    this._isDone = true;
    if (this._eventsStream) {
      await this._returnAsyncIterators(this._eventsStream);
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
      const { deferredFragments, incrementalDataRecords } = result;
      const newRootNodes = this._incrementalGraph.getNewRootNodes(
        deferredFragments,
        incrementalDataRecords,
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

  private _handleNewStream(newRootNode: Stream): void {
    this._incrementalGraph.completeStreamItems(newRootNode);

    // TODO: add test case - original executor completes stream early normally
    /* c8 ignore next 4 */
    if (this._mergedResult === undefined) {
      this._incrementalGraph.terminateStream(newRootNode);
      return;
    }

    const key = newRootNode.pathStr;
    const positionInfo = this._mergedResult.getPositionInfo(key);

    // TODO: add test case - original executor completes stream early normally
    /* c8 ignore next 4 */
    if (positionInfo === undefined) {
      this._incrementalGraph.terminateStream(newRootNode);
      return;
    }

    const errors = positionInfo.errors;
    // TODO: add test case - original executor completes stream early with errors
    /* c8 ignore start */
    if (errors) {
      this._incrementalGraph.terminateStream(newRootNode, errors);
    }
    /* c8 ignore stop */
  }

  private _handleNewDeferredFragment(newRootNode: DeferredFragment): void {
    const { label, pathStr } = newRootNode;
    const key = label + '.' + pathStr;
    const positionInfo = this._mergedResult?.getPositionInfo(key);

    if (positionInfo === undefined) {
      this._incrementalGraph.onCompletedOriginalDeferredFragment(
        newRootNode,
        undefined,
      );
      return;
    }

    const errors = positionInfo.errors;
    // TODO: add test case - original executor completes defer early with errors
    /* c8 ignore start */
    if (errors) {
      this._incrementalGraph.onCompletedOriginalDeferredFragment(
        newRootNode,
        errors,
      );
    }
    /* c8 ignore stop */
  }

  private _processEvents(events: SubsequentResultEvents): void {
    const {
      streamsWithNewItems,
      completedStreams,
      completedDeferredFragments,
    } = events;

    for (const keyedStream of streamsWithNewItems) {
      this._onOriginalStreamItems(keyedStream);
    }

    for (const [keyedStream, errors] of completedStreams) {
      this._onCompletedOriginalStream(keyedStream, errors);
    }

    for (const [keyedDefer, errors] of completedDeferredFragments) {
      this._onCompletedOriginalDeferredFragment(keyedDefer, errors);
    }
  }

  private _onOriginalStreamItems(key: string): void {
    const streams = this._incrementalGraph.getStreams(key);
    if (streams != null) {
      for (const stream of streams) {
        this._incrementalGraph.completeStreamItems(stream);
      }
    }
  }

  private _onCompletedOriginalStream(
    key: string,
    errors: ReadonlyArray<GraphQLError> | undefined,
  ): void {
    const streams = this._incrementalGraph.getStreams(key);

    // TODO: add test case - original executor completes pending result early, not found in graph
    /* c8 ignore next 3 */
    if (streams === undefined) {
      return;
    }

    for (const stream of streams) {
      this._incrementalGraph.terminateStream(stream, errors);
    }
  }

  private _onCompletedOriginalDeferredFragment(
    key: string,
    errors: ReadonlyArray<GraphQLError> | undefined,
  ): void {
    const deferredFragment = this._incrementalGraph.getDeferredFragment(key);

    if (deferredFragment === undefined) {
      return;
    }

    this._incrementalGraph.onCompletedOriginalDeferredFragment(
      deferredFragment,
      errors,
    );
  }

  private async _returnAsyncIterators(
    subsequentResults: SimpleAsyncGenerator<SubsequentResultEvents>,
  ): Promise<void> {
    await subsequentResults.return?.(undefined);
  }

  private async _returnAsyncIteratorsIgnoringErrors(
    subsequentResults: SimpleAsyncGenerator<SubsequentResultEvents>,
  ): Promise<void> {
    await this._returnAsyncIterators(subsequentResults).catch(() => {
      // Ignore errors
    });
  }
}
