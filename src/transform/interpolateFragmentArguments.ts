import type {
  DocumentNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  NameNode,
  OperationDefinitionNode,
  ValueNode,
  VariableDefinitionNode,
  VariableNode,
} from 'graphql';
import { Kind, print, visit } from 'graphql';

/**
 * Transforms a GraphQL DocumentNode by inlining fragment arguments
 * for compatibility with versions that don't support fragment spread args.
 */
export function interpolateFragmentArguments(
  document: DocumentNode,
): DocumentNode {
  const fragments = extractFragmentDefinitions(document);
  const operations = extractOperations(document);
  const fragmentVarDefs = buildFragmentVarDefMap(fragments);

  const interpolatedFragments: Array<FragmentDefinitionNode> = [];
  const nameCache = new Map<string, string>();
  const inFlight = new Set<string>();
  const replaced = new Set<string>();
  const interpolatedFragmentCounters = new Map<string, number>();
  const missingVariableCounters = new Map<string, number>();
  const usedVariableCounters = new Map<string, number>();

  const getUniqueFragmentName = (base: string): string => {
    const idx = interpolatedFragmentCounters.get(base) ?? 0;
    interpolatedFragmentCounters.set(base, idx + 1);
    return `${base}_interpolated_${idx}`;
  };

  const getMissingVariableName = (base: string): string => {
    const idx = missingVariableCounters.get(base) ?? 0;
    missingVariableCounters.set(base, idx + 1);
    return `missing_fragment_variable_${base}_${idx}`;
  };

  const cacheKey = (
    fragmentName: string,
    argMap: Map<string, ValueNode>,
  ): string => {
    const entries = [...argMap.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return (
      fragmentName +
      '__' +
      entries.map(([k, v]) => `${k}:${print(v)}`).join(';')
    );
  };

  /**
   * Resolves a fragment spread's arguments, inlining literals,
   * drilling into lists/objects to replace nested variables,
   * falling back to fragment defaults,
   * and otherwise generating explicit nulls.
   */
  function resolveFragmentSpreadArguments(
    spread: FragmentSpreadNode,
    parentMap: Map<string, ValueNode>,
    newOpVarDefs: Array<VariableDefinitionNode>,
  ): Map<string, ValueNode> {
    const varDefMap = fragmentVarDefs.get(spread.name.value);
    const argMap = new Map<string, ValueNode>();
    if (!varDefMap) {
      return argMap;
    }
    for (const [name, vd] of varDefMap.entries()) {
      const argNode = spread.arguments?.find((a) => a.name.value === name);
      if (argNode) {
        const inlined = inlineVariables(argNode.value, parentMap);
        argMap.set(name, inlined);
      } else if (vd.defaultValue) {
        argMap.set(name, vd.defaultValue as ValueNode);
      } else {
        const newVarNameStr = getMissingVariableName(name);
        const newVariableNode: VariableNode = {
          kind: Kind.VARIABLE,
          name: mkName(newVarNameStr),
        };
        const newVarDef: VariableDefinitionNode = {
          kind: Kind.VARIABLE_DEFINITION,
          variable: newVariableNode,
          type: vd.type,
        };
        newOpVarDefs.push(newVarDef);
        argMap.set(name, newVariableNode);
      }
    }
    return argMap;
  }

  function incrementUsedVariables(node: ValueNode): void {
    if (node.kind === Kind.VARIABLE) {
      const name = node.name.value;
      const idx = usedVariableCounters.get(name) ?? 0;
      usedVariableCounters.set(name, idx + 1);
    } else if (node.kind === Kind.LIST) {
      for (const item of node.values) {
        incrementUsedVariables(item);
      }
    } else if (node.kind === Kind.OBJECT) {
      for (const field of node.fields) {
        incrementUsedVariables(field.value);
      }
    }
  }

  function buildFragment(
    name: string,
    argMap: Map<string, ValueNode>,
    newOpVarDefs: Array<VariableDefinitionNode>,
  ): string {
    const orig = fragments.get(name);
    const fragmentVariableDefinitions = orig?.variableDefinitions;
    if (
      !fragmentVariableDefinitions ||
      fragmentVariableDefinitions.length === 0
    ) {
      return name;
    }

    const key = cacheKey(name, argMap);
    if (inFlight.has(name)) {
      return name;
    }

    const cached = nameCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    inFlight.add(name);

    const newSelectionSet = visit(orig.selectionSet, {
      [Kind.VARIABLE]: (node: VariableNode) => {
        const valueNode = argMap.get(node.name.value);
        if (valueNode === undefined) {
          incrementUsedVariables(node);
          return;
        }
        incrementUsedVariables(valueNode);
        return valueNode;
      },
      [Kind.FRAGMENT_SPREAD]: (node: FragmentSpreadNode) => {
        const nestedArgs = resolveFragmentSpreadArguments(
          node,
          argMap,
          newOpVarDefs,
        );
        const childName = buildFragment(
          node.name.value,
          nestedArgs,
          newOpVarDefs,
        );
        return {
          ...node,
          name: mkName(childName),
          arguments: [],
        };
      },
    });

    const freshName = getUniqueFragmentName(name);
    interpolatedFragments.push({
      ...orig,
      name: mkName(freshName),
      variableDefinitions: [],
      selectionSet: newSelectionSet,
    });

    inFlight.delete(name);
    nameCache.set(key, freshName);
    replaced.add(name);
    return freshName;
  }

  const rewrittenOps = operations.map((originalOp) => {
    const newOpVarDefs: Array<VariableDefinitionNode> = [];

    const visitedOp = visit(originalOp, {
      [Kind.FRAGMENT_SPREAD]: (node: FragmentSpreadNode) => {
        const args = resolveFragmentSpreadArguments(
          node,
          new Map<string, ValueNode>(),
          newOpVarDefs,
        );
        const fragName = buildFragment(node.name.value, args, newOpVarDefs);
        return {
          ...node,
          name: mkName(fragName),
          arguments: [],
        };
      },
    });

    const originalOpVarDefs = originalOp.variableDefinitions ?? [];
    const finalOpVarDefs = [
      ...originalOpVarDefs,
      ...newOpVarDefs.filter((vd) => {
        const count = usedVariableCounters.get(vd.variable.name.value);
        return count !== undefined && count > 0;
      }),
    ];

    return {
      ...visitedOp,
      variableDefinitions:
        finalOpVarDefs.length > 0 ? finalOpVarDefs : undefined,
    };
  });

  const leftoverFragments = document.definitions.filter(
    (def): def is FragmentDefinitionNode =>
      def.kind === Kind.FRAGMENT_DEFINITION && !replaced.has(def.name.value),
  );

  return {
    ...document,
    definitions: [
      ...rewrittenOps,
      ...leftoverFragments,
      ...interpolatedFragments,
    ],
  };
}

function extractFragmentDefinitions(
  document: DocumentNode,
): Map<string, FragmentDefinitionNode> {
  const map = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      map.set(def.name.value, def);
    }
  }
  return map;
}

function extractOperations(
  document: DocumentNode,
): Array<OperationDefinitionNode> {
  return document.definitions.filter(
    (def) => def.kind === Kind.OPERATION_DEFINITION,
  );
}

function buildFragmentVarDefMap(
  fragments: Map<string, FragmentDefinitionNode>,
): Map<string, Map<string, VariableDefinitionNode>> {
  const map = new Map<string, Map<string, VariableDefinitionNode>>();
  for (const [name, frag] of fragments) {
    const varMap = new Map<string, VariableDefinitionNode>();
    for (const vd of frag.variableDefinitions ?? []) {
      varMap.set(vd.variable.name.value, vd);
    }
    map.set(name, varMap);
  }
  return map;
}

function mkName(name: string): NameNode {
  return { kind: Kind.NAME, value: name };
}

/**
 * Recursively inline any VariableNodes inside a ValueNode using parentMap,
 * preserving lists, objects, and other literal types.
 */
function inlineVariables(
  valueNode: ValueNode,
  parentMap: Map<string, ValueNode>,
): ValueNode {
  switch (valueNode.kind) {
    case Kind.VARIABLE: {
      const mapped = parentMap.get(valueNode.name.value);
      return mapped ?? valueNode;
    }
    case Kind.LIST:
      return {
        ...valueNode,
        values: valueNode.values.map((v) => inlineVariables(v, parentMap)),
      };
    case Kind.OBJECT:
      return {
        ...valueNode,
        fields: valueNode.fields.map((f) => ({
          ...f,
          value: inlineVariables(f.value, parentMap),
        })),
      };
    default:
      return valueNode;
  }
}
