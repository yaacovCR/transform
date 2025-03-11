import type { GraphQLError } from 'graphql';
import type {
  PendingResult,
  SubsequentIncrementalExecutionResult,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

import { invariant } from '../jsutils/invariant.js';
import type { ObjMap } from '../jsutils/ObjMap.js';

import type {
  DeferredFragment,
  IncrementalDataRecord,
  Stream,
  SubsequentResultRecord,
} from './buildTransformationContext.js';
import { isStream } from './buildTransformationContext.js';
import { IncrementalGraph } from './IncrementalGraph.js';
import type { EncounteredPendingResult } from './MergedResult.js';
import { MergedResult } from './MergedResult.js';
import type {
  LegacyExperimentalIncrementalExecutionResults,
  LegacyInitialIncrementalExecutionResult,
  LegacySubsequentIncrementalExecutionResult,
  PayloadPublisher,
  SubsequentPayloadPublisher,
} from './PayloadPublisher.js';
import { getPayloadPublisher } from './PayloadPublisher.js';

/**
 * This class is used to publish incremental results to the client, enabling semi-concurrent
 * execution while preserving result order.
 *
 * @internal
 */
export class IncrementalPublisher {
  private _mergedResult: MergedResult;
  private _incrementalGraph: IncrementalGraph;
  private _payloadPublisher: PayloadPublisher<
    LegacyInitialIncrementalExecutionResult,
    LegacySubsequentIncrementalExecutionResult
  >;

  constructor(originalData: ObjMap<unknown>) {
    this._mergedResult = new MergedResult(originalData);
    this._payloadPublisher = getPayloadPublisher();
    this._incrementalGraph = new IncrementalGraph();
  }

  buildResponse(
    initialResult: {
      data: ObjMap<unknown>;
      errors: ReadonlyArray<GraphQLError>;
      incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>;
    },
    pending?: ReadonlyArray<PendingResult>,
    subsequentResults?: AsyncGenerator<SubsequentIncrementalExecutionResult>,
  ): LegacyExperimentalIncrementalExecutionResults {
    if (pending != null) {
      this._mergedResult.processPending(pending);
    }

    const { data, errors, incrementalDataRecords } = initialResult;

    this._incrementalGraph.addIncrementalDataRecords(incrementalDataRecords);

    return {
      initialResult: this._payloadPublisher.getInitialPayload(data, errors),
      subsequentResults: this._subscribe(subsequentResults),
    };
  }

  private _subscribe(
    subsequentResults:
      | AsyncGenerator<SubsequentIncrementalExecutionResult>
      | undefined,
  ): AsyncGenerator<LegacySubsequentIncrementalExecutionResult, void, void> {
    let isDone = false;

    const subsequentPayloadPublisher =
      this._payloadPublisher.getSubsequentPayloadPublisher();

    const _next = async (): Promise<
      IteratorResult<LegacySubsequentIncrementalExecutionResult, void>
    > => {
      if (isDone) {
        if (subsequentResults) {
          await this._returnAsyncIteratorsIgnoringErrors(subsequentResults);
        }
        return { value: undefined, done: true };
      }

      while (true) {
        const newRootNodes = this._incrementalGraph.getNewRootNodes();
        for (const newRootNode of newRootNodes) {
          this._handleNewRootNode(newRootNode, subsequentPayloadPublisher);
        }

        const hasNext = this._incrementalGraph.hasNext();
        const subsequentPayload =
          subsequentPayloadPublisher.getSubsequentPayload(hasNext);

        if (subsequentPayload !== undefined) {
          if (!hasNext) {
            isDone = true;
          }

          return { value: subsequentPayload, done: false };
        } else if (!hasNext) {
          isDone = true;
          return { value: { hasNext }, done: false };
        }

        invariant(subsequentResults != null);

        // eslint-disable-next-line no-await-in-loop
        const next = await subsequentResults.next();

        if (isDone) {
          return { value: undefined, done: true };
        }

        this._onSubsequentIncrementalExecutionResult(
          next.value,
          subsequentPayloadPublisher,
        );
      }
    };

    const _return = async (): Promise<
      IteratorResult<LegacySubsequentIncrementalExecutionResult, void>
    > => {
      isDone = true;
      if (subsequentResults) {
        await this._returnAsyncIterators(subsequentResults);
      }
      return { value: undefined, done: true };
    };

    const _throw = async (
      error?: unknown,
    ): Promise<
      IteratorResult<LegacySubsequentIncrementalExecutionResult, void>
    > => {
      isDone = true;
      if (subsequentResults) {
        await this._returnAsyncIterators(subsequentResults);
      }
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(error);
    };

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: _next,
      return: _return,
      throw: _throw,
    };
  }

  private _handleNewRootNode(
    newRootNode: SubsequentResultRecord,
    subsequentPayloadPublisher: SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult>,
  ): void {
    const pendingResultsByPath = this._mergedResult.getPendingResultsByPath(
      newRootNode.pathStr,
    );

    if (isStream(newRootNode)) {
      const nextIndex = newRootNode.nextIndex;
      const streamItemsResult = newRootNode.result(nextIndex);
      const numItems = streamItemsResult.items.length;
      if (numItems > 0) {
        this._incrementalGraph.addIncrementalDataRecords(
          streamItemsResult.incrementalDataRecords,
        );
        subsequentPayloadPublisher.addStreamItems(
          newRootNode,
          streamItemsResult,
        );
        newRootNode.nextIndex += numItems;
      }

      // TODO: add test case - original executor completes stream early normally
      /* c8 ignore next 4 */
      if (pendingResultsByPath === undefined) {
        this._incrementalGraph.removeStream(newRootNode);
        return;
      }

      for (const pendingResult of pendingResultsByPath.values()) {
        const maybeErrors = pendingResult.completed;
        // TODO: add test case - original executor completes stream early with errors
        /* c8 ignore start */
        if (maybeErrors !== undefined) {
          this._handleCompletedStream(
            subsequentPayloadPublisher,
            maybeErrors,
            newRootNode,
          );
          this._incrementalGraph.removeStream(newRootNode);
          return;
        }
        /* c8 ignore stop */
      }

      return;
    }

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
      this._handleCompletedDeferredFragment(
        subsequentPayloadPublisher,
        errors,
        newRootNode,
      );
      this._incrementalGraph.removeDeferredFragment(newRootNode);
    }
  }

  private _onSubsequentIncrementalExecutionResult(
    subsequentIncrementalExecutionResult: SubsequentIncrementalExecutionResult,
    subsequentPayloadPublisher: SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult>,
  ): void {
    this._mergedResult.onSubsequentIncrementalExecutionResult(
      subsequentIncrementalExecutionResult,
      (pendingStreamResult) => {
        const streams = this._incrementalGraph.getStreams(
          pendingStreamResult.pathStr,
        );
        if (streams != null) {
          for (const stream of streams) {
            const nextIndex = stream.nextIndex;
            const streamItemsResult = stream.result(nextIndex);
            this._incrementalGraph.addIncrementalDataRecords(
              streamItemsResult.incrementalDataRecords,
            );
            subsequentPayloadPublisher.addStreamItems(
              stream,
              streamItemsResult,
            );
            stream.nextIndex += streamItemsResult.items.length;
          }
        }
      },
      (pendingResult) =>
        this._onCompletedOriginalStream(
          pendingResult,
          subsequentPayloadPublisher,
        ),
      (pendingResult) =>
        this._onCompletedOriginalDeferredFragment(
          pendingResult,
          subsequentPayloadPublisher,
        ),
    );
  }

  private _onCompletedOriginalStream(
    pendingResult: EncounteredPendingResult,
    subsequentPayloadPublisher: SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult>,
  ): void {
    const streams = this._incrementalGraph.getStreams(pendingResult.pathStr);

    // TODO: add test case - original executor completes pending result early, not found in graph
    /* c8 ignore next 3 */
    if (streams === undefined) {
      return;
    }

    for (const stream of streams) {
      this._handleCompletedStream(
        subsequentPayloadPublisher,
        pendingResult.completed,
        stream,
      );
    }
  }

  private _onCompletedOriginalDeferredFragment(
    pendingResult: EncounteredPendingResult,
    subsequentPayloadPublisher: SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult>,
  ): void {
    const deferredFragment = this._incrementalGraph.getDeferredFragment(
      pendingResult.key,
    );

    // TODO: add test case - original executor completes pending result early, not found in graph
    /* c8 ignore next 3 */
    if (deferredFragment === undefined) {
      return;
    }

    this._handleCompletedDeferredFragment(
      subsequentPayloadPublisher,
      pendingResult.completed,
      deferredFragment,
    );
  }

  private _handleCompletedStream(
    subsequentPayloadPublisher: SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult>,
    errors: ReadonlyArray<GraphQLError> | undefined,
    stream: Stream,
  ): void {
    if (Array.isArray(errors)) {
      subsequentPayloadPublisher.addFailedStream(stream, errors);
    }
    this._incrementalGraph.removeStream(stream);
  }

  private _handleCompletedDeferredFragment(
    subsequentPayloadPublisher: SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult>,
    errors: ReadonlyArray<GraphQLError> | undefined,
    deferredFragment: DeferredFragment,
  ): void {
    if (Array.isArray(errors)) {
      subsequentPayloadPublisher.addFailedDeferredFragment(
        deferredFragment,
        errors,
      );
      this._incrementalGraph.removeDeferredFragment(deferredFragment);
    } else {
      const executionGroupResults =
        this._incrementalGraph.completeDeferredFragment(deferredFragment);
      if (executionGroupResults !== undefined) {
        subsequentPayloadPublisher.addSuccessfulDeferredFragment(
          deferredFragment,
          executionGroupResults,
        );
      }
    }
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
