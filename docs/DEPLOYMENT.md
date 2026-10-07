# Cloudflare deployment

## Prerequisites

Use a Cloudflare account with Workers, D1, Workers AI and Zero Trust Access enabled, an API token scoped to the intended account, and a hostname you control. The current environment has no configured Cloudflare credentials or family identity list, so live deployment cannot be verified yet.

1. Create a D1 database: `npx wrangler d1 create hearth-family`. Replace the placeholder `database_id` in `wrangler.jsonc` with its returned id.
2. Configure the production hostname as a Worker custom domain or route in `wrangler.jsonc`. Keep `workers_dev: false` so an alternate public hostname cannot bypass Access.
3. Create a self-hosted Cloudflare Access application protecting the **entire hostname**, with an allow policy containing only your family's exact email addresses. Enable email one-time PIN or your chosen identity provider. Avoid public bypass policies.
4. Record the Access team domain and application audience. Prepare `FAMILY_MEMBERS` as an array of `{id,name,email,role,color}`. Use stable ids; email values must exactly match signed Access identities. Include one or more administrators. Do not reuse the `.test` development identities.

Member ids are permanent ownership keys. Never assign a departed member's id to a different person: doing so grants that identity the former member's private records. Removing a member revokes application access but preserves their data; their shared records remain available and private records remain private.
5. Set `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `APP_ORIGIN` and `FAMILY_MEMBERS` in the deployment process environment. Do not put them in commits or command history. Set `FAMILY_TIMEZONE` in Worker vars to your IANA timezone. APP_ORIGIN is the exact HTTPS origin, without trailing slash.
6. Optionally set `FAMILY_QUESTION_PAIR` in the deployment environment to a JSON pair of stable member ids, for example `["alex","sam"]`, or JSON `null` to disable participation. If omitted, a household with exactly two members is paired automatically; households of any other size remain unpaired. See the pairing rules below.
7. Run `npm run deploy`. Preflight checks required settings; the script runs checks, applies migrations to the configured database, writes application configuration as Worker secrets through stdin, and deploys the Worker. The script explicitly pins `DEV_AUTH=false` to clear any stale development secret. Do not configure `DEV_AUTH` or secret-based Access/family settings, including `FAMILY_QUESTION_PAIR`, in production vars.
8. Verify unauthenticated requests challenge for Access, unrelated identities are rejected, family members can sign in, private moods remain private, daily answers reveal only to the configured pair unless explicitly shared on profiles, and recipe text/photo AI imports return drafts. Test on the actual phones before relying on camera/PWA installation.

Workers AI calls require a live binding and may incur account usage charges. JSON-LD extraction and manual recipe entry avoid unnecessary model calls. Set Cloudflare account budgets/alerts appropriate for household use. Never log recipe images, access tokens, mood entries or full API bodies in observability.

The vision model `@cf/meta/llama-3.2-11b-vision-instruct` requires account acceptance of Meta's model license before first use. Follow the [official Cloudflare vision setup](https://developers.cloudflare.com/workers-ai/guides/tutorials/llama-vision-tutorial/). Text extraction uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Model availability, license acceptance and actual inference must be verified in the target account. URL import also needs public recipe-site and Cloudflare DNS egress; the current development workspace only permits configured destinations, so arbitrary remote imports are tested with controlled fixtures locally.

## Daily question pairing

`FAMILY_QUESTION_PAIR` configures one pair per household. Both ids must be distinct and present in `FAMILY_MEMBERS`; invalid JSON, unknown ids, and arrays of any other size fail closed. The runtime and deployment preflight share the same parser and normalize id order. This setting is optional, but every deployment uploads its resolved pair or `null` as a Worker secret. Removing the environment setting therefore replaces a previously configured secret with the current roster's default instead of retaining stale pairing. Use explicit JSON `null` to keep even a two-member household unpaired. The two-person demo continues to pair automatically.

New answers record their original two participant ids. Private reveal requires both members of that exact active pair to answer the same dated question. Profile sharing is a separate, reversible author opt-in that makes an answer visible to the whole family only after that answer has been released to its pair. Changing or disabling the pair hides answers from a previous pair from nonowners, including on profiles; owners retain their own history. Saved answers and stale drafts cannot be assigned to a replacement partner. If today's saved answer belongs to a different pair, the new pair resumes tomorrow.

Older answers without participant ids remain owner-only, including answers previously marked for profile sharing. No audience is inferred from the current roster, and no SQL migration is required for pairing. Preserve stable member ids permanently and never reuse them for a different person.

## Backup and recovery

Use D1 Time Travel and periodic account-controlled database exports. A user's in-app export intentionally includes only records that identity may view; it is not an administrator bypass or complete disaster-recovery backup. Store full database backups encrypted in a family-controlled location. Verify restore into a separate non-production database before depending on backups.

For a bad code release, use `npx wrangler rollback` to the last known-good Worker version. D1 migrations are separate from Worker rollback: keep migrations additive, take a backup before destructive changes, and restore to a separate database when needed. Never overwrite the live database blindly.

## Resource boundaries

The current release loads the family collection together. Atomic database triggers limit it to 10,000 records and 8 MiB of UTF-8 record data, including private and disabled-module data. Individual records are limited to 32 KiB. Delete or shrink existing records to recover capacity; nothing is silently discarded. Pagination and archival are the next step before raising these bounds. Apply both migrations before starting the updated Worker.

Each member has limits of 300 requests per minute, 240 writes per hour, 10 recipe imports per hour and 10 exports per hour. The family has a 40-import daily limit. These limits reduce accidental usage spikes; they are not a substitute for Cloudflare account billing controls. Recipe source pages are bounded to 1 MiB and input images to 4 MiB.

## Continued development

`docs/ROADMAP.md` records completion evidence and blockers. This repository supports continued work across agent sessions; an active chat does not by itself guarantee a permanent background process. Do not claim an unattended daemon or scheduled continuation exists unless the platform confirms it.
