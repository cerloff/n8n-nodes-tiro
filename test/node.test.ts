import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IExecuteFunctions } from 'n8n-workflow';
import { Tiro } from '../nodes/Tiro/Tiro.node';
import { DOCUMENT, INBOX, makeContext, type Recorded } from './helpers';

/** The multipart bytes the node would put on the wire. */
const multipart = (body: unknown): string => (body as Buffer).toString('utf8');

const tiro = new Tiro();

test('uploading sends the binary file to the inbox and links the document', async () => {
	const context = makeContext({
		parameters: {
			resource: 'document',
			operation: 'upload',
			inboxId: 'inbox-1',
			binaryPropertyName: 'data',
			fileName: '',
		},
		binary: {
			data: Buffer.from('%PDF-1.7 fake'),
			fileName: 'order-confirmation-4711.pdf',
			mimeType: 'application/pdf',
		},
		route: () => ({ status: 201, body: { ...DOCUMENT, status: 'uploaded' } }),
	});

	const [items] = await tiro.execute.call(context as unknown as IExecuteFunctions);

	const [call] = context.calls;
	assert.equal(call.method, 'POST');
	assert.equal(call.url, 'https://tirodocs.com/api/v1/inboxes/inbox-1/documents');
	// A multipart body with the file under its own name — never JSON.
	const contentType = (call.headers as Record<string, string>)['Content-Type'];
	assert.match(contentType, /^multipart\/form-data; boundary=/);
	const body = multipart(call.body);
	assert.match(body, /name="file"; filename="order-confirmation-4711.pdf"/);
	assert.match(body, /Content-Type: application\/pdf/);

	assert.equal(items[0].json.status, 'uploaded');
	assert.equal(
		items[0].json.document_url,
		'https://tirodocs.com/en/app/inboxes/inbox-1/documents/doc-1',
	);
});

test('the file name can be overridden for the workflow', async () => {
	const context = makeContext({
		parameters: {
			resource: 'document',
			operation: 'upload',
			inboxId: 'inbox-1',
			binaryPropertyName: 'data',
			fileName: 'invoice-from-gmail.pdf',
		},
		binary: { data: Buffer.from('%PDF'), fileName: 'attachment.pdf', mimeType: 'application/pdf' },
		route: () => ({ status: 201, body: DOCUMENT }),
	});

	await tiro.execute.call(context as unknown as IExecuteFunctions);

	assert.match(multipart(context.calls[0].body), /filename="invoice-from-gmail.pdf"/);
});

test("an upload Tiro refuses reaches the workflow with the API's reason", async () => {
	const context = makeContext({
		parameters: {
			resource: 'document',
			operation: 'upload',
			inboxId: 'inbox-1',
			binaryPropertyName: 'data',
		},
		binary: { data: Buffer.from('x'), fileName: 'huge.pdf', mimeType: 'application/pdf' },
		route: () => ({ status: 429, body: { detail: 'Nicht genug Credits.' } }),
	});

	await assert.rejects(
		tiro.execute.call(context as unknown as IExecuteFunctions),
		/Nicht genug Credits/,
	);
});

test('getting an extract maps fields and rows once the document is done', async () => {
	const answers: Record<string, Recorded> = {};
	const context = makeContext({
		parameters: {
			resource: 'extract',
			operation: 'get',
			inboxId: 'inbox-1',
			documentId: 'doc-1',
		},
		route: (request) => {
			answers[request.url] = request;
			if (request.url.endsWith('/extract')) {
				return {
					body: {
						data: { supplier: 'Example Supplies Ltd.', line_items: [{ amount: 106.8 }] },
						created_at: '2026-09-12T09:15:02.123456',
					},
				};
			}
			if (request.url.endsWith('/documents/doc-1')) return { body: DOCUMENT };
			return { body: { ...INBOX, fields: [] } };
		},
	});

	const [items] = await tiro.execute.call(context as unknown as IExecuteFunctions);

	assert.equal(items[0].json.found, true);
	assert.deepEqual(items[0].json.fields, { supplier: 'Example Supplies Ltd.' });
	assert.equal(items[0].json.row_count, 1);
	// The API prints naive UTC; the workflow sees ISO 8601 with a zone.
	assert.equal(items[0].json.extracted_at, '2026-09-12T09:15:02.123456Z');
	assert.equal(items[0].json.inbox_name, 'Order confirmations');
});

test('a document that is not finished yet is "found: false", not an error', async () => {
	const context = makeContext({
		parameters: {
			resource: 'extract',
			operation: 'get',
			inboxId: 'inbox-1',
			documentId: 'doc-1',
		},
		route: () => ({ body: { ...DOCUMENT, status: 'processing' } }),
	});

	const [items] = await tiro.execute.call(context as unknown as IExecuteFunctions);

	assert.deepEqual(items[0].json, {
		found: false,
		inbox_id: 'inbox-1',
		document_id: 'doc-1',
		status: 'processing',
	});
	// Nothing beyond the document was asked for.
	assert.equal(context.calls.length, 1);
});

test('an unknown document is "found: false" as well', async () => {
	const context = makeContext({
		parameters: {
			resource: 'extract',
			operation: 'get',
			inboxId: 'inbox-1',
			documentId: 'gone',
		},
		route: () => ({ status: 404, body: { detail: 'Dokument nicht gefunden.' } }),
	});

	const [items] = await tiro.execute.call(context as unknown as IExecuteFunctions);

	assert.equal(items[0].json.found, false);
	assert.equal(items[0].json.status, null);
});
