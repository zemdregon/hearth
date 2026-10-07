# Architecture

Hearth uses one Cloudflare Worker and one D1 database per family. Vite builds the React PWA into static assets served by the Worker platform. Authenticated JSON APIs run in Hono. Shared TypeScript contracts define the modules and their records. Modules own their interface and validation while using a common versioned record API.

Cloudflare Access supplies signed identity tokens; the API verifies signature, issuer, audience and membership in FAMILY_MEMBERS. Only administrators change module settings. Sensitive personal records enforce ownership and visibility on the server, including data export. Mood entries are private by default. Daily question answers are revealed after all configured members have answered; profile sharing is an explicit choice. Disabling a module preserves its stored data and removes API access until enabled again.

Mutations validate the request origin and record schema. Records carry a version to reject conflicting edits instead of silently overwriting. The browser refreshes on visibility and network return and periodically while visible. Personal API responses are never cached by the service worker or written to browser persistent storage. Offline installation caches only the static application shell, so private data requires a connection. Demo records are fictional, isolated in memory and never uploaded.

Recipe URL extraction prefers structured recipe data and uses Workers AI when text needs cleaning. Camera scans submit the selected image to Workers AI for a reviewable recipe draft. Only recipe input is sent to AI; mood, profile and relationship data do not feed prompts. Ingredients preserve quantities and ranges for serving calculations. Users review and correct imported drafts before saving.

See `CONTRACTS.md` for endpoint and component interfaces. To add a module, add its types and registry entry, server validation and authorization, client view, and meaningful checks. Do not implement a new module as an unrestricted arbitrary JSON record.
