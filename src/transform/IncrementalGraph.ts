import { invariant } from '../jsutils/invariant.js';

import type {
  DeferredFragment,
  ExecutionGroupResult,
  IncrementalDataRecord,
  Stream,
  SubsequentResultRecord,
} from './buildTransformationContext.js';
import { isStream } from './buildTransformationContext.js';

/**
 * @internal
 */
export class IncrementalGraph {
  private _streamNodes: Map<string, Set<Stream>>;
  private _deferredFragmentNodes: Map<string, DeferredFragment>;
  private _newRootNodes: Array<SubsequentResultRecord>;

  constructor() {
    this._streamNodes = new Map();
    this._deferredFragmentNodes = new Map();
    this._newRootNodes = Array<SubsequentResultRecord>();
  }

  getStreams(pathStr: string): Set<Stream> | undefined {
    return this._streamNodes.get(pathStr);
  }

  getDeferredFragment(key: string): DeferredFragment | undefined {
    return this._deferredFragmentNodes.get(key);
  }

  addIncrementalDataRecords(
    incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>,
  ): void {
    const initialResultChildren: Array<SubsequentResultRecord> = [];
    this._addIncrementalDataRecords(
      incrementalDataRecords,
      undefined,
      initialResultChildren,
    );
    this._promoteNonEmptyToRoot(initialResultChildren);
  }

  *getNewRootNodes(): Generator<SubsequentResultRecord> {
    let newRootNode;
    while ((newRootNode = this._newRootNodes.shift()) !== undefined) {
      yield newRootNode;
    }
  }

  hasNext(): boolean {
    return this._streamNodes.size > 0 || this._deferredFragmentNodes.size > 0;
  }

  completeDeferredFragment(
    deferredFragment: DeferredFragment,
  ): ReadonlyArray<ExecutionGroupResult> | undefined {
    if (!this._deferredFragmentNodes.has(deferredFragment.key)) {
      return;
    }
    const executionGroupResults: Array<ExecutionGroupResult> = [];
    for (const pendingExecutionGroup of deferredFragment.pendingExecutionGroups) {
      const executionGroupResult = pendingExecutionGroup.result();
      executionGroupResults.push(executionGroupResult);
      this._addIncrementalDataRecords(
        executionGroupResult.incrementalDataRecords,
        executionGroupResult.pendingExecutionGroup.deferredFragments,
      );
    }
    this._deferredFragmentNodes.delete(deferredFragment.key);
    for (const executionGroupResult of executionGroupResults) {
      const pendingExecutionGroup = executionGroupResult.pendingExecutionGroup;
      for (const otherDeferredFragment of pendingExecutionGroup.deferredFragments) {
        otherDeferredFragment.pendingExecutionGroups.delete(
          pendingExecutionGroup,
        );
      }
    }
    this._promoteNonEmptyToRoot(deferredFragment.children);
    return executionGroupResults;
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
  ): void {
    for (const node of maybeEmptyNewRootNodes) {
      if (!isStream(node)) {
        if (node.pendingExecutionGroups.size > 0) {
          this._deferredFragmentNodes.set(node.key, node);
          this._newRootNodes.push(node);
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
        this._newRootNodes.push(node);
      }
    }
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
}
