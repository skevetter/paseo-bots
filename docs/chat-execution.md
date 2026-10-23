# Chat execution boundaries

## Opt-in

The bot's Model panel has a separate **Execution > Managed execution** switch. It is off when `executionMode` is absent or `legacy`, and can only be enabled on the storing host. It does not change model/provider policy, approval, routing or Memory Bridge settings. It does not promise a hard spend cap on an in-flight inference. Moving a bot to another host resets execution to legacy; returning does not opt it in again. Existing/imported bots are not enabled by opening settings.

The setting governs future tasks and routine runs. It does not retroactively convert existing conversations or change their active work.

## Conversations and task records

The composer classifies the actual loaded native agent using `paseo-bots.run` (`RUN_LABEL`), not the bot's current setting. An existing agent without that label remains an ordinary conversation even after its bot opts in. Its replies and queue continue on the selected host without managed admission or accounting.

An agent carrying that label is a managed task record, including while it is active or after its bot opts out. **Start new task** sends only the newly entered message and attachments through `ChatPane.onStart`. It never directly sends another turn to the managed agent, silently copies history, or changes the old task. The new task uses the bot's current execution settings. Existing history remains visible. Provider commands from the old task are not offered as commands for the new task.

Queued messages in ordinary conversations retain their existing automatic drain behavior. A managed record never automatically drains old queued messages into new tasks. Its retained queue can be edited or explicitly submitted with **Start new task**; each submission is a separate request, not continuation. Failed starts restore the draft or queue entry. Attachments and message identity retain the existing wire format.

Sending, keyboard submission and queue delivery stay disabled until the selected agent's identity and labels are loaded. A missing, mismatched or failed-to-load agent is not evidence of legacy execution. Offline conversations do not fall back to creating a new task.

Remote manual chats keep the selected remote host API. The composer and settings show that local managed accounting, budgets and Memory Bridge are unavailable; no remote admission protocol is implied.

## Retry identity

Each submitted intent gets one client message/request ID before delivery. If the response is lost after admission, an unchanged restored draft keeps that ID through retry and draft persistence/remount. Queued retries use the queue entry's stable ID. Editing queued content into the composer preserves the ID until text or attachments actually change.

Text/attachment edits, a merged failure restoration containing newly typed content, or an explicitly new message get a new ID. The client does not deduplicate by body or use a time window: deliberately submitting the same text twice remains two requests. If storage pressure drops image attachments, the changed persisted draft loses its old request ID. Failed starts restore input; an accepted pending result must resolve normally rather than being treated as a transport failure.

## Integration and rollback

`client/ChatPane.tsx` retains `onStart(message: OutgoingMessage): Promise<void>`, with text, messageId, images and attachments. The local start integration owns raw `bots.chats.start` requests and created/pending navigation. `ComposerProps.agentReady` is an internal ChatPane-to-Composer readiness gate, not a new surface-owner requirement.

Opting out affects future tasks, not existing task identities. It does not release reservations, cancel active work, erase history or undo external effects. Preserve run metadata and artifacts when rolling back; an older client that sends directly to a managed record must not be used to resume that record. Server admission/session gates remain authoritative.
