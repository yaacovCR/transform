import type {
  GraphQLError,
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
import { PromiseRegistry } from '../jsutils/PromiseRegistry.js';

import type { DeferUsageSet, ExecutionPlan } from './buildExecutionPlan.js';
import type { TransformationContext } from './buildTransformationContext.js';
import { EmbeddedErrors } from './EmbeddedError.js';
import { filter } from './filter.js';
import type {
  DeferredFragment,
  ExecutionGroupResult,
  IncrementalDataRecord,
  PendingExecutionGroup,
  Stream,
  StreamItemResult,
} from './types.js';

interface IncrementalContext {
  promiseRegistry: PromiseRegistry;
  newErrors: Map<Path | undefined, GraphQLError>;
  originalErrors: Array<GraphQLError>;
  incrementalDataRecords: Array<IncrementalDataRecord>;
  deferUsageSet: DeferUsageSet | undefined;
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

export function completeInitialResult(
  context: TransformationContext,
  originalData: ObjMap<unknown>,
): PromiseOrValue<{
  data: ObjMap<unknown>;
  errors: ReadonlyArray<GraphQLError>;
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>;
}> {
  const incrementalContext: IncrementalContext = {
    promiseRegistry: new PromiseRegistry(),
    newErrors: new Map(),
    originalErrors: [],
    incrementalDataRecords: [],
    deferUsageSet: undefined,
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

  const newDeferMap = getNewDeferMap(context, newDeferUsages);

  const completed = completeObjectValue(
    context,
    groupedFieldSet,
    rootType,
    originalData,
    undefined,
    incrementalContext,
    newDeferMap,
  );

  collectExecutionGroups(
    context,
    rootType,
    originalData,
    undefined,
    newGroupedFieldSets,
    incrementalContext,
    newDeferMap,
  );

  const promiseRegistry = incrementalContext.promiseRegistry;
  return promiseRegistry.pending()
    ? promiseRegistry
        .wait()
        .then(() => resolveInitialResult(completed, incrementalContext))
    : resolveInitialResult(completed, incrementalContext);
}

function resolveInitialResult(
  completedObject: ObjMap<unknown>,
  incrementalContext: IncrementalContext,
): {
  data: ObjMap<unknown>;
  errors: ReadonlyArray<GraphQLError>;
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>;
} {
  const { newErrors, originalErrors, incrementalDataRecords } =
    incrementalContext;

  const { filteredData, filteredRecords } = filter(
    completedObject,
    undefined,
    newErrors,
    incrementalDataRecords,
  );

  return {
    data: filteredData,
    errors: [...originalErrors, ...newErrors.values()],
    incrementalDataRecords: filteredRecords,
  };
}

// eslint-disable-next-line @typescript-eslint/max-params
function completeValue(
  context: TransformationContext,
  nullableType: GraphQLNullableOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: unknown,
  path: Path,
  incrementalContext: IncrementalContext,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment> | undefined,
): PromiseOrValue<unknown> {
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
    return maybeTransformLeafValue(
      context,
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

  const newDeferMap = getNewDeferMap(context, newDeferUsages, deferMap, path);

  const completed = completeObjectValue(
    context,
    groupedFieldSet,
    runtimeType,
    result,
    path,
    incrementalContext,
    newDeferMap,
  );

  collectExecutionGroups(
    context,
    runtimeType,
    result,
    path,
    newGroupedFieldSets,
    incrementalContext,
    newDeferMap,
  );

  return completed;
}

// eslint-disable-next-line @typescript-eslint/max-params
function maybeTransformLeafValue(
  context: TransformationContext,
  type: GraphQLLeafType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  value: unknown,
  path: Path,
  incrementalContext: IncrementalContext,
): PromiseOrValue<unknown> {
  const transformer = context.leafTransformers[type.name];
  if (transformer === undefined) {
    return value;
  }

  try {
    const transformed = transformer(value, type);

    if (isPromise(transformed)) {
      return transformed
        .then((resolved: unknown) =>
          handleTransformedLeafValue(
            resolved,
            fieldDetailsList,
            path,
            incrementalContext,
          ),
        )
        .then(undefined, (rawError: unknown) =>
          handleRawError(rawError, fieldDetailsList, path, incrementalContext),
        );
    }

    return handleTransformedLeafValue(
      transformed,
      fieldDetailsList,
      path,
      incrementalContext,
    );
  } catch (rawError) {
    return handleRawError(rawError, fieldDetailsList, path, incrementalContext);
  }
}

function handleTransformedLeafValue(
  transformed: unknown,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  path: Path,
  incrementalContext: IncrementalContext,
): unknown {
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
}

function handleRawError(
  rawError: unknown,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  path: Path,
  incrementalContext: IncrementalContext,
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
function completeObjectValue(
  context: TransformationContext,
  groupedFieldSet: GroupedFieldSet,
  runtimeType: GraphQLObjectType,
  originalData: ObjMap<unknown>,
  path: Path | undefined,
  incrementalContext: IncrementalContext,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment> | undefined,
): ObjMap<unknown> {
  const {
    argsWithNewLabels: { schema },
  } = context;
  const completedObject = Object.create(null);

  for (const [responseName, fieldDetailsList] of groupedFieldSet) {
    const fieldName = fieldDetailsList[0].node.name.value;
    const fieldDef = schema.getField(runtimeType, fieldName);

    if (fieldDef) {
      const fieldType = fieldDef.type;
      const nullableType = getNullableType(fieldType);
      const fieldPath = addPath(path, responseName, nullableType === fieldType);
      const completed = completeValue(
        context,
        nullableType,
        fieldDetailsList,
        originalData[responseName],
        fieldPath,
        incrementalContext,
        deferMap,
      );

      if (isPromise(completed)) {
        completedObject[responseName] = undefined;
        incrementalContext.promiseRegistry.add(
          completed
            .then((resolved) =>
              maybeTransformFieldValue(
                context,
                runtimeType,
                fieldDef,
                fieldDetailsList,
                resolved,
                fieldPath,
                incrementalContext,
              ),
            )
            .then((maybeTransformed) => {
              completedObject[responseName] = maybeTransformed;
            }),
        );
      } else {
        const maybeTransformed = maybeTransformFieldValue(
          context,
          runtimeType,
          fieldDef,
          fieldDetailsList,
          completed,
          fieldPath,
          incrementalContext,
        );
        if (isPromise(maybeTransformed)) {
          incrementalContext.promiseRegistry.add(
            maybeTransformed.then((resolved) => {
              completedObject[responseName] = resolved;
            }),
          );
        } else {
          completedObject[responseName] = maybeTransformed;
        }
      }
    }
  }

  return completedObject;
}

// eslint-disable-next-line @typescript-eslint/max-params
function maybeTransformFieldValue(
  context: TransformationContext,
  parentType: GraphQLObjectType,
  fieldDef: GraphQLField,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  value: unknown,
  path: Path,
  incrementalContext: IncrementalContext,
): PromiseOrValue<unknown> {
  const transformer =
    context.objectFieldTransformers[parentType.name]?.[fieldDef.name];

  if (transformer === undefined) {
    return value;
  }

  try {
    const transformed = transformer(value, fieldDef);

    if (isPromise(transformed)) {
      return transformed
        .then((resolved: unknown) =>
          handleTransformedFieldValue(
            resolved,
            fieldDef,
            fieldDetailsList,
            path,
            incrementalContext,
          ),
        )
        .then(undefined, (rawError: unknown) =>
          handleRawError(rawError, fieldDetailsList, path, incrementalContext),
        );
    }

    return handleTransformedFieldValue(
      transformed,
      fieldDef,
      fieldDetailsList,
      path,
      incrementalContext,
    );
  } catch (rawError) {
    return handleRawError(rawError, fieldDetailsList, path, incrementalContext);
  }
}

function handleTransformedFieldValue(
  transformed: unknown,
  fieldDef: GraphQLField,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  path: Path,
  incrementalContext: IncrementalContext,
): unknown {
  if (transformed === null) {
    if (!path.nullable) {
      throw new Error(`Cannot return null for non-nullable field ${fieldDef}.`);
    }
    return null;
  } else if (transformed instanceof Error) {
    handleRawError(transformed, fieldDetailsList, path, incrementalContext);
    return null;
  }
  return transformed;
}

// eslint-disable-next-line @typescript-eslint/max-params
function completeListValue(
  context: TransformationContext,
  itemType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: ReadonlyArray<unknown>,
  path: Path,
  incrementalContext: IncrementalContext,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment> | undefined,
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
      incrementalContext,
      deferMap,
    );

    // TODO: add test case
    /* c8 ignore start */
    if (isPromise(completedItem)) {
      completedItems.push(undefined);
      incrementalContext.promiseRegistry.add(
        completedItem.then((resolved) => {
          completedItems[index] = resolved;
        }),
      );
    } else {
      /* c8 ignore stop */
      completedItems.push(completedItem);
    }
  }

  if (streamUsage && result.length >= streamUsage.initialCount) {
    maybeAddStream(
      context,
      streamUsage,
      itemType,
      fieldDetailsList,
      result,
      path,
      result.length,
      incrementalContext,
    );
  }
  return completedItems;
}

function getNewDeferMap(
  context: TransformationContext,
  newDeferUsages: ReadonlyArray<DeferUsage>,
  deferMap?: ReadonlyMap<DeferUsage, DeferredFragment>,
  path?: Path,
): ReadonlyMap<DeferUsage, DeferredFragment> {
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
    const deferredFragment: DeferredFragment = {
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

    // Update the map.
    newDeferMap.set(newDeferUsage, deferredFragment);
  }

  return newDeferMap;
}

function deferredFragmentRecordFromDeferUsage(
  deferUsage: DeferUsage,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment>,
): DeferredFragment {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return deferMap.get(deferUsage)!;
}

function buildSubExecutionPlan(
  context: TransformationContext,
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
function collectExecutionGroups(
  context: TransformationContext,
  runtimeType: GraphQLObjectType,
  result: ObjMap<unknown>,
  path: Path | undefined,
  newGroupedFieldSets: Map<DeferUsageSet, GroupedFieldSet>,
  incrementalContext: IncrementalContext,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment>,
): void {
  for (const [deferUsageSet, groupedFieldSet] of newGroupedFieldSets) {
    const deferredFragments = getDeferredFragments(deferUsageSet, deferMap);

    const pendingExecutionGroup: PendingExecutionGroup = {
      path,
      deferredFragments,
      result:
        undefined as unknown as () => BoxedPromiseOrValue<ExecutionGroupResult>,
    };

    pendingExecutionGroup.result = () =>
      new BoxedPromiseOrValue(
        executeExecutionGroup(
          context,
          pendingExecutionGroup,
          result,
          path,
          groupedFieldSet,
          runtimeType,
          {
            promiseRegistry: new PromiseRegistry(),
            newErrors: new Map(),
            originalErrors: [],
            incrementalDataRecords: [],
            deferUsageSet,
          },
          deferMap,
        ),
      );

    incrementalContext.incrementalDataRecords.push(pendingExecutionGroup);
  }
}

function getDeferredFragments(
  deferUsages: DeferUsageSet,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment>,
): ReadonlyArray<DeferredFragment> {
  return Array.from(deferUsages).map((deferUsage) =>
    deferredFragmentRecordFromDeferUsage(deferUsage, deferMap),
  );
}

// eslint-disable-next-line @typescript-eslint/max-params
function executeExecutionGroup(
  context: TransformationContext,
  pendingExecutionGroup: PendingExecutionGroup,
  result: ObjMap<unknown>,
  path: Path | undefined,
  groupedFieldSet: GroupedFieldSet,
  runtimeType: GraphQLObjectType,
  incrementalContext: IncrementalContext,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment>,
): PromiseOrValue<ExecutionGroupResult> {
  const completed = completeObjectValue(
    context,
    groupedFieldSet,
    runtimeType,
    result,
    path,
    incrementalContext,
    deferMap,
  );

  const promiseRegistry = incrementalContext.promiseRegistry;
  return promiseRegistry.pending()
    ? promiseRegistry
        .wait()
        .then(() =>
          resolveExecutionGroupResult(
            completed,
            pendingExecutionGroup,
            incrementalContext,
          ),
        )
    : resolveExecutionGroupResult(
        completed,
        pendingExecutionGroup,
        incrementalContext,
      );
}

function resolveExecutionGroupResult(
  completedObject: ObjMap<unknown>,
  pendingExecutionGroup: PendingExecutionGroup,
  incrementalContext: IncrementalContext,
): ExecutionGroupResult {
  const { newErrors, originalErrors, incrementalDataRecords } =
    incrementalContext;

  const { filteredData, filteredRecords } = filter(
    completedObject,
    pendingExecutionGroup.path,
    newErrors,
    incrementalDataRecords,
  );

  return {
    pendingExecutionGroup,
    data: filteredData,
    errors: [...originalErrors, ...newErrors.values()],
    incrementalDataRecords: filteredRecords,
  };
}

function getStreamUsage(
  context: TransformationContext,
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
function maybeAddStream(
  context: TransformationContext,
  streamUsage: StreamUsage,
  itemType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: ReadonlyArray<unknown>,
  path: Path,
  nextIndex: number,
  incrementalContext: IncrementalContext,
): void {
  const label = streamUsage.label;
  const originalLabel = context.originalLabels.get(label);

  const stream: Stream = {
    path,
    label,
    pathStr: pathToArray(path).join('.'),
    originalLabel,
    list: result,
    nextExecutionIndex: nextIndex,
    publishedItems: nextIndex,
    result: undefined as unknown as (
      index: number,
    ) => BoxedPromiseOrValue<StreamItemResult>,
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
        index,
        {
          promiseRegistry: new PromiseRegistry(),
          newErrors: new Map(),
          originalErrors: [],
          incrementalDataRecords: [],
          deferUsageSet: undefined,
        },
      ),
    );

  incrementalContext.incrementalDataRecords.push(stream);
}

// eslint-disable-next-line @typescript-eslint/max-params
function executeStreamItem(
  context: TransformationContext,
  result: ReadonlyArray<unknown>,
  itemType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  path: Path,
  index: number,
  incrementalContext: IncrementalContext,
): PromiseOrValue<StreamItemResult> {
  const nullableType = getNullableType(itemType);
  const completed = completeValue(
    context,
    nullableType,
    fieldDetailsList,
    result[index],
    addPath(path, index, nullableType === itemType),
    incrementalContext,
    undefined,
  );

  if (isPromise(completed)) {
    return completed.then((resolved) =>
      resolveStreamItemResult(resolved, path, incrementalContext),
    );
  }
  return resolveStreamItemResult(completed, path, incrementalContext);
}

function resolveStreamItemResult(
  completedItem: unknown,
  path: Path,
  incrementalContext: IncrementalContext,
): PromiseOrValue<StreamItemResult> {
  const promiseRegistry = incrementalContext.promiseRegistry;
  // TODO: add test case?
  return promiseRegistry.pending()
    ? /* c8 ignore start */ promiseRegistry
        .wait()
        .then(() =>
          buildStreamItemResult(completedItem, path, incrementalContext),
        )
    : /* c8 ignore stop */ buildStreamItemResult(
        completedItem,
        path,
        incrementalContext,
      );
}

function buildStreamItemResult(
  completedItem: unknown,
  path: Path,
  incrementalContext: IncrementalContext,
): StreamItemResult {
  const { newErrors, originalErrors, incrementalDataRecords } =
    incrementalContext;

  const errors = [...originalErrors, ...newErrors.values()];

  const { filteredData, filteredRecords } = filter(
    [completedItem],
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
    incrementalDataRecords: filteredRecords,
  };
}
