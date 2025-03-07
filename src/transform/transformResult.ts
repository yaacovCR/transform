import type {
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
  GraphQLError,
  IncrementalResult,
  InitialIncrementalExecutionResult,
  SubsequentIncrementalExecutionResult,
} from 'graphql';
import { isObjectType } from 'graphql';
import type {
  CompletedResult,
  PendingResult,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

import { invariant } from '../jsutils/invariant.js';
import { isObjectLike } from '../jsutils/isObjectLike.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';
import { addPath, pathToArray } from '../jsutils/Path.js';

import { addNewDeferredFragments } from './addNewDeferredFragments.js';
import type {
  EncounteredPendingResult,
  TransformationContext,
} from './buildTransformationContext.js';
import { isStream } from './buildTransformationContext.js';
import { collectRootFields } from './collectFields.js';
import { completeListValue, completeValue } from './completeValue.js';
import { embedErrors } from './embedErrors.js';
import { getObjectAtPath } from './getObjectAtPath.js';
import { inlineDefers } from './inlineDefers.js';
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
  const streamKeys = new Set<string>();
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
      const items = incrementalResult.items as ReadonlyArray<unknown>;
      const errors = incrementalResult.errors;
      incompleteAtPath.push(...items);
      embedErrors(context.mergedResult, errors);
      streamKeys.add(pendingResult.key);
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

  const incremental: Array<LegacyIncrementalStreamResult> = [];
  for (const key of streamKeys) {
    const stream = context.subsequentResultRecords.get(key);
    invariant(stream != null);
    invariant(isStream(stream));
    const { path, itemType, originalStreams, nextIndex } = stream;
    const list = getObjectAtPath(context.mergedResult, pathToArray(path));
    invariant(Array.isArray(list));
    for (const { originalLabel, fieldDetailsList } of originalStreams) {
      const errors: Array<GraphQLError> = [];
      const items = completeListValue(
        context,
        errors,
        itemType,
        fieldDetailsList,
        list,
        path,
        nextIndex,
      );
      stream.nextIndex = list.length;
      const newIncrementalResult: LegacyIncrementalStreamResult = {
        items,
        path: [...pathToArray(path), nextIndex],
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
  return incremental;
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
      const object = getObjectAtPath(context.mergedResult, pendingResult.path);
      invariant(isObjectLike(object));
      const typeName = object[context.prefix];
      invariant(typeof typeName === 'string');
      const runtimeType = context.transformedArgs.schema.getType(typeName);
      invariant(isObjectType(runtimeType));

      const errors: Array<GraphQLError> = [];

      const { groupedFieldSetTree } = subsequentResultRecord.executionGroups[0];

      const pathStr = pendingResult.pathStr;
      const { groupedFieldSet, deferredFragmentDetails } = inlineDefers(
        context,
        groupedFieldSetTree,
        pathStr,
      );

      addNewDeferredFragments(context, deferredFragmentDetails, pathStr);

      const objectPath = pathFromArray(pendingResult.path);

      const data = completeValue(
        context,
        object,
        runtimeType,
        groupedFieldSet,
        errors,
        objectPath,
      );

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

  const groupedFieldSetTree = collectRootFields(transformedArgs, rootType);

  const { groupedFieldSet, deferredFragmentDetails } = inlineDefers(
    context,
    groupedFieldSetTree,
    '',
  );

  addNewDeferredFragments(context, deferredFragmentDetails, '');

  const data = completeValue(
    context,
    originalData,
    rootType,
    groupedFieldSet,
    errors,
    undefined,
  );

  return (rest.errors ? { ...rest, errors, data } : { ...rest, data }) as T;
}

function pathFromArray(path: ReadonlyArray<string | number>): Path | undefined {
  if (path.length === 0) {
    return undefined;
  }
  let current = addPath(undefined, path[0], undefined);
  for (let i = 1; i < path.length; i++) {
    current = addPath(current, path[i], undefined);
  }
  return current;
}
