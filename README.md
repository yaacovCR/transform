# @yaacovcr/transform

## Installation

Using npm:

```
npm install @yaacovCR/transform graphql@17.0.0-alpha.8
```

Using yarn:

```
yarn add @yaacovCR/transform graphql@17.0.0-alpha.8
```

Using pnpm:

```
pnpm add @yaacovCR/transform graphql@17.0.0-alpha.8
```

## Overview

This library offers:

- Configurable synchronous leaf value transformers, object field transformers, and path-scoped field transformers for modifying GraphQL results.
- Configurable synchronous/asynchronous extenders of object values with additional GraphQL results.
- Mapping from the latest incremental delivery format to the legacy format.

Note: In the case of multiple transformers, execution is in the above order: first any leaf value transformer is executed, followed by any object field transformer, and then the path-scoped field transformer.

## Usage

### Configurable Leaf Transformers

Pass `leafTransformers` in a `Transformers` object to `transformResult()`.

```ts
import { transformResult } from '@yaacovCR/transform';

const originalResult = await experimentalExecuteIncrementally({
  schema,
  document,
  rootValue,
  contextValue,
  variableValues,
});

const transformed = await transformResult(originalResult, {
  leafTransformers: {
    Color: (value) => (value === 'GREEN' ? 'DARK_GREEN' : value),
  },
});
```

The signature is as follows:

```ts
type LeafTransformers = ObjMap<LeafTransformer>;

type LeafTransformer = (
  value: unknown,
  type: GraphQLLeafType,
  path: Path,
) => unknown;
```

### Configurable Object Field Transformers

Pass `objectFieldTransformers` in a `Transformers` object to `transformResult()`, namespaced by type and field.

```ts
import { transformResult } from '@yaacovCR/transform';

const originalResult = await experimentalExecuteIncrementally({
  schema,
  document,
  rootValue,
  contextValue,
  variableValues,
});

const transformed = await transformResult(originalResult, {
  objectFieldTransformers: {
    SomeType: {
      someField: (value) => 'transformed',
    },
  },
});
```

The signature is as follows:

```ts
type ObjectFieldTransformers = ObjMap<ObjMap<FieldTransformer>>;

type FieldTransformer = (
  value: unknown,
  field: GraphQLField,
  path: Path,
) => unknown;
```

### Configurable Path Scoped Field Transformers

Pass `pathScopedFieldTransformers` in a `Transformers` object to `transformResult()`, keyed by a period-delimited path to the given field within the operation. (Numeric indices for list fields are simply skipped, reflecting the path within the given operation rather than the result.)

```ts
import { transformResult } from '@yaacovCR/transform';

const originalResult = await experimentalExecuteIncrementally({
  schema,
  document,
  rootValue,
  contextValue,
  variableValues,
});

const transformed = await transformResult(originalResult, {
  objectFieldTransformers: {
    'someType.someFieldNameOrAlias': (value) => 'transformed',
  },
});
```

### Configurable Path Scoped Object Extenders

Pass `pathScopedObjectBatchExtenders` in a `Transformers` object to `transformResult()`, keyed by a period-delimited path to the given field within the operation as well as the type of object. (If the field is of abstract type, the type may vary, and you can specify how to extend the object value for each possible type.)

```ts
import { transformResult } from '@yaacovCR/transform';

const originalResult = await experimentalExecuteIncrementally({
  schema,
  document,
  rootValue,
  contextValue,
  variableValues,
});

const transformed = await transformResult(originalResult, {
  pathScopedObjectBatchExtenders: {
    someType.someField: {
      SomeField: (objects) =>
        objects.map(() => ({
          data: { additionalField: 'additionalField' },
        })),
    },
  },
});
```

The signature is as follows:

```ts
type PathScopedObjectBatchExtenders = ObjMap<ObjMap<ObjectBatchExtender>>;

export type ObjectBatchExtender = (
  objects: ReadonlyArray<ObjMap<unknown>>,
  type: GraphQLObjectType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
) => PromiseOrValue<ReadonlyArray<ExecutionResult>>;
```

### Legacy Incremental Delivery Format

Convert from the the latest incremental delivery format to the legacy format:

```ts
import { legacyExecuteIncrementally } from '@yaacovCR/transform';

const result = await legacyExecuteIncrementally({
  schema,
  document,
  rootValue,
  contextValue,
  variableValues,
});
```

### Changelog

Changes are tracked as [GitHub releases](https://github.com/yaacovCR/transform/releases).

### License

@yaacovcr/transform is [MIT-licensed](./LICENSE).
