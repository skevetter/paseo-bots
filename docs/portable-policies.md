# Portable runtime policies

Bot exports now use format version 3. Readers continue to accept version 1 and 2 bot files. Team files remain version 1 and contain versioned bot exports.

A bot using global, team or bot runtime policies exports a resolved execution-policy snapshot. It includes executor and delegated-role selections, capability requirements, routing definitions, explicit task-class restrictions, budgets and concurrency. The destination does not receive the source host's global/team bindings or policy IDs. Import derives a new policy ID from the snapshot content and binds the imported bot to revision 1. Identical definitions can be reused without mutating an existing revision.

The snapshot pins the exported configuration, not a live link to future source-policy revisions. An absent task-class restriction still inherits destination restrictions; importing does not implicitly grant an unrestricted task class. A provider/model unavailable on the destination is not replaced with a guessed alternative. Launch policy validation remains authoritative.

Permissions are separate. Imports start with destination new-bot approval defaults, no always-allowed tools, no connected apps and paused routines. Execution-policy JSON cannot contain permission fields. Local duplication intentionally restores the original bot's permissions and library references, while retaining a portable snapshot of its effective execution configuration.

## Atomic admission

`bots.imports.apply` accepts an operation ID, expected state revision, parsed imported bots and teams. Policy definitions and the bots that reference them are saved in one `BotStore.apply` transition. A stale revision or duplicate bot ID changes neither definitions nor bots. Replaying the same operation and body returns the saved state without admitting the bots twice; reusing the ID with changed content conflicts. Generic whole-state saves cannot add policy definitions.

The app's import dialogs, Duplicate and MCP import/duplicate paths use this writer. Import proposals use the same pure `addImportedBots` transition when accepted. Existing source IDs are never used to overwrite immutable destination policy revisions.

File extraction remains the existing preparation step before admission. An abandoned or rejected import can leave prepared bot/skill files, but cannot create a dangling policy binding in authoritative config. This package does not change that filesystem staging contract.

## Rollback

Older plugins cannot read bot export version 3. Keep the original version 1/2 file if it must be imported by an older plugin. Restoring the checked v1 state backup described in [Policies](policies.md) removes policies, imported bots and operation receipts saved after that backup; it does not remove prepared filesystem data.
