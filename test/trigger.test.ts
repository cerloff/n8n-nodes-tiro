import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IHookFunctions, IWebhookFunctions } from 'n8n-workflow';
import { TiroTrigger } from '../nodes/Tiro/TiroTrigger.node';
import {
	EXTRACT_PAYLOAD,
	FAILURE_PAYLOAD,
	SECRET,
	WEBHOOK_URL,
	makeContext,
	signedRequest,
} from './helpers';

const trigger = new TiroTrigger();
const hooks = trigger.webhookMethods.default;

test('subscribing creates an n8n destination for the chosen inbox and event', async () => {
	const context = makeContext({
		parameters: { inboxId: 'inbox-1', event: 'failure' },
		route: () => ({ status: 201, body: { id: 'dest-1', secret: SECRET } }),
	});

	assert.equal(await hooks.create.call(context as unknown as IHookFunctions), true);

	assert.deepEqual(context.calls, [
		{
			method: 'POST',
			url: 'https://tirodocs.com/api/v1/destinations',
			body: {
				inbox_id: 'inbox-1',
				url: WEBHOOK_URL,
				type: 'n8n',
				event: 'document.failed',
			},
			qs: undefined,
			headers: { 'User-Agent': 'Tiro-n8n/1.0' },
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		},
	]);
	// The id unsubscribes later, the secret verifies every call.
	assert.equal(context.staticData.destinationId, 'dest-1');
	assert.equal(context.staticData.secret, SECRET);
});

test('an existing subscription is recognised, a moved one is replaced', async () => {
	const matching = makeContext({
		parameters: { inboxId: 'inbox-1', event: 'extract' },
		staticData: { destinationId: 'dest-1' },
		route: () => ({
			body: {
				id: 'dest-1',
				inbox_id: 'inbox-1',
				url: WEBHOOK_URL,
				event: 'extract.completed',
				active: true,
			},
		}),
	});
	assert.equal(await hooks.checkExists.call(matching as unknown as IHookFunctions), true);

	const moved = makeContext({
		parameters: { inboxId: 'inbox-1', event: 'extract' },
		staticData: { destinationId: 'dest-1', secret: SECRET },
		route: () => ({
			body: {
				id: 'dest-1',
				inbox_id: 'inbox-1',
				url: 'https://old.example.com/webhook/tiro',
				event: 'extract.completed',
				active: true,
			},
		}),
	});
	assert.equal(await hooks.checkExists.call(moved as unknown as IHookFunctions), false);
	// The stale destination is gone instead of delivering into the void.
	assert.deepEqual(
		moved.calls.map((call) => call.method),
		['GET', 'DELETE'],
	);
	assert.equal(moved.staticData.destinationId, undefined);
});

test('deleting the trigger removes the destination, a missing one is fine', async () => {
	const context = makeContext({
		staticData: { destinationId: 'dest-1', secret: SECRET },
		route: () => ({ status: 404, body: { detail: 'Ziel nicht gefunden.' } }),
	});

	assert.equal(await hooks.delete.call(context as unknown as IHookFunctions), true);

	assert.equal(context.calls[0].method, 'DELETE');
	assert.equal(context.calls[0].url, 'https://tirodocs.com/api/v1/destinations/dest-1');
	assert.deepEqual(context.staticData, {});
});

test('a signed extract call becomes one item with fields and rows', async () => {
	const context = makeContext({
		parameters: { event: 'extract' },
		staticData: { secret: SECRET },
		...signedRequest(EXTRACT_PAYLOAD),
	});

	const response = await trigger.webhook.call(context as unknown as IWebhookFunctions);

	const [items] = response.workflowData!;
	assert.equal(items.length, 1);
	assert.deepEqual(items[0].json.fields, { document_number: 'AB-2026-4711', total: 1234.5 });
	assert.equal(items[0].json.rows_field, 'line_items');
	assert.equal(items[0].json.row_count, 2);
	assert.equal(items[0].json.id, 'doc-1:2026-09-12T09:15:02Z');
	assert.equal(
		items[0].json.document_url,
		'https://tirodocs.com/en/app/inboxes/inbox-1/documents/doc-1',
	);
	assert.equal(
		items[0].json.csv_url,
		'https://tirodocs.com/api/v1/inboxes/inbox-1/documents/doc-1/download?format=csv',
	);
});

test('"one item per row" repeats the header fields on every row', async () => {
	const context = makeContext({
		parameters: { event: 'row' },
		staticData: { secret: SECRET },
		...signedRequest(EXTRACT_PAYLOAD),
	});

	const response = await trigger.webhook.call(context as unknown as IWebhookFunctions);

	const [items] = response.workflowData!;
	assert.equal(items.length, 2);
	assert.deepEqual(
		items.map((item) => item.json.id),
		['doc-1:2026-09-12T09:15:02Z:1', 'doc-1:2026-09-12T09:15:02Z:2'],
	);
	assert.deepEqual(items[1].json.row, { description: 'Assembly', quantity: 1, amount: 1127.7 });
	assert.deepEqual(items[1].json.fields, { document_number: 'AB-2026-4711', total: 1234.5 });
});

test('a failure call carries the error, an extract call does not start the failure trigger', async () => {
	const failure = makeContext({
		parameters: { event: 'failure' },
		staticData: { secret: SECRET },
		...signedRequest(FAILURE_PAYLOAD),
	});
	const [items] = (await trigger.webhook.call(failure as unknown as IWebhookFunctions))
		.workflowData!;
	assert.equal(items[0].json.error, 'Das Dokument konnte nicht verarbeitet werden.');
	assert.equal(items[0].json.status, 'failed');
	assert.equal(items[0].json.failed_at, '2026-09-12T09:20:00Z');

	const wrongEvent = makeContext({
		parameters: { event: 'failure' },
		staticData: { secret: SECRET },
		...signedRequest(EXTRACT_PAYLOAD),
	});
	const response = await trigger.webhook.call(wrongEvent as unknown as IWebhookFunctions);
	assert.deepEqual(response, {});
});

test('a call without a valid signature never starts a workflow', async () => {
	const signed = signedRequest(EXTRACT_PAYLOAD, 'whsec_someone-else');
	const context = makeContext({
		parameters: { event: 'extract' },
		staticData: { secret: SECRET },
		...signed,
	});

	await assert.rejects(
		trigger.webhook.call(context as unknown as IWebhookFunctions),
		/signature does not match/,
	);
});
