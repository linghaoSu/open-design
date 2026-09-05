import type {
  ComponentRegistry,
  JsonValue,
  ValidationDiagnostic,
} from '@open-design/contracts';

/** Internal input; persisted document envelopes are parsed by the contract schemas. */
export interface ComponentUsage {
  component: string;
  props: Record<string, JsonValue>;
  nodeId?: string;
}

/** Validates registry property values only; local components and slots are not resolved. */
export function validateComponentUsage(
  registry: ComponentRegistry,
  usage: ComponentUsage,
): ValidationDiagnostic[] {
  const context = {
    schemaVersion: 1 as const,
    severity: 'error' as const,
    componentRef: usage.component,
    ...(usage.nodeId === undefined ? {} : { nodeId: usage.nodeId }),
  };
  const matches = registry.components.filter(
    (component) => usage.component === `ds:${registry.id}/${component.id}`,
  );
  const component = matches.length === 1 ? matches[0] : undefined;
  if (!component) {
    return [{
      ...context,
      code: 'ODDS1001',
      message: `Component reference ${usage.component} does not resolve uniquely in registry ${registry.id}.`,
      path: ['component'],
    }];
  }

  const diagnostics: ValidationDiagnostic[] = [];
  for (const propName of Object.keys(usage.props).sort()) {
    const definition = Object.hasOwn(component.props, propName) ? component.props[propName] : undefined;
    const value = usage.props[propName];
    const path = ['props', propName];
    if (!definition) {
      diagnostics.push({
        ...context,
        code: 'ODDS1002',
        message: `Component ${component.id} has no property ${propName}.`,
        path,
      });
    } else if (definition.type === 'enum') {
      if (!definition.values.some((allowed) => allowed === value)) {
        diagnostics.push({
          ...context,
          code: 'ODDS1003',
          message: `Property ${propName} must be one of the declared enum values.`,
          path,
          allowedValues: [...definition.values],
        });
      }
    } else if (typeof value !== definition.type
      || (typeof value === 'number' && !Number.isFinite(value))) {
      diagnostics.push({
        ...context,
        code: 'ODDS1005',
        message: `Property ${propName} must be a ${definition.type}.`,
        path,
      });
    }
  }

  for (const propName of Object.keys(component.props).sort()) {
    const definition = component.props[propName];
    if (definition?.required && definition.default === undefined && !Object.hasOwn(usage.props, propName)) {
      diagnostics.push({
        ...context,
        code: 'ODDS1006',
        message: `Component ${component.id} requires property ${propName}.`,
        path: ['props', propName],
      });
    }
  }
  return diagnostics;
}
