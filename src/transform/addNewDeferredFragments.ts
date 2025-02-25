import type { GraphQLError, GraphQLObjectType } from 'graphql';

import { invariant } from '../jsutils/invariant.js';
import { isObjectLike } from '../jsutils/isObjectLike.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';

import type { TransformationContext } from './buildTransformationContext.js';
import type { GroupedFieldSetTree } from './collectFields.js';
import { completeObjectValue } from './completeValue.js';
import { getObjectAtPath } from './getObjectAtPath.js';

// eslint-disable-next-line @typescript-eslint/max-params
export function addNewDeferredFragments(
  context: TransformationContext,
  deferredFragmentDetails: Map<string, GroupedFieldSetTree>,
  runtimeType: GraphQLObjectType,
  path: Path | undefined,
  pathArr: ReadonlyArray<string | number>,
  pathStr: string,
): void {
  for (const [label, deferredGroupedFieldSetTree] of deferredFragmentDetails) {
    const key = label + '.' + pathStr;
    const result = (errors: Array<GraphQLError>) =>
      executeExecutionGroup(
        context,
        errors,
        path,
        pathArr,
        deferredGroupedFieldSetTree,
        runtimeType,
      );
    const subsequentResultRecord = {
      originalLabel: context.originalLabels.get(label),
      executionGroups: [{ result }],
    };
    context.subsequentResultRecords.set(key, subsequentResultRecord);
  }
}

// eslint-disable-next-line @typescript-eslint/max-params
function executeExecutionGroup(
  context: TransformationContext,
  errors: Array<GraphQLError>,
  path: Path | undefined,
  pathArr: ReadonlyArray<string | number>,
  groupedFieldSetTree: GroupedFieldSetTree,
  runtimeType: GraphQLObjectType,
): ObjMap<unknown> {
  const object = getObjectAtPath(context.mergedResult, pathArr);
  invariant(isObjectLike(object));

  return completeObjectValue(
    context,
    errors,
    groupedFieldSetTree,
    runtimeType,
    object,
    path,
  );
}
