import type {
  ExecutionResult,
  GraphQLField,
  GraphQLLeafType,
  GraphQLNullableOutputType,
  GraphQLObjectType,
  GraphQLOutputType,
  ValidatedExecutionArgs,
} from 'graphql';
import {
  getDirectiveValues,
  getNullableType,
  GraphQLError,
  GraphQLStreamDirective,
  isLeafType,
  isListType,
  isObjectType,
  locatedError,
} from 'graphql';
import type {
  DeferUsage,
  FieldDetails,
  GroupedFieldSet,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';
import {
  collectFields,
  collectSubfields as _collectSubfields,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';

import { BoxedPromiseOrValue } from '../jsutils/BoxedPromiseOrValue.js';
import { invariant } from '../jsutils/invariant.js';
import { isObjectLike } from '../jsutils/isObjectLike.js';
import { isPromise } from '../jsutils/isPromise.js';
import { memoize3 } from '../jsutils/memoize3.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';
import { addPath, pathToArray } from '../jsutils/Path.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

import type { DeferUsageSet, ExecutionPlan } from './buildExecutionPlan.js';
import type {
  FieldTransformer,
  LeafTransformer,
  ObjectBatchExtender,
  TransformationContext,
} from './buildTransformationContext.js';
import { EmbeddedErrors } from './EmbeddedError.js';
import { filter } from './filter.js';
import { getObjectAtPath } from './getObjectAtPath.js';
import type {
  DeferredFragment,
  ExecutionGroupResult,
  IncrementalDataRecord,
  IncrementalResults,
  PendingExecutionGroup,
  Stream,
  StreamItemResult,
} from './types.js';

interface IncrementalContext<TInitial, TSubsequent> {
  deferUsageSet: DeferUsageSet | undefined;
  newErrors: Map<Path | undefined, GraphQLError>;
  originalErrors: Array<GraphQLError>;
  foundPathScopedObjects: ObjMap<
    ObjMap<FoundPathScopedObjects<TInitial, TSubsequent>>
  >;
  deferredFragments: Array<
    DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
  >;
  incrementalDataRecords: Array<
    IncrementalDataRecord<IncrementalResults<TInitial, TSubsequent>>
  >;
}

interface FoundPathScopedObjects<TInitial, TSubsequent> {
  objects: Array<ObjMap<unknown>>;
  paths: Array<Path>;
  extender: ObjectBatchExtender<TInitial, TSubsequent>;
  type: GraphQLObjectType;
  fieldDetailsList: ReadonlyArray<FieldDetails>;
}

interface StreamUsage {
  label: string;
  initialCount: number;
}

const collectSubfields = memoize3(
  (
    validatedExecutionArgs: ValidatedExecutionArgs,
    returnType: GraphQLObjectType,
    fieldDetailsList: ReadonlyArray<FieldDetails>,
  ) => {
    const { schema, fragments, variableValues, hideSuggestions } =
      validatedExecutionArgs;
    return _collectSubfields(
      schema,
      fragments,
      variableValues,
      returnType,
      fieldDetailsList,
      hideSuggestions,
    );
  },
);

export function completeInitialResult<
  TInitial extends ExecutionResult,
  TSubsequent,
>(
  context: TransformationContext<TInitial, TSubsequent>,
  originalData: ObjMap<unknown>,
): PromiseOrValue<{
  data: ObjMap<unknown>;
  errors: ReadonlyArray<GraphQLError>;
  deferredFragments: ReadonlyArray<
    DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
  >;
  incrementalDataRecords: ReadonlyArray<
    IncrementalDataRecord<IncrementalResults<TInitial, TSubsequent>>
  >;
}> {
  const incrementalContext: IncrementalContext<TInitial, TSubsequent> = {
    deferUsageSet: undefined,
    newErrors: new Map(),
    originalErrors: [],
    foundPathScopedObjects: Object.create(null),
    deferredFragments: [],
    incrementalDataRecords: [],
  };

  const { schema, operation, fragments, variableValues, hideSuggestions } =
    context.argsWithNewLabels;

  const rootType = schema.getRootType(operation.operation);
  invariant(rootType != null);

  const { groupedFieldSet: originalGroupedFieldSet, newDeferUsages } =
    collectFields(
      schema,
      fragments,
      variableValues,
      rootType,
      operation.selectionSet,
      hideSuggestions,
    );

  const { groupedFieldSet, newGroupedFieldSets } = context.executionPlanBuilder(
    originalGroupedFieldSet,
  );

  const newDeferMap = getNewDeferMap(
    context,
    incrementalContext,
    newDeferUsages,
  );

  const completed = completeObjectValue(
    context,
    groupedFieldSet,
    rootType,
    originalData,
    undefined,
    '',
    incrementalContext,
    newDeferMap,
  );

  collectExecutionGroups(
    context,
    rootType,
    originalData,
    undefined,
    '',
    newGroupedFieldSets,
    incrementalContext,
    newDeferMap,
  );

  const maybePromise = extendObjects(incrementalContext, completed, undefined);

  if (isPromise(maybePromise)) {
    return maybePromise.then(() =>
      buildInitialResult(incrementalContext, completed),
    );
  }
  return buildInitialResult(incrementalContext, completed);
}

function buildInitialResult<TInitial, TSubsequent>(
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  completed: ObjMap<unknown>,
): {
  data: ObjMap<unknown>;
  errors: ReadonlyArray<GraphQLError>;
  deferredFragments: ReadonlyArray<
    DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
  >;
  incrementalDataRecords: ReadonlyArray<
    IncrementalDataRecord<IncrementalResults<TInitial, TSubsequent>>
  >;
} {
  const {
    newErrors,
    originalErrors,
    deferredFragments,
    incrementalDataRecords,
  } = incrementalContext;

  const { filteredData, filteredRecords } = filter(
    completed,
    undefined,
    newErrors,
    incrementalDataRecords,
  );

  const errors = [...originalErrors, ...newErrors.values()];

  return {
    data: filteredData,
    errors,
    deferredFragments,
    incrementalDataRecords: filteredRecords,
  };
}

function extendObjects<TInitial extends ExecutionResult, TSubsequent>(
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  completed: unknown,
  initialPath: Path | undefined,
): PromiseOrValue<void> {
  const promises: Array<Promise<void>> = [];
  for (const foundPathScopedObjectsForPath of Object.values(
    incrementalContext.foundPathScopedObjects,
  )) {
    for (const foundPathScopedObjectsForType of Object.values(
      foundPathScopedObjectsForPath,
    )) {
      invariant(isObjectLike(completed));
      extendObjectsOfType(
        promises,
        incrementalContext,
        foundPathScopedObjectsForType,
        completed,
        initialPath,
      );
    }
  }
  if (promises.length > 0) {
    return Promise.all(promises) as unknown as PromiseOrValue<void>;
  }
}

function extendObjectsOfType<TInitial extends ExecutionResult, TSubsequent>(
  promises: Array<Promise<void>>,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  foundPathScopedObjects: FoundPathScopedObjects<TInitial, TSubsequent>,
  completed: ObjMap<unknown>,
  initialPath: Path | undefined,
): void {
  const { objects, paths, extender, type, fieldDetailsList } =
    foundPathScopedObjects;
  try {
    const results = extender(objects, type, fieldDetailsList);
    if (isPromise(results)) {
      promises.push(
        results.then(
          (resolved) =>
            updateObjects(
              incrementalContext,
              resolved,
              fieldDetailsList,
              completed,
              paths,
              initialPath,
            ),
          (rawError: unknown) =>
            nullObjects(
              incrementalContext,
              rawError,
              fieldDetailsList,
              completed,
              paths,
              initialPath,
            ),
        ),
      );
      return;
    }
    updateObjects(
      incrementalContext,
      results,
      fieldDetailsList,
      completed,
      paths,
      initialPath,
    );
  } catch (rawError) {
    nullObjects(
      incrementalContext,
      rawError,
      fieldDetailsList,
      completed,
      paths,
      initialPath,
    );
  }
}

// eslint-disable-next-line @typescript-eslint/max-params
function updateObjects<TInitial extends ExecutionResult, TSubsequent>(
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  results: ReadonlyArray<
    ExecutionResult | IncrementalResults<TInitial, TSubsequent>
  >,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  completed: ObjMap<unknown>,
  paths: ReadonlyArray<Path>,
  initialPath: Path | undefined,
): void {
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const initialPathLength = pathToArray(initialPath).length;
    const pathArr = pathToArray(paths[i]).slice(initialPathLength);
    const incompleteAtPath = getObjectAtPath(completed, pathArr);
    invariant(!Array.isArray(incompleteAtPath));
    if ('initialResult' in result) {
      handleInitialResult(
        incrementalContext,
        result.initialResult,
        fieldDetailsList,
        incompleteAtPath,
        paths[i],
        pathArr,
      );
      incrementalContext.incrementalDataRecords.push({
        stream: result,
        path: paths[i],
        initialPath: pathArr,
      });
      continue;
    }
    handleInitialResult(
      incrementalContext,
      result,
      fieldDetailsList,
      incompleteAtPath,
      paths[i],
      pathArr,
    );
  }
}

// eslint-disable-next-line @typescript-eslint/max-params
function handleInitialResult<TInitial extends ExecutionResult, TSubsequent>(
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  result: ExecutionResult | TInitial,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  incompleteAtPath: ObjMap<unknown>,
  path: Path | undefined,
  pathArr: ReadonlyArray<string | number>,
): void {
  const { data, errors } = result;
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      incompleteAtPath[key] = value;
    }
    if (errors) {
      incrementalContext.originalErrors.push(
        ...errors.map((error) => prependErrorWithPath(error, pathArr)),
      );
    }
  } else {
    invariant(errors !== undefined);
    const error = locatedError(
      new AggregateError(
        errors,
        'Fatal GraphQL error(s) occurred while resolving a batched object.',
      ),
      fieldDetailsList.map((f) => f.node),
      pathArr,
    );
    incrementalContext.newErrors.set(path, error);
  }
}

function prependErrorWithPath(
  error: GraphQLError,
  pathArr: ReadonlyArray<string | number>,
): GraphQLError {
  const errorPath = error.path;
  return new GraphQLError(error.message, {
    ...error,
    path: errorPath
      ? // TODO: add test case?
        [...pathArr, ...errorPath] /* c8 ignore start */
      : pathArr /* c8 ignore stop */,
  });
}

// eslint-disable-next-line @typescript-eslint/max-params
function nullObjects<TInitial, TSubsequent>(
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  rawError: unknown,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  completed: ObjMap<unknown>,
  paths: ReadonlyArray<Path>,
  initialPath: Path | undefined,
): void {
  const initialPathLength = pathToArray(initialPath).length;
  for (const path of paths) {
    const pathArr = pathToArray(path).slice(initialPathLength);
    const incompleteAtPath = getObjectAtPath(completed, pathArr);
    invariant(!Array.isArray(incompleteAtPath));
    const error = locatedError(
      rawError,
      fieldDetailsList.map((f) => f.node),
      pathArr,
    );
    incrementalContext.newErrors.set(path, error);
  }
}

// eslint-disable-next-line @typescript-eslint/max-params
function completeValue<TInitial extends ExecutionResult, TSubsequent>(
  context: TransformationContext<TInitial, TSubsequent>,
  nullableType: GraphQLNullableOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: unknown,
  path: Path,
  pathStr: string,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  deferMap:
    | ReadonlyMap<
        DeferUsage,
        DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
      >
    | undefined,
): unknown {
  if (result == null) {
    return null;
  }

  if (result instanceof EmbeddedErrors) {
    const originalErrors = incrementalContext.originalErrors;
    for (const error of result.errors) {
      originalErrors.push(error);
    }
    return null;
  }

  if (isLeafType(nullableType)) {
    const leafTransformer = context.leafTransformers[nullableType.name];
    return leafTransformer === undefined
      ? result
      : transformLeafValue(
          leafTransformer,
          nullableType,
          fieldDetailsList,
          result,
          path,
          incrementalContext,
        );
  }

  if (isListType(nullableType)) {
    invariant(Array.isArray(result));

    const itemType = nullableType.ofType;

    const completed = completeListValue(
      context,
      itemType,
      fieldDetailsList,
      result,
      path,
      pathStr,
      incrementalContext,
      deferMap,
    );

    return completed;
  }

  invariant(isObjectLike(result));

  const { prefix, argsWithNewLabels } = context;

  const typeName = result[prefix];

  if (typeName == null) {
    return Object.create(null);
  }

  invariant(typeof typeName === 'string');

  const runtimeType = argsWithNewLabels.schema.getType(typeName);

  invariant(isObjectType(runtimeType));

  const { groupedFieldSet: originalGroupedFieldSet, newDeferUsages } =
    collectSubfields(argsWithNewLabels, runtimeType, fieldDetailsList);

  const { groupedFieldSet, newGroupedFieldSets } = buildSubExecutionPlan(
    context,
    originalGroupedFieldSet,
    incrementalContext.deferUsageSet,
  );

  const newDeferMap = getNewDeferMap(
    context,
    incrementalContext,
    newDeferUsages,
    deferMap,
    path,
  );

  const completed = completeObjectValue(
    context,
    groupedFieldSet,
    runtimeType,
    result,
    path,
    pathStr,
    incrementalContext,
    newDeferMap,
  );

  collectExecutionGroups(
    context,
    runtimeType,
    result,
    path,
    pathStr,
    newGroupedFieldSets,
    incrementalContext,
    newDeferMap,
  );

  const foundPathScopedObjects = incrementalContext.foundPathScopedObjects;
  const extender = context.pathScopedObjectBatchExtenders[pathStr]?.[typeName];
  if (extender !== undefined) {
    let foundPathScopedObjectsForPath = foundPathScopedObjects[pathStr];
    foundPathScopedObjectsForPath ??= foundPathScopedObjects[pathStr] =
      Object.create(null);
    let foundPathScopedObjectsForType = foundPathScopedObjectsForPath[typeName];
    foundPathScopedObjectsForType ??= foundPathScopedObjectsForPath[typeName] =
      {
        objects: [],
        paths: [],
        extender,
        type: runtimeType,
        fieldDetailsList,
      };
    const { objects, paths } = foundPathScopedObjectsForType;
    objects.push(result);
    paths.push(path);
  }

  return completed;
}

// eslint-disable-next-line @typescript-eslint/max-params
function transformLeafValue<TInitial, TSubsequent>(
  leafTransformer: LeafTransformer,
  type: GraphQLLeafType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  value: unknown,
  path: Path,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
): PromiseOrValue<unknown> {
  try {
    const transformed = leafTransformer(value, type, path);

    if (transformed === null) {
      if (!path.nullable) {
        const fieldName = fieldDetailsList[0].node.name.value;
        throw new Error(
          `Cannot return null for non-nullable field ${fieldName}.`,
        );
      }
      return null;
    } else if (transformed instanceof Error) {
      handleRawError(transformed, fieldDetailsList, path, incrementalContext);
      return null;
    }
    return transformed;
  } catch (rawError) {
    return handleRawError(rawError, fieldDetailsList, path, incrementalContext);
  }
}

function handleRawError<TInitial, TSubsequent>(
  rawError: unknown,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  path: Path,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
): null {
  const error = locatedError(
    rawError,
    fieldDetailsList.map((f) => f.node),
    pathToArray(path),
  );
  incrementalContext.newErrors.set(path, error);
  return null;
}

// eslint-disable-next-line @typescript-eslint/max-params
function completeObjectValue<TInitial extends ExecutionResult, TSubsequent>(
  context: TransformationContext<TInitial, TSubsequent>,
  groupedFieldSet: GroupedFieldSet,
  runtimeType: GraphQLObjectType,
  originalData: ObjMap<unknown>,
  path: Path | undefined,
  pathStr: string,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  deferMap:
    | ReadonlyMap<
        DeferUsage,
        DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
      >
    | undefined,
): ObjMap<unknown> {
  const {
    argsWithNewLabels: { schema },
  } = context;
  const completedObject = Object.create(null);

  const objectFieldTransformers =
    context.objectFieldTransformers[runtimeType.name];
  const pathScopedFieldTransformers = context.pathScopedFieldTransformers;
  for (const [responseName, fieldDetailsList] of groupedFieldSet) {
    const fieldName = fieldDetailsList[0].node.name.value;
    const fieldDef = schema.getField(runtimeType, fieldName);

    if (fieldDef) {
      const fieldType = fieldDef.type;
      const nullableType = getNullableType(fieldType);
      const fieldPath = addPath(path, responseName, nullableType === fieldType);
      const fieldPathStr = pathStr + '.' + responseName;
      let completed = completeValue(
        context,
        nullableType,
        fieldDetailsList,
        originalData[responseName],
        fieldPath,
        fieldPathStr,
        incrementalContext,
        deferMap,
      );

      for (const fieldTransformer of [
        objectFieldTransformers?.[fieldName],
        pathScopedFieldTransformers[fieldPathStr],
      ]) {
        if (fieldTransformer !== undefined) {
          completed = transformFieldValue(
            fieldTransformer,
            fieldDef,
            fieldDetailsList,
            completed,
            fieldPath,
            incrementalContext,
          );
        }
      }

      completedObject[responseName] = completed;
    }
  }

  return completedObject;
}

// eslint-disable-next-line @typescript-eslint/max-params
function transformFieldValue<TInitial, TSubsequent>(
  fieldTransformer: FieldTransformer,
  fieldDef: GraphQLField,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  value: unknown,
  path: Path,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
): PromiseOrValue<unknown> {
  try {
    const transformed = fieldTransformer(value, fieldDef, path);

    if (transformed === null) {
      if (!path.nullable) {
        throw new Error(
          `Cannot return null for non-nullable field ${fieldDef}.`,
        );
      }
      return null;
    } else if (transformed instanceof Error) {
      handleRawError(transformed, fieldDetailsList, path, incrementalContext);
      return null;
    }
    return transformed;
  } catch (rawError) {
    return handleRawError(rawError, fieldDetailsList, path, incrementalContext);
  }
}

// eslint-disable-next-line @typescript-eslint/max-params
function completeListValue<TInitial extends ExecutionResult, TSubsequent>(
  context: TransformationContext<TInitial, TSubsequent>,
  itemType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: ReadonlyArray<unknown>,
  path: Path,
  pathStr: string,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  deferMap:
    | ReadonlyMap<
        DeferUsage,
        DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
      >
    | undefined,
): Array<unknown> {
  const streamUsage = getStreamUsage(context, fieldDetailsList, path);
  const completedItems = [];
  for (let index = 0; index < result.length; index++) {
    if (streamUsage && index >= streamUsage.initialCount) {
      maybeAddStream(
        context,
        streamUsage,
        itemType,
        fieldDetailsList,
        result,
        path,
        pathStr,
        index,
        incrementalContext,
      );
      return completedItems;
    }

    const nullableType = getNullableType(itemType);
    const completedItem = completeValue(
      context,
      nullableType,
      fieldDetailsList,
      result[index],
      addPath(path, index, nullableType === itemType),
      pathStr,
      incrementalContext,
      deferMap,
    );

    completedItems.push(completedItem);
  }

  if (streamUsage && result.length >= streamUsage.initialCount) {
    maybeAddStream(
      context,
      streamUsage,
      itemType,
      fieldDetailsList,
      result,
      path,
      pathStr,
      result.length,
      incrementalContext,
    );
  }
  return completedItems;
}

function getNewDeferMap<TInitial, TSubsequent>(
  context: TransformationContext<TInitial, TSubsequent>,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  newDeferUsages: ReadonlyArray<DeferUsage>,
  deferMap?: ReadonlyMap<
    DeferUsage,
    DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
  >,
  path?: Path,
): ReadonlyMap<
  DeferUsage,
  DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
> {
  const deferredFragments = incrementalContext.deferredFragments;
  const newDeferMap = new Map(deferMap);

  // For each new deferUsage object:
  for (const newDeferUsage of newDeferUsages) {
    const parentDeferUsage = newDeferUsage.parentDeferUsage;

    const parent =
      parentDeferUsage === undefined
        ? undefined
        : deferredFragmentRecordFromDeferUsage(parentDeferUsage, newDeferMap);

    const label = newDeferUsage.label;
    invariant(label != null);

    const pathStr = pathToArray(path).join('.');
    // Instantiate the new record.
    const deferredFragment: DeferredFragment<
      IncrementalResults<TInitial, TSubsequent>
    > = {
      path,
      label,
      pathStr,
      key: label + '.' + pathStr,
      parent,
      originalLabel: context.originalLabels.get(label),
      pendingExecutionGroups: new Set(),
      successfulExecutionGroups: new Set(),
      children: new Set(),
      ready: false,
      failed: undefined,
    };

    deferredFragments.push(deferredFragment);

    // Update the map.
    newDeferMap.set(newDeferUsage, deferredFragment);
  }

  return newDeferMap;
}

function deferredFragmentRecordFromDeferUsage<TInitial, TSubsequent>(
  deferUsage: DeferUsage,
  deferMap: ReadonlyMap<
    DeferUsage,
    DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
  >,
): DeferredFragment<IncrementalResults<TInitial, TSubsequent>> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return deferMap.get(deferUsage)!;
}

function buildSubExecutionPlan<TInitial, TSubsequent>(
  context: TransformationContext<TInitial, TSubsequent>,
  originalGroupedFieldSet: GroupedFieldSet,
  deferUsageSet: DeferUsageSet | undefined,
): ExecutionPlan {
  let executionPlan = (
    originalGroupedFieldSet as unknown as { _executionPlan: ExecutionPlan }
  )._executionPlan;
  if (executionPlan !== undefined) {
    return executionPlan;
  }
  executionPlan = context.executionPlanBuilder(
    originalGroupedFieldSet,
    deferUsageSet,
  );
  (
    originalGroupedFieldSet as unknown as { _executionPlan: ExecutionPlan }
  )._executionPlan = executionPlan;
  return executionPlan;
}

// eslint-disable-next-line @typescript-eslint/max-params
function collectExecutionGroups<TInitial extends ExecutionResult, TSubsequent>(
  context: TransformationContext<TInitial, TSubsequent>,
  runtimeType: GraphQLObjectType,
  result: ObjMap<unknown>,
  path: Path | undefined,
  pathStr: string,
  newGroupedFieldSets: Map<DeferUsageSet, GroupedFieldSet>,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  deferMap: ReadonlyMap<
    DeferUsage,
    DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
  >,
): void {
  for (const [deferUsageSet, groupedFieldSet] of newGroupedFieldSets) {
    const deferredFragments = getDeferredFragments(deferUsageSet, deferMap);

    const pendingExecutionGroup: PendingExecutionGroup<
      IncrementalResults<TInitial, TSubsequent>
    > = {
      path,
      deferredFragments,
      result: undefined as unknown as () => BoxedPromiseOrValue<
        ExecutionGroupResult<IncrementalResults<TInitial, TSubsequent>>
      >,
    };

    pendingExecutionGroup.result = () =>
      new BoxedPromiseOrValue(
        executeExecutionGroup(
          context,
          pendingExecutionGroup,
          result,
          path,
          pathStr,
          groupedFieldSet,
          runtimeType,
          {
            deferUsageSet,
            newErrors: new Map(),
            originalErrors: [],
            foundPathScopedObjects: Object.create(null),
            deferredFragments: [],
            incrementalDataRecords: [],
          },
          deferMap,
        ),
      );

    incrementalContext.incrementalDataRecords.push(pendingExecutionGroup);
  }
}

function getDeferredFragments<TInitial, TSubsequent>(
  deferUsages: DeferUsageSet,
  deferMap: ReadonlyMap<
    DeferUsage,
    DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
  >,
): ReadonlyArray<DeferredFragment<IncrementalResults<TInitial, TSubsequent>>> {
  return Array.from(deferUsages).map((deferUsage) =>
    deferredFragmentRecordFromDeferUsage(deferUsage, deferMap),
  );
}

// eslint-disable-next-line @typescript-eslint/max-params
function executeExecutionGroup<TInitial extends ExecutionResult, TSubsequent>(
  context: TransformationContext<TInitial, TSubsequent>,
  pendingExecutionGroup: PendingExecutionGroup<
    IncrementalResults<TInitial, TSubsequent>
  >,
  result: ObjMap<unknown>,
  path: Path | undefined,
  pathStr: string,
  groupedFieldSet: GroupedFieldSet,
  runtimeType: GraphQLObjectType,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  deferMap: ReadonlyMap<
    DeferUsage,
    DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
  >,
): PromiseOrValue<
  ExecutionGroupResult<IncrementalResults<TInitial, TSubsequent>>
> {
  const completed = completeObjectValue(
    context,
    groupedFieldSet,
    runtimeType,
    result,
    path,
    pathStr,
    incrementalContext,
    deferMap,
  );

  const maybePromise = extendObjects(incrementalContext, completed, path);

  if (isPromise(maybePromise)) {
    return maybePromise.then(() =>
      buildExecutionGroupResult(
        incrementalContext,
        completed,
        pendingExecutionGroup,
      ),
    );
  }
  return buildExecutionGroupResult(
    incrementalContext,
    completed,
    pendingExecutionGroup,
  );
}

function buildExecutionGroupResult<TInitial, TSubsequent>(
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  completed: ObjMap<unknown>,
  pendingExecutionGroup: PendingExecutionGroup<
    IncrementalResults<TInitial, TSubsequent>
  >,
): ExecutionGroupResult<IncrementalResults<TInitial, TSubsequent>> {
  const {
    newErrors,
    originalErrors,
    deferredFragments,
    incrementalDataRecords,
  } = incrementalContext;

  const { filteredData, filteredRecords } = filter(
    completed,
    pendingExecutionGroup.path,
    newErrors,
    incrementalDataRecords,
  );

  return {
    pendingExecutionGroup,
    data: filteredData,
    errors: [...originalErrors, ...newErrors.values()],
    deferredFragments,
    incrementalDataRecords: filteredRecords,
  };
}

function getStreamUsage<TInitial, TSubsequent>(
  context: TransformationContext<TInitial, TSubsequent>,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  path: Path,
): StreamUsage | undefined {
  // do not stream inner lists of multi-dimensional lists
  if (typeof path.key === 'number') {
    return;
  }

  const fieldDetails = fieldDetailsList[0];
  const stream = getDirectiveValues(
    GraphQLStreamDirective,
    fieldDetails.node,
    context.argsWithNewLabels.variableValues,
    fieldDetails.fragmentVariableValues,
  );

  if (stream == null || stream.if === false) {
    return;
  }

  const { label, initialCount } = stream;
  invariant(typeof label === 'string');
  invariant(typeof initialCount === 'number');

  return {
    label,
    initialCount,
  };
}

// eslint-disable-next-line @typescript-eslint/max-params
function maybeAddStream<TInitial extends ExecutionResult, TSubsequent>(
  context: TransformationContext<TInitial, TSubsequent>,
  streamUsage: StreamUsage,
  itemType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: ReadonlyArray<unknown>,
  path: Path,
  pathStr: string,
  nextIndex: number,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
): void {
  const label = streamUsage.label;
  const originalLabel = context.originalLabels.get(label);

  const stream: Stream<IncrementalResults<TInitial, TSubsequent>> = {
    path,
    label,
    pathStr: pathToArray(path).join('.'),
    originalLabel,
    list: result,
    nextExecutionIndex: nextIndex,
    publishedItems: nextIndex,
    result: undefined as unknown as (
      index: number,
    ) => BoxedPromiseOrValue<
      StreamItemResult<IncrementalResults<TInitial, TSubsequent>>
    >,
    streamItemQueue: [],
    pending: false,
  };

  stream.result = (index: number) =>
    new BoxedPromiseOrValue(
      executeStreamItem(
        context,
        result,
        itemType,
        fieldDetailsList.map((details) => ({
          ...details,
          deferUsage: undefined,
        })),
        path,
        pathStr,
        index,
        {
          deferUsageSet: undefined,
          newErrors: new Map(),
          originalErrors: [],
          foundPathScopedObjects: Object.create(null),
          deferredFragments: [],
          incrementalDataRecords: [],
        },
      ),
    );

  incrementalContext.incrementalDataRecords.push(stream);
}

// eslint-disable-next-line @typescript-eslint/max-params
function executeStreamItem<TInitial extends ExecutionResult, TSubsequent>(
  context: TransformationContext<TInitial, TSubsequent>,
  result: ReadonlyArray<unknown>,
  itemType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  path: Path,
  pathStr: string,
  index: number,
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
): PromiseOrValue<StreamItemResult<IncrementalResults<TInitial, TSubsequent>>> {
  const nullableType = getNullableType(itemType);
  const itemPath = addPath(path, index, nullableType === itemType);
  const completed = completeValue(
    context,
    nullableType,
    fieldDetailsList,
    result[index],
    itemPath,
    pathStr,
    incrementalContext,
    undefined,
  );

  const maybePromise = extendObjects(incrementalContext, completed, itemPath);

  if (isPromise(maybePromise)) {
    return maybePromise.then(() =>
      buildStreamItemResult(incrementalContext, completed, path),
    );
  }
  return buildStreamItemResult(incrementalContext, completed, path);
}

function buildStreamItemResult<TInitial, TSubsequent>(
  incrementalContext: IncrementalContext<TInitial, TSubsequent>,
  completed: unknown,
  path: Path,
): StreamItemResult<IncrementalResults<TInitial, TSubsequent>> {
  const {
    newErrors,
    originalErrors,
    deferredFragments,
    incrementalDataRecords,
  } = incrementalContext;

  const errors = [...originalErrors, ...newErrors.values()];

  const { filteredData, filteredRecords } = filter(
    [completed],
    path,
    newErrors,
    incrementalDataRecords,
  );

  if (filteredData === null) {
    return { errors };
  }

  return {
    item: filteredData[0],
    errors,
    deferredFragments,
    incrementalDataRecords: filteredRecords,
  };
}
