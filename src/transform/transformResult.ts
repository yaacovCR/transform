import type {
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
  GraphQLError,
  IncrementalResult,
  InitialIncrementalExecutionResult,
  SubsequentIncrementalExecutionResult,
} from 'graphql';
import type {
  CompletedResult,
  PendingResult,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

import { invariant } from '../jsutils/invariant.js';
import type { ObjMap } from '../jsutils/ObjMap.js';

import type {
  EncounteredPendingResult,
  TransformationContext,
} from './buildTransformationContext.js';
import { isStream } from './buildTransformationContext.js';
import { completeInitialResult } from './completeValue.js';
import { embedErrors } from './embedErrors.js';
import { getObjectAtPath } from './getObjectAtPath.js';
import { mapAsyncIterable } from './mapAsyncIterable.js';

export interface LegacyExperimentalIncrementalExecutionResults {
  initialResult: LegacyInitialIncrementalExecutionResult;
  subsequentResults: AsyncGenerator<
    LegacySubsequentIncrementalExecutionResult,
    void,
    void
  >;
}

export interface LegacyInitialIncrementalExecutionResult
  extends ExecutionResult {
  data: ObjMap<unknown>;
  hasNext: true;
}

export interface LegacySubsequentIncrementalExecutionResult {
  incremental?: ReadonlyArray<LegacyIncrementalResult>;
  hasNext: boolean;
}

interface LegacyIncrementalDeferResult extends ExecutionResult {
  path: ReadonlyArray<string | number>;
  label?: string;
}

interface LegacyIncrementalStreamResult {
  items: ReadonlyArray<unknown> | null;
  errors?: ReadonlyArray<GraphQLError>;
  path: ReadonlyArray<string | number>;
  label?: string;
}

type LegacyIncrementalResult =
  | LegacyIncrementalDeferResult
  | LegacyIncrementalStreamResult;

export function transformResult(
  context: TransformationContext,
  result: ExecutionResult | ExperimentalIncrementalExecutionResults,
): ExecutionResult | LegacyExperimentalIncrementalExecutionResults {
  if ('initialResult' in result) {
    const initialResult = transformInitialResult(context, result.initialResult);

    return {
      initialResult,
      subsequentResults: mapAsyncIterable(
        result.subsequentResults,
        (subsequentResult) => transformSubsequent(context, subsequentResult),
      ),
    };
  }
  return transformInitialResult(context, result);
}

function transformSubsequent(
  context: TransformationContext,
  result: SubsequentIncrementalExecutionResult,
): LegacySubsequentIncrementalExecutionResult {
  const newResult: LegacySubsequentIncrementalExecutionResult = {
    hasNext: result.hasNext,
  };
  if (result.pending) {
    processPending(context, result.pending);
  }

  if (result.incremental) {
    const incremental = processIncremental(context, result.incremental);
    if (incremental.length > 0) {
      newResult.incremental = incremental;
    }
  }

  if (result.completed) {
    const incremental = processCompleted(context, result.completed);
    if (incremental.length > 0) {
      if (newResult.incremental) {
        newResult.incremental = [...newResult.incremental, ...incremental];
      } else {
        newResult.incremental = incremental;
      }
    }
  }

  return newResult;
}

function processPending(
  context: TransformationContext,
  pendingResults: ReadonlyArray<PendingResult>,
): void {
  for (const pendingResult of pendingResults) {
    const { id, path, label } = pendingResult;
    invariant(label != null);
    const pathStr = path.join('.');
    context.encounteredPendingResults.set(id, {
      path,
      label,
      pathStr,
      key: label + '.' + pathStr,
    });
    let labels = context.pendingLabelsByPath.get(pathStr);
    if (!labels) {
      labels = new Set();
      context.pendingLabelsByPath.set(pathStr, labels);
    }
    invariant(pendingResult.label != null);
    labels.add(pendingResult.label);
  }
}

function processIncremental(
  context: TransformationContext,
  incrementalResults: ReadonlyArray<IncrementalResult>,
): ReadonlyArray<LegacyIncrementalStreamResult> {
  const incremental: Array<LegacyIncrementalStreamResult> = [];
  for (const incrementalResult of incrementalResults) {
    const id = incrementalResult.id;
    const pendingResult = context.encounteredPendingResults.get(id);
    invariant(pendingResult != null);
    const path = incrementalResult.subPath
      ? [...pendingResult.path, ...incrementalResult.subPath]
      : pendingResult.path;

    const incompleteAtPath = getObjectAtPath(context.mergedResult, path);
    if (Array.isArray(incompleteAtPath)) {
      invariant('items' in incrementalResult);
      incompleteAtPath.push(
        ...(incrementalResult.items as ReadonlyArray<unknown>),
      );
      embedErrors(context.mergedResult, incrementalResult.errors);
      onStreamItems(context, pendingResult, incremental);
    } else {
      invariant('data' in incrementalResult);
      for (const [key, value] of Object.entries(
        incrementalResult.data as ObjMap<unknown>,
      )) {
        incompleteAtPath[key] = value;
      }
      embedErrors(context.mergedResult, incrementalResult.errors);
    }
  }
  return incremental;
}

function onStreamItems(
  context: TransformationContext,
  pendingResult: EncounteredPendingResult,
  incremental: Array<LegacyIncrementalResult>,
): void {
  const stream = context.subsequentResultRecords.get(pendingResult.key);
  invariant(stream != null);
  invariant(isStream(stream));
  const { originalStreams } = stream;
  for (const originalStream of originalStreams) {
    const { originalLabel, result, nextIndex } = originalStream;
    const errors: Array<GraphQLError> = [];
    const items = result(errors, nextIndex);
    originalStream.nextIndex = nextIndex + items.length;
    const newIncrementalResult: LegacyIncrementalStreamResult = {
      items,
      path: [...pendingResult.path, nextIndex],
    };
    if (errors.length > 0) {
      newIncrementalResult.errors = errors;
    }
    if (originalLabel != null) {
      newIncrementalResult.label = originalLabel;
    }
    incremental.push(newIncrementalResult);
  }
}

function processCompleted(
  context: TransformationContext,
  completedResults: ReadonlyArray<CompletedResult>,
): ReadonlyArray<LegacyIncrementalResult> {
  const incremental: Array<LegacyIncrementalResult> = [];
  for (const completedResult of completedResults) {
    const id = completedResult.id;
    const pendingResult = context.encounteredPendingResults.get(id);
    invariant(pendingResult != null);
    const subsequentResultRecord = context.subsequentResultRecords.get(
      pendingResult.key,
    );
    invariant(subsequentResultRecord != null);

    if (isStream(subsequentResultRecord)) {
      if ('errors' in completedResult) {
        const list = getObjectAtPath(context.mergedResult, pendingResult.path);
        invariant(Array.isArray(list));
        const incrementalResult: LegacyIncrementalStreamResult = {
          items: null,
          errors: completedResult.errors,
          path: [...pendingResult.path, list.length],
        };
        incremental.push(incrementalResult);
      }

      deletePendingResult(context, id, pendingResult);
      continue;
    }

    let incrementalResult: LegacyIncrementalDeferResult;
    if ('errors' in completedResult) {
      incrementalResult = {
        data: null,
        errors: completedResult.errors,
        path: pendingResult.path,
      };
    } else {
      const errors: Array<GraphQLError> = [];
      const data = subsequentResultRecord.executionGroups[0].result(errors);

      incrementalResult = { data, path: pendingResult.path };

      if (errors.length > 0) {
        incrementalResult.errors = errors;
      }
    }

    const originalLabel = subsequentResultRecord.originalLabel;
    if (originalLabel != null) {
      incrementalResult.label = originalLabel;
    }

    incremental.push(incrementalResult);

    deletePendingResult(context, id, pendingResult);
  }
  return incremental;
}

function deletePendingResult(
  context: TransformationContext,
  originalId: string,
  pendingResult: EncounteredPendingResult,
): void {
  context.subsequentResultRecords.delete(pendingResult.key);
  context.encounteredPendingResults.delete(originalId);
  const pathStr = pendingResult.pathStr;
  const labels = context.pendingLabelsByPath.get(pathStr);
  invariant(labels != null);
  labels.delete(pendingResult.label);
  if (labels.size === 0) {
    context.pendingLabelsByPath.delete(pathStr);
  }
}

function transformInitialResult<
  T extends ExecutionResult | InitialIncrementalExecutionResult,
>(context: TransformationContext, result: T): T {
  const originalData = result.data;
  if (originalData == null) {
    return result;
  }

  const errors = embedErrors(originalData, result.errors);
  context.mergedResult = originalData;

  const transformedArgs = context.transformedArgs;
  const { schema, operation } = transformedArgs;
  const rootType = schema.getRootType(operation.operation);
  invariant(rootType != null);

  const { pending, ...rest } = result as InitialIncrementalExecutionResult;

  if (pending != null) {
    context.mergedResult[context.prefix] = rootType.name;
    processPending(context, pending);
  }

  const data = completeInitialResult(context, originalData, rootType, errors);

  return (rest.errors ? { ...rest, errors, data } : { ...rest, data }) as T;
}
