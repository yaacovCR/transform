import type {
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
  GraphQLCompositeType,
  GraphQLField,
  GraphQLLeafType,
  GraphQLSchema,
  OperationDefinitionNode,
  ValidatedExecutionArgs,
} from 'graphql';
import type {
  FragmentDetails,
  GroupedFieldSet,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';
// eslint-disable-next-line n/no-missing-import
import type { VariableValues } from 'graphql/execution/values.js';

import { invariant } from '../jsutils/invariant.js';
import { keyMap } from '../jsutils/keyMap.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

import { addNewLabels } from './addNewLabels.js';
import type { DeferPlan, DeferUsageSet } from './buildDeferPlan.js';
import { MergedResult } from './MergedResult.js';
import { transformSelectionSetForTargetSubschema } from './transformSelectionSetForTargetSubschema.js';

export type DeferPlanBuilder = (
  originalGroupedFieldSet: GroupedFieldSet,
  parentDeferUsages?: DeferUsageSet,
) => DeferPlan;

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

export interface PathSegmentNode {
  fieldTransformer?: FieldTransformer;
  children: ObjMap<PathSegmentNode>;
}

export interface TransformationContext {
  superschema: GraphQLSchema;
  subschemas: ObjMap<SubschemaConfig>;
  operation: OperationDefinitionNode;
  fragments: ObjMap<FragmentDetails>;
  fragmentsBySubschema: ObjMap<ObjMap<FragmentDetails>>;
  variableValues: VariableValues;
  hideSuggestions: boolean;
  originalArgs: ValidatedExecutionArgs;
  originalLabels: Map<string, string | undefined>;
  pathSegmentRootNode: PathSegmentNode;
  objectFieldTransformers: ObjectFieldTransformers;
  leafTransformers: LeafTransformers;
  deferPlanBuilder: DeferPlanBuilder;
  prefix: string;
  mergedResult: MergedResult;
}

export interface SubschemaConfig {
  label: string;
  schema: GraphQLSchema;
  executor?: Executor;
}

export type Executor = (
  args: ValidatedExecutionArgs,
) => PromiseOrValue<ExecutionResult | ExperimentalIncrementalExecutionResults>;

export function buildTransformationContext(
  originalArgs: ValidatedExecutionArgs,
  subschemas: ReadonlyArray<SubschemaConfig>,
  transformers: Transformers,
  deferPlanBuilder: DeferPlanBuilder,
  prefix: string,
): TransformationContext {
  const { operation, fragments } = originalArgs;
  const {
    operation: operationWithNewLabels,
    fragments: fragmentsWithNewLabels,
    originalLabels,
  } = addNewLabels(operation, fragments, prefix);

  const {
    objectFieldTransformers = {},
    pathScopedFieldTransformers = {},
    leafTransformers = {},
  } = transformers;

  const { variableValues, hideSuggestions } = originalArgs;

  return {
    superschema: originalArgs.schema,
    subschemas: keyMap(subschemas, (subschema) => subschema.label),
    operation: operationWithNewLabels,
    fragments: fragmentsWithNewLabels,
    fragmentsBySubschema: getFragmentsBySubschema(
      subschemas,
      fragmentsWithNewLabels,
      prefix,
    ),
    variableValues,
    hideSuggestions,
    originalArgs,
    originalLabels,
    objectFieldTransformers,
    pathSegmentRootNode: buildPathSegmentTree(pathScopedFieldTransformers),
    leafTransformers,
    deferPlanBuilder,
    prefix,
    mergedResult: new MergedResult(),
  };
}

function getFragmentsBySubschema(
  subschemas: ReadonlyArray<SubschemaConfig>,
  fragments: ObjMap<FragmentDetails>,
  prefix: string,
): ObjMap<ObjMap<FragmentDetails>> {
  const fragmentsBySubschema: ObjMap<ObjMap<FragmentDetails>> =
    Object.create(null);
  for (const subschema of subschemas) {
    const { label, schema } = subschema;
    const fragmentsForSubschema = Object.create(null);
    for (const fragmentName of Object.keys(fragments)) {
      const fragmentDetails = fragments[fragmentName];
      const definition = fragmentDetails.definition;
      const typeName = definition.typeCondition.name.value;
      const parentType = schema.getType(typeName) as GraphQLCompositeType;
      invariant(parentType != null);
      const transformedFragment = {
        ...fragmentDetails,
        definition: {
          ...definition,
          selectionSet: transformSelectionSetForTargetSubschema(
            definition.selectionSet,
            fragments,
            parentType,
            schema,
            prefix,
          ),
        },
      };
      fragmentsForSubschema[fragmentName] = transformedFragment;
    }
    fragmentsBySubschema[label] = fragmentsForSubschema;
  }
  return fragmentsBySubschema;
}

function buildPathSegmentTree(
  inputTransformers: ObjMap<FieldTransformer>,
): PathSegmentNode {
  const root: PathSegmentNode = {
    children: {},
  };
  for (const pathString of Object.keys(inputTransformers)) {
    const segments = pathString.split('.');
    let currentNode = root;
    for (const segment of segments) {
      const child = (currentNode.children[segment] ??= {
        children: {},
      });
      currentNode = child;
    }
    currentNode.fieldTransformer = inputTransformers[pathString];
  }
  return root;
}
