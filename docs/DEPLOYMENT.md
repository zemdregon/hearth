# Cloudflare deployment

## Passkey deployment prerequisites

The Worker uses internal passkey-only authentication. No email identity provider, password, OTP or public signup is supported. Follow [AUTHENTICATION.md](AUTHENTICATION.md) for operator enrollment/recovery and the verification gates. Production release still requires a stable hostname, real-device checks and the live operational rehearsals recorded in the roadmap.

Cloudflare Workers, D1 and Workers AI remain the hosting stack. Token/account configuration and read-only D1 access were verified on 2026-10-08; `wrangler.jsonc` identifies the existing `hearth-family-db`. Remote migrations, deployment and inference have not been verified.

Release sequence after local verification:

1. Select a stable canonical HTTPS hostname and exact `APP_ORIGIN`; configure a matching WebAuthn RP ID and Worker route. Keep `workers_dev: false` and reject unexpected origins. Changing the RP ID later requires an explicit credential migration/re-enrollment plan.
2. Back up D1 and rehearse restore in isolation. Apply the new authentication migrations after reviewing their preservation of permanent member ids and existing data ownership.
3. Configure `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `APP_ORIGIN` and `WEBAUTHN_RP_ID`, then run preflight and publish the verified passkey Worker. Preflight rejects legacy Access/email roster configuration and production development bypass settings. The new Worker denies private access until internal enrollment and passkey assertion succeed. Remove any existing Access application gate and legacy Worker secrets as part of this authorized release after verifying that denial; the new Worker never reads them. Deployment keeps `DEV_AUTH=false` solely to neutralize a stale setting on rollback; the current runtime has no bypass branch.
4. Use the reviewed operator import and bootstrap commands to authorize the initial administrator's passkey enrollment. The operator command defaults to local and dry-run; selecting the remote target and applying a reviewed plan are explicit actions. Add a second passkey and rehearse recovery before relying on the deployment.
5. Enroll other members through administrator-issued private invitations. Store membership internally in D1 without email fields. Set the family timezone and question pair using permanent ids.
6. Verify unauthenticated private API denial, passkey sign-in, enrollment/recovery, session revocation, member isolation and private moods/answers on the actual phones and PWA before admitting normal family use. Then verify recipe text/photo AI drafts and model licensing in the target account.

Member ids are permanent ownership keys. Never assign a departed member's id to a different person: doing so grants that identity the former member's private records. Removing a member revokes application access but preserves their data; their shared records remain available and private records remain private.

Keep account tokens and enrollment authorizations out of commits, command history and logs. `npm run deploy` runs checks, applies remote migrations, uploads the passkey configuration and publishes the Worker. It does not automatically create or enroll members.

Workers AI calls require a live binding and may incur account usage charges. JSON-LD extraction and manual recipe entry avoid unnecessary model calls. Set Cloudflare account budgets/alerts appropriate for household use. Never log recipe images, access tokens, mood entries or full API bodies in observability.

The vision model `@cf/meta/llama-3.2-11b-vision-instruct` requires account acceptance of Meta's model license before first use. Follow the [official Cloudflare vision setup](https://developers.cloudflare.com/workers-ai/guides/tutorials/llama-vision-tutorial/). Text extraction uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Model availability, license acceptance and actual inference must be verified in the target account. URL import requires public recipe-site and Cloudflare DNS egress. Local tests use controlled fixtures; they do not establish live destination reachability. Verify egress in the target runtime before relying on remote imports.

## Daily question pairing

`FAMILY_QUESTION_PAIR` configures one pair of distinct permanent D1 member ids. Deployment validates its shape and pins omitted configuration to JSON `null` so a stale pair is not retained. The Worker validates configured ids against the complete internal roster; when either member is pending or suspended, pairing is unavailable (`null`) without breaking other family API access. Unknown ids or malformed configuration fail closed. Local runtime omission infers a pair only if the complete roster has exactly two members, both active; the fictional two-person demo also pairs automatically. Set an explicit pair for deployed households.

New answers record their original two participant ids. Private reveal requires both members of that exact active pair to answer the same dated question. Profile sharing is a separate, reversible author opt-in that makes an answer visible to the whole family only after that answer has been released to its pair. Changing or disabling the pair hides answers from a previous pair from nonowners, including on profiles; owners retain their own history. Saved answers and stale drafts cannot be assigned to a replacement partner. If today's saved answer belongs to a different pair, the new pair resumes tomorrow.

Older answers without participant ids remain owner-only, including answers previously marked for profile sharing. No audience is inferred from the current roster, and no SQL migration is required for pairing. Preserve stable member ids permanently and never reuse them for a different person.

## Backup and recovery

Use D1 Time Travel and periodic account-controlled database exports. A user's in-app export intentionally includes only records that identity may view; it is not an administrator bypass or complete disaster-recovery backup. Store full database backups encrypted in a family-controlled location. Verify restore into a separate non-production database before depending on backups.

For a bad code release, use `npx wrangler rollback` only to a version compatible with the restored authentication configuration and schema. D1 migrations are separate from Worker rollback: keep migrations additive, take a backup before destructive changes, and restore to a separate database when needed. Never overwrite the live database blindly. The passkey restore workflow must invalidate restored sessions, invitations and challenges and reconcile credential/member revocations before admitting traffic; rolling back code alone must not resurrect access.

### Restore rehearsal and authentication lock

`npm run test:restore` rehearses the local procedure using generated fictional data, two separate temporary D1 databases, the installed Wrangler export/import commands, and the actual Worker. It accepts no database path, backup, configuration or remote target. Temporary files are private and removed on completion; output contains assertions only, never backup contents or enrollment tokens. Run `npm ci` first. This command is separate from the fast unit suite because it starts several local Wrangler processes.

For an actual restore, keep the destination disconnected from the public Worker until the following procedure finishes. Merely importing a backup can restore valid sessions and credentials; a later authentication lock does not protect the time between those operations.

1. Preserve the source and export the intended backup into a restricted, encrypted storage location. Record its database, time and schema version. Restore into a separate isolated destination, then apply any missing additive migrations. Do not bind normal application traffic to it.
2. Review record counts and bytes, permanent owner ids, couples audiences, paused modules, foreign keys, schema and storage accounting against the backup. Use D1's documented [`PRAGMA quick_check` and `PRAGMA foreign_key_check`](https://developers.cloudflare.com/d1/sql-api/sql-statements/) for database checks. Compare account membership and roles against current operator knowledge, not just the older backup. Retain every historical identity; never reassign a departed person's id.
3. Prepare a current reviewed roster covering exactly the restored member ids, using only `pending` or `suspended` statuses. Review each role explicitly, including demotions and departures since the backup. Run `npm run auth:operator -- restore-lock --config <destination.json> --input <roster>` against the explicit destination configuration. Choose `--local --persist-to <isolated-directory>` for local state or `--remote` for an explicitly authorized remote destination; a production-looking configuration file alone does not select remote D1. Review the printed target and hash, then apply that exact plan with identical target flags. See [restore operator lock](AUTHENTICATION.md#restore-operator-lock). This revokes every restored credential, session and enrollment authorization, removes every pending ceremony, reconciles the reviewed roster and preserves data and identity handles. It issues no enrollment token. Any unconfirmed result requires inspection before traffic is admitted.
4. Verify the lock receipt and state: no active member, usable credential, session or grant remains; pending ceremonies are gone and suspended members remain suspended. All restored passkeys must be replaced, including keys that were still valid at backup time. This conservative reset prevents a credential revoked after the backup from becoming usable again.
5. Authorize recovery for the reviewed pending administrator using the existing operator recovery command, the identical destination/target flags, and a new private output file. Once the locked destination and passkey Worker are deliberately exposed at the canonical origin, enroll and separately sign in with a new passkey. Confirm that an old cookie, old invitation and old passkey cannot authenticate. Add a backup passkey, recover only individually reviewed members, and rehearse administrator recovery before normal family use resumes.
6. Verify actual phones/PWAs and member isolation; retain the previous database for rollback investigation. Do not roll back to its old authentication state. A local synthetic rehearsal does not prove Cloudflare Time Travel, remote import transaction behavior, production routing or real-device recovery; those remain separate release gates.

## Resource boundaries

The current release loads the family collection together. Conditional refresh avoids sending unchanged response bodies but still reads and processes the full collection. Atomic database triggers limit it to 10,000 records and 8 MiB of UTF-8 record data, including private and disabled-module data. Individual records are limited to 32 KiB. Delete or shrink existing records to recover capacity; nothing is silently discarded. Server pagination and bounded export measurements are prerequisites for raising these bounds; archival remains a separate, reversible product capability to evaluate. See the [scaling evaluation](PERFORMANCE.md) for constraints and measured limits. Apply all checked-in migrations before starting the updated Worker; the additive authentication tables do not themselves enable passkey sign-in.

Each member has limits of 300 requests per minute, 240 writes per hour, 10 recipe imports per hour and 10 exports per hour. The family has a 40-import daily limit. These limits reduce accidental usage spikes; they are not a substitute for Cloudflare account billing controls. Recipe source pages are bounded to 1 MiB and input images to 4 MiB.

## Continued development

`docs/ROADMAP.md` records completion evidence and blockers. This repository supports continued work across agent sessions; an active chat does not by itself guarantee a permanent background process. Do not claim an unattended daemon or scheduled continuation exists unless the platform confirms it.
