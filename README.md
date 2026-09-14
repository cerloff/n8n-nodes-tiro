# n8n-nodes-tiro

n8n community node for [Tiro](https://tirodocs.com) — document in, table out. Upload a PDF,
image or Office file into a Tiro inbox and let the workflow continue with the extracted header
fields and table rows.

This package contains two nodes:

| Node | What it does |
| --- | --- |
| **Tiro Trigger** | Starts the workflow when Tiro finished a document (whole result, one item per table row, or a document that failed for good). |
| **Tiro** | `Document → Upload` puts a file into an inbox; `Extract → Get` reads the result of a document by its ID. |

## Installation

Self-hosted n8n: **Settings → Community nodes → Install**, package name `n8n-nodes-tiro`.
Manually: `npm install n8n-nodes-tiro` in your n8n data folder and restart n8n.

## Credentials

Create an API key in Tiro under **Account → API keys** (shown exactly once). The key belongs to
a workspace, so the node only ever sees that workspace's inboxes and documents. `Base URL` stays
`https://tirodocs.com/api/v1` unless you run Tiro yourself.

## Trigger

The trigger subscribes as a destination of type `n8n` in the chosen inbox — Tiro calls the
workflow's webhook URL as soon as a document is finished. No polling, no empty executions.

- Every call is signed (`X-Tiro-Signature: v1=HMAC-SHA256`); the node verifies it and refuses
  anything that did not come from Tiro or is older than five minutes.
- If the inbox reviews its results, only released results reach the workflow.
- Your n8n instance must be reachable from the internet over **https** with a public hostname —
  Tiro refuses private, loopback and link-local addresses. For a quick test use `n8n start
  --tunnel` or n8n Cloud.
- Deleting or deactivating the workflow deletes the destination in Tiro.

## Upload and result

`Document → Upload` charges the document's credits at intake, exactly like an upload in the app,
and answers right away with the document (status `uploaded`/`processing`) — extraction runs in
the background. Pick the result up with the trigger in another workflow, or with
`Extract → Get` after a Wait step. A document that is not finished yet answers `found: false`
instead of an error, so an IF node can loop back into the Wait step.

## Development

```bash
npm install
npm test          # builds and runs the node test runner
npm run build     # dist/ as n8n loads it
```

Local n8n: `npm run build && npm link`, then `npm link n8n-nodes-tiro` in `~/.n8n/custom/`
(create the folder if it does not exist) and restart n8n.

The package ships **no runtime dependencies** — n8n refuses to verify a community node that
installs anything at runtime, so the multipart upload body is built by hand in
`nodes/Tiro/GenericFunctions.ts`. Keep it that way; `test/app.test.ts` guards it.

## Publishing (runbook)

1. `npm test` green, version bumped in `package.json`.
2. Sync this folder into the public mirror <https://github.com/cerloff/n8n-nodes-tiro> (the
   GitHub link is also the backlink for the integration page, and provenance needs a public
   repository). From the monorepo:

   ```bash
   git archive HEAD -- integrations/n8n | tar -x -C ../n8n-nodes-tiro --strip-components=2
   ```

   then commit and push there.
3. On npmjs.com, add `.github/workflows/publish.yml` of that repository as a **trusted
   publisher** for the package (or store an automation token as the secret `NPM_TOKEN`).
4. Tag the release (`git tag v1.0.0 && git push --tags`). The workflow installs, tests and runs
   `npm publish --provenance` — since 2026-05-01 n8n only verifies packages published this way,
   never ones pushed from a laptop.
5. Submit the package on the n8n Creator Portal (<https://creators.n8n.io/nodes>) and link the
   listing in `docs/marketing/` (fact sheet). Until it is verified, the node installs on
   self-hosted n8n only.

The nodes are a thin client of Tiro's public API (`/v1`) — every rule (credits, review, retries,
SSRF protection) lives in Tiro, never here.
