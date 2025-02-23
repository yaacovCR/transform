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
import type { FieldDetails, GroupedFieldSet } from './collectFields.js';
import { collectSubfields as _collectSubfields } from './collectFields.js';
import { inlineDefers } from './inlineDefers.js';

const collectSubfields = memoize3(
  (
    validatedExecutionArgs: ValidatedExecutionArgs,
    returnType: GraphQLObjectType,
    fieldDetailsList: ReadonlyArray<FieldDetails>,
  ) => _collectSubfields(validatedExecutionArgs, returnType, fieldDetailsList),
);

// eslint-disable-next-line @typescript-eslint/max-params
export function completeValue(
  context: TransformationContext,
  rootValue: ObjMap<unknown>,
  rootType: GraphQLObjectType,
  groupedFieldSet: GroupedFieldSet,
  errors: Array<GraphQLError>,
  path: Path | undefined,
): ObjMap<unknown> {
  const transformedArgs = context.transformedArgs;
  const data = Object.create(null);
  for (const [responseName, fieldDetailsList] of groupedFieldSet) {
    const fieldName = fieldDetailsList[0].node.name.value;
    const fieldDef = transformedArgs.schema.getField(rootType, fieldName);

    if (fieldDef) {
      data[responseName] = completeSubValue(
        context,
        errors,
        fieldDef.type,
        fieldDetailsList,
        rootValue[responseName],
        addPath(path, responseName, undefined),
      );
    }
  }

  return data;
}

// eslint-disable-next-line @typescript-eslint/max-params
function completeSubValue(
  context: TransformationContext,
  errors: Array<GraphQLError>,
  returnType: GraphQLOutputType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: unknown,
  path: Path,
): unknown {
  if (isNonNullType(returnType)) {
    return completeSubValue(
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
  return completeObjectValue(context, errors, fieldDetailsList, result, path);
}

function completeObjectValue(
  context: TransformationContext,
  errors: Array<GraphQLError>,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
  result: ObjMap<unknown>,
  path: Path,
): ObjMap<unknown> {
  const { prefix, transformedArgs } = context;

  const typeName = result[prefix];

  const completed = Object.create(null);

  if (typeName != null) {
    invariant(typeof typeName === 'string');

    const runtimeType = transformedArgs.schema.getType(typeName);

    invariant(isObjectType(runtimeType));

    const groupedFieldSetTree = collectSubfields(
      transformedArgs,
      runtimeType,
      fieldDetailsList,
    );

    const pathStr = pathToArray(path).join('.');

    const { groupedFieldSet, deferredFragmentDetails } = inlineDefers(
      context,
      groupedFieldSetTree,
      pathStr,
    );

    addNewDeferredFragments(context, deferredFragmentDetails, pathStr);

    for (const [responseName, subFieldDetailsList] of groupedFieldSet) {
      if (responseName === prefix) {
        continue;
      }

      const fieldName = subFieldDetailsList[0].node.name.value;
      const fieldDef = transformedArgs.schema.getField(runtimeType, fieldName);

      if (fieldDef) {
        completed[responseName] = completeSubValue(
          context,
          errors,
          fieldDef.type,
          subFieldDetailsList,
          result[responseName],
          addPath(path, responseName, undefined),
        );
      }
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
    const completed = completeSubValue(
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
