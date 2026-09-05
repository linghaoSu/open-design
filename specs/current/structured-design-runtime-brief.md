# OpenDesign Fork — Structured Design Runtime Architecture & Implementation Plan

## 0. Purpose

This document defines the architecture and implementation plan for extending OpenDesign into a more deterministic, production-oriented AI design system.

The goal is NOT to replace OpenDesign's agent-driven design workflow or turn it immediately into another Figma/pen.dev clone.

The goal is to preserve OpenDesign's strengths:

* agent-native workflow
* DESIGN.md / skills / design intelligence
* real artifacts and real code
* support for multiple coding agents
* local-first project model

while adding a deterministic design runtime that provides:

* reusable component definitions and instances
* machine-readable component registries
* strong design-system constraints
* project-local reusable components
* component usage/reference tracking
* impact analysis before shared changes
* design-system versioning and lockfiles
* semantic design-system upgrades
* migration support
* persistent Design ↔ Code component bindings
* deterministic engineering handoff
* Explore / Guided / Strict design modes

The central principle is:

> Anything that can be structurally determined should not be re-inferred by an LLM on every run.

The AI should primarily understand intent, select, compose and reason.

The runtime should own identity, constraints, dependencies, versions, references and validation.

---

# 1. Product problem

Current agent-driven design systems are highly flexible, but flexibility creates instability when a mature design system already exists.

Typical failure modes include:

1. The agent creates a new visual implementation instead of reusing an existing component.

2. The agent creates slightly different copies of the same design in multiple screens.

3. Updating one shared visual pattern requires repeatedly asking the agent to modify every location.

4. The user cannot reliably know which screens will change when a shared component changes.

5. Design-system rules are interpreted semantically by the model rather than enforced structurally.

6. Design-system upgrades do not have a clear dependency/version model.

7. A design-system upgrade may silently invalidate components, variants, tokens or overrides.

8. Engineering handoff relies on the coding agent identifying components again from screenshots, HTML or descriptions.

9. The coding agent may implement an existing design-system component using custom markup instead of the real production component.

10. Design and code gradually drift because their relationship is inferred rather than persisted.

This fork should solve these problems with a structured design runtime.

---

# 2. Product positioning

The intended positioning is:

> OpenDesign provides Design Intelligence.
>
> This fork adds Design Structure, Governance and Traceability.

Conceptually:

```text
Design Intelligence
DESIGN.md / Skills / AI reasoning
               │
               ▼
       Design Planner
               │
               ▼
    Component Retrieval
               │
               ▼
         Semantic UI IR
               │
       ┌───────┴────────┐
       ▼                ▼
Component Registry   Pattern Registry
       │                │
       └───────┬────────┘
               ▼
        Design Grammar
               │
               ▼
       Constraint Engine
               │
               ▼
       Reference Graph
               │
               ▼
        Renderer / Code
               │
       ┌───────┴─────────┐
       ▼                 ▼
Design Preview      Code Handoff
```

Long term this should sit somewhere between:

```text
OpenDesign
    +
pen.dev-style structured design concepts
    +
Claude-Design-style code-aware workflow
```

without requiring a full vector-editor document model in the first iterations.

---

# 3. Non-goals

Do NOT start by implementing:

* a Figma-compatible vector engine
* arbitrary SVG/path editing
* absolute x/y based design representation
* full pixel-level Design ↔ Code synchronization
* multiplayer collaborative canvas infrastructure
* automatic two-way CSS synchronization
* a custom rendering engine for all web layouts
* a replacement for React/Vue component runtime

The initial IR should be semantic rather than graphical.

The real component implementation remains responsible for final pixels whenever possible.

---

# 4. Architecture rules

The implementation MUST respect existing OpenDesign architecture.

## 4.1 Daemon remains product authority

Business logic belongs in:

```text
apps/daemon
```

The Web UI must not introduce an independent browser-side implementation of registries, version resolution or validation.

The `od` CLI and Web UI should consume the same daemon services.

---

## 4.2 Canonical contracts belong in packages/contracts

Shared schemas and DTOs belong under:

```text
packages/contracts/src/
```

Do not create independent duplicated schemas in:

```text
apps/web
apps/daemon
```

The same canonical contract should be consumed by both.

---

## 4.3 Do not implement structural constraints as prompt instructions

Do NOT solve Strict Mode with:

```ts
systemPrompt += `
Never invent components.
Never use undeclared tokens.
...
`;
```

Prompt instructions may explain workflow requirements.

Actual legality must be determined by deterministic code.

Example:

```text
Agent:
Use validateDesign before implementation.

Runtime:
Button.variant="filled"
              ↓
actual registry validation
              ↓
OD1003 InvalidVariant
```

The runtime, not the model, decides whether a design is valid.

---

## 4.4 Preserve upstream compatibility where practical

Prefer additive packages and schemas.

Avoid heavily rewriting existing:

```text
components.manifest.json
```

Its existing role as a fixture-derived component/token inventory remains useful.

Introduce a new stronger registry rather than forcing the existing manifest to represent unrelated concepts.

---

# 5. Design modes

Projects should support three design modes.

## Explore

Purpose:

* greenfield exploration
* landing pages
* visual ideation
* experiments

Behavior:

```text
Agent freedom: high
Existing DS reuse: recommended
Creating new structures: allowed
Unknown component: allowed
Raw CSS: allowed
Validation: mostly advisory
```

This should remain close to current OpenDesign behavior.

---

## Guided

Purpose:

* products with an existing design system
* design-system evolution
* prototype work intended to become production

Behavior:

```text
Existing component reuse: strongly preferred
Unknown component: warning / requires explicit local component
Unknown token: error or warning by policy
Raw design literals: warning
Pattern reuse: preferred
Validation: repair loop enabled
```

New components may still be created intentionally.

---

## Strict

Purpose:

* mature applications
* enterprise products
* production UI implementation

Behavior:

```text
Unknown DS component       ERROR
Invalid prop               ERROR
Invalid variant            ERROR
Invalid slot composition   ERROR
Unknown token              ERROR
Forbidden raw CSS          ERROR
Reimplement bound control  ERROR
```

The agent should primarily:

```text
retrieve
compose
configure
```

instead of:

```text
invent
```

---

# 6. Core domain model

The runtime should eventually contain the following first-class concepts.

```text
DesignSystem
DesignSystemVersion
DesignSystemDependency
DesignSystemLock

ComponentDefinition
ComponentInstance
ComponentOverride

ProjectComponentDefinition

PatternDefinition

ComponentBinding
CodeComponentDefinition

UIIRDocument
UIIRNode

ReferenceGraph

ConstraintPolicy
ValidationDiagnostic

SemanticDiff
ImpactAnalysis
MigrationPlan

HandoffManifest
```

Stable identity is critical across all of these models.

---

# 7. Design System package

Retain the current OpenDesign package structure and extend it.

Target shape:

```text
design-systems/acme/

manifest.json
DESIGN.md
tokens.css

USAGE.md
components.html
components.manifest.json

assets/
fonts/
preview/
source/

# new structured runtime files

registry.json
patterns.json
grammar.json

bindings/
  react.json
  vue.json

constraints/
  explore.json
  guided.json
  strict.json

migrations/
  2.4.0-2.5.0.json
  2.5.0-3.0.0.json
```

The existing files continue to serve OpenDesign's current prompt/import/preview workflows.

The new files provide machine-enforceable contracts.

---

# 8. Component Registry

`registry.json` must describe real design components rather than CSS selectors.

Example:

```json
{
  "schemaVersion": 1,
  "components": [
    {
      "id": "cmp_button",
      "name": "Button",

      "props": {
        "variant": {
          "type": "enum",
          "values": [
            "primary",
            "secondary",
            "danger"
          ],
          "default": "primary"
        },

        "size": {
          "type": "enum",
          "values": [
            "sm",
            "md",
            "lg"
          ]
        },

        "disabled": {
          "type": "boolean"
        }
      },

      "slots": {
        "default": {
          "accepts": [
            "text",
            "icon"
          ]
        }
      },

      "states": [
        "default",
        "hover",
        "focus",
        "disabled",
        "loading"
      ]
    }
  ]
}
```

Important properties:

```text
stable component ID
display name
props
prop types
variants
slots
states
source provenance
code bindings
```

Do not use component display name as identity.

Example:

```text
v2.4:
id   = cmp_button
name = PrimaryButton

v2.5:
id   = cmp_button
name = Button
```

This must be recognized as a rename rather than delete + add.

---

# 9. Design System Compiler

Do not require users to manually maintain the full Component Registry.

Introduce a compiler/import pipeline:

```text
Existing codebase
       │
       ├── React components
       ├── Vue components
       ├── TypeScript types
       ├── Storybook
       ├── package exports
       ├── CSS/tokens
       └── documentation
               │
               ▼
       Design System Compiler
               │
               ▼
          registry.json
          bindings/*
          source evidence
```

Initial implementation priority:

```text
1. React + TypeScript
2. Storybook metadata
3. Vue + TypeScript
```

Possible extraction sources:

React:

```text
TypeScript AST
React prop types/interfaces
export declarations
default values
JSDoc
Storybook args/argTypes
```

Vue:

```text
defineProps<T>()
component metadata
slots
emits if useful
Storybook
```

Each inferred field should optionally contain provenance/confidence.

Example:

```json
{
  "source": "Button.stories.tsx",
  "confidence": 0.95
}
```

Prefer deterministic metadata extraction over AI inference.

AI inference should be a fallback.

---

# 10. Code Component Index

Introduce a project/repository-level Code Component Index.

Its job is to answer:

```text
What reusable UI components already exist in this codebase?
```

Example:

```text
CodeComponentDefinition

id
framework
package
export
source path
props
slots
variants
documentation
Storybook story
version
```

This index provides the code-side half of Design ↔ Code Binding.

Conceptually:

```text
Design Component Registry
              │
              │
         Binding Registry
              │
              ▼
     Code Component Index
```

---

# 11. Design ↔ Code Binding

A design component should persistently know which production code component it represents.

Do NOT defer this mapping until handoff.

Example:

```json
{
  "componentId": "cmp_button",

  "bindings": {
    "react": {
      "package": "@acme/ui",
      "export": "Button",
      "sourcePath": "src/components/Button.tsx"
    },

    "vue": {
      "package": "@acme/vue-ui",
      "export": "AcmeButton"
    }
  }
}
```

Bindings may also map semantic design props to implementation props.

Example:

```json
{
  "designProp": "tone",
  "codeProp": "intent",

  "values": {
    "primary": "primary",
    "danger": "destructive"
  }
}
```

Thus:

```text
Design

Button
tone=danger

       ↓ binding

React

<Button intent="destructive" />
```

The coding agent must not need to infer this mapping again.

---

# 12. Binding states

Bindings should expose lifecycle state.

Suggested states:

```text
unbound
candidate
bound
stale
broken
```

Meaning:

```text
unbound
No production component relationship exists.

candidate
A likely existing component has been discovered but not confirmed.

bound
A validated relationship exists.

stale
The source component/API changed since the binding was verified.

broken
The referenced code component/export/path no longer exists.
```

Agent-generated candidate mappings should retain confidence and provenance.

Example:

```json
{
  "status": "candidate",
  "confidence": 0.89,
  "source": "agent",
  "verified": false
}
```

Compiler-proven mappings may be automatically accepted when identity is deterministic.

---

# 13. Semantic UI IR

Introduce a lightweight Semantic UI IR.

Do NOT model pixels initially.

Example:

```json
{
  "type": "screen",
  "id": "applications",

  "children": [
    {
      "type": "component",
      "ref": "ds:PageHeader",
      "props": {
        "title": "Applications"
      }
    },

    {
      "type": "instance",
      "ref": "local:ApplicationCard",
      "overrides": {
        "props.title": "Production"
      }
    }
  ]
}
```

The IR describes:

```text
semantic hierarchy
component identity
props
slots
component instances
patterns
overrides
```

It should NOT initially describe:

```text
absolute x/y
vector paths
arbitrary pixel geometry
```

Initially the IR is an intermediate representation.

The existing React/Vue/project source remains the production source of truth.

Do not attempt persistent round-trip synchronization in the first version.

---

# 14. Shared Component Definition / Instance model

The project needs real reusable components.

Incorrect model:

```text
Screen A
  copied card

Screen B
  copied card

Screen C
  copied card
```

Correct model:

```text
              ProjectSummaryCard
                 Definition
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       Instance   Instance   Instance
          A          B          C
```

Instances store overrides only.

Example:

```json
{
  "type": "instance",
  "ref": "local:project-summary-card",

  "overrides": {
    "props.title": "Production",
    "props.status": "healthy"
  }
}
```

Inherited values should not be duplicated in the instance.

---

# 15. Project-local reusable components

Distinguish:

```text
Design System Components
```

from:

```text
Project Components
```

Examples:

Design System:

```text
Button
Card
Select
Dialog
Table
Tabs
```

Project:

```text
ApplicationHealthCard
ClusterSummary
ResourceStatusPanel
```

The agent should eventually be able to detect repeated structures:

```text
This pattern appears in 4 places.

Extract as reusable component?

[Extract]
[Ignore]
```

A project component may later be promoted into an organizational Design System.

Target lifecycle:

```text
Repeated structure
       ↓
Project Component
       ↓
Project-wide reuse
       ↓
Optional promotion
       ↓
Design System Component
```

---

# 16. Overrides

Component instances inherit Definition state.

Only explicitly changed values are stored as overrides.

Example:

```text
Definition

title color = text.primary

Instance

title color = warning
             ↑
           override
```

If Definition changes:

```text
text.primary
   ↓
text.secondary
```

the overridden instance remains:

```text
warning
```

UI must support:

```text
Reset to component
```

Invalid overrides must be detected during design-system/component upgrades.

---

# 17. Reference Graph

Introduce a first-class Reference Graph.

Do NOT calculate usage by repeatedly searching generated HTML.

The graph represents dependencies such as:

```text
ds:Button
      ↑
local:ApplicationCard
      ↑
screen:Applications

ds:Button
      ↑
local:ApplicationCard
      ↑
screen:Dashboard
```

Primary operations:

```text
find direct usages
find transitive usages
find affected screens
find dependency chain
detect safe deletion
detect upgrade impact
```

This enables:

```text
Find usages
Impact analysis
Delete safety
Change preview
Refactoring
Upgrade analysis
Handoff traceability
```

Reference Graph queries should be deterministic.

---

# 18. Shared component editing

Editing a shared Component Definition must clearly communicate that the change is global.

Example UI:

```text
ProjectSummaryCard
Shared component

17 instances
6 screens

[View usages]
```

When the component is edited:

```text
Editing shared component

This change affects:

17 instances
6 screens

[Preview affected screens]
[Publish changes]
```

Avoid silently applying a change while giving the impression that only the currently visible instance is being modified.

---

# 19. Staged shared changes

Prefer a staged model:

```text
Edit definition
      ↓
Draft revision
      ↓
Reference Graph impact analysis
      ↓
Preview
      ↓
Publish revision
```

Project-local component definitions may maintain simple revisions:

```text
revision 17
revision 18
```

Full SemVer is not required for project-local components initially.

This enables:

```text
history
preview
undo
change impact
```

---

# 20. Impact Preview

Before applying a shared component change, calculate affected usage.

Example:

```text
Updating ProjectSummaryCard

17 instances will change
6 screens affected

Applications          6
Application Detail    3
Projects              4
Dashboard              2
Settings               2

[Preview]
[Apply]
```

Preview should preferably render representative affected screens.

MVP visual mode:

```text
Current | Proposed
```

Later modes may include:

```text
overlay
swipe
pixel diff
```

Reference Graph must determine affected screens.

Do not depend on the LLM to guess what is affected.

---

# 21. Delete semantics

Deleting a referenced component must not silently break instances.

If references exist:

```text
Cannot safely delete ProjectSummaryCard.

12 instances depend on this component.
```

Possible actions:

```text
Replace references
Detach instances
Delete component and instances
Cancel
```

`Detach` materializes the current inherited component tree into standalone nodes.

Detach should be discouraged.

Strict Mode may forbid detaching Design System components.

---

# 22. Design Grammar

Registry answers:

```text
What components exist?
```

Grammar answers:

```text
How may they be composed?
```

Example:

```json
{
  "component": "Dialog",

  "slots": {
    "header": {
      "allowed": [
        "DialogTitle",
        "DialogDescription"
      ]
    },

    "body": {
      "allowed": [
        "Form",
        "Stack",
        "Text"
      ]
    },

    "footer": {
      "allowed": [
        "Button",
        "ButtonGroup"
      ]
    }
  }
}
```

Invalid composition should produce deterministic validation diagnostics.

Grammar should remain distinct from prose design principles in DESIGN.md.

---

# 23. Pattern Registry

Mature product layouts should also be reusable.

Examples:

```text
ResourceList
ResourceDetail
SettingsPage
FormPage
Dashboard
Wizard
EmptyState
```

Example:

```text
ResourceList

PageHeader
   ↓
Toolbar
   ↓
FilterBar
   ↓
DataTable
   ↓
Pagination
```

Agent flow becomes:

```text
Understand page intent
       ↓
Retrieve pattern
       ↓
Configure slots
```

instead of redesigning mature page structure each time.

---

# 24. Constraint Engine

Separate semantic rules from deterministic rules.

## Semantic / soft rules

Remain in:

```text
DESIGN.md
```

Example:

```text
Prefer dense layouts.
Avoid unnecessary decoration.
Primary CTA should dominate.
```

## Machine / hard rules

Stored in structured policy.

Example:

```json
{
  "unknownComponents": "error",
  "unknownProps": "error",
  "invalidVariants": "error",

  "tokens": {
    "undeclared": "error"
  },

  "rawCss": {
    "colors": "error",
    "radius": "error",
    "spacing": "warning"
  },

  "interactiveHtml": {
    "customControlsWhenBoundComponentExists": "error"
  }
}
```

---

# 25. Validation diagnostics

Introduce stable diagnostic codes.

Example namespace:

```text
ODDS1001 UnknownComponent
ODDS1002 UnknownProp
ODDS1003 InvalidVariant
ODDS1004 InvalidSlotComposition

ODDS2001 UnknownToken
ODDS2002 ForbiddenRawColor
ODDS2003 ForbiddenRawSpacing

ODDS3001 BrokenBinding
ODDS3002 StaleBinding
ODDS3003 ReimplementedBoundComponent

ODDS4001 InvalidOverride
ODDS4002 DanglingComponentReference

ODDS5001 DesignSystemVersionMismatch
ODDS5002 BreakingUpgradeWithoutMigration
```

Diagnostics should be structured.

Example:

```json
{
  "code": "ODDS1003",
  "nodeId": "save-button",

  "message": "Button variant 'filled' does not exist.",

  "allowedValues": [
    "primary",
    "secondary",
    "danger"
  ],

  "suggestedFix": {
    "variant": "primary"
  }
}
```

Repair loops should operate on diagnostics rather than vague natural-language critique.

---

# 26. Design System versioning

A Design System version must be immutable once published.

Example:

```text
acme-ui@2.4.0
acme-ui@2.4.1
acme-ui@2.5.0
acme-ui@3.0.0
```

Use SemVer-like semantics.

Patch:

```text
non-contract visual bugfix
documentation
safe corrections
```

Minor:

```text
new component
new token
new backward-compatible variant
new pattern
```

Major:

```text
removed prop
removed token
removed component
removed variant
incompatible slot contract
```

The runtime may eventually suggest a version bump based on Semantic Diff.

---

# 27. Project dependency and lock model

Borrow the mental model from package managers.

Project declares intent:

```json
{
  "dependencies": {
    "acme-ui": "^2.4.0"
  }
}
```

Lockfile resolves exact version:

```json
{
  "acme-ui": {
    "version": "2.4.3",
    "digest": "sha256:...",
    "source": {
      "type": "github",
      "commit": "abc123"
    }
  }
}
```

Design rendering must resolve against the lock.

Opening the same project tomorrow must not silently change its design-system version.

---

# 28. Component references should not include resolved DS version

Do NOT store:

```text
acme-ui@2.4.3/Button
```

in every node.

Store:

```text
ds:Button
```

and resolve through project dependency state:

```text
ds:Button
      ↓
acme-ui
      ↓
design-system.lock
      ↓
2.4.3
```

A DS upgrade therefore changes dependency resolution rather than rewriting every component instance.

---

# 29. Semantic Design System Diff

Design-system upgrades must not be represented only as textual file diffs.

Produce semantic changes.

Example:

```text
Tokens

spacing.card
16px → 20px


Components

Button
+ variant ghost

Select
- prop bordered
+ prop appearance


Breaking

Button.variant=text removed

Dialog.footer slot contract changed
```

The diff engine must use stable component/token identities.

---

# 30. Upgrade Impact Analysis

Combine Semantic Diff with Reference Graph.

Example:

```text
Acme UI
2.4.3 → 3.0.0

3 breaking changes
12 affected instances
5 affected screens

Button.variant=text removed

8 affected design instances

Applications     3
Projects         2
Settings         2
Dashboard        1
```

If Code Bindings exist, include production code impact as well:

```text
11 code usages affected
7 source files
```

---

# 31. Migration definitions

Design-system packages may provide deterministic migrations.

Example:

```json
{
  "from": "2.x",
  "to": "3.0.0",

  "rules": [
    {
      "component": "Button",
      "prop": "variant",

      "map": {
        "text": "ghost"
      }
    },

    {
      "component": "Select",

      "renameProp": {
        "bordered": "appearance"
      },

      "valueMap": {
        "true": "outline",
        "false": "plain"
      }
    }
  ]
}
```

Upgrade workflow:

```text
Semantic Diff
      ↓
Migration Rules
      ↓
Transform UI IR
      ↓
Validate
      ↓
Impact Preview
      ↓
Apply
```

Use the LLM only for ambiguous cases where no deterministic migration exists.

---

# 32. Design System Upgrade UX

Treat design-system upgrades similarly to dependency-update review.

Example:

```text
Acme UI

2.4.3 → 2.5.0

12 token changes
3 component changes
1 pattern change
0 breaking changes

[Review upgrade]
```

Review screen:

```text
Overview
   ↓
Semantic Diff
   ↓
Affected components
   ↓
Affected screens
   ↓
Current / New visual preview
   ↓
Migration plan
   ↓
Apply upgrade
```

Do not silently upgrade.

---

# 33. Handoff Manifest

Engineering handoff should produce a machine-readable contract.

Do not make screenshots or generated HTML the primary handoff contract.

Suggested shape:

```text
design/

design-system.json
design-system.lock

screens/
  applications.ui.json

components/
  application-card.json

handoff/
  manifest.json
```

Example:

```json
{
  "schemaVersion": "design-handoff/v1",

  "designSystem": {
    "id": "acme-ui",
    "version": "4.2.1"
  },

  "target": {
    "framework": "react"
  },

  "screens": [
    {
      "id": "applications",
      "design": "screens/applications.ui.json"
    }
  ],

  "bindings": [
    {
      "designComponent": "ds:Button",

      "code": {
        "package": "@acme/ui",
        "export": "Button"
      }
    },

    {
      "designComponent": "local:ApplicationCard",

      "code": {
        "path": "src/components/ApplicationCard.tsx",
        "export": "ApplicationCard"
      }
    }
  ]
}
```

---

# 34. Coding Agent handoff behavior

Coding Agent should receive:

```text
Handoff Manifest
UI IR
Component Registry
Binding Registry
Design System Lock
Semantic Change Set
Target repository context
Visual screenshots
```

Screenshots are visual evidence, not the primary structural contract.

The coding agent should be instructed to:

```text
Read the handoff manifest first.

Use declared component bindings.

Do not recreate a bound component using custom markup.

Respect the locked Design System version.

Reuse existing local/project components whenever a binding exists.

Validate implementation against design contracts before finishing.
```

---

# 35. Project Component → Code binding lifecycle

A project component may initially have no implementation.

Example:

```text
ApplicationCard

Design        ✓
Code Binding  —
```

At handoff, the Coding Agent creates:

```text
src/components/ApplicationCard.tsx
```

The resulting binding should be persisted:

```json
{
  "id": "local:application-card",

  "binding": {
    "status": "bound",

    "react": {
      "path": "src/components/ApplicationCard.tsx",
      "export": "ApplicationCard"
    }
  }
}
```

Future design runs now know this component already exists in production.

Do not recreate it.

---

# 36. Version compatibility between design and code packages

A design system may declare compatible production packages.

Example:

```json
{
  "id": "acme",
  "version": "4.2.0",

  "codeBindings": {
    "react": {
      "package": "@acme/ui",
      "version": "^4.2.0"
    }
  }
}
```

The project can check:

```text
Design System      4.2.x
Code Component Lib 4.2.x

Compatible
```

or:

```text
Design System      5.0
Code Component Lib 4.2

VERSION MISMATCH
```

The mismatch should be visible during design and handoff.

---

# 37. Reverse drift detection

Later, Code Index changes should be able to mark Design Bindings stale.

Example:

```text
ApplicationCard.tsx changed
          ↓
Code Index refresh
          ↓
public API changed
          ↓
Binding marked stale
          ↓
Design impact available
```

Do not initially attempt automatic pixel synchronization.

Synchronize semantic contracts:

```text
identity
props
variants
slots
tokens
composition
bindings
```

not raw CSS geometry.

---

# 38. Agent-facing operations

Eventually expose runtime capabilities such as:

```text
search_components(query)
get_component(id)

search_patterns(query)
get_pattern(id)

find_code_components(query)
get_component_binding(id)

get_component_usages(id)
get_affected_screens(id)

validate_design(document)
validate_artifact(path)

get_design_system_version()
get_design_system_diff(from, to)

create_handoff()
```

Initial implementation does not require custom MCP.

Prefer first exposing these through daemon + `od` CLI.

Example:

```bash
od ds component search button

od ds component inspect Button

od design validate design/screens/applications.ui.json

od design usages local:ApplicationCard

od ds diff acme-ui@2.4.0 acme-ui@3.0.0
```

External agents such as Codex / Claude Code / OpenCode can use this interface.

MCP can wrap the same services later.

---

# 39. Proposed package/module structure

Prefer additive architecture.

```text
packages/

  contracts/
    src/
      design-runtime/
        component-registry.ts
        component-binding.ts
        design-grammar.ts
        design-pattern.ts

        ui-ir.ts
        reference-graph.ts

        design-system-version.ts
        design-system-diff.ts
        migration.ts

        validation.ts
        handoff.ts

  design-runtime/
    src/

      compiler/
        react.ts
        vue.ts
        storybook.ts
        tokens.ts

      registry/
        component-registry.ts
        code-component-index.ts
        search.ts

      binding/
        resolver.ts
        validator.ts

      grammar/
        validator.ts

      ir/
        parser.ts
        normalize.ts

      graph/
        reference-graph.ts
        impact-analysis.ts

      versioning/
        resolver.ts
        diff.ts
        migration.ts

      validation/
        component-validator.ts
        token-validator.ts
        grammar-validator.ts
        binding-validator.ts

      handoff/
        manifest.ts

      renderer/
        react.ts
        vue.ts
        html.ts
```

Daemon integrations:

```text
apps/daemon/src/

services/
  design-runtime/

routes/
  design-runtime.ts
```

Web surfaces eventually live under:

```text
apps/web/src/
```

but Web should consume daemon contracts rather than duplicate runtime logic.

---

# 40. Suggested Web product surfaces

## Design System detail

Show:

```text
Overview
Tokens
Components
Patterns
Bindings
Versions
Constraints
Coverage
```

Example:

```text
Components      47
Bound to code   42
Patterns         8
Tokens          84

Strict readiness
92%

Warnings

3 components missing state metadata
2 components missing bindings
1 broken binding
```

---

## Component detail

Show:

```text
Button

Source
Design System / Acme UI

Props
Variants
Slots
States

Code Bindings
React  @acme/ui → Button

Usages
37 instances
11 screens

History
```

---

## Shared Project Component

Show:

```text
ApplicationCard
Project Component

18 instances
6 screens

Code Binding
src/components/ApplicationCard.tsx

Revision
18

[View usages]
[Edit component]
```

---

## Design project mode

Show:

```text
Design mode

Explore
Guided
Strict
```

---

# 41. Implementation roadmap

Do NOT implement everything at once.

Use the following dependency order.

---

## Phase 0 — Baseline and repository inspection

Before feature work:

1. Read root `AGENTS.md`.
2. Read relevant nested `AGENTS.md`.
3. Read:

   * `docs/architecture.md`
   * `docs/design-systems.md`
   * `docs/prompt-composition.md`
   * current design-system schemas
4. Trace:

   * design-system discovery
   * project design-system selection
   * daemon prompt composition
   * design-system API
   * `od` CLI design-system APIs if present
5. Run existing tests before modifications.

Document current extension points before introducing new architecture.

Do not begin by editing prompts.

---

## Phase 1 — Core contracts

Implement canonical contracts only.

Add under:

```text
packages/contracts/src/design-runtime/
```

Initial schemas:

```text
ComponentDefinition
ComponentRegistry
ComponentBinding
CodeComponentDefinition

ComponentInstance
ComponentOverride

UIIRDocument
UIIRNode

ValidationDiagnostic
```

Requirements:

```text
stable IDs
schema version fields
runtime validation if project conventions support it
tests
serialization/deserialization tests
```

No UI required.

No LLM integration required.

This phase is deliberately boring.

It establishes the foundation.

---

## Phase 2 — Component Registry + React compiler MVP

Implement:

```text
React/TypeScript source
        ↓
Component compiler
        ↓
ComponentRegistry
```

Minimum extraction:

```text
export
component name
source path
props
required/optional
union/enum values
default values where reliable
```

Support a small fixture repository in tests.

Do not use LLM extraction for deterministic TypeScript information.

Acceptance example:

```tsx
type ButtonProps = {
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
};
```

must produce equivalent registry metadata.

---

## Phase 3 — Code Component Index + Binding MVP

Create Code Component Index from compiler results.

Support explicit binding:

```text
Design component
      ↔
Code component
```

Implement:

```text
bind
unbind
resolve
validate
```

No fuzzy AI binding required yet.

Acceptance:

```text
ds:Button
→ @acme/ui/Button
```

can be resolved deterministically.

---

## Phase 4 — Component Definition / Instance + Reference Graph

Add project-local Component Definitions.

Add Instance nodes that store only overrides.

Implement Reference Graph operations:

```text
add reference
remove reference
direct usages
transitive usages
affected screens
```

Acceptance test:

```text
ApplicationCard
→ Button

ApplicationsPage
→ ApplicationCard

Dashboard
→ ApplicationCard
```

Changing `Button` must identify:

```text
ApplicationCard
ApplicationsPage
Dashboard
```

without textual search.

---

## Phase 5 — Shared component change impact

Implement staged shared component revisions.

Before publishing a Definition change:

```text
calculate affected instances
calculate affected screens
return ImpactAnalysis
```

Initial UI may simply list affected screens.

Visual before/after preview may follow.

Acceptance:

Changing one shared definition updates all non-overridden instances.

No duplicated per-instance mutation should be required.

---

## Phase 6 — Design System dependency/version model

Implement:

```text
DesignSystemVersion
ProjectDesignSystemDependency
DesignSystemLock
```

Exact locked resolution is required.

Acceptance:

Opening the same project repeatedly resolves the same DS version until explicit upgrade.

No silent latest-version resolution.

---

## Phase 7 — Semantic Diff

Implement deterministic diff for:

```text
tokens
components
props
variants
slots
patterns when available
```

Use stable IDs.

Classify:

```text
added
removed
renamed
changed
breaking
```

Do not start with visual diff.

Acceptance:

Removing:

```text
Button.variant=text
```

must be reported as a semantic breaking change rather than generic JSON text change.

---

## Phase 8 — Upgrade Impact + migration

Connect:

```text
Semantic Diff
        +
Reference Graph
        +
Instance overrides
        ↓
Upgrade Impact
```

Detect:

```text
invalid variants
invalid props
removed components
removed tokens
invalid overrides
affected screens
```

Add deterministic migration schema and migration application.

---

## Phase 9 — Handoff Manifest

Implement machine-readable engineering handoff.

Handoff must include:

```text
design-system lock
target framework
UI IR
component bindings
project component bindings
affected/change context where applicable
```

Provide daemon/CLI API.

Coding Agent should no longer need to identify already-bound components from visual appearance.

---

## Phase 10 — Guided Mode

Integrate validators into generation workflow.

Keep normal code/artifact generation.

After generation:

```text
validate
   ↓
structured diagnostics
   ↓
agent repairs
```

This gives substantial benefit before full IR-driven Strict Mode.

---

## Phase 11 — Pattern Registry

Introduce reusable page/pattern contracts.

Agent should retrieve and configure patterns rather than freely redesigning mature product layouts.

---

## Phase 12 — Strict Mode + Semantic UI IR generation

Generation flow becomes:

```text
Intent
 ↓
Retrieve components/pattern
 ↓
Create UI IR
 ↓
Validate
 ↓
Render / modify source
 ↓
Validate source
 ↓
Runtime preview
```

Strict Mode must enforce structural constraints programmatically.

---

## Phase 13 — Visual Impact Preview

Add representative affected-screen rendering.

Start with:

```text
side-by-side
```

Potential later features:

```text
overlay
swipe
pixel diff
```

Visual validation should evaluate visual quality.

It should not replace deterministic structural validation.

---

# 42. Initial implementation scope for Codex

IMPORTANT:

Do NOT attempt the whole roadmap in one change.

The first implementation should be:

```text
Phase 1:
Core contracts

+

minimal Phase 2:
Component Registry compiler spike
```

Start by inspecting the current repository.

Propose file placement based on existing package conventions before introducing a new package.

The first PR/change should preferably contain:

```text
1. Component Registry contract
2. Component Binding contract
3. Semantic UI IR contract
4. ValidationDiagnostic contract
5. contract tests
6. a minimal React/TypeScript component extraction proof of concept
```

Do NOT add:

```text
Canvas
visual diff
Strict Mode UI
Design System upgrade UI
prompt rewrites
MCP server
```

in the first implementation.

---

# 43. First concrete acceptance fixture

Use a simple deterministic fixture.

Source:

```tsx
export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
}

export function Button(props: ButtonProps) {
  // fixture
}
```

Expected registry representation should capture:

```text
name        Button
export      Button

variant
  enum
  primary | secondary | danger

size
  enum
  sm | md | lg

disabled
  boolean
```

Then establish a Design Component binding:

```text
ds:test/Button
        ↕
fixture/Button
```

Validation should accept:

```json
{
  "component": "ds:test/Button",
  "props": {
    "variant": "primary"
  }
}
```

and reject:

```json
{
  "component": "ds:test/Button",
  "props": {
    "variant": "filled"
  }
}
```

with:

```text
ODDS1003 InvalidVariant
```

This fixture demonstrates the architectural direction without requiring product UI.

---

# 44. Testing strategy

Every structural subsystem should be testable without an LLM.

Required test categories:

```text
schema parsing
component extraction
binding resolution
registry validation
instance inheritance
override behavior
reference traversal
semantic diff
version resolution
migration transform
handoff serialization
```

LLM tests should be layered on top later.

Core correctness must not depend on model behavior.

---

# 45. Benchmark strategy

Before Guided/Strict mode work, create a small evaluation suite.

Representative tasks:

```text
resource list
resource detail
settings page
form
dialog
dashboard
empty state
error state
```

Track metrics such as:

```text
existing component reuse rate
unknown component count
raw style literal count
invalid token count
binding reuse rate
number of generated duplicate component structures
number of manual repair steps
variance across repeated generations
```

The objective is not only:

```text
looks good
```

but also:

```text
is repeatable
is structurally valid
reuses the product system
is easy to maintain
```

---

# 46. Design principles to preserve during implementation

## AI for intent, runtime for facts

Good:

```text
AI decides:
"This looks like a resource-list page."

Runtime decides:
"ResourceList pattern exists."
"These children are allowed."
"Button variant is invalid."
```

Bad:

```text
AI decides whether Button.variant is legal.
```

---

## Retrieve before create

Agent workflow should increasingly become:

```text
search
retrieve
compose
configure
```

Creation is fallback behavior.

---

## Bind once, reuse permanently

Once:

```text
Design Button
↔
@acme/ui/Button
```

is established, future agents should consume that fact.

Do not infer it on every handoff.

---

## References are identities, not copied markup

Shared component use must use references.

Never implement shared design components by copying rendered subtree content into every screen.

---

## Upgrades are explicit

No silent DS upgrade.

Every upgrade should have:

```text
version change
semantic diff
impact
migration
review
apply
```

---

## Semantic sync before pixel sync

Persist:

```text
component identity
props
variants
slots
tokens
patterns
bindings
```

Avoid attempting automatic pixel-level synchronization initially.

---

# 47. Desired end-state workflow

A mature workflow should eventually look like this:

```text
Existing product repository
          │
          ▼
Design System Compiler
          │
          ▼
Versioned Design System
          │
   ┌──────┴────────┐
   ▼               ▼
Component       Patterns
Registry
   │
   ▼
Code Bindings
   │
   ▼
Designer / Agent
   │
   ▼
Semantic UI IR
   │
   ├── DS components
   ├── project components
   └── component instances
          │
          ▼
    Reference Graph
          │
          ▼
      Design Preview
          │
          ▼
        Handoff
          │
          ▼
      Coding Agent
          │
          ▼
Uses exact bound production components
```

When a shared component changes:

```text
Edit component
      ↓
Reference Graph
      ↓
Affected instances/screens
      ↓
Preview
      ↓
Publish
```

When Design System upgrades:

```text
DS 2.4 → 3.0
      ↓
Semantic Diff
      ↓
Reference Graph
      ↓
Design Impact
      +
Code Impact
      ↓
Migration
      ↓
Before / After Preview
      ↓
Apply
```

This is the target architecture.

---

# 48. Codex execution instruction

When continuing implementation:

1. Inspect current repository conventions before writing new architecture.
2. Follow root and nested `AGENTS.md`.
3. Keep daemon as authority.
4. Keep shared contracts canonical in `packages/contracts`.
5. Avoid changing existing prompt behavior unless explicitly required by the current milestone.
6. Do not overload existing `components.manifest.json`; introduce a dedicated strong Component Registry.
7. Prefer additive architecture so upstream OpenDesign changes can still be rebased.
8. Build deterministic infrastructure before AI-assisted behavior.
9. Every new contract must have tests.
10. Every persisted structure must have a schema version.
11. Every reusable entity must have stable identity.
12. Do not implement future roadmap items opportunistically in the first PR.
13. After inspecting the repo, first produce a short implementation note containing:

* current relevant files
* proposed files
* compatibility concerns
* exact scope of the first change

14. Then implement Phase 1 plus the smallest useful React compiler spike.
15. Run the narrow tests first, then repository-required validation/typecheck according to `AGENTS.md`.

The immediate goal is not to build the full product.

The immediate goal is to establish the correct structural foundation on which Component Instances, Reference Graph, Versioning, Upgrade Analysis and deterministic Handoff can safely be built.
