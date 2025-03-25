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

- Configurable synchronous leaf value and object field transformers for modifying GraphQL results.
- Mapping from the latest incremental delivery format to the legacy format.

Planned:

- Asynchronous result transformers!

The synchronous object field transformers can be used to collect sites within the result that need to be updated asynchronously as a separate step. We should be able to provide a way to do this within the library that allows these sites to be scoped to the correct initial vs. incremental result so that any asynchronous work can be batched for each individual result.

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
  parent: ObjMap<unknown>,
  responseKey: string,
  path: Path,
) => unknown;
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
