import type { GraphQLError } from 'graphql';

import type { ObjMap } from '../jsutils/ObjMap.js';

import type {
  DeferredFragment,
  ExecutionGroupResult,
  Stream,
  StreamItemsResult,
  SubsequentResultRecord,
} from './types.js';

export interface PayloadPublisher<TSubsequentPayload, TInitialPayload> {
  getSubsequentPayloadPublisher: () => SubsequentPayloadPublisher<TSubsequentPayload>;
  getPayloads: (
    data: ObjMap<unknown>,
    errors: ReadonlyArray<GraphQLError>,
    newRootNodes: ReadonlyArray<SubsequentResultRecord>,
    subsequentPayloads: AsyncGenerator<TSubsequentPayload, void, void>,
  ) => TInitialPayload;
}

export interface SubsequentPayloadPublisher<TSubsequentPayload> {
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
  getSubsequentPayload: (hasNext: boolean) => TSubsequentPayload | undefined;
}
