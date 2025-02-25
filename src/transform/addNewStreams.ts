import type { GraphQLError, GraphQLOutputType } from 'graphql';
import { getDirectiveValues, GraphQLStreamDirective } from 'graphql';

import { invariant } from '../jsutils/invariant.js';
import type { Path } from '../jsutils/Path.js';
import { pathToArray } from '../jsutils/Path.js';

import type { TransformationContext } from './buildTransformationContext.js';
import { isStream } from './buildTransformationContext.js';
import type { FieldDetails } from './collectFields.js';
import { completeListValue } from './completeValue.js';
import { getObjectAtPath } from './getObjectAtPath.js';

export function addNewStreams(
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

  const list = getObjectAtPath(context.mergedResult, pathToArray(path));
  invariant(Array.isArray(list));

  const originalStreams = Array.from(originalStreamsByDeferLabel.values()).map(
    ({ originalLabel, fieldDetailsList: fieldDetailsListForStream }) => ({
      originalLabel,
      result: (errors: Array<GraphQLError>, index: number) =>
        completeListValue(
          context,
          errors,
          itemType,
          fieldDetailsListForStream,
          list,
          path,
          index,
        ),
      nextIndex,
    }),
  );

  const key = pendingLabel + '.' + pathStr;
  const streamForPendingLabel = context.subsequentResultRecords.get(key);
  if (streamForPendingLabel == null) {
    context.subsequentResultRecords.set(key, {
      originalStreams,
    });
  } else {
    invariant(isStream(streamForPendingLabel));
    streamForPendingLabel.originalStreams.push(...originalStreams);
  }
}
