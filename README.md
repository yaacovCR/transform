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

- Configurable leaf transformers for modifying GraphQL results.
- Mapping from the latest incremental delivery format to the legacy format.

## Usage

### Configurable Leaf Transformers

Pass leafTransformers in a Transformers object to `transformResult()`.

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
