import type { GraphQLError } from 'graphql';
import type {
  CompletedResult,
  IncrementalResult,
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
import { embedErrors } from './embedErrors.js';
import { getObjectAtPath } from './getObjectAtPath.js';
import { IncrementalGraph } from './IncrementalGraph.js';
import type {
  LegacyExperimentalIncrementalExecutionResults,
  LegacyInitialIncrementalExecutionResult,
  LegacySubsequentIncrementalExecutionResult,
  PayloadPublisher,
  SubsequentPayloadPublisher,
} from './PayloadPublisher.js';
import { getPayloadPublisher } from './PayloadPublisher.js';

interface EncounteredPendingResult {
  id: string;
  path: ReadonlyArray<string | number>;
  label: string;
  pathStr: string;
  key: string;
  completed: undefined | ReadonlyArray<GraphQLError>;
}

/**
 * This class is used to publish incremental results to the client, enabling semi-concurrent
 * execution while preserving result order.
 *
 * @internal
 */
export class IncrementalPublisher {
  private _mergedResult: ObjMap<unknown>;
  private _incrementalGraph: IncrementalGraph;
  private _payloadPublisher: PayloadPublisher<
    LegacyInitialIncrementalExecutionResult,
    LegacySubsequentIncrementalExecutionResult
  >;
  private _encounteredResultsById: Map<string, EncounteredPendingResult>;
  private _encounteredResultsByPath: Map<
    string,
    Map<string, EncounteredPendingResult>
  >;

  constructor(originalData: ObjMap<unknown>) {
    this._mergedResult = originalData;
    this._payloadPublisher = getPayloadPublisher();
    this._incrementalGraph = new IncrementalGraph();
    this._encounteredResultsById = new Map();
    this._encounteredResultsByPath = new Map();
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
      this._processPending(pending);
    }

    const { data, errors, incrementalDataRecords } = initialResult;

    this._incrementalGraph.addIncrementalDataRecords(incrementalDataRecords);

    return {
      initialResult: this._payloadPublisher.getInitialPayload(data, errors),
      subsequentResults: this._subscribe(subsequentResults),
    };
  }

  private _processPending(pendingResults: ReadonlyArray<PendingResult>): void {
    for (const pendingResult of pendingResults) {
      const { id, path, label } = pendingResult;
      invariant(label != null);
      const pathStr = path.join('.');
      const key = label + '.' + pathStr;
      const encounteredPendingResult: EncounteredPendingResult = {
        id,
        path,
        label,
        pathStr,
        key,
        completed: undefined,
      };
      this._encounteredResultsById.set(id, encounteredPendingResult);
      let encounteredResultsByPath =
        this._encounteredResultsByPath.get(pathStr);
      if (encounteredResultsByPath === undefined) {
        encounteredResultsByPath = new Map();
        this._encounteredResultsByPath.set(pathStr, encounteredResultsByPath);
      }
      encounteredResultsByPath.set(label, encounteredPendingResult);
    }
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
        const value = next.value as SubsequentIncrementalExecutionResult;
        if (value === undefined) {
          return { value: undefined, done: true };
        }

        if (value.pending != null) {
          this._processPending(value.pending);
        }

        if (value.incremental != null) {
          const pendingStreamResults = this._processIncremental(
            value.incremental,
          );
          for (const pendingStreamResult of pendingStreamResults) {
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
          }
        }

        if (value.completed != null) {
          this._processCompleted(value.completed, subsequentPayloadPublisher);
        }
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
    const encounteredResultsByPath = this._encounteredResultsByPath.get(
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

      // TODO: add test case - executor completes stream early normally
      /* c8 ignore next 4 */
      if (encounteredResultsByPath === undefined) {
        this._incrementalGraph.removeStream(newRootNode);
        return;
      }

      for (const encounteredPendingResult of encounteredResultsByPath.values()) {
        const maybeErrors = encounteredPendingResult.completed;
        // TODO: add test case - executor completes stream early with errors
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
    const encounteredPendingResult = encounteredResultsByPath?.get(label);

    let completed = true;
    let errors: ReadonlyArray<GraphQLError> | undefined;
    if (encounteredPendingResult !== undefined) {
      const maybeErrors = encounteredPendingResult.completed;
      if (maybeErrors === undefined) {
        completed = false;
      } /* c8 ignore start */ else {
        // TODO: add test case - executor completes fragment early with errors
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

  private _processIncremental(
    incrementalResults: ReadonlyArray<IncrementalResult>,
  ): ReadonlyArray<EncounteredPendingResult> {
    const incrementalStreamResults: Array<EncounteredPendingResult> = [];
    for (const incrementalResult of incrementalResults) {
      const id = incrementalResult.id;
      const pendingResult = this._encounteredResultsById.get(id);
      invariant(pendingResult != null);
      const path = incrementalResult.subPath
        ? [...pendingResult.path, ...incrementalResult.subPath]
        : pendingResult.path;

      const incompleteAtPath = getObjectAtPath(this._mergedResult, path);
      if (Array.isArray(incompleteAtPath)) {
        invariant('items' in incrementalResult);
        incompleteAtPath.push(
          ...(incrementalResult.items as ReadonlyArray<unknown>),
        );
        embedErrors(this._mergedResult, incrementalResult.errors);
        incrementalStreamResults.push(pendingResult);
      } else {
        invariant('data' in incrementalResult);
        for (const [key, value] of Object.entries(
          incrementalResult.data as ObjMap<unknown>,
        )) {
          incompleteAtPath[key] = value;
        }
        embedErrors(this._mergedResult, incrementalResult.errors);
      }
    }
    return incrementalStreamResults;
  }

  private _processCompleted(
    completedResults: ReadonlyArray<CompletedResult>,
    subsequentPayloadPublisher: SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult>,
  ): void {
    for (const completedResult of completedResults) {
      const id = completedResult.id;
      const pendingResult = this._encounteredResultsById.get(id);
      this._encounteredResultsById.delete(id);

      invariant(pendingResult != null);
      const streams = this._incrementalGraph.getStreams(pendingResult.pathStr);

      if ('errors' in completedResult) {
        pendingResult.completed = completedResult.errors;
      }

      if (streams !== undefined) {
        for (const stream of streams) {
          this._handleCompletedStream(
            subsequentPayloadPublisher,
            pendingResult.completed,
            stream,
          );
        }

        if (pendingResult.completed === undefined) {
          // we cannot clean this up in the case of errors, because in branching mode,
          // there may be a deferred version of the stream for which we will need to send errors
          this._encounteredResultsByPath.delete(pendingResult.pathStr);
        }

        continue;
      }

      const key = pendingResult.key;
      const deferredFragment = this._incrementalGraph.getDeferredFragment(key);

      // TODO: add test case - executor completes pending result early, not found in graph as stream or deferred fragment
      /* c8 ignore next 3 */
      if (deferredFragment === undefined) {
        continue;
      }

      this._handleCompletedDeferredFragment(
        subsequentPayloadPublisher,
        pendingResult.completed,
        deferredFragment,
      );

      const encounteredResultsByPath = this._encounteredResultsByPath.get(
        pendingResult.pathStr,
      );
      invariant(encounteredResultsByPath != null);
      encounteredResultsByPath.delete(pendingResult.label);
      if (encounteredResultsByPath.size === 0) {
        this._encounteredResultsByPath.delete(pendingResult.pathStr);
      }
    }
  }

  private _handleCompletedStream(
    subsequentPayloadPublisher: SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult>,
    errors: ReadonlyArray<GraphQLError> | false | undefined,
    stream: Stream,
  ): void {
    if (Array.isArray(errors)) {
      subsequentPayloadPublisher.addFailedStream(stream, errors);
    }
    this._incrementalGraph.removeStream(stream);
  }

  private _handleCompletedDeferredFragment(
    subsequentPayloadPublisher: SubsequentPayloadPublisher<LegacySubsequentIncrementalExecutionResult>,
    errors: ReadonlyArray<GraphQLError> | false | undefined,
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
