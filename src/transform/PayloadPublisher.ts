import type { GraphQLError } from 'graphql';

import type { ObjMap } from '../jsutils/ObjMap.js';
import type { SimpleAsyncGenerator } from '../jsutils/SimpleAsyncGenerator.js';

import type {
  DeferredFragment,
  ExecutionGroupResult,
  ExternalStream,
  IncrementalResults,
  Stream,
  StreamItemsResult,
  SubsequentResultRecord,
} from './types.js';

export interface PayloadPublisher<TInitial, TSubsequent> {
  getSubsequentPayloadPublisher: () => SubsequentPayloadPublisher<
    TInitial,
    TSubsequent
  >;

  getPayloads: (
    data: ObjMap<unknown>,
    errors: ReadonlyArray<GraphQLError>,
    newRootNodes: ReadonlyArray<
      SubsequentResultRecord<IncrementalResults<TInitial, TSubsequent>>
    >,
    subsequentPayloads: SimpleAsyncGenerator<TSubsequent>,
  ) => IncrementalResults<TInitial, TSubsequent>;
}

export interface SubsequentPayloadPublisher<TInitial, TSubsequent> {
  addFailedDeferredFragment: (
    deferredFragment: DeferredFragment<
      IncrementalResults<TInitial, TSubsequent>
    >,
    errors: ReadonlyArray<GraphQLError>,
  ) => void;
  addSuccessfulDeferredFragment: (
    deferredFragment: DeferredFragment<
      IncrementalResults<TInitial, TSubsequent>
    >,
    newRootNodes: ReadonlyArray<
      SubsequentResultRecord<IncrementalResults<TInitial, TSubsequent>>
    >,
    executionGroupResults: ReadonlyArray<
      ExecutionGroupResult<IncrementalResults<TInitial, TSubsequent>>
    >,
  ) => void;
  addFailedStream: (
    stream: Stream<IncrementalResults<TInitial, TSubsequent>>,
    errors: ReadonlyArray<GraphQLError>,
    index: number,
  ) => void;
  addSuccessfulStream: (
    stream: Stream<IncrementalResults<TInitial, TSubsequent>>,
  ) => void;
  addStreamItems: (
    stream: Stream<IncrementalResults<TInitial, TSubsequent>>,
    newRootNodes: ReadonlyArray<
      SubsequentResultRecord<IncrementalResults<TInitial, TSubsequent>>
    >,
    streamItemsResult: StreamItemsResult<
      IncrementalResults<TInitial, TSubsequent>
    >,
    index: number,
  ) => void;
  addExternalStream: (
    externalStream: ExternalStream<IncrementalResults<TInitial, TSubsequent>>,
  ) => void;
  getSubsequentPayload: (hasNext: boolean) => TSubsequent | undefined;
}
