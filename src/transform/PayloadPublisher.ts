import type { GraphQLError } from 'graphql';

import type { ObjMap } from '../jsutils/ObjMap.js';

import type {
  DeferredFragment,
  ExecutionGroupResult,
  Stream,
  StreamItemsResult,
} from './types.js';

export interface PayloadPublisher<TSubsequentPayload, TInitialPayload> {
  getSubsequentPayloadPublisher: () => SubsequentPayloadPublisher<TSubsequentPayload>;
  getPayloads: (
    data: ObjMap<unknown>,
    errors: ReadonlyArray<GraphQLError>,
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
    executionGroupResults: ReadonlyArray<ExecutionGroupResult>,
  ) => void;
  addFailedStream: (
    stream: Stream,
    errors: ReadonlyArray<GraphQLError>,
    index: number,
  ) => void;
  addStreamItems: (
    stream: Stream,
    streamItemsResult: StreamItemsResult,
    index: number,
  ) => void;
  getSubsequentPayload: (hasNext: boolean) => TSubsequentPayload | undefined;
}
