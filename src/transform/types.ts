import type { GraphQLError } from 'graphql';

import type { BoxedPromiseOrValue } from '../jsutils/BoxedPromiseOrValue.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';

export interface Stream {
  path: Path;
  label: string | undefined;
  pathStr: string;
  originalLabel: string | undefined;
  list: ReadonlyArray<unknown>;
  nextExecutionIndex: number;
  publishedItems: number;
  result: (index: number) => BoxedPromiseOrValue<StreamItemResult>;
  streamItemQueue: Array<StreamItem>;
  pending: boolean;
}

export type StreamItemResult =
  | SuccessfulStreamItemResult
  | FailedStreamItemResult;

interface SuccessfulStreamItemResult {
  item: unknown;
  errors: ReadonlyArray<GraphQLError>;
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>;
}

interface FailedStreamItemResult {
  item?: never;
  errors: ReadonlyArray<GraphQLError>;
  incrementalDataRecords?: never;
}

type Thunk<T> = T | (() => T);

export interface StreamItem {
  stream: Stream;
  result:
    | Thunk<BoxedPromiseOrValue<StreamItemResult>>
    | ReadonlyArray<GraphQLError>
    | null;
}

export interface StreamItems {
  stream: Stream;
  errors?: ReadonlyArray<GraphQLError>;
  result?: StreamItemsResult;
}

export interface StreamItemsResult {
  items: ReadonlyArray<unknown>;
  errors: ReadonlyArray<GraphQLError>;
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>;
}

export function isStream(
  record: IncrementalDataRecord | SubsequentResultRecord,
): record is Stream {
  return 'list' in record;
}

export type SubsequentResultRecord = DeferredFragment | Stream;

export interface DeferredFragment {
  path: Path | undefined;
  label: string | undefined;
  pathStr: string;
  key: string;
  parent: DeferredFragment | undefined;
  originalLabel: string | undefined;
  pendingExecutionGroups: Set<PendingExecutionGroup>;
  successfulExecutionGroups: Set<ExecutionGroupResult>;
  children: Set<SubsequentResultRecord>;
  ready: boolean | ReadonlyArray<GraphQLError>;
  failed: boolean | undefined;
}

export interface PendingExecutionGroup {
  path: Path | undefined;
  deferredFragments: ReadonlyArray<DeferredFragment>;
  result: Thunk<BoxedPromiseOrValue<ExecutionGroupResult>>;
}

export interface ExecutionGroupResult {
  pendingExecutionGroup: PendingExecutionGroup;
  data: ObjMap<unknown>;
  errors: ReadonlyArray<GraphQLError>;
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>;
}

export interface FailedDeferredFragment {
  deferredFragment: DeferredFragment;
  errors: ReadonlyArray<GraphQLError>;
}

export type IncrementalDataRecord = PendingExecutionGroup | Stream;

export type IncrementalGraphEvent =
  | ExecutionGroupResult
  | FailedDeferredFragment
  | StreamItems;
