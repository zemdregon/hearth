# Internal passkey authentication transition

Decision, 2026-10-08: replace Cloudflare Access with authentication owned by Hearth. The internal implementation now replaces Access in the Worker and client. Local verification evidence and remaining real-device/deployment gates are recorded in ROADMAP.md; implementation alone is not a claim of live readiness.

## Foundation checkpoint

The additive `0003_passkey_foundation.sql` migration defines email-free member, credential, enrollment-grant, challenge, session and audit tables. It creates no members or credentials and does not modify existing records or ownership. Database constraints bind sessions to the credential's member and grant-backed challenges to the grant's member. Lifetime ceilings are five minutes for challenges, one day for grants and thirty days for sessions; the runtime additionally enforces seven-day idle expiry, cleanup, revocation, and fresh verification within five minutes for sensitive changes. Migration `0004` adds runtime state and database transaction guards. Migration `0005` binds sessions to their initiating browser so logout invalidates pending sign-ins and sessions even when a login response arrives late; existing sessions remain compatible. Constraints alone are not authentication.

`src/shared/members.ts` defines the new email-free identity contract. `User`, bootstrap, demo identities and family exports use this email-free contract. Legacy email roster configuration is no longer accepted for deployment.

Prepare a private JSON roster and run `npm run auth:roster:check -- --input /path/to/roster.json`. Each entry has `id`, `name`, `role`, `color`, and `status` (`pending` or `suspended`). Example fictional entry: `{"id":"alex","name":"Alex","role":"admin","color":"#38634A","status":"pending"}`. The file contains an array of 1–20 entries, including a pending administrator. It rejects email/credential fields, active accounts, duplicate ids and oversized input. The check is offline, prints counts only, and never changes a database or issues enrollment authorization.

This is shape validation, not ownership verification or a working import command. Before a future import, review every historical id in record owners, answer participants, task assignees and habit owners against the intended person; retain departed identities as suspended and never infer identity from a name. The separate operator command below performs reviewed import and grant issuance; the client provides passkey enrollment, sign-in, credential management and administrator member recovery.

## Product contract

Passkeys are the only member authentication method. No passwords, email addresses, email links, email/SMS codes, phone-number identities, social login, or recovery codes that sign someone in. No public signup. Members have a permanent opaque id, display name, role, color and active status. Names are labels, not proof of identity. Remove email fields from member configuration, shared types, UI, fixtures and exports during implementation.

Use discoverable WebAuthn credentials, required user verification, and a stable RP ID tied to the canonical HTTPS hostname. The device may ask for its own unlock PIN or biometric; Hearth neither collects nor stores these. Registration and assertion validation must follow the [W3C WebAuthn specification](https://www.w3.org/TR/webauthn-3/), including challenge, origin, RP ID, signature, user presence and verification checks. The implementation uses pinned `@simplewebauthn/server` 14.0.3 and `@simplewebauthn/browser` 14.0.0; verification runs in the Worker, with no hosted authentication service.

## Enrollment and recovery

1. An explicit account-operator command creates the initial administrator enrollment authorization. There is no public “first visitor becomes admin” route. The authorization is high-entropy, short-lived, single-use, stored hashed, bound to one member id and usable only to register a passkey. Completion atomically consumes it and the ceremony challenge; app access requires a subsequent verified passkey assertion.
2. A signed-in administrator, after fresh passkey verification, creates a member and an enrollment invitation shown as a link or QR code for direct personal transfer. Hearth sends no email or SMS. Enrollment authorizations grant no family-data access, cannot select another identity or role, expire, and can be revoked. Keep tokens out of query strings, logs and referrers; exchange a fragment-carried token through a no-store POST and clear it from browser history.
3. Members can register multiple passkeys and name/revoke them after fresh verification. Encourage a second passkey or hardware security key. Prevent removing the last usable credential through ordinary credential management and prevent disabling the last active administrator.
4. If all a member's passkeys are lost, another administrator verifies the person out of band and authorizes re-enrollment for the same permanent id, with fresh administrator passkey verification. Revoke old credentials, outstanding invitations and sessions as part of the recovery operation. Recovery still requires registration and assertion of a new passkey; the invitation itself never authenticates a session. Administrators therefore have account-recovery authority, which must be explicit in the UI and audit trail; they do not receive a direct private-record browsing bypass.
5. If every administrator loses access, an explicit account-operator recovery command authorizes the same bounded re-enrollment procedure. There is no persistent web master secret, password fallback or automatic recovery. Without an available passkey, another administrator or account-operator access, the household remains locked out.

## Server and session design

Add separate D1 tables for members, credentials, short-lived ceremonies, enrollment authorizations, sessions and minimal authentication audit events. Preserve existing member ids and record owners exactly when migrating; never map ownership by display name or reuse a departed member's id. Credential public keys and opaque WebAuthn user handles remain internal to authentication, excluded from family bootstrap and exports; handles necessarily pass through browser/authenticator ceremonies. Never store private keys or biometric data. Use opaque, non-email WebAuthn account labels. Membership suspension preserves records while revoking credentials/sessions and preventing authentication. Grant consumption, credential insertion and membership activation must commit atomically.

Store unpredictable session-token hashes in D1; issue an opaque token only through a Secure, HttpOnly, SameSite cookie restricted to the canonical host and root path. Sessions have server-enforced idle and absolute expiry, rotate on sign-in and privilege changes, and support logout/revoke-all. Revoke-all also cancels pending anonymous sign-in challenges household-wide, so another member with an open sign-in prompt may need to retry. Every private request checks current session, active membership and role. Require recent passkey verification for enrollment, recovery, credential changes and administrative changes. Enforce exact origin and CSRF protection on state-changing endpoints, including authentication/enrollment flows. Reject alternate-host and cross-origin ceremonies.

Challenges are random, expire promptly, are bound to the browser ceremony, operation, intended origin and member/authorization where applicable, and are atomically single-use. Verify credential ownership and the assertion user handle; reject duplicate credential registration and mismatched accounts. Treat authenticator signature counters according to the verified library's documented multi-device credential behavior, not an assumption that every passkey has a strictly increasing counter. Bound requests, pending challenges, credentials, sessions and audit retention; rate-limit unauthenticated attempts and invitation redemption without creating account-enumeration responses.

Authentication endpoints, cookies, invitations and private responses are never service-worker cached or stored in localStorage/IndexedDB. Credential/session secrets must not appear in logs or exports. Retain existing UI clearing, cross-tab logout, stale-response suppression and in-memory refresh-validator invalidation. Clear private UI promptly on expiry, suspension or revocation. Database restores must invalidate all restored sessions, invitations and pending ceremonies before traffic is admitted, and explicitly reconcile revocations since the backup.

## Implementation order and acceptance gates

1. Add migrations and email-free member contracts, with an explicit operator-reviewed import of existing stable ids. Keep historical ownership and couples audiences unchanged. Define bounds, expiry constants and recovery commands in reviewed code.
2. Implement and test WebAuthn ceremonies, invitation consumption, sessions, revocation and operator bootstrap/recovery. Validate Worker runtime/library compatibility. No production development bypass.
3. Build passkey sign-in, enrollment, credential management and administrator member/recovery screens. Unsupported/cancelled ceremonies explain how to use a compatible device without offering another authentication method. Local full-stack testing uses WebAuthn with isolated test configuration; fictional memory-only demo stays separate.
4. Replace Access JWT/email configuration, client Access redirects/logout, deployment preflight, secret upload and tests together. Configure exact `APP_ORIGIN` and RP ID; membership becomes internal D1 state. Remove `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and email-bearing `FAMILY_MEMBERS` requirements. Do not make Access an optional fallback. Keep alternate hostnames disabled and production closed until auth is ready.
5. Verify unit/integration rejection cases (replay, concurrent consumption, expiry, wrong origin/RP/user/signature, absent verification, revoked member/credential/session, CSRF, role escalation), API privacy regressions and logout races. Run typecheck, production build, local Worker/D1 tests and browser checks with a virtual authenticator. Test real phone/PWA passkeys, second-device enrollment, recovery and isolated restore before claiming production readiness.
6. Cut over only after backup, administrator enrollment and recovery rehearsal. Remove any existing Access gate/configuration as part of the verified release, never as a standalone exposure change. If migration fails, keep the app unavailable or roll back the complete compatible release/configuration; never deploy unauthenticated APIs. Historical Access tests are not evidence of passkey readiness.

## Operator commands

`node scripts/auth-operator.mjs --help` describes the account-operator workflow. It uses the installed project Wrangler and the `DB` binding from the specified JSON Wrangler configuration. The default configuration is the project's `wrangler.jsonc`, which must contain valid JSON; comments are not supported by this command. Local D1 and a read-only dry run are the defaults. `--local` makes that selection explicit, and `--persist-to /absolute/directory` selects isolated local state. Without that option, local state is the configuration directory's `.wrangler/state`. Apply all migrations, through `0005_passkey_browser_sessions.sql`, to the intended database first.

Prepare a private email-free roster as described above. Review each permanent id against the intended person, including identities referenced only by an answer's participants, a task's assignee, or a habit's user. Keep departed identities as `suspended`. The command prints stable ids, roles, statuses and counts, never display names or saved record contents. It rejects missing or malformed historical references, active roster entries, and any initial import into a nonempty member table. It never updates existing member rows or reassigns records.

Run a plan, review its target and ids, then repeat with the printed review hash:

```text
node scripts/auth-operator.mjs import --local --persist-to /private/hearth-test-state --input /private/roster.json
node scripts/auth-operator.mjs import --local --persist-to /private/hearth-test-state --input /private/roster.json --apply --review <printed-hash>
```

The hash binds the command, roster, relevant authentication state, historical ids, database id, configuration path and local persistence path. A changed plan requires a fresh review. The apply batch rechecks database conditions before mutation, so a concurrent import or recovery cannot silently replace another operation. Historical record bytes and references remain unchanged. The SQL file is private and temporary; Wrangler receives arguments directly without shell interpolation. Local Wrangler executes the file as one D1 batch, and failed constraints roll it back. Remote file execution uses Wrangler's D1 import workflow; remote execution and rollback have not been rehearsed by the local checks.

After import, authorize the initial pending administrator:

```text
node scripts/auth-operator.mjs bootstrap --local --persist-to /private/hearth-test-state --member alex
node scripts/auth-operator.mjs bootstrap --local --persist-to /private/hearth-test-state --member alex --apply --review <printed-hash> --output /private/initial-enrollment.json
```

Bootstrap requires a pending administrator with no active members or existing credentials. A durable database marker makes it one-time, including after expired authorizations and audit events are cleaned up. If the first authorization is lost or expires, use explicit recovery for the same member id instead of creating another administrator.

For operator recovery, verify the person out of band, review the exact existing id, and use a new output path:

```text
node scripts/auth-operator.mjs recover --local --persist-to /private/hearth-test-state --member alex
node scripts/auth-operator.mjs recover --local --persist-to /private/hearth-test-state --member alex --apply --review <printed-hash> --output /private/recovery-enrollment.json
```

Recovery atomically revokes that member's old sessions, credentials and authorizations, removes their pending ceremonies, preserves the permanent id and user handle, changes the member to `pending`, and issues one new authorization. Other members' access and all family records are preserved. Suspended identities cannot be recovered through this command. Operator recovery can intentionally leave the household without an active administrator until enrollment completes; account-operator authority must therefore remain restricted.

The output file contains a fresh 32-byte random token. Only its SHA-256 hash is stored in D1. Authorizations expire after one hour by default; `--expires-in` accepts 60–86400 seconds and is part of the reviewed plan. The file is created exclusively with mode `0600`; existing paths, including symlinks, are never overwritten. The token is never printed, sent in CLI arguments, embedded in SQL, or included in a query string. Transfer it privately using the canonical app's `/#enroll=<token>` fragment; the enrollment UI clears the fragment immediately. Registration and a separate passkey assertion are still required before family-data access. Dry runs create neither a token nor an output file.

The private file is flushed before the database batch begins. A reported failure after mutation starts has an **unconfirmed outcome**, because a connection failure can hide a committed operation. Retain that output file, inspect state, and use a fresh recovery if necessary to revoke an uncertain grant. Never assume a failed command issued nothing or overwrite an existing authorization file. Successful apply output is printed only after the command reads back its unique audit receipt.

Remote D1 requires explicit `--remote`; `--persist-to` is rejected for remote operations. The same review and `--apply` requirements apply. A remote dry run reads the configured remote database; a remote apply changes it. Use this only within an explicitly authorized account-operator maintenance operation. The command does not deploy Workers, apply migrations automatically, disable authentication, sign in a member, or provide a production bypass.
