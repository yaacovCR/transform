import type { GraphQLError } from 'graphql';

import { BoxedPromiseOrValue } from '../jsutils/BoxedPromiseOrValue.js';
import { invariant } from '../jsutils/invariant.js';
import { isPromise } from '../jsutils/isPromise.js';
import { promiseWithResolvers } from '../jsutils/promiseWithResolvers.js';

import type {
  DeferredFragment,
  ExecutionGroupResult,
  IncrementalDataRecord,
  IncrementalGraphEvent,
  PendingExecutionGroup,
  Stream,
  StreamItem,
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
  private _completedQueue: Array<IncrementalGraphEvent>;
  private _nextQueue: Array<
    (iterable: Iterable<IncrementalGraphEvent> | undefined) => void
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
    const initialResultChildren = new Set<SubsequentResultRecord>();
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

    this._addIncrementalDataRecords(incrementalDataRecords, deferredFragments);
  }

  *currentCompletedBatch(): Generator<IncrementalGraphEvent> {
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

  // TODO: add test case for async transformation
  /* c8 ignore next 8 */
  nextCompletedBatch(): Promise<Iterable<IncrementalGraphEvent> | undefined> {
    const { promise, resolve } = promiseWithResolvers<
      Iterable<IncrementalGraphEvent> | undefined
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
    errors: ReadonlyArray<GraphQLError> | undefined,
  ): void {
    deferredFragment.ready = true;
    if (errors === undefined) {
      const pendingExecutionGroups = deferredFragment.pendingExecutionGroups;
      for (const pendingExecutionGroup of pendingExecutionGroups) {
        this._onExecutionGroup(pendingExecutionGroup);
      }
    } else {
      deferredFragment.ready = errors;
      this._enqueue({ deferredFragment, errors });
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
    initialResultChildren?: Set<SubsequentResultRecord>,
  ): void {
    for (const incrementalDataRecord of incrementalDataRecords) {
      if (!isStream(incrementalDataRecord)) {
        let ready = false;
        for (const deferredFragment of incrementalDataRecord.deferredFragments) {
          this._addDeferredFragment(deferredFragment, initialResultChildren);
          deferredFragment.pendingExecutionGroups.add(incrementalDataRecord);
          if (deferredFragment.ready === true) {
            ready = true;
          }
        }
        if (ready && this._completesRootNode(incrementalDataRecord)) {
          this._onExecutionGroup(incrementalDataRecord);
        }
      } else if (parents === undefined) {
        invariant(initialResultChildren !== undefined);
        initialResultChildren.add(incrementalDataRecord);
      } else {
        for (const parent of parents) {
          this._addDeferredFragment(parent, initialResultChildren);
          parent.children.add(incrementalDataRecord);
        }
      }
    }
  }

  private _promoteNonEmptyToRoot(
    maybeEmptyNewRootNodes: Set<SubsequentResultRecord>,
  ): ReadonlyArray<SubsequentResultRecord> {
    const newRootNodes: Array<SubsequentResultRecord> = [];
    for (const node of maybeEmptyNewRootNodes) {
      if (!isStream(node)) {
        if (node.pendingExecutionGroups.size > 0) {
          // TODO: add test cases for executor returning results early
          /* c8 ignore start */
          const ready = node.ready;
          if (ready === true) {
            for (const pendingExecutionGroup of node.pendingExecutionGroups) {
              if (!this._completesRootNode(pendingExecutionGroup)) {
                this._onExecutionGroup(pendingExecutionGroup);
              }
            }
          } else if (Array.isArray(ready)) {
            this._enqueue({
              deferredFragment: node,
              errors: ready,
            });
          }
          /* c8 ignore stop */
          this._deferredFragmentNodes.set(node.key, node);
          newRootNodes.push(node);
          continue;
        }
        for (const child of node.children) {
          maybeEmptyNewRootNodes.add(child);
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

  private _completesRootNode(
    pendingExecutionGroup: PendingExecutionGroup,
  ): boolean {
    return pendingExecutionGroup.deferredFragments.some((deferredFragment) =>
      this._deferredFragmentNodes.has(deferredFragment.key),
    );
  }

  private _addDeferredFragment(
    deferredFragment: DeferredFragment,
    initialResultChildren: Set<SubsequentResultRecord> | undefined,
  ): void {
    if (
      deferredFragment.failed ||
      this._deferredFragmentNodes.has(deferredFragment.key)
    ) {
      return;
    }
    const parent = deferredFragment.parent;
    if (parent === undefined) {
      invariant(initialResultChildren !== undefined);
      initialResultChildren.add(deferredFragment);
      return;
    }
    parent.children.add(deferredFragment);
    this._addDeferredFragment(parent, initialResultChildren);
  }

  private _onExecutionGroup(
    pendingExecutionGroup: PendingExecutionGroup,
  ): void {
    let result = pendingExecutionGroup.result;
    if (result instanceof BoxedPromiseOrValue) {
      return;
    }

    pendingExecutionGroup.result = result = result();
    const value = result.value;
    // TODO: add test case for async transformation
    /* c8 ignore next 8 */
    if (isPromise(value)) {
      this._pending.add(pendingExecutionGroup);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      value.then((resolved) => {
        this._pending.delete(pendingExecutionGroup);
        this._enqueue(resolved);
      });
    } else {
      this._enqueue(value);
    }
  }

  private async _onStreamItems(stream: Stream): Promise<void> {
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
        // TODO: add test case for completion with existing items
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
      // TODO: add test case for async transformation
      /* c8 ignore start */
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
      /* c8 ignore stop */
      const item = value.item;
      if (item === undefined) {
        // TODO: add test case for failure via transformation with existing items
        /* c8 ignore start */
        if (items.length > 0) {
          this._enqueue({
            stream,
            result: {
              items,
              errors,
              incrementalDataRecords,
            },
          });
        }
        /* c8 ignore stop */
        this._enqueue({
          stream,
          errors: value.errors,
        });
        return;
      }
      items.push(item);
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

  private _enqueue(completed: IncrementalGraphEvent): void {
    this._completedQueue.push(completed);
    const next = this._nextQueue.shift();
    if (next === undefined) {
      return;
    } /* c8 ignore next 3 */
    // TODO: add test case for async transformation
    next(this.currentCompletedBatch());
  }
}
