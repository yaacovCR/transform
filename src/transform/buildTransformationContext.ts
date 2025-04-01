import type {
  GraphQLField,
  GraphQLLeafType,
  ValidatedExecutionArgs,
} from 'graphql';
import type {
  GroupedFieldSet,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';

import { mapKey } from '../jsutils/mapKey.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';

import { addNewLabels } from './addNewLabels.js';
import type { DeferUsageSet, ExecutionPlan } from './buildExecutionPlan.js';

export type ExecutionPlanBuilder = (
  originalGroupedFieldSet: GroupedFieldSet,
  parentDeferUsages?: DeferUsageSet,
) => ExecutionPlan;

export type FieldTransformer = (
  value: unknown,
  field: GraphQLField,
  path: Path,
) => unknown;

type FieldTransformers = ObjMap<FieldTransformer>;

type ObjectFieldTransformers = ObjMap<FieldTransformers>;

export type LeafTransformer = (
  value: unknown,
  type: GraphQLLeafType,
  path: Path,
) => unknown;

type LeafTransformers = ObjMap<LeafTransformer>;

type PathScopedFieldTransformers = ObjMap<FieldTransformer>;

export interface Transformers {
  pathScopedFieldTransformers?: PathScopedFieldTransformers;
  objectFieldTransformers?: ObjectFieldTransformers;
  leafTransformers?: LeafTransformers;
}

export interface TransformationContext {
  argsWithNewLabels: ValidatedExecutionArgs;
  originalLabels: Map<string, string | undefined>;
  pathScopedFieldTransformers: PathScopedFieldTransformers;
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

  const {
    objectFieldTransformers = {},
    pathScopedFieldTransformers = {},
    leafTransformers = {},
  } = transformers;

  return {
    argsWithNewLabels,
    originalLabels,
    objectFieldTransformers,
    pathScopedFieldTransformers: prefixKeys(pathScopedFieldTransformers),
    leafTransformers,
    executionPlanBuilder,
    prefix,
  };
}

function prefixKeys<T>(obj: ObjMap<T>): ObjMap<T> {
  return mapKey(
    obj,
    //by modifying the keys, identical pathStr logic can be utilized for root fields and subfields
    (key) => `.${key}`,
  );
}
