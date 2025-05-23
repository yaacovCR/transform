import type {
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
  GraphQLError,
  GraphQLField,
  GraphQLLeafType,
  GraphQLNullableOutputType,
  GraphQLObjectType,
  GraphQLOutputType,
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
  collectSubfields as _collectSubfields,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';

import { BoxedPromiseOrValue } from '../jsutils/BoxedPromiseOrValue.js';
import { invariant } from '../jsutils/invariant.js';
import { isObjectLike } from '../jsutils/isObjectLike.js';
import { isPromise } from '../jsutils/isPromise.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';
import { addPath, pathToArray } from '../jsutils/Path.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

import type { DeferUsageSet } from './buildDeferPlan.js';
import type { SubschemaPlan } from './buildFieldPlan.js';
import { buildSubfieldPlan } from './buildFieldPlan.js';
import type {
  FieldTransformer,
  LeafTransformer,
  PathSegmentNode,
  SubschemaConfig,
  TransformationContext,
} from './buildTransformationContext.js';
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

export interface CompletedInitialResult {
  data: ObjMap<unknown>;
  errors: ReadonlyArray<GraphQLError>;
  deferredFragments: ReadonlyArray<DeferredFragment>;
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>;
}

interface IncrementalContext {
  deferUsageSet: DeferUsageSet | undefined;
  newErrors: Map<Path | undefined, GraphQLError>;
  originalErrors: Array<GraphQLError>;
  deferredFragments: Array<DeferredFragment>;
  incrementalDataRecords: Array<IncrementalDataRecord>;
  encounteredPlans: Map<Path, EncounteredPlan>;
}

interface EncounteredPlan {
  plansBySubschema: Map<SubschemaConfig, SubschemaPlan>;
  complete: (
    subschemaConfig: SubschemaConfig,
    result: ExecutionResult | ExperimentalIncrementalExecutionResults,
  ) => void;
}

interface StreamUsage {
  label: string;
  initialCount: number;
}

// eslint-disable-next-line @typescript-eslint/max-params
export function completeInitialResult(
  context: TransformationContext,
  rootType: GraphQLObjectType,
  groupedFieldSet: GroupedFieldSet,
  newDeferUsages: ReadonlyArray<DeferUsage>,
  newGroupedFieldSets: Map<DeferUsageSet, GroupedFieldSet>,
  subschemaConfig: SubschemaConfig,
  originalResult: ExecutionResult | ExperimentalIncrementalExecutionResults,
): ExecutionResult | PromiseOrValue<CompletedInitialResult> {
  const mergedResult = context.mergedResult;
  mergedResult.add(subschemaConfig.label, originalResult);
  const originalData = mergedResult.getMergedData();
  if (originalData instanceof EmbeddedErrors) {
    return {
      errors: originalData.errors,
      data: null,
    };
  }

  const incrementalContext: IncrementalContext = {
    deferUsageSet: undefined,
    newErrors: new Map(),
    originalErrors: [],
    deferredFragments: [],
    incrementalDataRecords: [],
    encounteredPlans: new Map(),
  };

  const newDeferMap = getNewDeferMap(
    context,
    incrementalContext,
    newDeferUsages,
  );

  const pathSegmentRootNode = context.pathSegmentRootNode;

  const completed = completeObjectValueCollectingExecutionGroups(
    context,
    groupedFieldSet,
    newGroupedFieldSets,
    rootType,
    originalData,
    undefined,
    pathSegmentRootNode,
    incrementalContext,
    subschemaConfig,
    newDeferMap,
  );

  const promises = executeSubschemaPlans(incrementalContext.encounteredPlans);

  if (promises.length > 0) {
    return Promise.all(promises).then(() =>
      buildInitialResult(incrementalContext, completed),
    );
  }

  return buildInitialResult(incrementalContext, completed);
}

function executeSubschemaPlans(
  encounteredPlans: Map<Path, EncounteredPlan>,
): Array<Promise<void>> {
  const promises: Array<Promise<void>> = [];
  for (const [, encounteredPlan] of encounteredPlans) {
    const { plansBySubschema, complete } = encounteredPlan;
    for (const [subschemaConfig, subschemaPlan] of plansBySubschema) {
      const { executor } = subschemaPlan;
      const result = executor();
      if (isPromise(result)) {
        promises.push(
          result.then((resolved) => {
            complete(subschemaConfig, resolved);
          }),
        );
        continue;
      }
      complete(subschemaConfig, result);
    }
  }
  return promises;
}

function buildInitialResult(
  incrementalContext: IncrementalContext,
  completed: ObjMap<unknown>,
): {
  data: ObjMap<unknown>;
  errors: ReadonlyArray<GraphQLError>;
  deferredFragments: ReadonlyArray<DeferredFragment>;
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>;
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

// eslint-disable-next-line @typescript-eslint/max-params
function completeValue(
  context: TransformationContext,
  nullableType: GraphQLNullableOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: unknown,
  path: Path,
  pathSegmentNode: PathSegmentNode | undefined,
  incrementalContext: IncrementalContext,
  subschemaConfig: SubschemaConfig,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment> | undefined,
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
      pathSegmentNode,
      incrementalContext,
      subschemaConfig,
      deferMap,
    );

    return completed;
  }

  invariant(isObjectLike(result));

  const { prefix, superschema } = context;

  const typeName = result[prefix];

  if (typeName == null) {
    return Object.create(null);
  }

  invariant(typeof typeName === 'string');

  const runtimeType = superschema.getType(typeName);

  invariant(isObjectType(runtimeType));

  const {
    groupedFieldSet,
    newDeferUsages,
    newGroupedFieldSets,
    plansBySubschema,
  } = buildSubfieldPlan(
    context,
    runtimeType,
    fieldDetailsList,
    subschemaConfig,
    incrementalContext.deferUsageSet,
  );

  const newDeferMap = getNewDeferMap(
    context,
    incrementalContext,
    newDeferUsages,
    deferMap,
    path,
  );

  const completed = completeObjectValueCollectingExecutionGroups(
    context,
    groupedFieldSet,
    newGroupedFieldSets,
    runtimeType,
    result,
    path,
    pathSegmentNode,
    incrementalContext,
    subschemaConfig,
    newDeferMap,
  );

  if (plansBySubschema.size > 0) {
    incrementalContext.encounteredPlans.set(path, {
      plansBySubschema,
      complete: (
        additionalSubschemaConfig: SubschemaConfig,
        newResult: ExecutionResult | ExperimentalIncrementalExecutionResults,
      ) =>
        completeSubschemaObjectValue(
          context,
          runtimeType,
          plansBySubschema,
          result,
          newResult,
          path,
          pathSegmentNode,
          incrementalContext,
          additionalSubschemaConfig,
          newDeferMap,
          completed,
        ),
    });
  }

  return completed;
}

// eslint-disable-next-line @typescript-eslint/max-params
function completeSubschemaObjectValue(
  context: TransformationContext,
  runtimeType: GraphQLObjectType,
  plansBySubschema: Map<SubschemaConfig, SubschemaPlan>,
  originalData: ObjMap<unknown>,
  newResult: ExecutionResult | ExperimentalIncrementalExecutionResults,
  path: Path | undefined,
  pathSegmentNode: PathSegmentNode | undefined,
  incrementalContext: IncrementalContext,
  subschemaConfig: SubschemaConfig,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment>,
  originalCompleted: ObjMap<unknown>,
): void {
  context.mergedResult.add(subschemaConfig.label, newResult, pathToArray(path));

  const subschemaPlan = plansBySubschema.get(subschemaConfig);
  invariant(subschemaPlan !== undefined);

  const {
    groupedFieldSet: additionalGroupedFieldSet,
    newGroupedFieldSets: additionalNewGroupedFieldSets,
  } = subschemaPlan;

  completeObjectValueCollectingExecutionGroups(
    context,
    additionalGroupedFieldSet,
    additionalNewGroupedFieldSets,
    runtimeType,
    originalData,
    path,
    pathSegmentNode,
    incrementalContext,
    subschemaConfig,
    deferMap,
    originalCompleted,
  );
}

// eslint-disable-next-line @typescript-eslint/max-params
function transformLeafValue(
  leafTransformer: LeafTransformer,
  type: GraphQLLeafType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  value: unknown,
  path: Path,
  incrementalContext: IncrementalContext,
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
function completeObjectValueCollectingExecutionGroups(
  context: TransformationContext,
  groupedFieldSet: GroupedFieldSet,
  newGroupedFieldSets: Map<DeferUsageSet, GroupedFieldSet>,
  runtimeType: GraphQLObjectType,
  originalData: ObjMap<unknown>,
  path: Path | undefined,
  pathSegmentNode: PathSegmentNode | undefined,
  incrementalContext: IncrementalContext,
  subschemaConfig: SubschemaConfig,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment>,
  completedObject = Object.create(null),
): ObjMap<unknown> {
  const completed = completeObjectValue(
    context,
    groupedFieldSet,
    runtimeType,
    originalData,
    path,
    pathSegmentNode,
    incrementalContext,
    subschemaConfig,
    deferMap,
    completedObject,
  );

  collectExecutionGroups(
    context,
    runtimeType,
    originalData,
    path,
    pathSegmentNode,
    newGroupedFieldSets,
    incrementalContext,
    subschemaConfig,
    deferMap,
  );

  return completed;
}

// eslint-disable-next-line @typescript-eslint/max-params
function completeObjectValue(
  context: TransformationContext,
  groupedFieldSet: GroupedFieldSet,
  runtimeType: GraphQLObjectType,
  originalData: ObjMap<unknown>,
  path: Path | undefined,
  pathSegmentNode: PathSegmentNode | undefined,
  incrementalContext: IncrementalContext,
  subschemaConfig: SubschemaConfig,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment> | undefined,
  completedObject = Object.create(null),
): ObjMap<unknown> {
  const superschema = context.superschema;

  const objectFieldTransformers =
    context.objectFieldTransformers[runtimeType.name];
  const children = pathSegmentNode?.children;
  for (const [responseName, fieldDetailsList] of groupedFieldSet) {
    const fieldName = fieldDetailsList[0].node.name.value;
    const fieldDef = superschema.getField(runtimeType, fieldName);

    if (fieldDef) {
      const fieldType = fieldDef.type;
      const nullableType = getNullableType(fieldType);
      const fieldPath = addPath(path, responseName, nullableType === fieldType);
      const fieldPathSegmentNode = children?.[responseName];
      let completed = completeValue(
        context,
        nullableType,
        fieldDetailsList,
        originalData[responseName],
        fieldPath,
        fieldPathSegmentNode,
        incrementalContext,
        subschemaConfig,
        deferMap,
      );

      for (const fieldTransformer of [
        objectFieldTransformers?.[fieldName],
        fieldPathSegmentNode?.fieldTransformer,
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
function transformFieldValue(
  fieldTransformer: FieldTransformer,
  fieldDef: GraphQLField,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  value: unknown,
  path: Path,
  incrementalContext: IncrementalContext,
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
function completeListValue(
  context: TransformationContext,
  itemType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: ReadonlyArray<unknown>,
  path: Path,
  pathSegmentNode: PathSegmentNode | undefined,
  incrementalContext: IncrementalContext,
  subschemaConfig: SubschemaConfig,
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
        pathSegmentNode,
        index,
        incrementalContext,
        subschemaConfig,
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
      pathSegmentNode,
      incrementalContext,
      subschemaConfig,
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
      pathSegmentNode,
      result.length,
      incrementalContext,
      subschemaConfig,
    );
  }
  return completedItems;
}

function getNewDeferMap(
  context: TransformationContext,
  incrementalContext: IncrementalContext,
  newDeferUsages: ReadonlyArray<DeferUsage>,
  deferMap?: ReadonlyMap<DeferUsage, DeferredFragment>,
  path?: Path,
): ReadonlyMap<DeferUsage, DeferredFragment> {
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

    deferredFragments.push(deferredFragment);

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

// eslint-disable-next-line @typescript-eslint/max-params
function collectExecutionGroups(
  context: TransformationContext,
  runtimeType: GraphQLObjectType,
  result: ObjMap<unknown>,
  path: Path | undefined,
  pathSegmentNode: PathSegmentNode | undefined,
  newGroupedFieldSets: Map<DeferUsageSet, GroupedFieldSet>,
  incrementalContext: IncrementalContext,
  subschemaConfig: SubschemaConfig,
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
          pathSegmentNode,
          groupedFieldSet,
          runtimeType,
          {
            deferUsageSet,
            newErrors: new Map(),
            originalErrors: [],
            deferredFragments: [],
            incrementalDataRecords: [],
            encounteredPlans: new Map(),
          },
          subschemaConfig,
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
  pathSegmentNode: PathSegmentNode | undefined,
  groupedFieldSet: GroupedFieldSet,
  runtimeType: GraphQLObjectType,
  incrementalContext: IncrementalContext,
  subschemaConfig: SubschemaConfig,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment>,
): PromiseOrValue<ExecutionGroupResult> {
  const completed = completeObjectValue(
    context,
    groupedFieldSet,
    runtimeType,
    result,
    path,
    pathSegmentNode,
    incrementalContext,
    subschemaConfig,
    deferMap,
  );

  return buildExecutionGroupResult(
    incrementalContext,
    completed,
    pendingExecutionGroup,
  );
}

function buildExecutionGroupResult(
  incrementalContext: IncrementalContext,
  completed: ObjMap<unknown>,
  pendingExecutionGroup: PendingExecutionGroup,
): ExecutionGroupResult {
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
    context.variableValues,
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
  pathSegmentNode: PathSegmentNode | undefined,
  nextIndex: number,
  incrementalContext: IncrementalContext,
  subschemaConfig: SubschemaConfig,
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
        pathSegmentNode,
        index,
        {
          deferUsageSet: undefined,
          newErrors: new Map(),
          originalErrors: [],
          deferredFragments: [],
          incrementalDataRecords: [],
          encounteredPlans: new Map(),
        },
        subschemaConfig,
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
  pathSegmentNode: PathSegmentNode | undefined,
  index: number,
  incrementalContext: IncrementalContext,
  subschemaConfig: SubschemaConfig,
): PromiseOrValue<StreamItemResult> {
  const nullableType = getNullableType(itemType);
  const itemPath = addPath(path, index, nullableType === itemType);
  const completed = completeValue(
    context,
    nullableType,
    fieldDetailsList,
    result[index],
    itemPath,
    pathSegmentNode,
    incrementalContext,
    subschemaConfig,
    undefined,
  );

  return buildStreamItemResult(incrementalContext, completed, path);
}

function buildStreamItemResult(
  incrementalContext: IncrementalContext,
  completed: unknown,
  path: Path,
): StreamItemResult {
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
