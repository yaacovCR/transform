import { AccumulatorMap } from '../jsutils/AccumulatorMap.js';
import { invariant } from '../jsutils/invariant.js';

import type { TransformationContext } from './buildTransformationContext.js';
import type { FieldDetails, GroupedFieldSetTree } from './collectFields.js';

export function inlineDefers(
  context: TransformationContext,
  groupedFieldSetTree: GroupedFieldSetTree,
  pathStr: string,
): GroupedFieldSetTree {
  const groupedFieldSetWithInlinedDefers = new AccumulatorMap<
    string,
    FieldDetails
  >();

  const { groupedFieldSet, deferredFragmentDetails } = groupedFieldSetTree;

  for (const [responseName, fieldDetailsList] of groupedFieldSet) {
    for (const fieldDetails of fieldDetailsList) {
      groupedFieldSetWithInlinedDefers.add(responseName, fieldDetails);
    }
  }

  const newDeferredFragmentDetails = new Map<string, GroupedFieldSetTree>();

  maybeAddDefers(
    context,
    groupedFieldSetWithInlinedDefers,
    deferredFragmentDetails,
    newDeferredFragmentDetails,
    pathStr,
  );

  return {
    groupedFieldSet: groupedFieldSetWithInlinedDefers,
    deferredFragmentDetails: newDeferredFragmentDetails,
  };
}

function maybeAddDefers(
  context: TransformationContext,
  groupedFieldSetWithInlinedDefers: AccumulatorMap<string, FieldDetails>,
  deferredFragmentDetails: Map<string, GroupedFieldSetTree>,
  newDeferredFragmentDetails: Map<string, GroupedFieldSetTree>,
  pathStr: string,
): void {
  for (const [label, groupedFieldSetTree] of deferredFragmentDetails) {
    const labels = context.pendingLabelsByPath.get(pathStr);
    if (labels?.has(label)) {
      newDeferredFragmentDetails.set(label, groupedFieldSetTree);
      continue;
    }

    const {
      groupedFieldSet,
      deferredFragmentDetails: nestedDeferredFragmentDetails,
    } = groupedFieldSetTree;

    invariant(groupedFieldSet != null);

    for (const [responseName, fieldDetailsList] of groupedFieldSet) {
      for (const fieldDetails of fieldDetailsList) {
        groupedFieldSetWithInlinedDefers.add(responseName, fieldDetails);
      }
    }

    maybeAddDefers(
      context,
      groupedFieldSetWithInlinedDefers,
      nestedDeferredFragmentDetails,
      newDeferredFragmentDetails,
      pathStr,
    );
  }
}
