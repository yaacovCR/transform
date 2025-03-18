import type { GraphQLError } from 'graphql';

import { BoxedPromiseOrValue } from '../jsutils/BoxedPromiseOrValue.js';
import { invariant } from '../jsutils/invariant.js';
import { isPromise } from '../jsutils/isPromise.js';
import { promiseWithResolvers } from '../jsutils/promiseWithResolvers.js';

import type {
  CompletedIncrementalData,
  DeferredFragment,
  ExecutionGroupResult,
  IncrementalDataRecord,
  Stream,
  StreamItem,
  StreamItems,
  SubsequentResultRecord,
} from './types.js';
import { isStream } from './types.js';

/**
 * @internal
 */
export class IncrementalGraph {
  private _streamNodes: Map<string, Set<Stream>>;
  private _deferredFragmentNodes: Map<string, DeferredFragment>;
  private _pending: Set<IncrementalDataRecord>;
  private _completedQueue: Array<CompletedIncrementalData>;
  private _nextQueue: Array<
    (iterable: Iterable<CompletedIncrementalData> | undefined) => void
  >;

  constructor() {
    this._streamNodes = new Map();
    this._deferredFragmentNodes = new Map();
    this._pending = new Set();
    this._completedQueue = [];
    this._nextQueue = [];
  }

  getStreams(pathStr: string): Set<Stream> | undefined {
    return this._streamNodes.get(pathStr);
  }

  getDeferredFragment(key: string): DeferredFragment | undefined {
    return this._deferredFragmentNodes.get(key);
  }

  getNewRootNodes(
    incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>,
  ): ReadonlyArray<SubsequentResultRecord> {
    const initialResultChildren: Array<SubsequentResultRecord> = [];
    this._addIncrementalDataRecords(
      incrementalDataRecords,
      undefined,
      initialResultChildren,
    );
    return this._promoteNonEmptyToRoot(initialResultChildren);
  }

  addCompletedSuccessfulExecutionGroup(
    executionGroupResult: ExecutionGroupResult,
  ): void {
    const { pendingExecutionGroup, incrementalDataRecords } =
      executionGroupResult;

    const deferredFragments = pendingExecutionGroup.deferredFragments;

    for (const deferredFragment of deferredFragments) {
      const { pendingExecutionGroups, successfulExecutionGroups } =
        deferredFragment;
      pendingExecutionGroups.delete(pendingExecutionGroup);
      successfulExecutionGroups.add(executionGroupResult);
    }

    if (incrementalDataRecords !== undefined) {
      this._addIncrementalDataRecords(
        incrementalDataRecords,
        deferredFragments,
      );
    }
  }

  *currentCompletedBatch(): Generator<CompletedIncrementalData> {
    let completed;
    while ((completed = this._completedQueue.shift()) !== undefined) {
      yield completed;
    }
    // TODO: fix coverage?
    /* c8 ignore next 5 */
    if (!this.hasNext()) {
      for (const resolve of this._nextQueue) {
        resolve(undefined);
      }
    }
  }

  // TODO: add test cases for async transformations of incremental results
  /* c8 ignore next 9 */
  nextCompletedBatch(): Promise<
    Iterable<CompletedIncrementalData> | undefined
  > {
    const { promise, resolve } = promiseWithResolvers<
      Iterable<CompletedIncrementalData> | undefined
    >();
    this._nextQueue.push(resolve);
    return promise;
  }

  hasPending(): boolean {
    return this._pending.size > 0;
  }

  hasNext(): boolean {
    return this._streamNodes.size > 0 || this._deferredFragmentNodes.size > 0;
  }

  completeDeferredFragment(deferredFragment: DeferredFragment):
    | {
        newRootNodes: ReadonlyArray<SubsequentResultRecord>;
        successfulExecutionGroups: ReadonlyArray<ExecutionGroupResult>;
      }
    | undefined {
    // TODO: add test cases for async deferred fragment transformation
    /* c8 ignore next 6 */
    if (
      !this._deferredFragmentNodes.has(deferredFragment.key) ||
      deferredFragment.pendingExecutionGroups.size > 0
    ) {
      return;
    }
    const successfulExecutionGroups = Array.from(
      deferredFragment.successfulExecutionGroups,
    );
    this._deferredFragmentNodes.delete(deferredFragment.key);
    for (const successfulExecutionGroup of successfulExecutionGroups) {
      for (const otherDeferredFragmentRecord of successfulExecutionGroup
        .pendingExecutionGroup.deferredFragments) {
        otherDeferredFragmentRecord.successfulExecutionGroups.delete(
          successfulExecutionGroup,
        );
      }
    }
    const newRootNodes = this._promoteNonEmptyToRoot(deferredFragment.children);
    return { newRootNodes, successfulExecutionGroups };
  }

  onCompletedOriginalDeferredFragment(
    deferredFragment: DeferredFragment,
  ): void {
    const pendingExecutionGroups = deferredFragment.pendingExecutionGroups;
    for (const pendingExecutionGroup of pendingExecutionGroups) {
      const result = pendingExecutionGroup.result;
      const value =
        // TODO: fix coverage, add test case for async transformation of deferred fragment with overlapping execution groups
        result instanceof BoxedPromiseOrValue
          ? /* c8 ignore start */ result.value
          : /* c8 ignore stop */ result().value;
      // TODO: add test cases for async transformation of deferred fragment
      /* c8 ignore next 12 */
      if (isPromise(value)) {
        this._pending.add(pendingExecutionGroup);
        value.then(
          (resolved) => {
            this._pending.delete(pendingExecutionGroup);
            this._onCompletedOriginalExecutionGroup(resolved);
          },
          () => {
            /* ignore errors */
          },
        );
      } else {
        this._onCompletedOriginalExecutionGroup(value);
      }
    }
  }

  completeStreamItems(stream: Stream): void {
    const { list, nextExecutionIndex } = stream;
    const numItems = list.length;
    for (let i = nextExecutionIndex; i < numItems; i++) {
      const streamItem = { stream, result: () => stream.result(i) };
      stream.streamItemQueue.push(streamItem);
    }
    stream.nextExecutionIndex = numItems;

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this._onStreamItems(stream);
  }

  terminateStream(
    stream: Stream,
    result: ReadonlyArray<GraphQLError> | null,
  ): void {
    stream.streamItemQueue.push({ stream, result });

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this._onStreamItems(stream);
  }

  removeDeferredFragment(deferredFragment: DeferredFragment): void {
    this._deferredFragmentNodes.delete(deferredFragment.key);
  }

  removeStream(stream: Stream): void {
    const streamNodes = this._streamNodes.get(stream.pathStr);
    invariant(streamNodes !== undefined);
    streamNodes.delete(stream);
    if (streamNodes.size === 0) {
      this._streamNodes.delete(stream.pathStr);
    }
  }

  private _addIncrementalDataRecords(
    incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>,
    parents: ReadonlyArray<DeferredFragment> | undefined,
    initialResultChildren?: Array<SubsequentResultRecord>,
  ): void {
    for (const incrementalDataRecord of incrementalDataRecords) {
      if (!isStream(incrementalDataRecord)) {
        for (const deferredFragment of incrementalDataRecord.deferredFragments) {
          this._addDeferredFragment(deferredFragment, initialResultChildren);
          deferredFragment.pendingExecutionGroups.add(incrementalDataRecord);
        }
      } else if (parents === undefined) {
        invariant(initialResultChildren !== undefined);
        initialResultChildren.push(incrementalDataRecord);
      } else {
        for (const parent of parents) {
          this._addDeferredFragment(parent, initialResultChildren);
          parent.children.push(incrementalDataRecord);
        }
      }
    }
  }

  private _promoteNonEmptyToRoot(
    maybeEmptyNewRootNodes: Array<SubsequentResultRecord>,
  ): ReadonlyArray<SubsequentResultRecord> {
    const newRootNodes: Array<SubsequentResultRecord> = [];
    for (const node of maybeEmptyNewRootNodes) {
      if (!isStream(node)) {
        if (node.pendingExecutionGroups.size > 0) {
          this._deferredFragmentNodes.set(node.key, node);
          newRootNodes.push(node);
          continue;
        }
        for (const child of node.children) {
          maybeEmptyNewRootNodes.push(child);
        }
      } else {
        let streamNodes = this._streamNodes.get(node.pathStr);
        if (streamNodes === undefined) {
          streamNodes = new Set();
          this._streamNodes.set(node.pathStr, streamNodes);
        }
        streamNodes.add(node);
        newRootNodes.push(node);
      }
    }
    return newRootNodes;
  }

  private _addDeferredFragment(
    deferredFragment: DeferredFragment,
    initialResultChildren: Array<SubsequentResultRecord> | undefined,
  ): void {
    if (this._deferredFragmentNodes.has(deferredFragment.key)) {
      return;
    }
    const parent = deferredFragment.parent;
    if (parent === undefined) {
      invariant(initialResultChildren !== undefined);
      initialResultChildren.push(deferredFragment);
      return;
    }
    parent.children.push(deferredFragment);
    this._addDeferredFragment(parent, initialResultChildren);
  }

  private async _onStreamItems(stream: Stream): Promise<void> {
    // TODO: add test case for concurrent calls
    /* c8 ignore next 3 */
    if (stream.pending) {
      return;
    }
    stream.pending = true;

    let items: Array<unknown> = [];
    let errors: Array<GraphQLError> = [];
    let incrementalDataRecords: Array<IncrementalDataRecord> = [];

    const streamItemQueue = stream.streamItemQueue;
    let streamItem: StreamItem | undefined;
    while ((streamItem = streamItemQueue.shift()) !== undefined) {
      const result =
        typeof streamItem.result === 'function'
          ? streamItem.result()
          : streamItem.result;
      if (!(result instanceof BoxedPromiseOrValue)) {
        // TODO: fix coverage, add test case for completed items prior to stream termination
        /* c8 ignore next 6 */
        if (items.length > 0) {
          this._enqueue({
            stream,
            result: { items, errors, incrementalDataRecords },
          });
        }
        this._enqueue(
          result === null
            ? { stream }
            : {
                stream,
                errors: result,
              },
        );
        return;
      }

      let value = result.value;
      // TODO: add test cases for async transformation of stream items
      /* c8 ignore next 23 */
      if (isPromise(value)) {
        this._pending.add(stream);
        if (items.length > 0) {
          this._enqueue({
            stream,
            result: {
              items,
              errors,
              incrementalDataRecords,
            },
          });
          items = [];
          errors = [];
          incrementalDataRecords = [];
        }
        // eslint-disable-next-line no-await-in-loop
        value = await value;
        this._pending.delete(stream);
        // wait an additional tick to coalesce resolving additional promises
        // within the queue
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      items.push(value.item);
      errors.push(...value.errors);
      incrementalDataRecords.push(...value.incrementalDataRecords);
    }

    if (items.length > 0) {
      this._enqueue({
        stream,
        result: { items, errors, incrementalDataRecords },
      });
    }

    stream.pending = false;
  }

  private _onCompletedOriginalExecutionGroup(
    executionGroupResult: ExecutionGroupResult,
  ): void {
    const pendingExecutionGroup = executionGroupResult.pendingExecutionGroup;
    for (const deferredFragment of pendingExecutionGroup.deferredFragments) {
      const { pendingExecutionGroups, successfulExecutionGroups } =
        deferredFragment;
      pendingExecutionGroups.delete(pendingExecutionGroup);
      successfulExecutionGroups.add(executionGroupResult);
    }
    this._enqueue(executionGroupResult);
  }

  private _enqueue(completed: ExecutionGroupResult | StreamItems): void {
    this._completedQueue.push(completed);
    const next = this._nextQueue.shift();
    if (next === undefined) {
      return; /* c8 ignore start */
    }
    // TODO: fix coverage
    next(this.currentCompletedBatch());
  } /* c8 ignore stop */
}
