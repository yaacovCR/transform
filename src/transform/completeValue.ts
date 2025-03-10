import type {
  GraphQLError,
  GraphQLObjectType,
  GraphQLOutputType,
  ValidatedExecutionArgs,
} from 'graphql';
import {
  getDirectiveValues,
  GraphQLStreamDirective,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
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
// eslint-disable-next-line n/no-missing-import
import { pathToArray } from 'graphql/jsutils/Path.js';

import { invariant } from '../jsutils/invariant.js';
import { isObjectLike } from '../jsutils/isObjectLike.js';
import { memoize3 } from '../jsutils/memoize3.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';
import { addPath } from '../jsutils/Path.js';

import type { DeferUsageSet, ExecutionPlan } from './buildExecutionPlan.js';
import { buildExecutionPlan } from './buildExecutionPlan.js';
import type {
  DeferredFragment,
  ExecutionGroupResult,
  IncrementalDataRecord,
  PendingExecutionGroup,
  Stream,
  StreamItemsResult,
  TransformationContext,
} from './buildTransformationContext.js';

interface IncrementalContext {
  errors: Map<Path | undefined, GraphQLError>;
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
): {
  data: ObjMap<unknown>;
  errors: ReadonlyArray<GraphQLError>;
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>;
} {
  const incrementalContext: IncrementalContext = {
    errors: new Map(),
    incrementalDataRecords: [],
    deferUsageSet: undefined,
  };

  const { schema, operation, fragments, variableValues, hideSuggestions } =
    context.transformedArgs;

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

  const { groupedFieldSet, newGroupedFieldSets } = buildExecutionPlan(
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

  const errors = incrementalContext.errors;
  return {
    data: completed,
    errors: Array.from(errors.values()),
    incrementalDataRecords: filterIncrementalDataRecords(
      undefined,
      errors,
      incrementalContext.incrementalDataRecords,
    ),
  };
}

function filterIncrementalDataRecords(
  initialPath: Path | undefined,
  errors: ReadonlyMap<Path | undefined, GraphQLError>,
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>,
): ReadonlyArray<IncrementalDataRecord> {
  const filteredIncrementalDataRecords: Array<IncrementalDataRecord> = [];
  for (const incrementalDataRecord of incrementalDataRecords) {
    let currentPath: Path | undefined = incrementalDataRecord.path;

    // TODO: add test case - filtering atm not necessary unless we add transformations that can return new nulls
    /* c8 ignore next 3 */
    if (errors.has(currentPath)) {
      continue;
    }

    const paths: Array<Path | undefined> = [currentPath];
    let filtered = false;
    while (currentPath !== initialPath) {
      // Because currentPath leads to initialPath or is undefined, and the
      // loop will exit if initialPath is undefined, currentPath must be
      // defined.
      // TODO: Consider, however, adding an invariant.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      currentPath = currentPath!.prev;
      // TODO: add test case - filtering atm not necessary unless we add transformations that can return new nulls
      /* c8 ignore next 4 */
      if (errors.has(currentPath)) {
        filtered = true;
        break;
      }
      paths.push(currentPath);
    }

    if (!filtered) {
      filteredIncrementalDataRecords.push(incrementalDataRecord);
    }
  }

  return filteredIncrementalDataRecords;
}

// eslint-disable-next-line @typescript-eslint/max-params
function completeValue(
  context: TransformationContext,
  returnType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: unknown,
  path: Path,
  incrementalContext: IncrementalContext,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment> | undefined,
): unknown {
  if (isNonNullType(returnType)) {
    return completeValue(
      context,
      returnType.ofType,
      fieldDetailsList,
      result,
      path,
      incrementalContext,
      deferMap,
    );
  }

  if (result == null) {
    return null;
  }

  if (result instanceof AggregateError) {
    const errors = incrementalContext.errors;
    for (const error of result.errors) {
      errors.set(path, error);
    }
    return null;
  }

  if (isLeafType(returnType)) {
    return result;
  }

  if (isListType(returnType)) {
    invariant(Array.isArray(result));

    const itemType = returnType.ofType;

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

  const { prefix, transformedArgs } = context;

  const typeName = result[prefix];

  if (typeName == null) {
    return Object.create(null);
  }

  invariant(typeof typeName === 'string');

  const runtimeType = transformedArgs.schema.getType(typeName);

  invariant(isObjectType(runtimeType));

  const { groupedFieldSet: originalGroupedFieldSet, newDeferUsages } =
    collectSubfields(transformedArgs, runtimeType, fieldDetailsList);

  const { groupedFieldSet, newGroupedFieldSets } = buildSubExecutionPlan(
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
export function completeObjectValue(
  context: TransformationContext,
  groupedFieldSet: GroupedFieldSet,
  runtimeType: GraphQLObjectType,
  originalData: ObjMap<unknown>,
  path: Path | undefined,
  incrementalContext: IncrementalContext,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment> | undefined,
): ObjMap<unknown> {
  const {
    prefix,
    transformedArgs: { schema },
  } = context;
  const completed = Object.create(null);
  for (const [responseName, fieldDetailsList] of groupedFieldSet) {
    if (responseName === prefix) {
      continue;
    }

    const fieldName = fieldDetailsList[0].node.name.value;
    const fieldDef = schema.getField(runtimeType, fieldName);

    if (fieldDef) {
      completed[responseName] = completeValue(
        context,
        fieldDef.type,
        fieldDetailsList,
        originalData[responseName],
        addPath(path, responseName, undefined),
        incrementalContext,
        deferMap,
      );
    }
  }

  return completed;
}

// eslint-disable-next-line @typescript-eslint/max-params
export function completeListValue(
  context: TransformationContext,
  itemType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: ReadonlyArray<unknown>,
  path: Path,
  incrementalContext: IncrementalContext,
  deferMap: ReadonlyMap<DeferUsage, DeferredFragment> | undefined,
  initialIndex?: number,
): Array<unknown> {
  const streamUsage = getStreamUsage(
    context,
    fieldDetailsList,
    path,
    initialIndex,
  );
  const completedItems = [];
  for (let index = initialIndex ?? 0; index < result.length; index++) {
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

    const completed = completeValue(
      context,
      itemType,
      fieldDetailsList,
      result[index],
      addPath(path, index, undefined),
      incrementalContext,
      deferMap,
    );
    completedItems.push(completed);
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
      children: [],
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
  originalGroupedFieldSet: GroupedFieldSet,
  deferUsageSet: DeferUsageSet | undefined,
): ExecutionPlan {
  let executionPlan = (
    originalGroupedFieldSet as unknown as { _executionPlan: ExecutionPlan }
  )._executionPlan;
  if (executionPlan !== undefined) {
    return executionPlan;
  }
  executionPlan = buildExecutionPlan(originalGroupedFieldSet, deferUsageSet);
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
      result: undefined as unknown as () => ExecutionGroupResult,
    };

    pendingExecutionGroup.result = () =>
      executeExecutionGroup(
        context,
        pendingExecutionGroup,
        result,
        path,
        groupedFieldSet,
        runtimeType,
        {
          errors: new Map(),
          incrementalDataRecords: [],
          deferUsageSet,
        },
        deferMap,
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
): ExecutionGroupResult {
  return {
    pendingExecutionGroup,
    data: completeObjectValue(
      context,
      groupedFieldSet,
      runtimeType,
      result,
      path,
      incrementalContext,
      deferMap,
    ),
    errors: incrementalContext.errors,
    incrementalDataRecords: filterIncrementalDataRecords(
      pendingExecutionGroup.path,
      incrementalContext.errors,
      incrementalContext.incrementalDataRecords,
    ),
  };
}

function getStreamUsage(
  context: TransformationContext,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  path: Path,
  initialIndex: number | undefined,
): StreamUsage | undefined {
  // do not stream when streaming;
  if (initialIndex !== undefined) {
    return;
  }

  // do not stream inner lists of multi-dimensional lists
  if (typeof path.key === 'number') {
    return;
  }

  const fieldDetails = fieldDetailsList[0];
  const stream = getDirectiveValues(
    GraphQLStreamDirective,
    fieldDetails.node,
    context.transformedArgs.variableValues,
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
    result: undefined as unknown as (index: number) => StreamItemsResult,
    nextIndex,
  };

  stream.result = (index: number) =>
    executeStreamItems(
      context,
      stream,
      result,
      itemType,
      fieldDetailsList.map((details) => ({
        ...details,
        deferUsage: undefined,
      })),
      path,
      index,
      {
        errors: new Map(),
        incrementalDataRecords: [],
        deferUsageSet: undefined,
      },
    );

  incrementalContext.incrementalDataRecords.push(stream);
}

// eslint-disable-next-line @typescript-eslint/max-params
function executeStreamItems(
  context: TransformationContext,
  stream: Stream,
  result: ReadonlyArray<unknown>,
  itemType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  path: Path,
  index: number,
  incrementalContext: IncrementalContext,
): StreamItemsResult {
  return {
    stream,
    items: completeListValue(
      context,
      itemType,
      fieldDetailsList,
      result,
      path,
      incrementalContext,
      undefined,
      index,
    ),
    errors: incrementalContext.errors,
    incrementalDataRecords: filterIncrementalDataRecords(
      path,
      incrementalContext.errors,
      incrementalContext.incrementalDataRecords,
    ),
  };
}
