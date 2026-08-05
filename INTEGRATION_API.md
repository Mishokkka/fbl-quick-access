# Quick Access Integration API

Version 1, introduced in `fbl-quick-access` 1.5.8.

The API is published during the Foundry `init` hook:

```js
const qa = game.modules.get("fbl-quick-access")?.api;
```

A dependent module can also listen for:

```js
Hooks.once("fblQuickAccess.apiReady", (qa) => {
  // Register providers here when module hook ordering is uncertain.
});
```

`qa.apiVersion` is `1`. Feature detection is available through:

```js
qa.capabilities.statProviders;
qa.capabilities.newDayProviders;
qa.capabilities.activeGmExecution;
```

## STAT providers

```js
const unregister = qa.registerStatProvider({
  id: "fbl-disease-management",
  order: 250,

  async render({ app, actor, editable, providerId }) {
    // Return public-safe HTML. Quick Access inserts it after native STAT rows.
    return `<div class="fdm-stat-section">...</div>`;
  },

  activateListeners({ app, actor, root, editable, refresh, providerId }) {
    root.querySelector("[data-action='open']")?.addEventListener("click", () => {
      // Open provider-owned UI.
    });
  },

  async onActorDeleted(actor) {
    // Called once by the deterministic active GM.
  }
});
```

Contract:

- `id`: unique stable id matching `^[a-z0-9][a-z0-9._-]*$` (case-insensitive).
- `order`: numeric provider order. Default is `500`.
- `render(context)`: required, returns an HTML string.
- `activateListeners(context)`: optional. `root` is the provider-owned wrapper only.
- `onActorDeleted(actor)`: optional GM-side cleanup.
- Quick Access does not parse or rewrite provider markup.
- Provider sections span both columns when STAT uses its two-column mode.
- `refresh()` or `qa.refreshStat(appOrActor)` rerenders open sheets without opening a closed sheet.
- The registration call returns an unregister function.

Provider HTML is trusted module output. It must not expose GM-only data.

## New Day providers

```js
const unregister = qa.registerNewDayProvider({
  id: "fbl-disease-management",
  category: "diseases",
  categoryLabel: "Болезни",
  order: 400,

  async buildActions(actor, context) {
    return [{
      id: "case-abc-progress",
      itemName: "Недомогание",
      kind: "disease-progress",
      checked: true,
      warning: false,
      caseId: "abc"
    }];
  },

  async applyAction(actor, action, context) {
    return {
      changed: true,
      summary: "Состояние изменилось.",
      privateSummary: "Severity 5 → 6; disease won by 1 success."
    };
  },

  describeAction(action) {
    return "Провести суточное развитие болезни";
  },

  icon(action) {
    return "fa-virus";
  }
});
```

Contract:

- `id`, `category`, `order`, `buildActions`, `applyAction`, `describeAction`, and `icon` are required.
- `categoryLabel` is optional and can be a string or synchronous function.
- `buildActions` and `applyAction` are executed on the deterministic active GM through the Quick Access socket bridge.
- The requesting player must be a GM or have OWNER permission for the actor.
- `buildActions` must return public-safe, serializable action data. Do not include the true diagnosis, secret rolls, or other GM-only state.
- Action ids are automatically namespaced as `provider:<providerId>:<actionId>`.
- `applyAction` receives the original action object returned by `buildActions`.
- `summary` is included in the public New Day chat card.
- `privateSummary` is whispered to GMs by the active GM. It is not returned to a non-GM requester.
- Provider failures are isolated. One failed provider or action does not stop native or other provider actions.
- The registration call returns an unregister function.

The complete provider-aware plan is available through:

```js
await qa.buildNewDayPlanWithProviders(actor);
```

The older synchronous `qa.buildNewDayPlan(actor)` remains available and returns only native Quick Access actions for backward compatibility.

## Active-GM socket operations

A module can register its own privileged operation on every client:

```js
const unregister = qa.registerSocketHandler(
  "my-module.rebuild-index",
  async (payload, context) => {
    // Runs only on the deterministic active GM.
    // Validate document permissions and payload contents here.
    return { rebuilt: true };
  }
);
```

Then call it from any client:

```js
const result = await qa.executeAsActiveGM(
  "my-module.rebuild-index",
  { actorUuid: actor.uuid },
  { timeoutMs: 30000 }
);
```

`context` contains:

- `operation`
- `requestId`
- `requesterId`
- `requestUser`
- `activeGM`
- `isRemote`

Other methods:

```js
qa.getActiveGM();
qa.registerSocketHandler(operation, handler);
qa.executeAsActiveGM(operation, payload, options);
```

Rules:

- Operation ids must match `^[a-z0-9][a-z0-9._:-]*$` (case-insensitive).
- Duplicate operation ids throw instead of replacing another module's handler.
- Payloads and results must be JSON-serializable plain data.
- Registered handlers are privileged code. Each handler must validate the requesting user, document permission, ids, and expected payload shape.
- The active GM is selected deterministically from active GM users by id, so every client addresses the same GM.


## Character-import helpers

Quick Access exposes the same structured fields used by its Reputation and
start-Willpower interfaces. Importers should prefer these methods instead of
writing module flags directly:

```js
const qa = game.modules.get("fbl-quick-access")?.api;

await qa.saveReputationEntries(actor, [
  { id: "stable-id", amount: 2, description: "Known monster hunter", location: "Noctis" }
], { render: false });

await qa.saveWillpowerTalents(actor, {
  kinTalentId: importedKinTalent.id,
  professionalTalentId: importedPath.id
}, { render: false });
```

Read the current values with:

```js
qa.getReputationEntries(actor);
qa.getWillpowerTalents(actor);
```

`qa.capabilities.characterImport` is `true` when these helpers are available.
The talent ids are Actor Embedded Item ids, not compendium ids or catalog ids.
