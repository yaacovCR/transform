import type { ValidatedExecutionArgs } from 'graphql';
// eslint-disable-next-line n/no-missing-import
import type { GroupedFieldSet } from 'graphql/execution/collectFields.js';

import { addNewLabels } from './addNewLabels.js';
import type { DeferUsageSet, ExecutionPlan } from './buildExecutionPlan.js';

export type ExecutionPlanBuilder = (
  originalGroupedFieldSet: GroupedFieldSet,
  parentDeferUsages?: DeferUsageSet,
) => ExecutionPlan;

export interface TransformationContext {
  prefix: string;
  argsWithNewLabels: ValidatedExecutionArgs;
  originalLabels: Map<string, string | undefined>;
  executionPlanBuilder: ExecutionPlanBuilder;
}

export function buildTransformationContext(
  originalArgs: ValidatedExecutionArgs,
  executionPlanBuilder: ExecutionPlanBuilder,
  prefix: string,
): TransformationContext {
  const { argsWithNewLabels, originalLabels } = addNewLabels(
    prefix,
    originalArgs,
  );

  return {
    prefix,
    argsWithNewLabels,
    originalLabels,
    executionPlanBuilder,
  };
}
