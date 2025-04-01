import type { GraphQLError } from 'graphql';

import type { BoxedPromiseOrValue } from '../jsutils/BoxedPromiseOrValue.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';
import type { SimpleAsyncGenerator } from '../jsutils/SimpleAsyncGenerator.js';

export interface Stream<TIncremental> {
  path: Path;
  label: string | undefined;
  pathStr: string;
  originalLabel: string | undefined;
  list: ReadonlyArray<unknown>;
  nextExecutionIndex: number;
  publishedItems: number;
  result: (
    index: number,
  ) => BoxedPromiseOrValue<StreamItemResult<TIncremental>>;
  streamItemQueue: Array<StreamItem<TIncremental>>;
  pending: boolean;
}

export type StreamItemResult<TIncremental> =
  | SuccessfulStreamItemResult<TIncremental>
  | FailedStreamItemResult;

interface SuccessfulStreamItemResult<TIncremental> {
  item: unknown;
  errors: ReadonlyArray<GraphQLError>;
  deferredFragments: ReadonlyArray<DeferredFragment<TIncremental>>;
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord<TIncremental>>;
}

interface FailedStreamItemResult {
  item?: never;
  errors: ReadonlyArray<GraphQLError>;
  deferredFragments?: never;
  incrementalDataRecords?: never;
}

type Thunk<T> = T | (() => T);

export interface StreamItem<TIncremental> {
  stream: Stream<TIncremental>;
  result:
    | Thunk<BoxedPromiseOrValue<StreamItemResult<TIncremental>>>
    | ReadonlyArray<GraphQLError>
    | null;
}

export function isCompletedStreamItems<TIncremental>(
  record: IncrementalGraphEvent<TIncremental>,
): record is StreamItems<TIncremental> {
  return 'stream' in record;
}

export interface StreamItems<TIncremental> {
  stream: Stream<TIncremental>;
  errors?: ReadonlyArray<GraphQLError>;
  result?: StreamItemsResult<TIncremental>;
}

export interface StreamItemsResult<TIncremental> {
  items: ReadonlyArray<unknown>;
  errors: ReadonlyArray<GraphQLError>;
  deferredFragments: ReadonlyArray<DeferredFragment<TIncremental>>;
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord<TIncremental>>;
}

export function isStream<TIncremental>(
  record:
    | IncrementalDataRecord<TIncremental>
    | SubsequentResultRecord<TIncremental>,
): record is Stream<TIncremental> {
  return 'list' in record;
}

export type SubsequentResultRecord<TIncremental> =
  | DeferredFragment<TIncremental>
  | Stream<TIncremental>;

export function isDeferredFragment<TIncremental>(
  record:
    | IncrementalDataRecord<TIncremental>
    | SubsequentResultRecord<TIncremental>,
): record is DeferredFragment<TIncremental> {
  return 'pendingExecutionGroups' in record;
}

export interface DeferredFragment<TIncremental> {
  path: Path | undefined;
  label: string | undefined;
  pathStr: string;
  key: string;
  parent: DeferredFragment<TIncremental> | undefined;
  originalLabel: string | undefined;
  pendingExecutionGroups: Set<PendingExecutionGroup<TIncremental>>;
  successfulExecutionGroups: Set<ExecutionGroupResult<TIncremental>>;
  children: Set<SubsequentResultRecord<TIncremental>>;
  ready: boolean | ReadonlyArray<GraphQLError>;
  failed: boolean | undefined;
}

export function isPendingExecutionGroup<TIncremental>(
  record: IncrementalDataRecord<TIncremental>,
): record is PendingExecutionGroup<TIncremental> {
  return 'deferredFragments' in record;
}

export interface PendingExecutionGroup<TIncremental> {
  path: Path | undefined;
  deferredFragments: ReadonlyArray<DeferredFragment<TIncremental>>;
  result: Thunk<BoxedPromiseOrValue<ExecutionGroupResult<TIncremental>>>;
}

export function isExecutionGroupResult<TIncremental>(
  record: IncrementalGraphEvent<TIncremental>,
): record is ExecutionGroupResult<TIncremental> {
  return 'deferredFragments' in record;
}
export interface ExecutionGroupResult<TIncremental> {
  pendingExecutionGroup: PendingExecutionGroup<TIncremental>;
  data: ObjMap<unknown>;
  errors: ReadonlyArray<GraphQLError>;
  deferredFragments: ReadonlyArray<DeferredFragment<TIncremental>>;
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord<TIncremental>>;
}

export function isFailedDeferredFragment<TIncremental>(
  record: IncrementalGraphEvent<TIncremental>,
): record is FailedDeferredFragment<TIncremental> {
  return 'deferredFragment' in record;
}

export interface FailedDeferredFragment<TIncremental> {
  deferredFragment: DeferredFragment<TIncremental>;
  errors: ReadonlyArray<GraphQLError>;
}

export type IncrementalDataRecord<TIncremental> =
  | PendingExecutionGroup<TIncremental>
  | Stream<TIncremental>
  | ExternalStream<TIncremental>;

export type IncrementalGraphEvent<TIncremental> =
  | ExecutionGroupResult<TIncremental>
  | FailedDeferredFragment<TIncremental>
  | StreamItems<TIncremental>;

export interface ExternalStream<TIncremental> {
  stream: TIncremental;
  path: Path;
  initialPath: ReadonlyArray<string | number>;
}

export interface IncrementalResults<TInitial, TSubsequent> {
  initialResult: TInitial;
  subsequentResults: SimpleAsyncGenerator<TSubsequent>;
}
