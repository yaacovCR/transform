# @yaacovcr/transform

## 0.0.7

### Patch Changes

- d26e9ed: Switch from filtering of root fields to actual routing.

  Each root field will now be sent to at most one subschema.

## 0.0.6

### Patch Changes

- a359146: Add initial functionality for composition of subschemas, i.e. stitching.

  This functionality will supplant object extension.

- a359146: Change main export to `transform` from `transformResult`.

  Instead of processing an existing result, the function delegates the request directly to the underlying service using a gateway-style approach.

- 61b888a: Remove path-scoped object extenders.

  While workable for non-incremental requests, API for modifying existing deferred fragments would be quite complex.

## 0.0.5

### Patch Changes

- 070dac0: Add path-scoped field transformers and path-scoped object extenders.

## 0.0.4

### Patch Changes

- 17ddd66: Add ability to transform field values
- 17ddd66: Switch graphql to peer dependency

## 0.0.3

### Patch Changes

- 13dbde4: Support transformation of incremental GraphQL results utilizing either new and legacy formats
- 13dbde4: Add ability to transform leaf values based on the type

## 0.0.2

### Patch Changes

- 39fcf37: Add source map support
- 6d3d2f6: Remove inlining

  This change is a necessary precondition for adding potentially async transformations of the initial and subsequent results.

## 0.0.1

### Patch Changes

- fd4b1e0: initial release
