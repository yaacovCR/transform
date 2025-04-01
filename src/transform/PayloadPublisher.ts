import type { GraphQLError } from 'graphql';

import type { ObjMap } from '../jsutils/ObjMap.js';
import type { SimpleAsyncGenerator } from '../jsutils/SimpleAsyncGenerator.js';

import type {
  DeferredFragment,
  ExecutionGroupResult,
  Stream,
  StreamItemsResult,
  SubsequentResultRecord,
} from './types.js';

export interface PayloadPublisher<TSubsequent, TIncremental> {
  getSubsequentPayloadPublisher: () => SubsequentPayloadPublisher<TSubsequent>;

  getPayloads: (
    data: ObjMap<unknown>,
    errors: ReadonlyArray<GraphQLError>,
    newRootNodes: ReadonlyArray<SubsequentResultRecord>,
    subsequentPayloads: SimpleAsyncGenerator<TSubsequent>,
  ) => TIncremental;
}

export interface SubsequentPayloadPublisher<TSubsequent> {
  addFailedDeferredFragment: (
    deferredFragment: DeferredFragment,
    errors: ReadonlyArray<GraphQLError>,
  ) => void;
  addSuccessfulDeferredFragment: (
    deferredFragment: DeferredFragment,
    newRootNodes: ReadonlyArray<SubsequentResultRecord>,
    executionGroupResults: ReadonlyArray<ExecutionGroupResult>,
  ) => void;
  addFailedStream: (
    stream: Stream,
    errors: ReadonlyArray<GraphQLError>,
    index: number,
  ) => void;
  addSuccessfulStream: (stream: Stream) => void;
  addStreamItems: (
    stream: Stream,
    newRootNodes: ReadonlyArray<SubsequentResultRecord>,
    streamItemsResult: StreamItemsResult,
    index: number,
  ) => void;
  getSubsequentPayload: (hasNext: boolean) => TSubsequent | undefined;
}
