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

This library, primarily through its `transform()` export, provides several helpful functionalities for working with GraphQL results:

- **Result Composition:** Combine GraphQL results, including incremental delivery payloads (`@defer`/`@stream`), from multiple downstream GraphQL services into a single unified result. (Note: Composition is currently under development and primarily functional for root fields.)
- **Result Transformation:** Modify results using configurable transformers based on the leaf type, object field, or specific location within a GraphQL operation.
- **Legacy Incremental Format Mapping:** Convert results from the modern incremental delivery specification to the legacy format used in earlier `graphql-js` versions.

Notes:

- When multiple transformer types are applied to the same field, they execute in the following order: leaf value transformer -> object field transformer -> path-scoped field transformer.

- A separate `legacyExecuteIncrementally()` export is also available. It leverages the same underlying transformation logic but is specifically designed to provide backwards compatibility for the legacy incremental delivery format when interacting with a single GraphQL service (i.e., without composition).

## Usage

### Composition of GraphQL Results

To compose results from multiple GraphQL services, provide a `subschemas` array to `transform()`:

```ts
import { transform } from '@yaacovCR/transform';

const transformed = await transform({
  schema,
  document,
  variableValues,
  subschemas: [
    {
      label: 'Subschema1',
      subschema: new GraphQLSchema({ ... }),
      executor: myExecutor1,
    },
    {
      label: 'Subschema2',
      subschema: new GraphQLSchema({ ... }),
      executor: myExecutor1,
    },
  ],
});
```

### Transformation of GraphQL Results

## Configurable Leaf Transformers

To apply transformations to specific leaf types (scalars or enums), pass `leafTransformers` to `transform()`:

```ts
import { transform } from '@yaacovCR/transform';

const transformed = await transform({
  schema,
  document,
  variableValues,
  subschemas,
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

## Configurable Object Field Transformers

To apply transformations to specific fields within object types, pass `objectFieldTransformers` to `transform()`, namespaced by type name and field name:

```ts
import { transform } from '@yaacovCR/transform';

const transformed = await transform({
  schema,
  document,
  variableValues,
  subschemas,
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

## Configurable Path-Scoped Field Transformers

To apply transformations based on a field's specific location within the operation, pass `pathScopedFieldTransformers` to `transform()`. The keys are period-delimited paths reflecting the field structure in the operation (numeric list indices are omitted).

```ts
import { transform } from '@yaacovCR/transform';

const transformed = await transform({
  schema,
  document,
  variableValues,
  subschemas,
  objectFieldTransformers: {
    'someType.someFieldNameOrAlias': (value) => 'transformed',
  },
});
```

### Legacy Incremental Delivery Format

If you need to interact with systems expecting the older incremental delivery format (from `graphql-js` pre-v17), you can enable conversion:

```ts
import { transform } from '@yaacovCR/transform';

const result = await transform({
  schema,
  document,
  variableValues,
  subschemas,
  legacyIncremental: true,
});
```

Alternatively, if you are working with a single GraphQL service (no composition) and need the legacy format, the `legacyExecuteIncrementally()` function provides a dedicated interface:

```ts
import { legacyExecuteIncrementally } from '@yaacovCR/transform';

const result = await legacyExecuteIncrementally({
  schema,
  document,
  variableValues,
  operationName,
  rootValue,
  contextValue,
  fieldResolver,
  typeResolver,
  subscribeFieldResolver,
  perEventExecutor,
  enableEarlyExecution,
  hideSuggestions,
  abortSignal,
});
```

### Changelog

Changes are tracked as [GitHub releases](https://github.com/yaacovCR/transform/releases).

### License

@yaacovcr/transform is [MIT-licensed](./LICENSE).
