import type { TransformationContext } from './buildTransformationContext.js';
import type { GroupedFieldSetTree } from './collectFields.js';

export function addNewDeferredFragments(
  context: TransformationContext,
  deferredFragmentDetails: Map<string, GroupedFieldSetTree>,
  pathStr: string,
): void {
  for (const [label, groupedFieldSetTree] of deferredFragmentDetails) {
    const key = label + '.' + pathStr;
    const subsequentResultRecord = {
      originalLabel: context.originalLabels.get(label),
      executionGroups: [{ groupedFieldSetTree }],
    };
    context.subsequentResultRecords.set(key, subsequentResultRecord);
  }
}
