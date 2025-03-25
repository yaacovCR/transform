import type {
  GraphQLField,
  GraphQLLeafType,
  ValidatedExecutionArgs,
} from 'graphql';
// eslint-disable-next-line n/no-missing-import
import type { GroupedFieldSet } from 'graphql/execution/collectFields.js';

import type { ObjMap } from '../jsutils/ObjMap.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

import { addNewLabels } from './addNewLabels.js';
import type { DeferUsageSet, ExecutionPlan } from './buildExecutionPlan.js';

export type ExecutionPlanBuilder = (
  originalGroupedFieldSet: GroupedFieldSet,
  parentDeferUsages?: DeferUsageSet,
) => ExecutionPlan;

type FieldTransformer = (
  value: unknown,
  field: GraphQLField,
) => PromiseOrValue<unknown>;

type FieldTransformers = ObjMap<FieldTransformer>;

type ObjectFieldTransformers = ObjMap<FieldTransformers>;

type LeafTransformer = (
  value: unknown,
  type: GraphQLLeafType,
) => PromiseOrValue<unknown>;

type LeafTransformers = ObjMap<LeafTransformer>;

export interface Transformers {
  objectFieldTransformers?: ObjectFieldTransformers;
  leafTransformers?: LeafTransformers;
}

export interface TransformationContext {
  argsWithNewLabels: ValidatedExecutionArgs;
  originalLabels: Map<string, string | undefined>;
  objectFieldTransformers: ObjectFieldTransformers;
  leafTransformers: LeafTransformers;
  executionPlanBuilder: ExecutionPlanBuilder;
  prefix: string;
}

export function buildTransformationContext(
  originalArgs: ValidatedExecutionArgs,
  transformers: Transformers,
  executionPlanBuilder: ExecutionPlanBuilder,
  prefix: string,
): TransformationContext {
  const { argsWithNewLabels, originalLabels } = addNewLabels(
    prefix,
    originalArgs,
  );

  const { objectFieldTransformers = {}, leafTransformers = {} } = transformers;

  return {
    argsWithNewLabels,
    originalLabels,
    objectFieldTransformers,
    leafTransformers,
    executionPlanBuilder,
    prefix,
  };
}
