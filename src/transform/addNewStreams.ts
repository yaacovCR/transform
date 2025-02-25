import type { GraphQLOutputType } from 'graphql';
import { getDirectiveValues, GraphQLStreamDirective } from 'graphql';
import { pathToArray } from 'graphql/jsutils/Path';

import { invariant } from '../jsutils/invariant.js';
import type { Path } from '../jsutils/Path.js';

import type {TransformationContext} from './buildTransformationContext.js';
import {
  isStream
} from './buildTransformationContext.js';
import type { FieldDetails } from './collectFields.js';

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
