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

import { invariant } from '../jsutils/invariant.js';
import { isObjectLike } from '../jsutils/isObjectLike.js';
import { memoize3 } from '../jsutils/memoize3.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';
import { addPath, pathToArray } from '../jsutils/Path.js';

import { addNewDeferredFragments } from './addNewDeferredFragments.js';
import type { TransformationContext } from './buildTransformationContext.js';
import { isStream } from './buildTransformationContext.js';
import type { FieldDetails, GroupedFieldSetTree } from './collectFields.js';
import {
  collectRootFields,
  collectSubfields as _collectSubfields,
} from './collectFields.js';
import { inlineDefers } from './inlineDefers.js';

const collectSubfields = memoize3(
  (
    validatedExecutionArgs: ValidatedExecutionArgs,
    returnType: GraphQLObjectType,
    fieldDetailsList: ReadonlyArray<FieldDetails>,
  ) => _collectSubfields(validatedExecutionArgs, returnType, fieldDetailsList),
);

export function completeInitialResult(
  context: TransformationContext,
  originalData: ObjMap<unknown>,
  rootType: GraphQLObjectType,
  errors: Array<GraphQLError>,
): ObjMap<unknown> {
  const groupedFieldSetTree = collectRootFields(
    context.transformedArgs,
    rootType,
  );

  return completeObjectValue(
    context,
    errors,
    groupedFieldSetTree,
    rootType,
    originalData,
    undefined,
  );
}

// eslint-disable-next-line @typescript-eslint/max-params
function completeValue(
  context: TransformationContext,
  errors: Array<GraphQLError>,
  returnType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: unknown,
  path: Path,
): unknown {
  if (isNonNullType(returnType)) {
    return completeValue(
      context,
      errors,
      returnType.ofType,
      fieldDetailsList,
      result,
      path,
    );
  }

  if (result == null) {
    return null;
  }

  if (result instanceof AggregateError) {
    for (const error of result.errors) {
      errors.push(error as GraphQLError);
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
      errors,
      itemType,
      fieldDetailsList,
      result,
      path,
    );

    maybeAddStream(context, itemType, fieldDetailsList, path, result.length);

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

  const groupedFieldSetTree = collectSubfields(
    transformedArgs,
    runtimeType,
    fieldDetailsList,
  );

  return completeObjectValue(
    context,
    errors,
    groupedFieldSetTree,
    runtimeType,
    result,
    path,
  );
}

// eslint-disable-next-line @typescript-eslint/max-params
export function completeObjectValue(
  context: TransformationContext,
  errors: Array<GraphQLError>,
  groupedFieldSetTree: GroupedFieldSetTree,
  runtimeType: GraphQLObjectType,
  originalData: ObjMap<unknown>,
  path: Path | undefined,
): ObjMap<unknown> {
  const pathStr = pathToArray(path).join('.');

  const { groupedFieldSet, deferredFragmentDetails } = inlineDefers(
    context,
    groupedFieldSetTree,
    pathStr,
  );

  addNewDeferredFragments(context, deferredFragmentDetails, pathStr);

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
        errors,
        fieldDef.type,
        fieldDetailsList,
        originalData[responseName],
        addPath(path, responseName, undefined),
      );
    }
  }

  return completed;
}

// eslint-disable-next-line @typescript-eslint/max-params
export function completeListValue(
  context: TransformationContext,
  errors: Array<GraphQLError>,
  itemType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: Array<unknown>,
  path: Path,
  initialIndex = 0,
): Array<unknown> {
  const completedItems = [];

  for (let index = initialIndex; index < result.length; index++) {
    const completed = completeValue(
      context,
      errors,
      itemType,
      fieldDetailsList,
      result[index],
      addPath(path, index, undefined),
    );
    completedItems.push(completed);
  }

  return completedItems;
}

function maybeAddStream(
  context: TransformationContext,
  itemType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  path: Path,
  nextIndex: number,
): void {
  const pathStr = pathToArray(path).join('.');
  const pendingLabels = context.pendingLabelsByPath.get(pathStr);
  if (pendingLabels == null) {
    return;
  }

  // for stream, there must be at most one pending label at this path
  const pendingLabel = pendingLabels.values().next().value;
  invariant(pendingLabel != null);

  const originalStreamsByDeferLabel = new Map<
    string | undefined,
    {
      originalLabel: string | undefined;
      fieldDetailsList: Array<FieldDetails>;
    }
  >();
  for (const fieldDetails of fieldDetailsList) {
    const stream = getDirectiveValues(
      GraphQLStreamDirective,
      fieldDetails.node,
      context.transformedArgs.variableValues,
      fieldDetails.fragmentVariableValues,
    );
    if (stream != null) {
      const label = stream.label;
      invariant(typeof label === 'string');
      const originalStreamLabel = context.originalLabels.get(label);
      const deferLabel = fieldDetails.deferUsage?.label;
      let originalStream = originalStreamsByDeferLabel.get(deferLabel);
      if (originalStream === undefined) {
        originalStream = {
          originalLabel: originalStreamLabel,
          fieldDetailsList: [],
        };
        originalStreamsByDeferLabel.set(deferLabel, originalStream);
      }
      originalStream.fieldDetailsList.push(fieldDetails);
    }
  }

  const originalStreams = Array.from(originalStreamsByDeferLabel.values());
  const key = pendingLabel + '.' + pathStr;
  const streamForPendingLabel = context.subsequentResultRecords.get(key);
  if (streamForPendingLabel == null) {
    context.subsequentResultRecords.set(key, {
      path,
      itemType,
      originalStreams,
      nextIndex,
    });
  } else {
    invariant(isStream(streamForPendingLabel));
    streamForPendingLabel.originalStreams.push(...originalStreams);
  }
}
