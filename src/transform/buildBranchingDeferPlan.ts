import type {
  DeferUsage,
  FieldDetails,
  GroupedFieldSet,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';

import { AccumulatorMap } from '../jsutils/AccumulatorMap.js';
import { getBySet } from '../jsutils/getBySet.js';
import { isSameSet } from '../jsutils/isSameSet.js';

import type { DeferPlan, DeferUsageSet } from './buildDeferPlan.js';

export function buildBranchingDeferPlan(
  originalGroupedFieldSet: GroupedFieldSet,
  parentDeferUsages: DeferUsageSet = new Set<DeferUsage>(),
): DeferPlan {
  const groupedFieldSet = new AccumulatorMap<string, FieldDetails>();

  const newGroupedFieldSets = new Map<
    DeferUsageSet,
    AccumulatorMap<string, FieldDetails>
  >();

  for (const [responseKey, fieldGroup] of originalGroupedFieldSet) {
    for (const fieldDetails of fieldGroup) {
      const deferUsage = fieldDetails.deferUsage;
      const deferUsageSet =
        deferUsage === undefined
          ? new Set<DeferUsage>()
          : new Set([deferUsage]);
      if (isSameSet(parentDeferUsages, deferUsageSet)) {
        groupedFieldSet.add(responseKey, fieldDetails);
      } else {
        let newGroupedFieldSet = getBySet(newGroupedFieldSets, deferUsageSet);
        if (newGroupedFieldSet === undefined) {
          newGroupedFieldSet = new AccumulatorMap();
          newGroupedFieldSets.set(deferUsageSet, newGroupedFieldSet);
        }
        newGroupedFieldSet.add(responseKey, fieldDetails);
      }
    }
  }

  return {
    groupedFieldSet,
    newGroupedFieldSets,
  };
}
