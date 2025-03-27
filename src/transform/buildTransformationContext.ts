import type {
  ExecutionResult,
  GraphQLField,
  GraphQLLeafType,
  GraphQLObjectType,
  ValidatedExecutionArgs,
} from 'graphql';
import type {
  FieldDetails,
  GroupedFieldSet,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';

import { mapKey } from '../jsutils/mapKey.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

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

type PathScopedObjectBatchExtenders = ObjMap<ObjMap<ObjectBatchExtender>>;

export type ObjectBatchExtender = (
  objects: ReadonlyArray<ObjMap<unknown>>,
  type: GraphQLObjectType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
) => PromiseOrValue<ReadonlyArray<ExecutionResult>>;

export interface Transformers {
  pathScopedFieldTransformers?: PathScopedFieldTransformers;
  objectFieldTransformers?: ObjectFieldTransformers;
  leafTransformers?: LeafTransformers;
  pathScopedObjectBatchExtenders?: PathScopedObjectBatchExtenders;
}

export interface TransformationContext {
  argsWithNewLabels: ValidatedExecutionArgs;
  originalLabels: Map<string, string | undefined>;
  pathScopedFieldTransformers: PathScopedFieldTransformers;
  objectFieldTransformers: ObjectFieldTransformers;
  leafTransformers: LeafTransformers;
  pathScopedObjectBatchExtenders: PathScopedObjectBatchExtenders;
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
    pathScopedObjectBatchExtenders = {},
  } = transformers;

  return {
    argsWithNewLabels,
    originalLabels,
    objectFieldTransformers,
    pathScopedFieldTransformers: prefixKeys(pathScopedFieldTransformers),
    leafTransformers,
    pathScopedObjectBatchExtenders: prefixKeys(pathScopedObjectBatchExtenders),
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
